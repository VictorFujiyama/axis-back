import type { FastifyInstance } from 'fastify';
import { ConnectorEmitFailedError, type ConnectorEvent } from '@atlas/connectors';
import { config } from '../../config';
import { QUEUE_NAMES } from '../../queue';
import { signOutboundPayload } from '../webhooks/sign';
import { getConnectorForAccount } from './connector';
import type { AtlasEventJob } from './enqueue';

const TIMEOUT_MS = 5_000;

export interface AtlasEventsWorkerDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Post-Phase 12.2 the `atlas-events` queue carries two shapes (spec §2, §11):
 *  - {@link ConnectorEvent} (SDK) — enqueued by the connector leg's
 *    queueAdapter (T-006), delivered via `emitDirect` to the Phase 12.2
 *    connector endpoint with `${t}.${orgId}.${body}` HMAC.
 *  - {@link AtlasEventJob} — legacy Phase B / §12.1 envelope jobs, delivered
 *    via {@link serializeJob} + `signOutboundPayload` (`${t}.${body}`) to the
 *    Phase B endpoint.
 * During the soak (Phase 9, `ATLAS_DUAL_EMIT`) BOTH shapes flow concurrently as
 * SEPARATE jobs with distinct jobIds + event_ids (L-609) — one job → one POST,
 * dispatched here by shape. NOT one job → two POSTs.
 */
type AtlasEventQueueJob = AtlasEventJob | ConnectorEvent;

type Envelope = Extract<AtlasEventJob, { kind: string }>;
type LegacyJob = Exclude<AtlasEventJob, { kind: string }>;

/**
 * A queued SDK {@link ConnectorEvent} (Phase 12.2). Distinguished from the
 * §12.1 envelope — which ALSO has `kind` — by the required idempotency fields
 * (`event_id` + `schema_version`) that only the SDK shape carries.
 */
function isConnectorEvent(job: AtlasEventQueueJob): job is ConnectorEvent {
  return 'event_id' in job && 'schema_version' in job;
}

function isEnvelope(job: AtlasEventJob): job is Envelope {
  return 'kind' in job;
}

