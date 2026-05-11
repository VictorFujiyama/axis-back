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

      const body = JSON.stringify(job.data);
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
            jobType: job.data.type,
            conversationId: job.data.conversationId,
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
            jobType: job.data.type,
            conversationId: job.data.conversationId,
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
            jobType: job.data.type,
            conversationId: job.data.conversationId,
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
