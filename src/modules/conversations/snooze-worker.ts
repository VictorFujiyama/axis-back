import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';
import { QUEUE_NAMES, type SnoozeReopenJob } from '../../queue';

/**
 * Reopen a snoozed conversation when its timer fires — if and only if the
 * conversation is STILL snoozed with the same snoozedUntil. Any human action
 * (re-snooze, manual reopen, resolve) changes those fields, and our `scheduledFor`
 * check makes the job a no-op. Idempotent by design.
 */
export function registerSnoozeWorker(app: FastifyInstance): void {
  app.queues.registerWorker<SnoozeReopenJob>(
    QUEUE_NAMES.SNOOZE_REOPEN,
    async (job) => {
      const { conversationId, scheduledFor } = job.data;
      const [conv] = await app.db
        .select({
          id: schema.conversations.id,
          status: schema.conversations.status,
          snoozedUntil: schema.conversations.snoozedUntil,
          inboxId: schema.conversations.inboxId,
        })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversationId))
        .limit(1);
      if (!conv) return;
      if (conv.status !== 'snoozed') return;
      if (!conv.snoozedUntil) return;
      if (conv.snoozedUntil.getTime() !== scheduledFor) {
        // User re-snoozed to a different time; a later job will fire for that.
        return;
      }
      const now = new Date();
      await app.db
        .update(schema.conversations)
        .set({
          status: 'pending',
          snoozedUntil: null,
          waitingForAgentSince: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.conversations.id, conversationId),
            eq(schema.conversations.status, 'snoozed'),
          ),
        );
      eventBus.emitEvent({
        type: 'conversation.updated',
        inboxId: conv.inboxId,
        conversationId,
        changes: {
          status: 'pending',
          snoozedUntil: null,
          waitingForAgentSince: now,
        } as Record<string, unknown>,
      });
      app.log.info({ conversationId }, 'snooze-reopen: conversation reopened');
    },
    10,
  );
}
