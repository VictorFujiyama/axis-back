import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { QUEUE_NAMES } from '../../queue';
import { signOutboundPayload } from '../webhooks/sign';
import type { AtlasEventJob } from './enqueue';

const TIMEOUT_MS = 5_000;

export interface AtlasEventsWorkerDeps {
  fetchImpl?: typeof fetch;
}

/**
 * BullMQ worker that POSTs an Atlas event to ${ATLAS_BASE_URL}/api/messaging/events.
 *
 * Retry contract: 2xx → success; 4xx → terminal (no retry, BullMQ marks
 * complete so the job doesn't loop on a bad payload); 5xx / network / timeout
 * → throw (BullMQ retries with exponential backoff). HMAC_SECRET unset at
 * boot returns early (feature off); unset mid-job logs warn and returns
 * (mark complete — operator turned the feature off, don't pile up retries).
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

      // Map internal camelCase + `type` to Atlas snake_case + `event_type`.
      // Extra fields (assignedUserId/Team) go into `payload` per Atlas schema.
      const j = job.data;

      // T-003: AtlasEventJob now also accepts the Phase 12 `kind`-discriminator
      // envelope. T-006 will wire the dual-shape serializer + endpoint switch;
      // until then the producers (`mapEvent` in enqueue.ts) only emit legacy
      // variants, so any `kind`-shaped job here means a future producer landed
      // before T-006. Mark complete with a warn so the queue doesn't churn.
      if ('kind' in j) {
        app.log.warn(
          { jobId: job.id, envelopeKind: j.kind, action: j.action },
          'atlas-events worker: kind-envelope variant — T-006 not yet wired, skipping',
        );
        return;
      }

      const atlasPayload: Record<string, unknown> = {
        event_type: j.type,
        occurred_at: j.occurredAt,
        conversation_id: j.conversationId,
        summary: j.summary,
      };
      if (j.type === 'message_sent') {
        atlasPayload['message_id'] = j.messageId;
      } else if (j.type === 'handoff_to_human') {
        atlasPayload['payload'] = {
          assigned_user_id: j.assignedUserId,
          assigned_team_id: j.assignedTeamId,
        };
      }
      const body = JSON.stringify(atlasPayload);
      const signature = signOutboundPayload(body, secret);
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      const url = `${baseUrl.replace(/\/$/, '')}/api/messaging/events`;

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
          {
            err,
            jobId: job.id,
            jobType: j.type,
            conversationId: j.conversationId,
          },
          'atlas-events worker: network/timeout — will retry',
        );
        throw err;
      }

      const latencyMs = Date.now() - startedAt;

      if (res.ok) {
        app.log.info(
          {
            jobId: job.id,
            jobType: j.type,
            conversationId: j.conversationId,
            status: res.status,
            latencyMs,
          },
          'atlas-events worker: delivered',
        );
        return;
      }

      if (res.status >= 400 && res.status < 500) {
        app.log.warn(
          {
            jobId: job.id,
            jobType: j.type,
            conversationId: j.conversationId,
            status: res.status,
            latencyMs,
          },
          'atlas-events worker: 4xx (permanent, no retry)',
        );
        return;
      }

      throw new Error(`atlas-events ${res.status}`);
    },
    5,
  );
}
