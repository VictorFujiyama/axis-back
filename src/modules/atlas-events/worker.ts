import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { QUEUE_NAMES } from '../../queue';
import { signOutboundPayload } from '../webhooks/sign';
import type { AtlasEventJob } from './enqueue';

const TIMEOUT_MS = 5_000;

export interface AtlasEventsWorkerDeps {
  fetchImpl?: typeof fetch;
}

type Envelope = Extract<AtlasEventJob, { kind: string }>;
type LegacyJob = Exclude<AtlasEventJob, { kind: string }>;

function isEnvelope(job: AtlasEventJob): job is Envelope {
  return 'kind' in job;
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
 * BullMQ worker that POSTs an Atlas event to
 * `${ATLAS_BASE_URL}${ATLAS_EVENTS_ENDPOINT}` (Phase 12 default).
 *
 * Retry contract: 2xx → success; 4xx → terminal (no retry, BullMQ marks
 * complete so the job doesn't loop on a bad payload); 5xx / network / timeout
 * → throw (BullMQ retries with exponential backoff). HMAC_SECRET unset at
 * boot returns early (feature off); unset mid-job logs warn and returns
 * (mark complete — operator turned the feature off, don't pile up retries).
 *
 * Dual-shape serializer: Phase 12 `kind`-discriminator envelopes (T-003+)
 * serialize via {@link envelopeToWire}; legacy Phase B `type`-variants take
 * {@link legacyToWire} so in-flight jobs drain during deploy windows.
 */
export function registerAtlasEventsWorker(
  app: FastifyInstance,
  deps: AtlasEventsWorkerDeps = {},
): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET) {
    app.log.info('atlas-events worker: disabled (no HMAC secret)');
    return;
  }

  app.queues.registerWorker<AtlasEventJob>(
    QUEUE_NAMES.ATLAS_EVENTS,
    async (job) => {
      const secret = config.ATLAS_EVENTS_HMAC_SECRET;
      const baseUrl = config.ATLAS_BASE_URL;
      if (!secret || !baseUrl) {
        app.log.warn(
          { jobId: job.id, hasSecret: !!secret, hasBaseUrl: !!baseUrl },
          'atlas-events worker: feature disabled mid-job — marking complete',
        );
        return;
      }

      const j = job.data;
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
