import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';
import { QUEUE_NAMES, type ScheduledMessageJob } from '../../queue';

/**
 * Publishes a message that was staged with scheduledFor in the future.
 * Idempotent: checks scheduledFor still set before dispatching.
 */
export function registerScheduledMessageWorker(
  app: FastifyInstance,
  dispatchOutbound: (
    app: FastifyInstance,
    conversationId: string,
    messageId: string,
  ) => Promise<void>,
): void {
  app.queues.registerWorker<ScheduledMessageJob>(
    QUEUE_NAMES.SCHEDULED_MESSAGE,
    async (job) => {
      const { messageId, conversationId } = job.data;
      const [msg] = await app.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId))
        .limit(1);
      if (!msg || !msg.scheduledFor) return; // already published or cancelled

      // If this is a CSAT prompt (system sender) and the conversation has been
      // reopened since it was scheduled, drop silently — sending "como foi seu
      // atendimento?" mid-active-conversation is confusing UX.
      if (msg.senderType === 'system') {
        const [conv] = await app.db
          .select({ status: schema.conversations.status })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, conversationId))
          .limit(1);
        if (conv && conv.status !== 'resolved') {
          await app.db
            .update(schema.messages)
            .set({ scheduledFor: null, failedAt: new Date(), failureReason: 'cancelled by reopen' })
            .where(eq(schema.messages.id, messageId));
          return;
        }
      }

      const now = new Date();

      // Clear scheduledFor and update conversation timestamps atomically.
      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.messages)
          .set({ scheduledFor: null })
          .where(eq(schema.messages.id, messageId));

        const [conv] = await tx
          .select({ firstResponseAt: schema.conversations.firstResponseAt })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, conversationId))
          .limit(1);
        const convPatch: Record<string, unknown> = {
          lastMessageAt: now,
          updatedAt: now,
          waitingForAgentSince: null,
        };
        if (conv && !conv.firstResponseAt) convPatch.firstResponseAt = now;
        await tx
          .update(schema.conversations)
          .set(convPatch)
          .where(eq(schema.conversations.id, conversationId));
      });

      eventBus.emitEvent({
        type: 'message.created',
        inboxId: msg.inboxId,
        conversationId,
        message: {
          id: msg.id,
          conversationId: msg.conversationId,
          inboxId: msg.inboxId,
          senderType: msg.senderType,
          senderId: msg.senderId,
          content: msg.content,
          contentType: msg.contentType,
          mediaUrl: msg.mediaUrl,
          mediaMimeType: msg.mediaMimeType,
          isPrivateNote: msg.isPrivateNote,
          createdAt: now,
        },
      });

      if (msg.contentType === 'text' && !msg.isPrivateNote) {
        await dispatchOutbound(app, conversationId, messageId);
      }
    },
    5,
  );
}
