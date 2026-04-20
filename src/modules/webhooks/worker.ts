import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { safeFetch } from '../../lib/safe-fetch';
import { QUEUE_NAMES, type WebhookDeliveryJob } from '../../queue';
import { signOutboundPayload } from './sign';

const TIMEOUT_MS = 15_000;

/**
 * BullMQ worker that delivers a webhook payload. Same retry contract as the
 * other workers: 5xx/network → throw (BullMQ retries with exponential backoff,
 * default 4 attempts), 4xx → terminal (don't retry, stamp `lastFailureReason`).
 */
export function registerWebhookWorker(app: FastifyInstance): void {
  app.queues.registerWorker<WebhookDeliveryJob>(
    QUEUE_NAMES.WEBHOOK_DELIVERY,
    async (job) => {
      const { subscriptionId, event, body } = job.data;
      const [sub] = await app.db
        .select()
        .from(schema.webhookSubscriptions)
        .where(eq(schema.webhookSubscriptions.id, subscriptionId))
        .limit(1);
      if (!sub || !sub.active) return;

      let secret: string;
      try {
        secret = decryptJSON<string>(sub.secret);
      } catch (err) {
        app.log.error({ err, subscriptionId }, 'webhook: cannot decrypt secret');
        await app.db
          .update(schema.webhookSubscriptions)
          .set({ lastFailureAt: new Date(), lastFailureReason: 'bad secret' })
          .where(eq(schema.webhookSubscriptions.id, subscriptionId));
        return;
      }

      const signature = signOutboundPayload(body, secret);

      let res: Response;
      try {
        res = await safeFetch(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Blossom-Signature': signature,
            'X-Blossom-Event': event,
            'User-Agent': 'BlossomInbox/0.1 webhook',
          },
          body,
          timeoutMs: TIMEOUT_MS,
        });
      } catch (err) {
        app.log.warn({ err, subscriptionId, url: sub.url }, 'webhook: network — will retry');
        await app.db
          .update(schema.webhookSubscriptions)
          .set({
            lastFailureAt: new Date(),
            lastFailureReason: (err as Error).message.slice(0, 200),
          })
          .where(eq(schema.webhookSubscriptions.id, subscriptionId));
        throw err;
      }

      if (res.ok) {
        await app.db
          .update(schema.webhookSubscriptions)
          .set({ lastDeliveryAt: new Date(), lastFailureAt: null, lastFailureReason: null })
          .where(eq(schema.webhookSubscriptions.id, subscriptionId));
        return;
      }

      // 4xx terminal — bad URL / auth issue on receiver side. Don't retry.
      if (res.status >= 400 && res.status < 500) {
        app.log.error(
          { subscriptionId, status: res.status, url: sub.url },
          'webhook: 4xx (permanent)',
        );
        await app.db
          .update(schema.webhookSubscriptions)
          .set({
            lastFailureAt: new Date(),
            lastFailureReason: `HTTP ${res.status}`,
          })
          .where(eq(schema.webhookSubscriptions.id, subscriptionId));
        return;
      }

      // 5xx → throw, BullMQ retries.
      await app.db
        .update(schema.webhookSubscriptions)
        .set({
          lastFailureAt: new Date(),
          lastFailureReason: `HTTP ${res.status}`,
        })
        .where(eq(schema.webhookSubscriptions.id, subscriptionId));
      throw new Error(`webhook ${res.status}`);
    },
    10,
  );
}