function is4xx(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Extract the last HTTP status off a `ConnectorEmitFailedError`. Uses
 * `instanceof` (prod: worker + SDK share one module graph) with a duck-type
 * fallback on `.lastStatus` — under `vi.resetModules()` the re-imported SDK
 * gives the error class a distinct identity, so `instanceof` alone misses
 * (T-005 cross-module-instance gotcha). Non-connector errors → `undefined`
 * (always rethrow/retry).
 */
function connectorFailureStatus(err: unknown): number | undefined {
  if (err instanceof ConnectorEmitFailedError) return err.lastStatus;
  if (err && typeof err === 'object' && 'lastStatus' in err) {
    const s = (err as { lastStatus?: unknown }).lastStatus;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

/**
 * Convert the Phase 12 §12.1 envelope (internal camelCase) to the wire shape
 * (snake_case keys + nested `actors[].app_user_id`). Atlas-side connector
 * receiver parses this directly into `shadow_records`.
 */
function envelopeToWire(env: Envelope): Record<string, unknown> {
  return {
    kind: env.kind,
    action: env.action,
    source_ref: env.sourceRef,
    occurred_at: env.occurredAt,
    summary: env.summary,
    account_id: env.accountId,
    actors: env.actors.map((a) => {
      const out: Record<string, unknown> = { kind: a.kind, id: a.id };
      if (a.appUserId !== undefined) out['app_user_id'] = a.appUserId;
      return out;
    }),
    participants: env.participants.map((p) => ({ kind: p.kind, id: p.id })),
    viewable_by: env.viewableBy,
    ...(env.payload !== undefined ? { payload: env.payload } : {}),
  };
}

function legacyToWire(j: LegacyJob): Record<string, unknown> {
  const out: Record<string, unknown> = {
    event_type: j.type,
    occurred_at: j.occurredAt,
    conversation_id: j.conversationId,
    summary: j.summary,
  };
  if (j.type === 'message_sent') {
    out['message_id'] = j.messageId;
  } else if (j.type === 'handoff_to_human') {
    out['payload'] = {
      assigned_user_id: j.assignedUserId,
      assigned_team_id: j.assignedTeamId,
    };
  }
  return out;
}

function serializeJob(job: AtlasEventJob): string {
  return JSON.stringify(isEnvelope(job) ? envelopeToWire(job) : legacyToWire(job));
}

function jobLogContext(job: AtlasEventJob): Record<string, unknown> {
  if (isEnvelope(job)) {
    return {
      jobKind: job.kind,
      jobAction: job.action,
      sourceRef: job.sourceRef,
      accountId: job.accountId,
    };
  }
  return {
    jobType: job.type,
    conversationId: job.conversationId,
  };
}

/**
 * Phase 12.2 delivery — hand the queued {@link ConnectorEvent} to the SDK's
 * `emitDirect`, which signs (`${t}.${orgId}.${rawBody}`), POSTs to
 * `${ATLAS_URL}/api/connectors/messaging/events`, and retries 5× with backoff
 * (L-602). Runs independent of the Phase B secret/baseUrl so Phase 10 (dropping
 * the Phase B leg) can't disable connector delivery.
 *
 * The connector is resolved PER ACCOUNT (spec G5, Connect Flow): the queued
 * event carries `metadata.accountId`, so we look up THAT account's connection
 * and sign/POST with its org/secret. A job whose account has no connection
 * (deregistered, or the row is gone) is marked complete — there is nowhere to
 * deliver it.
 *
 * Error contract mirrors the Phase B leg: the SDK throws
 * `ConnectorEmitFailedError` once retries exhaust. A 4xx is terminal — a bad
 * signature/schema/rate-limit won't fix itself, so mark complete and don't let
 * BullMQ loop on it. Anything else (5xx / network exhausted) rethrows so BullMQ
 * retries and ultimately DLQs the job.
 */
async function deliverConnectorEvent(
  app: FastifyInstance,
  jobId: string | undefined,
  event: ConnectorEvent,
): Promise<void> {
  const accountId =
    typeof event.metadata['accountId'] === 'string' ? event.metadata['accountId'] : undefined;
  const connector = accountId ? await getConnectorForAccount(app, accountId) : null;
  if (!connector) {
    // The job's account has no Atlas connection (deregistered, the per-account
    // mapping is gone, or the event lacks accountId metadata). Mark complete —
    // there is nowhere to deliver it.
    app.log.warn(
      { jobId, eventId: event.event_id, kind: event.kind, accountId },
      'atlas-events worker: connector job but no connection for account — marking complete',
    );
    return;
  }

  const startedAt = Date.now();
  try {
    await connector.emitDirect(event);
  } catch (err) {
    const status = connectorFailureStatus(err);
    if (is4xx(status)) {
      app.log.warn(
        { jobId, eventId: event.event_id, kind: event.kind, status },
        'atlas-events worker: connector 4xx (permanent, no retry)',
      );
      return;
    }
    app.log.warn(
      { err, jobId, eventId: event.event_id, kind: event.kind },
      'atlas-events worker: connector emitDirect failed — will retry/DLQ',
    );
    throw err;
  }

  app.log.info(
    {
      jobId,
      eventId: event.event_id,
      kind: event.kind,
      latencyMs: Date.now() - startedAt,
    },
    'atlas-events worker: connector delivered',
  );
}

/**
 * BullMQ worker that POSTs an Atlas event to
 * `${ATLAS_BASE_URL}${ATLAS_EVENTS_ENDPOINT}` (Phase 12 default).
 *
 * Three job shapes dispatch here (spec §2, §11):
 *  - Phase 12.2 {@link ConnectorEvent} → {@link deliverConnectorEvent}
 *    (SDK `emitDirect`, connector endpoint).
 *  - Phase 12 §12.1 `kind`-discriminator envelopes → {@link envelopeToWire}.
 *  - Legacy Phase B `type`-variants → {@link legacyToWire}.
 * The latter two share the Phase B POST below (`signOutboundPayload` →
 * `${ATLAS_BASE_URL}${ATLAS_EVENTS_ENDPOINT}`).
 *
 * Phase B retry contract: 2xx → success; 4xx → terminal (no retry, BullMQ marks
 * complete so the job doesn't loop on a bad payload); 5xx / network / timeout
 * → throw (BullMQ retries with exponential backoff). Phase B secret/baseUrl
 * unset mid-job logs warn and returns (mark complete — don't pile up retries).
 * The worker registers while EITHER the Phase B secret OR the connector is on
 * (C1 gate decouple); the connector leg carries its own retry/error contract.
 */
export function registerAtlasEventsWorker(
  app: FastifyInstance,
  deps: AtlasEventsWorkerDeps = {},
): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET && !config.ATLAS_CONNECTOR_ENABLED) {
    app.log.info('atlas-events worker: disabled (no HMAC secret, connector off)');
    return;
  }

  app.queues.registerWorker<AtlasEventQueueJob>(
    QUEUE_NAMES.ATLAS_EVENTS,
    async (job) => {
      const j = job.data;

      // Phase 12.2 connector job → SDK emitDirect. Dispatched first; needs no
      // Phase B secret/baseUrl so connector delivery survives Phase 10.
      if (isConnectorEvent(j)) {
        await deliverConnectorEvent(app, job.id, j);
        return;
      }

      // Legacy Phase B / §12.1 envelope leg.
      const secret = config.ATLAS_EVENTS_HMAC_SECRET;
      const baseUrl = config.ATLAS_BASE_URL;
      if (!secret || !baseUrl) {
        app.log.warn(
          { jobId: job.id, hasSecret: !!secret, hasBaseUrl: !!baseUrl },
          'atlas-events worker: Phase B disabled mid-job — marking complete',
        );
        return;
      }

      const body = serializeJob(j);
      const signature = signOutboundPayload(body, secret);
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      const endpoint = config.ATLAS_EVENTS_ENDPOINT.startsWith('/')
        ? config.ATLAS_EVENTS_ENDPOINT
        : `/${config.ATLAS_EVENTS_ENDPOINT}`;
      const url = `${baseUrl.replace(/\/$/, '')}${endpoint}`;
      const logCtx = jobLogContext(j);

      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Atlas-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        app.log.warn(
          { err, jobId: job.id, ...logCtx },
          'atlas-events worker: network/timeout — will retry',
        );
        throw err;
      }

      const latencyMs = Date.now() - startedAt;

      if (res.ok) {
        app.log.info(
          { jobId: job.id, ...logCtx, status: res.status, latencyMs },
          'atlas-events worker: delivered',
        );
        return;
      }

      if (res.status >= 400 && res.status < 500) {
        app.log.warn(
          { jobId: job.id, ...logCtx, status: res.status, latencyMs },
          'atlas-events worker: 4xx (permanent, no retry)',
        );
        return;
      }

      throw new Error(`atlas-events ${res.status}`);
    },
    5,
  );
}
