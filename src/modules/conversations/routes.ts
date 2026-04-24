import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { canAccessConversation, userInboxIds } from './access';
import { eventBus } from '../../realtime/event-bus';
import { writeAudit } from '../../lib/audit';
import { QUEUE_NAMES, type SnoozeReopenJob } from '../../queue';
import { renderTranscript, sendTranscriptEmail } from './transcript';

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z.enum(['open', 'pending', 'resolved', 'snoozed']).optional(),
  assigned: z.enum(['me', 'unassigned', 'all']).default('all'),
  inboxId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  // Secondary filter layered over status/assigned:
  //  - 'mentions' narrows to conversations where the authenticated user has
  //    an active mention notification (private-note @mentions).
  //  - 'unattended' narrows to conversations that have never been replied to
  //    or are waiting for the first agent touch (Chatwoot parity).
  filter: z.enum(['mentions', 'unattended']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const updateBody = z.object({
  status: z.enum(['open', 'pending', 'resolved', 'snoozed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
});

const assignBody = z
  .object({
    userId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    botId: z.string().uuid().nullish(),
  })
  .refine(
    (b) =>
      [b.userId, b.teamId, b.botId].filter((v) => v !== null && v !== undefined)
        .length <= 1,
    { message: 'Provide at most one of userId, teamId, botId' },
  );

const snoozeBody = z.object({
  until: z.coerce.date(),
});

const tagsBody = z.object({ tagIds: z.array(z.string().uuid()).min(1) });

type ConversationRow = typeof schema.conversations.$inferSelect;

function publicConversation(row: ConversationRow) {
  return {
    id: row.id,
    contactId: row.contactId,
    inboxId: row.inboxId,
    assignedUserId: row.assignedUserId,
    assignedTeamId: row.assignedTeamId,
    assignedBotId: row.assignedBotId,
    status: row.status,
    priority: row.priority,
    firstResponseAt: row.firstResponseAt,
    lastMessageAt: row.lastMessageAt,
    waitingForAgentSince: row.waitingForAgentSince,
    snoozedUntil: row.snoozedUntil,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    muted: row.muted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/conversations',
    { preHandler: app.requireAuth },
    async (req) => {
      const query = listQuery.parse(req.query);
      const conditions = [isNull(schema.conversations.deletedAt), eq(schema.conversations.accountId, req.user.accountId)];

      // Inbox-level access control for agents
      if (req.user.role === 'agent') {
        const allowed = await userInboxIds(app, req.user.sub, req.user.accountId);
        if (allowed.length === 0) return { items: [], nextCursor: null };
        conditions.push(inArray(schema.conversations.inboxId, allowed));
      }

      if (query.status) conditions.push(eq(schema.conversations.status, query.status));
      if (query.inboxId) conditions.push(eq(schema.conversations.inboxId, query.inboxId));

      if (query.assigned === 'me') {
        conditions.push(eq(schema.conversations.assignedUserId, req.user.sub));
      } else if (query.assigned === 'unassigned') {
        conditions.push(isNull(schema.conversations.assignedUserId));
        conditions.push(isNull(schema.conversations.assignedTeamId));
        conditions.push(isNull(schema.conversations.assignedBotId));
      }

      if (query.cursor) {
        const cursorDate = new Date(query.cursor);
        if (!Number.isNaN(cursorDate.getTime())) {
          conditions.push(lt(schema.conversations.updatedAt, cursorDate));
        }
      }

      if (query.tagId) {
        const tagged = await app.db
          .select({ id: schema.conversationTags.conversationId })
          .from(schema.conversationTags)
          .where(eq(schema.conversationTags.tagId, query.tagId));
        if (tagged.length === 0) return { items: [], nextCursor: null };
        conditions.push(
          inArray(
            schema.conversations.id,
            tagged.map((t) => t.id),
          ),
        );
      }

      if (query.filter === 'mentions') {
        const mentioned = await app.db
          .select({ id: schema.notifications.conversationId })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, req.user.sub),
              eq(schema.notifications.type, 'mention'),
              isNull(schema.notifications.readAt),
            ),
          );
        const ids = mentioned
          .map((m) => m.id)
          .filter((id): id is string => id !== null);
        if (ids.length === 0) return { items: [], nextCursor: null };
        conditions.push(inArray(schema.conversations.id, ids));
      } else if (query.filter === 'unattended') {
        // Chatwoot parity: a conversation is "unattended" when no agent has
        // ever replied (firstResponseAt IS NULL) OR the customer has sent
        // something and we haven't caught up yet (waitingForAgentSince set).
        conditions.push(
          or(
            isNull(schema.conversations.firstResponseAt),
            isNotNull(schema.conversations.waitingForAgentSince),
          )!,
        );
      }

      const rows = await app.db
        .select({
          conv: schema.conversations,
          lastMessageContent: sql<string | null>`(
            SELECT content FROM messages
            WHERE messages.conversation_id = conversations.id
              AND messages.sender_type != 'system'
            ORDER BY messages.created_at DESC
            LIMIT 1
          )`.as('last_message_content'),
          lastMessageIsNote: sql<boolean>`(
            SELECT is_private_note FROM messages
            WHERE messages.conversation_id = conversations.id
              AND messages.sender_type != 'system'
            ORDER BY messages.created_at DESC
            LIMIT 1
          )`.as('last_message_is_note'),
          lastMessageSenderType: sql<string | null>`(
            SELECT sender_type FROM messages
            WHERE messages.conversation_id = conversations.id
              AND messages.sender_type != 'system'
            ORDER BY messages.created_at DESC
            LIMIT 1
          )`.as('last_message_sender_type'),
        })
        .from(schema.conversations)
        .where(and(...conditions))
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const convIds = page.map((r) => r.conv.id);

      // Batch-fetch tags for all conversations in one query
      const tagRows = convIds.length > 0
        ? await app.db
            .select({
              conversationId: schema.conversationTags.conversationId,
              id: schema.tags.id,
              name: schema.tags.name,
              color: schema.tags.color,
            })
            .from(schema.conversationTags)
            .innerJoin(schema.tags, eq(schema.tags.id, schema.conversationTags.tagId))
            .where(inArray(schema.conversationTags.conversationId, convIds))
        : [];

      const tagsByConv: Record<string, { id: string; name: string; color: string }[]> = {};
      for (const t of tagRows) {
        (tagsByConv[t.conversationId] ??= []).push({ id: t.id, name: t.name, color: t.color });
      }

      // Batch-fetch unread counts (inbound messages with read_at IS NULL)
      const unreadByConv: Record<string, number> = {};
      if (convIds.length > 0) {
        const unreadRows = await app.db.execute<{ conversation_id: string; cnt: string }>(sql`
          select conversation_id, count(*)::text as cnt
          from messages
          where conversation_id in (${sql.join(convIds.map((c) => sql`${c}`), sql`, `)})
            and sender_type = 'contact'
            and read_at is null
          group by conversation_id
        `);
        for (const row of unreadRows as unknown as Array<{ conversation_id: string; cnt: string }>) {
          unreadByConv[row.conversation_id] = Number(row.cnt);
        }
      }

      const items = page.map((r) => ({
        ...publicConversation(r.conv),
        lastMessageContent: r.lastMessageContent,
        lastMessageIsNote: !!r.lastMessageIsNote,
        lastMessageSenderType: r.lastMessageSenderType ?? null,
        tags: tagsByConv[r.conv.id] ?? [],
        unreadCount: unreadByConv[r.conv.id] ?? 0,
      }));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? last.updatedAt.toISOString() : null,
      };
    },
  );

  // Cheap SQL COUNT per tab so the inbox UI can show accurate badges without
  // paging through all conversations. Respects inbox access for agents.
  app.get(
    '/api/v1/conversations/counts',
    { preHandler: app.requireAuth },
    async (req) => {
      const countsQuery = z.object({
        status: z.enum(['open', 'pending', 'resolved', 'snoozed']).optional(),
        inboxId: z.string().uuid().optional(),
        tagId: z.string().uuid().optional(),
        filter: z.enum(['mentions', 'unattended']).optional(),
      });
      const query = countsQuery.parse(req.query);
      const base = [isNull(schema.conversations.deletedAt), eq(schema.conversations.accountId, req.user.accountId)];
      if (req.user.role === 'agent') {
        const allowed = await userInboxIds(app, req.user.sub, req.user.accountId);
        if (allowed.length === 0) return { mine: 0, unassigned: 0, all: 0 };
        base.push(inArray(schema.conversations.inboxId, allowed));
      }
      if (query.status) base.push(eq(schema.conversations.status, query.status));
      if (query.inboxId) base.push(eq(schema.conversations.inboxId, query.inboxId));
      if (query.tagId) {
        const tagged = await app.db
          .select({ id: schema.conversationTags.conversationId })
          .from(schema.conversationTags)
          .where(eq(schema.conversationTags.tagId, query.tagId));
        if (tagged.length === 0) return { mine: 0, unassigned: 0, all: 0 };
        base.push(inArray(schema.conversations.id, tagged.map((t) => t.id)));
      }
      if (query.filter === 'mentions') {
        const mentioned = await app.db
          .select({ id: schema.notifications.conversationId })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, req.user.sub),
              eq(schema.notifications.type, 'mention'),
              isNull(schema.notifications.readAt),
            ),
          );
        const ids = mentioned
          .map((m) => m.id)
          .filter((id): id is string => id !== null);
        if (ids.length === 0) return { mine: 0, unassigned: 0, all: 0 };
        base.push(inArray(schema.conversations.id, ids));
      } else if (query.filter === 'unattended') {
        base.push(
          or(
            isNull(schema.conversations.firstResponseAt),
            isNotNull(schema.conversations.waitingForAgentSince),
          )!,
        );
      }

      const runCount = async (extra: ReturnType<typeof and>[]) => {
        const [row] = await app.db
          .select({ c: count() })
          .from(schema.conversations)
          .where(and(...base, ...extra));
        return row?.c ?? 0;
      };

      const [mine, unassigned, all] = await Promise.all([
        runCount([eq(schema.conversations.assignedUserId, req.user.sub)]),
        runCount([
          isNull(schema.conversations.assignedUserId),
          isNull(schema.conversations.assignedTeamId),
          isNull(schema.conversations.assignedBotId),
        ]),
        runCount([]),
      ]);
      return { mine, unassigned, all };
    },
  );

  app.get(
    '/api/v1/conversations/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden('No access to this conversation');
      }
      const [conv] = await app.db
        .select()
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId), isNull(schema.conversations.deletedAt)))
        .limit(1);
      if (!conv) return reply.notFound();

      const tags = await app.db
        .select({
          id: schema.tags.id,
          name: schema.tags.name,
          color: schema.tags.color,
        })
        .from(schema.conversationTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.conversationTags.tagId))
        .where(eq(schema.conversationTags.conversationId, id));

      return { ...publicConversation(conv), tags };
    },
  );

  app.patch(
    '/api/v1/conversations/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.status) {
        patch.status = body.status;
        if (body.status === 'resolved') {
          patch.resolvedAt = new Date();
          patch.resolvedBy = req.user.sub;
        } else {
          patch.resolvedAt = null;
          patch.resolvedBy = null;
        }
      }
      if (body.priority) patch.priority = body.priority;
      const [conv] = await app.db
        .update(schema.conversations)
        .set(patch)
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .returning();
      if (!conv) return reply.notFound();
      eventBus.emitEvent({
        type: 'conversation.updated',
        inboxId: conv.inboxId,
        conversationId: conv.id,
        changes: { status: conv.status, priority: conv.priority },
      });
      return publicConversation(conv);
    },
  );

  app.post(
    '/api/v1/conversations/:id/assign',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = assignBody.parse(req.body);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }

      // Validate that the assignee (user/bot) belongs to the same inbox.
      const [conv] = await app.db
        .select({ id: schema.conversations.id, inboxId: schema.conversations.inboxId })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id))
        .limit(1);
      if (!conv) return reply.notFound();

      if (body.userId) {
        const [m] = await app.db
          .select({ userId: schema.inboxMembers.userId })
          .from(schema.inboxMembers)
          .where(
            and(
              eq(schema.inboxMembers.inboxId, conv.inboxId),
              eq(schema.inboxMembers.userId, body.userId),
            ),
          )
          .limit(1);
        if (!m) return reply.badRequest('User is not a member of this inbox');
      }
      if (body.botId) {
        const [b] = await app.db
          .select({ id: schema.bots.id })
          .from(schema.bots)
          .where(and(eq(schema.bots.id, body.botId), eq(schema.bots.inboxId, conv.inboxId)))
          .limit(1);
        if (!b) return reply.badRequest('Bot does not belong to this inbox');
      }

      const [updated] = await app.db
        .update(schema.conversations)
        .set({
          assignedUserId: body.userId ?? null,
          assignedTeamId: body.teamId ?? null,
          assignedBotId: body.botId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.conversations.id, id))
        .returning();
      eventBus.emitEvent({
        type: 'conversation.assigned',
        inboxId: updated!.inboxId,
        conversationId: updated!.id,
        assignedUserId: updated!.assignedUserId,
        assignedTeamId: updated!.assignedTeamId,
        assignedBotId: updated!.assignedBotId,
      });
      void writeAudit(
        req,
        {
          action: 'conversation.assigned',
          entityType: 'conversation',
          entityId: updated!.id,
          changes: {
            userId: updated!.assignedUserId,
            teamId: updated!.assignedTeamId,
            botId: updated!.assignedBotId,
          },
        },
        { db: app.db, log: app.log },
      );
      return publicConversation(updated!);
    },
  );

  app.post(
    '/api/v1/conversations/:id/resolve',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const [conv] = await app.db
        .update(schema.conversations)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: req.user.sub,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .returning();
      if (!conv) return reply.notFound();
      eventBus.emitEvent({
        type: 'conversation.resolved',
        inboxId: conv.inboxId,
        conversationId: conv.id,
        resolvedBy: conv.resolvedBy,
      });
      void writeAudit(
        req,
        { action: 'conversation.resolved', entityType: 'conversation', entityId: conv.id },
        { db: app.db, log: app.log },
      );
      // Enqueue CSAT prompt (delayed 1min).
      const csatEnabled =
        (conv.assignedUserId || conv.resolvedBy) &&
        ((await app.db
          .select({ config: schema.inboxes.config })
          .from(schema.inboxes)
          .where(eq(schema.inboxes.id, conv.inboxId))
          .limit(1))[0]?.config as { csat?: { enabled?: boolean } } | null)?.csat?.enabled;
      if (csatEnabled) {
        void (await import('../channels/post-ingest'))
          .enqueueCsatPrompt(app, conv.id)
          .catch((err) => app.log.warn({ err, conversationId: conv.id }, 'CSAT enqueue failed'));
      }
      return publicConversation(conv);
    },
  );

  app.post(
    '/api/v1/conversations/:id/reopen',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const [conv] = await app.db
        .update(schema.conversations)
        .set({
          status: 'open',
          resolvedAt: null,
          resolvedBy: null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .returning();
      if (!conv) return reply.notFound();
      eventBus.emitEvent({
        type: 'conversation.reopened',
        inboxId: conv.inboxId,
        conversationId: conv.id,
      });
      void writeAudit(
        req,
        { action: 'conversation.reopened', entityType: 'conversation', entityId: conv.id },
        { db: app.db, log: app.log },
      );
      return publicConversation(conv);
    },
  );

  app.post(
    '/api/v1/conversations/:id/snooze',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = snoozeBody.parse(req.body);
      if (body.until.getTime() <= Date.now()) {
        return reply.badRequest('snooze "until" must be in the future');
      }
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const [conv] = await app.db
        .update(schema.conversations)
        .set({
          status: 'snoozed',
          snoozedUntil: body.until,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .returning();
      if (!conv) return reply.notFound();

      // Schedule auto-reopen via BullMQ delayed job. jobId is deterministic per
      // (conv, until) — re-snooze to same time is a no-op; different time →
      // new job. Worker verifies `scheduledFor` to ignore stale firings.
      const delay = Math.max(0, body.until.getTime() - Date.now());
      await app.queues
        .getQueue<SnoozeReopenJob>(QUEUE_NAMES.SNOOZE_REOPEN)
        .add(
          'reopen',
          { conversationId: id, scheduledFor: body.until.getTime() },
          { jobId: `${id}__${body.until.getTime()}`, delay },
        );

      return publicConversation(conv);
    },
  );

  // Mark inbound messages as read
  app.post(
    '/api/v1/conversations/:id/read',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      await app.db
        .update(schema.messages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(schema.messages.conversationId, id),
            eq(schema.messages.senderType, 'contact'),
            isNull(schema.messages.readAt),
          ),
        );
      return reply.code(204).send();
    },
  );

  // Separate from /read: fired when the agent LEAVES a conversation. Clears
  // this user's active mention notification so the Menções sidebar drops the
  // row — but not so eagerly that the agent loses access while they're still
  // reading it.
  app.post(
    '/api/v1/conversations/:id/read-mention',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      await app.db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(schema.notifications.userId, req.user.sub),
            eq(schema.notifications.conversationId, id),
            eq(schema.notifications.type, 'mention'),
            isNull(schema.notifications.readAt),
          ),
        );
      return reply.code(204).send();
    },
  );

  // Tag management
  app.post(
    '/api/v1/conversations/:id/tags',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = tagsBody.parse(req.body);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      await app.db
        .insert(schema.conversationTags)
        .values(body.tagIds.map((tagId) => ({ conversationId: id, tagId })))
        .onConflictDoNothing();
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/conversations/:id/tags/:tagId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), tagId: z.string().uuid() })
        .parse(req.params);
      if (!(await canAccessConversation(app, req.user, params.id))) {
        return reply.forbidden();
      }
      await app.db
        .delete(schema.conversationTags)
        .where(
          and(
            eq(schema.conversationTags.conversationId, params.id),
            eq(schema.conversationTags.tagId, params.tagId),
          ),
        );
      return reply.code(204).send();
    },
  );

  // Mute / unmute. Mirrors Chatwoot's "Block Contact" / "Unblock Contact"
  // menu item: toggles conversation.muted, creates a system message, emits
  // a realtime event so other clients refresh. Does NOT resolve — that
  // behaviour from Chatwoot was an incidental side-effect of agent flow.
  async function writeMuteSystemMessage(
    inboxId: string,
    conversationId: string,
    agentName: string,
    muted: boolean,
  ): Promise<void> {
    const content = muted
      ? `${agentName} silenciou a conversa`
      : `${agentName} reativou os alertas da conversa`;
    const [msg] = await app.db
      .insert(schema.messages)
      .values({
        conversationId,
        inboxId,
        senderType: 'system',
        content,
        contentType: 'text',
      })
      .returning();
    if (!msg) return;
    eventBus.emitEvent({
      type: 'message.created',
      inboxId,
      conversationId,
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
      },
    });
  }

  app.post(
    '/api/v1/conversations/:id/mute',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const [conv] = await app.db
        .update(schema.conversations)
        .set({ muted: true, updatedAt: new Date() })
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .returning();
      if (!conv) return reply.notFound();
      const [actor] = await app.db
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, req.user.sub))
        .limit(1);
      const agentName = actor?.name ?? actor?.email ?? req.user.email ?? 'Atendente';
      await writeMuteSystemMessage(conv.inboxId, conv.id, agentName, true);
      eventBus.emitEvent({
        type: 'conversation.updated',
        inboxId: conv.inboxId,
        conversationId: conv.id,
        changes: { updatedAt: conv.updatedAt },
      });
      void writeAudit(
        req,
        { action: 'conversation.muted', entityType: 'conversation', entityId: conv.id },
        { db: app.db, log: app.log },
      );
      return publicConversation(conv);
    },
  );

  app.post(
    '/api/v1/conversations/:id/unmute',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const [conv] = await app.db
        .update(schema.conversations)
        .set({ muted: false, updatedAt: new Date() })
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .returning();
      if (!conv) return reply.notFound();
      const [actor] = await app.db
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, req.user.sub))
        .limit(1);
      const agentName = actor?.name ?? actor?.email ?? req.user.email ?? 'Atendente';
      await writeMuteSystemMessage(conv.inboxId, conv.id, agentName, false);
      eventBus.emitEvent({
        type: 'conversation.updated',
        inboxId: conv.inboxId,
        conversationId: conv.id,
        changes: { updatedAt: conv.updatedAt },
      });
      void writeAudit(
        req,
        { action: 'conversation.unmuted', entityType: 'conversation', entityId: conv.id },
        { db: app.db, log: app.log },
      );
      return publicConversation(conv);
    },
  );

  app.post(
    '/api/v1/conversations/:id/transcript',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = z.object({ email: z.string().email() }).parse(req.body);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const [conv] = await app.db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id))
        .limit(1);
      if (!conv) return reply.notFound();

      const [contactRow] = await app.db
        .select({ name: schema.contacts.name, email: schema.contacts.email, phone: schema.contacts.phone })
        .from(schema.contacts)
        .where(eq(schema.contacts.id, conv.contactId))
        .limit(1);
      const contactName =
        contactRow?.name ?? contactRow?.email ?? contactRow?.phone ?? 'Contato';

      const messages = await app.db
        .select({
          senderType: schema.messages.senderType,
          senderId: schema.messages.senderId,
          content: schema.messages.content,
          createdAt: schema.messages.createdAt,
          isPrivateNote: schema.messages.isPrivateNote,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, id))
        .orderBy(asc(schema.messages.createdAt));

      // Resolve user names for sender labels (batched to one query).
      const userIds = Array.from(
        new Set(
          messages
            .filter((m) => m.senderType === 'user' && m.senderId)
            .map((m) => m.senderId as string),
        ),
      );
      const userNameById: Record<string, string> = {};
      if (userIds.length > 0) {
        const users = await app.db
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds));
        for (const u of users) userNameById[u.id] = u.name ?? u.email ?? 'Atendente';
      }

      const rendered = renderTranscript({
        contactName,
        messages: messages.map((m) => ({
          senderType: m.senderType,
          senderName:
            m.senderType === 'contact'
              ? contactName
              : m.senderType === 'user' && m.senderId
                ? userNameById[m.senderId] ?? 'Atendente'
                : m.senderType === 'system'
                  ? 'Sistema'
                  : m.senderType === 'bot'
                    ? 'Bot'
                    : 'Desconhecido',
          content: m.content,
          createdAt: m.createdAt,
          isPrivateNote: m.isPrivateNote,
        })),
      });

      try {
        await sendTranscriptEmail(
          {
            to: body.email,
            subject: `Transcrição da conversa com ${contactName}`,
            html: rendered.html,
            text: rendered.text,
          },
          app.log,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Falha ao enviar';
        if (message.startsWith('SMTP not configured')) {
          return reply.code(503).send({ error: 'smtp_not_configured', message });
        }
        app.log.error({ err }, 'transcript email failed');
        return reply.code(502).send({ error: 'email_failed', message });
      }
      void writeAudit(
        req,
        {
          action: 'conversation.transcript_sent',
          entityType: 'conversation',
          entityId: conv.id,
          changes: { to: body.email },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );

}
