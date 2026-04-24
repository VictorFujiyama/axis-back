import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { canAccessConversation } from '../conversations/access';
import { eventBus } from '../../realtime/event-bus';
import { lastInboundChannelMsgId } from '../channels/email-sender';
import { QUEUE_NAMES, type EmailOutboundJob, type WhatsAppOutboundJob, type TelegramOutboundJob, type TwilioMetaOutboundJob, type ScheduledMessageJob } from '../../queue';
import { resolveMentions, createMentionNotifications } from '../notifications/helpers';

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  cursor: z.string().optional(), // ISO timestamp of last seen message
  limit: z.coerce.number().int().min(1).max(200).default(50),
  includePrivateNotes: z.coerce.boolean().default(true),
});

const sendBody = z.object({
  content: z.string().min(1).max(20_000),
  contentType: z
    .enum(['text', 'image', 'audio', 'video', 'document', 'location', 'template'])
    .default('text'),
  mediaUrl: z.string().url().optional(),
  mediaMimeType: z.string().optional(),
  isPrivateNote: z.boolean().default(false),
  replyToMessageId: z.string().uuid().optional(),
  /** ISO timestamp — when set, schedules the message for later dispatch. */
  scheduledFor: z.coerce.date().optional(),
});

type MessageRow = typeof schema.messages.$inferSelect;

function publicMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    inboxId: row.inboxId,
    senderType: row.senderType,
    senderId: row.senderId,
    content: row.content,
    contentType: row.contentType,
    mediaUrl: row.mediaUrl,
    mediaMimeType: row.mediaMimeType,
    isPrivateNote: row.isPrivateNote,
    metadata: row.metadata,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    replyToMessageId: row.replyToMessageId,
    scheduledFor: row.scheduledFor,
    createdAt: row.createdAt,
  };
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/conversations/:id/messages',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const query = listQuery.parse(req.query);

      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }

      const conditions = [eq(schema.messages.conversationId, id)];
      if (!query.includePrivateNotes) {
        conditions.push(eq(schema.messages.isPrivateNote, false));
      }
      if (query.cursor) {
        const cursorDate = new Date(query.cursor);
        if (!Number.isNaN(cursorDate.getTime())) {
          conditions.push(gt(schema.messages.createdAt, cursorDate));
        }
      }

      const rows = await app.db
        .select({
          msg: schema.messages,
          senderName: schema.users.name,
          senderEmail: schema.users.email,
        })
        .from(schema.messages)
        .leftJoin(schema.users, eq(schema.messages.senderId, schema.users.id))
        .where(and(...conditions))
        .orderBy(asc(schema.messages.createdAt))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const items = (hasMore ? rows.slice(0, query.limit) : rows).map((r) => ({
        ...publicMessage(r.msg),
        sender: r.msg.senderId ? { name: r.senderName, email: r.senderEmail } : null,
      }));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
      };
    },
  );

  app.post(
    '/api/v1/conversations/:id/messages',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = sendBody.parse(req.body);

      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }

      const [conv] = await app.db
        .select({
          id: schema.conversations.id,
          inboxId: schema.conversations.inboxId,
          status: schema.conversations.status,
          deletedAt: schema.conversations.deletedAt,
          firstResponseAt: schema.conversations.firstResponseAt,
          assignedUserId: schema.conversations.assignedUserId,
          assignedTeamId: schema.conversations.assignedTeamId,
          assignedBotId: schema.conversations.assignedBotId,
        })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id))
        .limit(1);

      if (!conv || conv.deletedAt) return reply.notFound();
      if (conv.status === 'resolved') {
        return reply.badRequest('Reabra a conversa antes de enviar mensagens');
      }

      const now = new Date();
      // Anything > 1s in the future is scheduled. Below that the latency of
      // the worker hop is higher than the "delay" itself — just dispatch now.
      const scheduled = body.scheduledFor && body.scheduledFor.getTime() > now.getTime() + 1_000;
      const result = await app.db.transaction(async (tx) => {
        const [msg] = await tx
          .insert(schema.messages)
          .values({
            conversationId: id,
            inboxId: conv.inboxId,
            senderType: 'user',
            senderId: req.user.sub,
            content: body.content,
            contentType: body.contentType,
            mediaUrl: body.mediaUrl,
            mediaMimeType: body.mediaMimeType,
            isPrivateNote: body.isPrivateNote,
            replyToMessageId: body.replyToMessageId ?? null,
            scheduledFor: scheduled ? body.scheduledFor : null,
            scheduledAt: scheduled ? now : null,
            accountId: req.user.accountId,
          })
          .returning();

        // Update conversation timestamps — only for actually-sent messages
        // (not private notes, not scheduled-for-future).
        let didAutoAssign = false;
        if (!body.isPrivateNote && !scheduled) {
          const convPatch: Record<string, unknown> = {
            lastMessageAt: now,
            updatedAt: now,
            waitingForAgentSince: null,
          };
          if (!conv.firstResponseAt) {
            convPatch.firstResponseAt = now;
          }
          // Auto-assign on reply (Chatwoot parity): the agent who sends a
          // reply into an unassigned conversation takes ownership. Skip when
          // the conversation already has an assignee (user/team/bot) to not
          // clobber explicit routing decisions.
          if (
            !conv.assignedUserId &&
            !conv.assignedTeamId &&
            !conv.assignedBotId
          ) {
            convPatch.assignedUserId = req.user.sub;
            didAutoAssign = true;
          }
          await tx
            .update(schema.conversations)
            .set(convPatch)
            .where(eq(schema.conversations.id, id));
        }

        return { msg, didAutoAssign };
      });

      const [senderRow] = await app.db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, req.user.sub))
        .limit(1);

      const msg = result!.msg;
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: conv.inboxId,
        conversationId: id,
        message: {
          id: msg.id,
          conversationId: msg.conversationId,
          inboxId: msg.inboxId,
          senderType: msg.senderType,
          senderId: msg.senderId,
          content: msg.content,
          contentType: msg.contentType,
          isPrivateNote: msg.isPrivateNote,
          createdAt: msg.createdAt,
          sender: { name: senderRow?.name ?? null, email: req.user.email },
        },
      });

      if (result!.didAutoAssign) {
        eventBus.emitEvent({
          type: 'conversation.assigned',
          inboxId: conv.inboxId,
          conversationId: id,
          assignedUserId: req.user.sub,
          assignedTeamId: null,
          assignedBotId: null,
        });
      }

      // Channel dispatch — skip if scheduled (worker dispatches later) or private note.
      if (!body.isPrivateNote && !scheduled) {
        void dispatchOutbound(app, id, msg.id).catch((err) => {
          app.log.error({ err, messageId: msg.id }, 'outbound dispatch failed');
        });
      }

      // Schedule future publish via BullMQ delayed job.
      if (scheduled) {
        const delay = Math.max(0, body.scheduledFor!.getTime() - Date.now());
        await app.queues
          .getQueue<ScheduledMessageJob>(QUEUE_NAMES.SCHEDULED_MESSAGE)
          .add(
            'publish',
            { messageId: msg.id, conversationId: id },
            { jobId: `msg-${msg.id}`, delay },
          );
      }

      // Mentions in private notes → notifications.
      if (body.isPrivateNote && !scheduled) {
        void (async () => {
          try {
            const resolved = await resolveMentions(body.content, app.db);
            if (resolved.length === 0) return;
            // Author name
            const [author] = await app.db
              .select({ name: schema.users.name })
              .from(schema.users)
              .where(eq(schema.users.id, req.user.sub))
              .limit(1);
            await createMentionNotifications(app.db, app.log, {
              mentionedUserIds: resolved.map((r) => r.userId).filter((u) => u !== req.user.sub),
              actorName: author?.name ?? req.user.email ?? 'Alguém',
              conversationId: id,
              messageId: msg.id,
              preview: body.content,
            });
          } catch (err) {
            app.log.warn({ err }, 'mentions: processing failed');
          }
        })();
      }

      // Clear autosaved draft on successful send — fire-and-forget.
      app.redis
        .del(`draft:${id}:${req.user.sub}`)
        .catch((err) => app.log.warn({ err }, 'draft: failed to clear on send'));

      return reply.code(201).send(publicMessage(msg));
    },
  );

  app.delete(
    '/api/v1/messages/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);

      const [msg] = await app.db
        .select({
          id: schema.messages.id,
          conversationId: schema.messages.conversationId,
          inboxId: schema.messages.inboxId,
          senderId: schema.messages.senderId,
          senderType: schema.messages.senderType,
        })
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);

      if (!msg) return reply.notFound();
      if (!(await canAccessConversation(app, req.user, msg.conversationId))) {
        return reply.forbidden();
      }
      if (msg.senderType !== 'user' || msg.senderId !== req.user.sub) {
        return reply.forbidden('Só é possível deletar mensagens enviadas por você');
      }

      await app.db.delete(schema.messages).where(eq(schema.messages.id, id));

      eventBus.emitEvent({
        type: 'message.deleted',
        inboxId: msg.inboxId,
        conversationId: msg.conversationId,
        messageId: id,
      });

      return reply.code(204).send();
    },
  );
}

