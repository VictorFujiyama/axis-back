import { and, asc, desc, eq, gte, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';
import { getOrCreateAtlasBotUser } from './atlas-bot';

/**
 * MCP tool handlers exposed under `messaging.*`.
 *
 * Read tools (T-013): take `db` + parsed input, pure functions. The SDK
 * validates input against the exported zod schemas before invocation so
 * handlers can trust the shape (L-419 passthrough).
 *
 * Write tools (T-021): take `(db, app, input, ctx)`. They need `app` for
 * queues (CSAT) and to keep a uniform signature across the trio. The `ctx`
 * carries the Atlas requester binding (`atlasAppUserId` + `atlasOrgId`) for
 * two purposes: (1) gate the call through `atlas_user_links` so only mapped
 * Atlas users can mutate, (2) ride along on emitted events as `meta` so the
 * atlas-events listener can stamp `actors[].app_user_id` on the Phase 12
 * §12.1 envelope (L-403 + L-409).
 *
 * V1 read tools are NOT account-scoped: the inbound HMAC gates trust
 * (L-408) and Atlas-side decides which org sees what via `viewable_by` on
 * the indexed envelopes (L-405). Write tools reintroduce scoping via
 * `atlas_user_links` because they mutate state.
 */

export type MessagingToolErrorCode = 'not_found' | 'forbidden' | 'bad_request';

export class MessagingToolError extends Error {
  readonly code: MessagingToolErrorCode;
  constructor(code: MessagingToolErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MessagingToolError';
  }
}

export interface AtlasRequestContext {
  atlasAppUserId: string;
  atlasOrgId: string;
}

const uuid = z.string().uuid();

const conversationStatusSchema = z.enum(['open', 'pending', 'resolved', 'snoozed']);

// Raw-SQL handle to the generated tsvector column. The ORM does not model
// generated columns, so the search handler references the column directly
// (mirrors `axis-back/src/modules/search/routes.ts:18` precedent).
const msgSearchVector = sql.raw('messages.search_vector');

// ──────────────────────────────────────────────────────────────────────────────
// messaging.get_thread
// ──────────────────────────────────────────────────────────────────────────────

export const getThreadInputSchema = z.object({ id: uuid });
export type GetThreadInput = z.infer<typeof getThreadInputSchema>;

export interface ThreadConversation {
  id: string;
  accountId: string | null;
  inboxId: string;
  contactId: string;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  assignedBotId: string | null;
  status: 'open' | 'pending' | 'resolved' | 'snoozed';
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadMessage {
  id: string;
  senderType: 'contact' | 'user' | 'bot' | 'system';
  senderId: string | null;
  content: string | null;
  contentType: string;
  isPrivateNote: boolean;
  createdAt: Date;
}

export interface ThreadResult {
  conversation: ThreadConversation;
  messages: ThreadMessage[];
}

const MAX_MESSAGES_PER_THREAD = 50;

export async function getThreadHandler(
  db: DB,
  input: GetThreadInput,
): Promise<ThreadResult> {
  const [conversation] = await db
    .select({
      id: schema.conversations.id,
      accountId: schema.conversations.accountId,
      inboxId: schema.conversations.inboxId,
      contactId: schema.conversations.contactId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
      assignedBotId: schema.conversations.assignedBotId,
      status: schema.conversations.status,
      createdAt: schema.conversations.createdAt,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.id, input.id), isNull(schema.conversations.deletedAt)),
    )
    .limit(1);

  if (!conversation) {
    throw new MessagingToolError('not_found', `conversation ${input.id} not found`);
  }

  const messages = await db
    .select({
      id: schema.messages.id,
      senderType: schema.messages.senderType,
      senderId: schema.messages.senderId,
      content: schema.messages.content,
      contentType: schema.messages.contentType,
      isPrivateNote: schema.messages.isPrivateNote,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversation.id))
    .orderBy(asc(schema.messages.createdAt))
    .limit(MAX_MESSAGES_PER_THREAD);

  return { conversation, messages };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.list_threads
// ──────────────────────────────────────────────────────────────────────────────

export const listThreadsInputSchema = z.object({
  inboxId: uuid.optional(),
  status: conversationStatusSchema.optional(),
  // Single-user filter — maps to `conversations.assigned_user_id`. Team-scoped
  // listing is deferred to D.4 (no Atlas use case yet per Phase 12 §12.10).
  assignee: uuid.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListThreadsInput = z.infer<typeof listThreadsInputSchema>;

export interface ListThreadsResult {
  conversations: ThreadConversation[];
}

export async function listThreadsHandler(
  db: DB,
  input: ListThreadsInput,
): Promise<ListThreadsResult> {
  const conditions: SQL[] = [isNull(schema.conversations.deletedAt)];
  if (input.inboxId) conditions.push(eq(schema.conversations.inboxId, input.inboxId));
  if (input.status) conditions.push(eq(schema.conversations.status, input.status));
  if (input.assignee) {
    conditions.push(eq(schema.conversations.assignedUserId, input.assignee));
  }
  if (input.since) {
    conditions.push(gte(schema.conversations.updatedAt, new Date(input.since)));
  }

  const rows = await db
    .select({
      id: schema.conversations.id,
      accountId: schema.conversations.accountId,
      inboxId: schema.conversations.inboxId,
      contactId: schema.conversations.contactId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
      assignedBotId: schema.conversations.assignedBotId,
      status: schema.conversations.status,
      createdAt: schema.conversations.createdAt,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(and(...conditions))
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(input.limit);

  return { conversations: rows };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.search
// ──────────────────────────────────────────────────────────────────────────────

export const searchInputSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

export interface SearchHit {
  messageId: string;
  conversationId: string;
  inboxId: string;
  senderType: 'contact' | 'user' | 'bot' | 'system';
  content: string | null;
  createdAt: Date;
}

export interface SearchResult {
  hits: SearchHit[];
}

export async function searchHandler(db: DB, input: SearchInput): Promise<SearchResult> {
  const tsquery = sql`websearch_to_tsquery('simple', ${input.query})`;
  const rows = await db
    .select({
      messageId: schema.messages.id,
      conversationId: schema.messages.conversationId,
      inboxId: schema.messages.inboxId,
      senderType: schema.messages.senderType,
      content: schema.messages.content,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(sql`${msgSearchVector} @@ ${tsquery}`)
    .orderBy(
      desc(sql`ts_rank(${msgSearchVector}, ${tsquery})`),
      desc(schema.messages.createdAt),
    )
    .limit(input.limit);

  return { hits: rows };
}

// ──────────────────────────────────────────────────────────────────────────────
// Write-tool shared helpers (T-021)
// ──────────────────────────────────────────────────────────────────────────────

interface ConversationScope {
  id: string;
  inboxId: string;
  accountId: string;
  contactId: string;
  status: 'open' | 'pending' | 'resolved' | 'snoozed';
  assignedUserId: string | null;
  assignedTeamId: string | null;
  assignedBotId: string | null;
}

async function loadConversationScope(
  db: DB,
  conversationId: string,
): Promise<ConversationScope> {
  const [row] = await db
    .select({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      contactId: schema.conversations.contactId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
      assignedBotId: schema.conversations.assignedBotId,
      status: schema.conversations.status,
      deletedAt: schema.conversations.deletedAt,
      accountId: schema.inboxes.accountId,
    })
    .from(schema.conversations)
    .innerJoin(schema.inboxes, eq(schema.inboxes.id, schema.conversations.inboxId))
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);

  if (!row || row.deletedAt) {
    throw new MessagingToolError('not_found', `conversation ${conversationId} not found`);
  }
  if (!row.accountId) {
    // Inbox without an account is unreachable in practice — Phase 0 backfilled
    // every inbox. Refuse rather than write under an unbound scope.
    throw new MessagingToolError('forbidden', 'conversation inbox has no account');
  }
  return {
    id: row.id,
    inboxId: row.inboxId,
    accountId: row.accountId,
    contactId: row.contactId,
    status: row.status,
    assignedUserId: row.assignedUserId,
    assignedTeamId: row.assignedTeamId,
    assignedBotId: row.assignedBotId,
  };
}

async function requireAtlasUserLink(
  db: DB,
  accountId: string,
  ctx: AtlasRequestContext,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.atlasUserLinks.id })
    .from(schema.atlasUserLinks)
    .where(
      and(
        eq(schema.atlasUserLinks.accountId, accountId),
        eq(schema.atlasUserLinks.atlasOrgId, ctx.atlasOrgId),
        eq(schema.atlasUserLinks.atlasAppUserId, ctx.atlasAppUserId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new MessagingToolError(
      'forbidden',
      'no atlas_user_link for this Atlas user in this account',
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.send_message
// ──────────────────────────────────────────────────────────────────────────────

export const sendMessageInputSchema = z.object({
  conversationId: uuid,
  content: z.string().min(1).max(20_000),
  contentType: z
    .enum(['text', 'image', 'audio', 'video', 'document', 'location', 'template'])
    .default('text'),
  isPrivateNote: z.boolean().default(false),
});
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export interface SendMessageResult {
  messageId: string;
}

export async function sendMessageHandler(
  db: DB,
  _app: FastifyInstance,
  input: SendMessageInput,
  ctx: AtlasRequestContext,
): Promise<SendMessageResult> {
  const conv = await loadConversationScope(db, input.conversationId);
  if (conv.status === 'resolved') {
    throw new MessagingToolError(
      'bad_request',
      'conversation is resolved — reopen before sending',
    );
  }
  await requireAtlasUserLink(db, conv.accountId, ctx);
  const bot = await getOrCreateAtlasBotUser(db, conv.accountId);

  const now = new Date();
  const [msg] = await db
    .insert(schema.messages)
    .values({
      conversationId: conv.id,
      inboxId: conv.inboxId,
      accountId: conv.accountId,
      senderType: 'bot',
      senderId: bot.id,
      content: input.content,
      contentType: input.contentType,
      isPrivateNote: input.isPrivateNote,
    })
    .returning();
  if (!msg) throw new Error('send_message: failed to insert message');

  // Mirror the conversation-timestamp update from `messages/routes.ts` so the
  // inbox UI surfaces the new bot reply at the top. Skip for private notes
  // (Chatwoot parity — internal notes do not bump the conversation).
  if (!input.isPrivateNote) {
    await db
      .update(schema.conversations)
      .set({ lastMessageAt: now, updatedAt: now, waitingForAgentSince: null })
      .where(eq(schema.conversations.id, conv.id));
  }

  // Outbound channel dispatch happens in `bots/outbound-hook.ts`, which
  // subscribes to `message.created` with senderType==='bot' and enqueues the
  // right channel job (L-414). The `meta` field carries the Atlas requester
  // binding so the atlas-events listener can stamp `actors[].app_user_id`.
  eventBus.emitEvent({
    type: 'message.created',
    inboxId: conv.inboxId,
    conversationId: conv.id,
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
      sender: { name: bot.name, email: bot.email },
    },
    meta: { atlasAppUserId: ctx.atlasAppUserId, atlasOrgId: ctx.atlasOrgId },
  });

  return { messageId: msg.id };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.assign
// ──────────────────────────────────────────────────────────────────────────────

// Split into a raw ZodObject + a refined ZodEffects so the MCP SDK can
// register the raw shape (`assignInputObjectSchema.shape`) while runtime
// validation still enforces the "at least one of userId/teamId" rule via
// `assignInputSchema.parse()` at the server.ts wrapper.
export const assignInputObjectSchema = z.object({
  conversationId: uuid,
  userId: uuid.nullable().optional(),
  teamId: uuid.nullable().optional(),
});
export const assignInputSchema = assignInputObjectSchema.refine(
  (v) => v.userId !== undefined || v.teamId !== undefined,
  { message: 'assign: at least one of userId or teamId must be provided' },
);
export type AssignInput = z.infer<typeof assignInputSchema>;

export interface AssignResult {
  conversationId: string;
  assignedUserId: string | null;
  assignedTeamId: string | null;
}

export async function assignHandler(
  db: DB,
  _app: FastifyInstance,
  input: AssignInput,
  ctx: AtlasRequestContext,
): Promise<AssignResult> {
  const conv = await loadConversationScope(db, input.conversationId);
  await requireAtlasUserLink(db, conv.accountId, ctx);

  if (input.userId) {
    const [member] = await db
      .select({ userId: schema.inboxMembers.userId })
      .from(schema.inboxMembers)
      .where(
        and(
          eq(schema.inboxMembers.inboxId, conv.inboxId),
          eq(schema.inboxMembers.userId, input.userId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new MessagingToolError(
        'bad_request',
        `user ${input.userId} is not a member of inbox ${conv.inboxId}`,
      );
    }
  }

  const nextUserId = input.userId === undefined ? conv.assignedUserId : (input.userId ?? null);
  const nextTeamId = input.teamId === undefined ? conv.assignedTeamId : (input.teamId ?? null);

  const [updated] = await db
    .update(schema.conversations)
    .set({
      assignedUserId: nextUserId,
      assignedTeamId: nextTeamId,
      assignedBotId: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversations.id, conv.id))
    .returning({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
      assignedBotId: schema.conversations.assignedBotId,
    });
  if (!updated) throw new Error('assign: update returned no row');

  eventBus.emitEvent({
    type: 'conversation.assigned',
    inboxId: updated.inboxId,
    conversationId: updated.id,
    assignedUserId: updated.assignedUserId,
    assignedTeamId: updated.assignedTeamId,
    assignedBotId: updated.assignedBotId,
    meta: { atlasAppUserId: ctx.atlasAppUserId, atlasOrgId: ctx.atlasOrgId },
  });

  return {
    conversationId: updated.id,
    assignedUserId: updated.assignedUserId,
    assignedTeamId: updated.assignedTeamId,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.resolve
// ──────────────────────────────────────────────────────────────────────────────

export const resolveInputSchema = z.object({ conversationId: uuid });
export type ResolveInput = z.infer<typeof resolveInputSchema>;

export interface ResolveResult {
  conversationId: string;
  status: 'resolved';
  resolvedBy: string;
}

export async function resolveHandler(
  db: DB,
  app: FastifyInstance,
  input: ResolveInput,
  ctx: AtlasRequestContext,
): Promise<ResolveResult> {
  const conv = await loadConversationScope(db, input.conversationId);
  if (conv.status === 'resolved') {
    throw new MessagingToolError('bad_request', 'conversation already resolved');
  }
  await requireAtlasUserLink(db, conv.accountId, ctx);
  const bot = await getOrCreateAtlasBotUser(db, conv.accountId);

  const now = new Date();
  const [updated] = await db
    .update(schema.conversations)
    .set({
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: bot.id,
      updatedAt: now,
    })
    .where(eq(schema.conversations.id, conv.id))
    .returning({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      resolvedBy: schema.conversations.resolvedBy,
    });
  if (!updated) throw new Error('resolve: update returned no row');

  eventBus.emitEvent({
    type: 'conversation.resolved',
    inboxId: updated.inboxId,
    conversationId: updated.id,
    resolvedBy: updated.resolvedBy,
    meta: { atlasAppUserId: ctx.atlasAppUserId, atlasOrgId: ctx.atlasOrgId },
  });

  // CSAT prompt is gated by inbox.config.csat.enabled (existing route precedent).
  // Dynamic import mirrors `conversations/routes.ts` to avoid a hard module
  // dependency on a queue-using path from this file. Best-effort.
  const [inbox] = await db
    .select({ config: schema.inboxes.config })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, conv.inboxId))
    .limit(1);
  const csatEnabled = (inbox?.config as { csat?: { enabled?: boolean } } | null)?.csat
    ?.enabled;
  if (csatEnabled) {
    void (async () => {
      try {
        const { enqueueCsatPrompt } = await import('../channels/post-ingest');
        await enqueueCsatPrompt(app, conv.id);
      } catch (err) {
        app.log.warn({ err, conversationId: conv.id }, 'resolve: CSAT enqueue failed');
      }
    })();
  }

  return {
    conversationId: updated.id,
    status: 'resolved',
    resolvedBy: updated.resolvedBy ?? bot.id,
  };
}
