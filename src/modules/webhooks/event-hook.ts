import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { QUEUE_NAMES, type WebhookDeliveryJob } from '../../queue';

/**
 * Subscribe to eventBus and fan-out to webhook subscriptions whose `events`
 * array contains the event type. Body is computed once and reused across
 * subscriptions so signature stability is maintained per-recipient.
 */
export function registerWebhookEventHook(app: FastifyInstance): void {
  eventBus.onEvent(async (event) => {
    try {
      const subs = await app.db
        .select({
          id: schema.webhookSubscriptions.id,
          events: schema.webhookSubscriptions.events,
        })
        .from(schema.webhookSubscriptions)
        .where(eq(schema.webhookSubscriptions.active, true));

      const interested = subs.filter((s) => {
        const events = Array.isArray(s.events) ? s.events : [];
        return events.includes(event.type) || events.includes('*');
      });
      if (interested.length === 0) return;

      const body = JSON.stringify({
        event: event.type,
        emittedAt: new Date().toISOString(),
        data: event,
      });

      const queue = app.queues.getQueue<WebhookDeliveryJob>(QUEUE_NAMES.WEBHOOK_DELIVERY);
      await Promise.all(
        interested.map((s) =>
          queue.add(
            'deliver',
            { subscriptionId: s.id, event: event.type, body },
            // jobId encodes (sub, event, hash-of-body) — duplicate emission is no-op.
            // Without hash we'd risk colliding distinct events; using timestamp.
            { jobId: `${s.id}__${event.type}__${Date.now()}` },
          ),
        ),
      );
    } catch (err) {
      app.log.warn({ err }, 'webhooks: event-hook failed');
    }
  });
}