export async function dispatchOutbound(
  app: FastifyInstance,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const [msg] = await app.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  if (!msg || msg.senderType !== 'user') return;

  const [conv] = await app.db
    .select({ contactId: schema.conversations.contactId, inboxId: schema.conversations.inboxId })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!conv) return;

  const [inbox] = await app.db
    .select()
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, conv.inboxId))
    .limit(1);
  if (!inbox) return;

  if (inbox.channelType === 'instagram' || inbox.channelType === 'messenger') {
    // Identifier was stored on the contact identity when inbound message arrived.
    const [ident] = await app.db
      .select({ identifier: schema.contactIdentities.identifier })
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.contactId, conv.contactId),
          eq(schema.contactIdentities.channel, inbox.channelType),
        ),
      )
      .limit(1);
    if (!ident?.identifier) {
      app.log.warn({ messageId, channel: inbox.channelType }, 'no channel identity on contact');
      await app.db
        .update(schema.messages)
        .set({ failedAt: new Date(), failureReason: `no ${inbox.channelType} identity` })
        .where(eq(schema.messages.id, messageId));
      return;
    }
    const queueName =
      inbox.channelType === 'instagram'
        ? QUEUE_NAMES.INSTAGRAM_OUTBOUND
        : QUEUE_NAMES.MESSENGER_OUTBOUND;
    await app.queues
      .getQueue<TwilioMetaOutboundJob>(queueName)
      .add(
        'send',
        {
          messageId,
          conversationId,
          inboxId: inbox.id,
          contactAddress: ident.identifier,
          text: msg.content ?? '',
          mediaUrl: msg.mediaUrl ?? null,
        },
        { jobId: messageId },
      );
    return;
  }
  if (inbox.channelType === 'telegram') {
    // Contact identity for Telegram is stored as the Telegram user id (string).
    const [ident] = await app.db
      .select({ identifier: schema.contactIdentities.identifier })
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.contactId, conv.contactId),
          eq(schema.contactIdentities.channel, 'telegram'),
        ),
      )
      .limit(1);
    if (!ident?.identifier) {
      app.log.warn({ messageId }, 'telegram.send: no telegram identity on contact');
      await app.db
        .update(schema.messages)
        .set({ failedAt: new Date(), failureReason: 'no telegram identity' })
        .where(eq(schema.messages.id, messageId));
      return;
    }
    await app.queues
      .getQueue<TelegramOutboundJob>(QUEUE_NAMES.TELEGRAM_OUTBOUND)
      .add(
        'send',
        {
          messageId,
          conversationId,
          inboxId: inbox.id,
          chatId: ident.identifier,
          text: msg.content ?? '',
          replyToChannelMsgId: null,
        },
        { jobId: messageId },
      );
    return;
  }
  if (inbox.channelType === 'whatsapp') {
    const [contact] = await app.db
      .select({ phone: schema.contacts.phone })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, conv.contactId))
      .limit(1);
    if (!contact?.phone) {
      app.log.warn({ messageId }, 'whatsapp.send: contact has no phone');
      await app.db
        .update(schema.messages)
        .set({ failedAt: new Date(), failureReason: 'contact has no phone' })
        .where(eq(schema.messages.id, messageId));
      return;
    }
    await app.queues
      .getQueue<WhatsAppOutboundJob>(QUEUE_NAMES.WHATSAPP_OUTBOUND)
      .add(
        'send',
        {
          messageId,
          conversationId,
          inboxId: inbox.id,
          contactPhone: contact.phone,
          text: msg.content ?? '',
          mediaUrl: msg.mediaUrl ?? null,
        },
        { jobId: messageId },
      );
    return;
  }
  if (inbox.channelType === 'email') {
    const [contact] = await app.db
      .select({ email: schema.contacts.email })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, conv.contactId))
      .limit(1);
    if (!contact?.email) {
      app.log.warn({ messageId }, 'email.send: contact has no email');
      await app.db
        .update(schema.messages)
        .set({ failedAt: new Date(), failureReason: 'contact has no email' })
        .where(eq(schema.messages.id, messageId));
      return;
    }

    const inReplyTo = await lastInboundChannelMsgId(app.db, conversationId);

    // Enqueue — worker (queue/workers.ts) reads inbox config/secrets and calls Postmark.
    // BullMQ handles retries with exponential backoff and persists across restarts.
    await app.queues
      .getQueue<EmailOutboundJob>(QUEUE_NAMES.EMAIL_OUTBOUND)
      .add(
        'send',
        {
          messageId,
          conversationId,
          inboxId: inbox.id,
          contactEmail: contact.email,
          subject: `Re: ${inbox.name}`,
          text: msg.content ?? '',
          inReplyToMessageId: inReplyTo,
        },
        { jobId: messageId },
      );
  }
  // TODO: whatsapp, telegram, etc. via channel adapters
}
