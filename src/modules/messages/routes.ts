import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { canAccessConversation } from '../conversations/access';
import { deleteMessageUpstream, deleteCapabilityForChannel } from './delete-upstream';
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
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
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
    // Surface async-mirror state so the client can render a skeleton on
    // refresh without inspecting the metadata jsonb itself.
    mediaPending: meta.mediaPending === true,
    /** True when the background mirror exhausted retries — front shows a fallback. */
    mediaFailed: meta.mediaMirrorFailed === true,
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
        if (!msg) throw new Error('Failed to insert message');

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
          mediaUrl: msg.mediaUrl,
          mediaMimeType: msg.mediaMimeType,
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

      // Include sender so the front renders the agent avatar immediately on
       // optimistic insert; otherwise the row sits without sender info until
      // a page reload (the realtime event that has it is deduped on arrival).
      return reply.code(201).send({
        ...publicMessage(msg),
        sender: { name: senderRow?.name ?? null, email: req.user.email },
      });
    },
  );

  const deleteQuery = z.object({
    scope: z.enum(['me', 'everyone']).default('me'),
  });

  app.delete(
    '/api/v1/messages/:id',
    {
      preHandler: app.requireAuth,
      // Each scope=everyone delete triggers an upstream Telegram call with a
      // 15s timeout. Cap per-user to keep a misbehaving client from burning
      // the bot's rate budget on the provider.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const { scope } = deleteQuery.parse(req.query ?? {});

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

      // For scope=everyone, first try to remove the message on the customer's
      // side. If the provider refuses (out of window, unsupported), surface a
      // 400 to the agent so they can fall back to scope=me.
      if (scope === 'everyone') {
        const result = await deleteMessageUpstream(app, id);
        if (!result.ok) {
          return reply.code(400).send({ error: result.reason });
        }
      }

      const [fullMsg] = await app.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!fullMsg) return reply.notFound();

      const nextMeta = {
        ...((fullMsg.metadata as Record<string, unknown> | null) ?? {}),
        deleted: true,
        deletedScope: scope,
      };

      await app.db
        .update(schema.messages)
        .set({
          content: 'Esta mensagem foi excluída',
          contentType: 'text',
          mediaUrl: null,
          mediaMimeType: null,
          metadata: nextMeta,
        })
        .where(eq(schema.messages.id, id));

      eventBus.emitEvent({
        type: 'message.deleted',
        inboxId: msg.inboxId,
        conversationId: msg.conversationId,
        messageId: id,
      });

      return reply.code(204).send();
    },
  );

  // Lightweight capability probe — lets the UI decide whether to show the
  // "delete for everyone" option based on the channel + message age.
  app.get(
    '/api/v1/messages/:id/delete-capabilities',
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .select({
          conversationId: schema.messages.conversationId,
          createdAt: schema.messages.createdAt,
          channelType: schema.inboxes.channelType,
          senderId: schema.messages.senderId,
          senderType: schema.messages.senderType,
        })
        .from(schema.messages)
        .innerJoin(schema.inboxes, eq(schema.inboxes.id, schema.messages.inboxId))
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!row) return reply.notFound();
      if (!(await canAccessConversation(app, req.user, row.conversationId))) {
        return reply.forbidden();
      }
      const isMine = row.senderType === 'user' && row.senderId === req.user.sub;
      if (!isMine) return reply.send({ canDeleteForMe: false, canDeleteForEveryone: false });

      const cap = deleteCapabilityForChannel(row.channelType);
      const withinWindow =
        !cap.maxAgeMs || Date.now() - row.createdAt.getTime() <= cap.maxAgeMs;
      return reply.send({
        canDeleteForMe: true,
        canDeleteForEveryone: cap.supported && withinWindow,
        channelType: row.channelType,
      });
    },
  );

  // ====== POST /api/v1/messages/:id/retry ======
  // Manual retry for failed outbound messages. Auto-retry (5 attempts with
  // exponential backoff) is handled by BullMQ at enqueue time; this endpoint
  // is for the case where all attempts exhausted and the agent wants another
  // shot — typically after fixing whatever caused the failure (Twilio sender,
  // contact phone, message template, etc.).
  app.post(
    '/api/v1/messages/:id/retry',
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);

      // Step 1: load row for auth + state checks. We re-validate state inside
      // the conditional UPDATE below to defeat the race (two simultaneous
      // retries) — this select is just for the friendly error responses.
      const [msg] = await app.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!msg) return reply.notFound();
      // Auth check FIRST — don't leak existence/state of cross-tenant rows.
      if (!(await canAccessConversation(app, req.user, msg.conversationId))) {
        return reply.notFound();
      }
      if (msg.senderType !== 'user') {
        return reply.badRequest('Only outbound messages can be retried');
      }
      if (msg.deliveredAt) {
        return reply.conflict('Message was already delivered');
      }
      if (!msg.failedAt) {
        return reply.conflict('Message is not in failed state');
      }

      // Step 2: claim the retry atomically. The WHERE clause ensures only
      // one concurrent request resets the row; the loser sees rowCount=0
      // and returns 409. This is our mutex against double Twilio submission.
      const claimed = await app.db
        .update(schema.messages)
        .set({
          failedAt: null,
          failureReason: null,
          channelMsgId: null,
          deliveredAt: null,
        })
        .where(
          and(
            eq(schema.messages.id, id),
            eq(schema.messages.senderType, 'user'),
            isNotNull(schema.messages.failedAt),
            isNull(schema.messages.deliveredAt),
          ),
        )
        .returning();
      if (claimed.length === 0) {
        return reply.conflict('Another retry is already in progress or state changed');
      }

      // Tell open clients the failed bubble should clear immediately —
      // otherwise the spinner stays until the status callback fires.
      eventBus.emitEvent({
        type: 'message.updated',
        inboxId: msg.inboxId,
        conversationId: msg.conversationId,
        messageId: id,
        changes: { failedAt: null, failureReason: null, deliveredAt: null },
      });

      // Step 3: enqueue. We await so a dispatch failure (e.g. inbox missing)
      // is reported synchronously and we can roll back to a failed state —
      // otherwise the row would stay reset but with no job ever scheduled.
      try {
        await dispatchOutbound(app, msg.conversationId, id);
      } catch (err) {
        app.log.error({ err, messageId: id }, 'manual retry: dispatch failed');
        await app.db
          .update(schema.messages)
          .set({ failedAt: new Date(), failureReason: 'retry: dispatch failed' })
          .where(eq(schema.messages.id, id));
        return reply.code(500).send({ error: 'dispatch failed, retry again' });
      }

      const [updated] = await app.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!updated) throw new Error('message vanished after retry update');
      return publicMessage(updated);
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
