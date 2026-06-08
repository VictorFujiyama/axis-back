import { and, asc, desc, eq, gte, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';
import type { ChannelType } from '@blossom/shared-types';
import { config } from '../../config';
import { decryptJSON } from '../../crypto';
import { isInboxConfigured } from '../channels/configured-check';
import { emitConversationTagged } from '../atlas-events/tagged-trigger';
import { eventBus } from '../../realtime/event-bus';
import { getOrCreateAtlasBotUser } from './atlas-bot';
import { ERR, type ErrCode } from './errors';

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

export type MessagingToolErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'bad_request'
  | 'conflict';

export class MessagingToolError extends Error {
  readonly code: MessagingToolErrorCode;
  /**
   * Optional domain-level structured reason (spec D14). Carries codes from
   * {@link ErrCode} (e.g. `OUTSIDE_24H_WINDOW`) so Atlas journey handlers can
   * apply a per-error retry policy. Left undefined by legacy callers — the
   * two-argument constructor stays backward compatible.
   */
  readonly errCode?: ErrCode;
  constructor(code: MessagingToolErrorCode, message: string, errCode?: ErrCode) {
    super(message);
    this.code = code;
    this.errCode = errCode;
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
      'Atlas user not linked — open /messaging in Atlas web first to activate the link, then retry.',
    );
  }
}

/**
 * Resolve the `bots.id` of the Atlas-managed bot for a conversation's inbox.
 *
 * Gap 3 bridge (T-19'/T-16'): `conversations.assignedBotId` carries a FK to
 * `bots(id)`, NOT the bot user's `users.id` in `atlas_user_links`. The two
 * id-spaces never match, so the bot that owns an Atlas-managed conversation
 * cannot be identified by the bot user's `axisUserId`. Instead it is the
 * inbox's `defaultBotId` — a real `bots` row created by
 * `POST /atlas-connector/set-inbox-default-bot` (T-19') and copied onto new
 * conversations by `channels/helpers`. An inbox with no `defaultBotId` is not
 * Atlas-managed, so there is no Atlas bot to act on → `conflict`.
 */
async function resolveAtlasManagedBotId(db: DB, inboxId: string): Promise<string> {
  const [row] = await db
    .select({ defaultBotId: schema.inboxes.defaultBotId })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, inboxId))
    .limit(1);
  if (!row || row.defaultBotId === null) {
    throw new MessagingToolError(
      'conflict',
      'conversation inbox is not Atlas-managed',
    );
  }
  return row.defaultBotId;
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

// ──────────────────────────────────────────────────────────────────────────────
// messaging.tag (T-15)
// ──────────────────────────────────────────────────────────────────────────────

export const tagInputSchema = z.object({
  conversationId: uuid,
  tag: z.string().trim().min(1).max(60),
  action: z.enum(['add', 'remove']),
});
export type TagInput = z.infer<typeof tagInputSchema>;

export interface TagResult {
  conversationId: string;
  tagId: string | null;
  tagName: string;
  action: 'add' | 'remove';
  // True when conversationTags was actually mutated (insert produced a row /
  // delete removed one); false on no-op (already present / never linked).
  applied: boolean;
}

async function resolveTagByName(
  db: DB,
  name: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(eq(schema.tags.name, name))
    .limit(1);
  return row ? { id: row.id } : null;
}

export async function tagHandler(
  db: DB,
  _app: FastifyInstance,
  input: TagInput,
  ctx: AtlasRequestContext,
): Promise<TagResult> {
  const conv = await loadConversationScope(db, input.conversationId);
  await requireAtlasUserLink(db, conv.accountId, ctx);

  // Normalize to match the lowercase+trim convention enforced by
  // `tags/routes.ts:9` so the trigger T-03 case match (`'qualified'`) lines up
  // regardless of agent capitalization.
  const name = input.tag.trim().toLowerCase();
  if (!name) {
    throw new MessagingToolError('bad_request', 'tag name must be a non-empty string');
  }

  if (input.action === 'add') {
    let tag = await resolveTagByName(db, name);
    if (!tag) {
      try {
        const [created] = await db
          .insert(schema.tags)
          .values({ name, accountId: conv.accountId })
          .returning({ id: schema.tags.id });
        if (created) tag = { id: created.id };
      } catch (err) {
        // tags.name is globally unique — a 23505 means another account beat us
        // to it. Re-lookup and reuse: cross-account reuse is the existing
        // schema's reality (`tags/routes.ts:43` also surfaces 23505 as a
        // conflict for the explicit-create path).
        if ((err as { code?: string }).code !== '23505') throw err;
      }
      if (!tag) tag = await resolveTagByName(db, name);
      if (!tag) {
        throw new Error('tag: failed to resolve or create tag after 23505 race');
      }
    }

    // Same emit contract as the four REST/bulk/automation/bot insert sites
    // (T-03): `.onConflictDoNothing().returning(...)` exposes only the rows
    // that truly inserted, so re-applying an existing tag does not re-fire
    // `lead_qualified`. The `qualified` case continues to flow through
    // `enqueue.ts:buildConnectorEventForEvent` → `buildLeadQualifiedEnvelope`.
    const inserted = await db
      .insert(schema.conversationTags)
      .values({ conversationId: conv.id, tagId: tag.id })
      .onConflictDoNothing()
      .returning({ tagId: schema.conversationTags.tagId });
    if (inserted.length > 0) {
      await emitConversationTagged(db, {
        conversationId: conv.id,
        tagIds: inserted.map((r) => r.tagId),
      });
    }

    return {
      conversationId: conv.id,
      tagId: tag.id,
      tagName: name,
      action: 'add',
      applied: inserted.length > 0,
    };
  }

  // action === 'remove'
  const tag = await resolveTagByName(db, name);
  if (!tag) {
    return {
      conversationId: conv.id,
      tagId: null,
      tagName: name,
      action: 'remove',
      applied: false,
    };
  }
  const removed = await db
    .delete(schema.conversationTags)
    .where(
      and(
        eq(schema.conversationTags.conversationId, conv.id),
        eq(schema.conversationTags.tagId, tag.id),
      ),
    )
    .returning({ tagId: schema.conversationTags.tagId });
  return {
    conversationId: conv.id,
    tagId: tag.id,
    tagName: name,
    action: 'remove',
    applied: removed.length > 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.unassign_bot (T-16 — Fase G smart handoff: D27/D29/D31/D32)
// ──────────────────────────────────────────────────────────────────────────────

export const unassignBotInputSchema = z.object({ conversationId: uuid });
export type UnassignBotInput = z.infer<typeof unassignBotInputSchema>;

export interface UnassignBotResult {
  ok: true;
  conversationId: string;
  status: 'open';
  // False when the bot assignment was actually cleared; true when the
  // conversation already had no bot (idempotent no-op).
  unchanged: boolean;
}

/**
 * Release the Atlas-bot from a conversation so it returns to the inbox's
 * general queue for a human to pick up (D29 reverse handoff bot→human).
 *
 * Gate + tenancy (D31/D32): `requireAtlasUserLink` is scoped to the
 * conversation's account, so only the Atlas-bot mapped to that account can
 * release it — a cross-account caller gets `forbidden`. The conversation must
 * currently be assigned to THIS bot; the Atlas bot for the inbox is its
 * `defaultBotId` (a `bots.id`), resolved via {@link resolveAtlasManagedBotId}
 * — NOT the bot user's `axisUserId`, which lives in the disjoint `users`
 * id-space (Gap 3 / T-16'). A different bot (or a human-managed thread) is a
 * `conflict` and is left untouched. An already-unassigned conversation is an
 * idempotent no-op (`unchanged: true`, no event).
 *
 * On release the conversation flips to `status='open'` and stamps
 * `waitingForAgentSince` (the same field `send_message` clears), surfacing it
 * to human agents, then emits `conversation.assigned` (bot→null) for realtime.
 */
export async function unassignBotHandler(
  db: DB,
  _app: FastifyInstance,
  input: UnassignBotInput,
  ctx: AtlasRequestContext,
): Promise<UnassignBotResult> {
  const conv = await loadConversationScope(db, input.conversationId);
  // Tenancy gate (D31/D32): caller must be the Atlas-bot mapped to this account.
  await requireAtlasUserLink(db, conv.accountId, ctx);

  // Idempotent: no bot to release → report ok without mutating or emitting.
  if (conv.assignedBotId === null) {
    return { ok: true, conversationId: conv.id, status: 'open', unchanged: true };
  }
  // Gap 3: the Atlas bot for this conversation is the inbox's defaultBotId
  // (a bots.id), NOT the bot user's axisUserId. Only that bot may be released.
  const expectedBotId = await resolveAtlasManagedBotId(db, conv.inboxId);
  if (conv.assignedBotId !== expectedBotId) {
    throw new MessagingToolError(
      'conflict',
      `conversation ${conv.id} is assigned to a different bot`,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(schema.conversations)
    .set({
      assignedBotId: null,
      status: 'open',
      waitingForAgentSince: now,
      updatedAt: now,
    })
    .where(eq(schema.conversations.id, conv.id))
    .returning({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
      assignedBotId: schema.conversations.assignedBotId,
    });
  if (!updated) throw new Error('unassign_bot: update returned no row');

  eventBus.emitEvent({
    type: 'conversation.assigned',
    inboxId: updated.inboxId,
    conversationId: updated.id,
    assignedUserId: updated.assignedUserId,
    assignedTeamId: updated.assignedTeamId,
    assignedBotId: updated.assignedBotId,
    meta: { atlasAppUserId: ctx.atlasAppUserId, atlasOrgId: ctx.atlasOrgId },
  });

  return { ok: true, conversationId: updated.id, status: 'open', unchanged: false };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.assign_user (T-17 — Fase G smart handoff: D29/D31/D32)
// ──────────────────────────────────────────────────────────────────────────────

export const assignUserInputSchema = z.object({
  conversationId: uuid,
  axisUserId: uuid,
});
export type AssignUserInput = z.infer<typeof assignUserInputSchema>;

export interface AssignUserResult {
  ok: true;
  conversationId: string;
  assignedUserId: string;
  status: 'open';
}

/**
 * Hand a conversation off from the Atlas-bot to a specific human agent (D29
 * reverse handoff bot→specific human). Unlike {@link unassignBotHandler}, which
 * returns the thread to the inbox's general queue, this routes it to a named
 * `assignedUserId`.
 *
 * Gate + tenancy: `requireAtlasUserLink` scopes the caller to the
 * conversation's account, so a cross-account bot is rejected `forbidden` (D31).
 * Unlike the reverse handoff, this tool never inspects the currently assigned
 * bot, so it is unaffected by the Gap 3 id-space split (T-16'/T-17') — the gate
 * is purely the account-scoped link check shared with the write tools.
 * The target `axisUserId` must (a) exist as a live user — otherwise `not_found`
 * — and (b) be a member of the conversation's account (`account_users`),
 * otherwise `forbidden` (D32 cross-account assignment is refused). On success
 * the conversation flips to `status='open'`, clears any bot assignment, stamps
 * `waitingForAgentSince`, and emits `conversation.assigned` for realtime.
 */
export async function assignUserHandler(
  db: DB,
  _app: FastifyInstance,
  input: AssignUserInput,
  ctx: AtlasRequestContext,
): Promise<AssignUserResult> {
  const conv = await loadConversationScope(db, input.conversationId);
  // Scopes the caller to conv.accountId — cross-tenant bot finds no link (D31).
  // Same corrected gate as the other write tools (T-16'); the bound axisUserId
  // is irrelevant here since this tool sets assignedUserId, not assignedBotId.
  await requireAtlasUserLink(db, conv.accountId, ctx);

  // Target user must exist (live) before we check membership, so a deleted /
  // unknown user is `not_found` rather than masquerading as cross-account.
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, input.axisUserId), isNull(schema.users.deletedAt)))
    .limit(1);
  if (!user) {
    throw new MessagingToolError('not_found', `user ${input.axisUserId} not found`);
  }

  // D32: the target must belong to the conversation's account. A user from
  // another account is a cross-tenant assignment → forbidden.
  const [member] = await db
    .select({ userId: schema.accountUsers.userId })
    .from(schema.accountUsers)
    .where(
      and(
        eq(schema.accountUsers.accountId, conv.accountId),
        eq(schema.accountUsers.userId, input.axisUserId),
      ),
    )
    .limit(1);
  if (!member) {
    throw new MessagingToolError(
      'forbidden',
      `user ${input.axisUserId} does not belong to the conversation account`,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(schema.conversations)
    .set({
      assignedUserId: input.axisUserId,
      assignedBotId: null,
      status: 'open',
      waitingForAgentSince: now,
      updatedAt: now,
    })
    .where(eq(schema.conversations.id, conv.id))
    .returning({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
      assignedBotId: schema.conversations.assignedBotId,
    });
  if (!updated) throw new Error('assign_user: update returned no row');

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
    ok: true,
    conversationId: updated.id,
    assignedUserId: updated.assignedUserId ?? input.axisUserId,
    status: 'open',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.get_inbox_playbook (T-06 — playbook-in-axis D26/D27/D40)
// ──────────────────────────────────────────────────────────────────────────────

export const getInboxPlaybookInputSchema = z.object({ inboxId: uuid });
export type GetInboxPlaybookInput = z.infer<typeof getInboxPlaybookInputSchema>;

export type GetInboxPlaybookResult =
  | { exists: false }
  | {
      exists: true;
      content: string;
      etag: string;
      version: number;
      updatedAt: Date;
    };

/**
 * Read the locally-stored playbook for an inbox (D1: axis-back is the source of
 * truth). Atlas-worker calls this via MCP to fetch the playbook it observes
 * conversations against (D26).
 *
 * Unlike the other read tools (which are intentionally not account-scoped —
 * L-408 trusts the inbound HMAC and Atlas decides visibility), this tool leaks
 * inbox content cross-org if unguarded, so it carries an explicit cross-tenant
 * check (D27): the playbook is only returned when the inbox's account matches
 * the account the calling Atlas org is bound to via its `atlas-bot:%` link in
 * `atlas_user_links`. A missing link or an account mismatch is `forbidden`.
 *
 * Degrades gracefully when the feature flag is off (D40) or the inbox /
 * playbook row is absent — returns `{exists: false}` rather than throwing, so
 * the Atlas worker falls back to its legacy `readPlaybook` path during a
 * rollback without surfacing a hard error.
 */
export async function getInboxPlaybookHandler(
  db: DB,
  input: GetInboxPlaybookInput,
  ctx: AtlasRequestContext,
): Promise<GetInboxPlaybookResult> {
  // D40 — feature flag off: behave as if no playbook exists so the Atlas worker
  // falls back to its legacy readPlaybook path.
  if (!config.PLAYBOOK_IN_AXIS_ENABLED) {
    return { exists: false };
  }

  // Resolve the inbox (its account drives the cross-tenant check). A
  // non-existent inbox degrades to {exists:false} (D26) — not a 404.
  const [inbox] = await db
    .select({ accountId: schema.inboxes.accountId })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, input.inboxId))
    .limit(1);
  if (!inbox || inbox.accountId === null) {
    return { exists: false };
  }

  // D27 — cross-tenant gate. The Atlas org is bound to exactly one axis account
  // through its provisioned `atlas-bot:<orgId>` link (D31). Reading an inbox
  // that belongs to a different account is a cross-tenant leak → forbidden.
  const [link] = await db
    .select({ accountId: schema.atlasUserLinks.accountId })
    .from(schema.atlasUserLinks)
    .where(
      and(
        eq(schema.atlasUserLinks.atlasOrgId, ctx.atlasOrgId),
        like(schema.atlasUserLinks.atlasAppUserId, 'atlas-bot:%'),
      ),
    )
    .limit(1);
  if (!link || link.accountId !== inbox.accountId) {
    throw new MessagingToolError('forbidden', 'cross-tenant access denied');
  }

  const [playbook] = await db
    .select({
      content: schema.inboxPlaybooks.content,
      etag: schema.inboxPlaybooks.etag,
      version: schema.inboxPlaybooks.version,
      updatedAt: schema.inboxPlaybooks.updatedAt,
    })
    .from(schema.inboxPlaybooks)
    .where(eq(schema.inboxPlaybooks.inboxId, input.inboxId))
    .limit(1);
  if (!playbook) {
    return { exists: false };
  }

  return {
    exists: true,
    content: playbook.content,
    etag: playbook.etag,
    version: playbook.version,
    updatedAt: playbook.updatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.list_inboxes (T-03 — journey-outbound-messaging D1/D2)
// ──────────────────────────────────────────────────────────────────────────────

const channelTypeSchema = z.enum([
  'whatsapp',
  'email',
  'instagram',
  'messenger',
  'telegram',
  'webchat',
  'sms',
  'api',
]);

export const listInboxesInputSchema = z.object({
  channelType: channelTypeSchema.optional(),
  // Default true: the journey builder only cares about inboxes it can actually
  // send through. Pass false to also surface disabled inboxes (e.g. a "needs
  // setup" badge for an inbox the operator turned off).
  enabledOnly: z.boolean().default(true),
});
export type ListInboxesInput = z.infer<typeof listInboxesInputSchema>;

export interface InboxCapabilities {
  /** Channel has an outbound sender implemented in axis-back. */
  supportsOutbound: boolean;
  /** Sending may require an approved provider template (informational). */
  requiresTemplate: boolean;
  /** Recipient must have initiated contact first (e.g. Telegram bot rule). */
  requiresUserInit: boolean;
}

export interface ListInboxesItem {
  id: string;
  name: string;
  channelType: ChannelType;
  enabled: boolean;
  /** Minimum credentials present to send (D2). Never exposes the secrets. */
  configured: boolean;
  capabilities: InboxCapabilities;
  /** Human-facing send identity (phone / from-email); null when not stored. */
  identifier: string | null;
  updatedAt: Date;
}

export interface ListInboxesResult {
  inboxes: ListInboxesItem[];
}

/**
 * Static per-channel capability matrix (D2). Cravado so Atlas does not hardcode
 * protocol rules: only channels with a real axis-back sender advertise
 * `supportsOutbound`. Telegram carries `requiresUserInit` (the bot can only
 * message users who started the conversation).
 */
export function capabilitiesForChannel(channelType: ChannelType): InboxCapabilities {
  switch (channelType) {
    case 'whatsapp':
      return { supportsOutbound: true, requiresTemplate: false, requiresUserInit: false };
    case 'email':
      return { supportsOutbound: true, requiresTemplate: false, requiresUserInit: false };
    case 'telegram':
      return { supportsOutbound: true, requiresTemplate: false, requiresUserInit: true };
    default:
      // sms / instagram / messenger / webchat / api: no outbound sender yet.
      return { supportsOutbound: false, requiresTemplate: false, requiresUserInit: false };
  }
}

/**
 * The send-identity surfaced in the journey builder dropdown (D2): WhatsApp's
 * Twilio from-number (or messaging-service SID fallback) and the email
 * from-address. Telegram stores no bot username in `config` (only `apiBase` /
 * `defaultBotId`), so it returns null and Atlas shows just the inbox name.
 * Reads only the public `config` jsonb — never `secrets`.
 */
export function identifierForInbox(channelType: ChannelType, config: unknown): string | null {
  const c = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  switch (channelType) {
    case 'whatsapp':
      return str(c.fromNumber) ?? str(c.messagingServiceSid);
    case 'email':
      return str(c.fromEmail);
    default:
      return null;
  }
}

/**
 * Decrypt an inbox's `secrets` blob best-effort. Mirrors the defensive decrypt
 * pattern in `src/queue/workers.ts` — a malformed / unkeyable blob is treated
 * as "no secrets" (→ `configured: false`) rather than failing the whole list.
 */
function safeDecryptSecrets(secrets: string | null): unknown {
  if (!secrets) return null;
  try {
    return decryptJSON(secrets);
  } catch {
    return null;
  }
}

/**
 * List the inboxes of the axis account the calling Atlas org is bound to (D1/D2).
 *
 * Cross-tenant gate (D27): the Atlas org maps to exactly one axis account via
 * its provisioned `atlas-bot:<orgId>` link in `atlas_user_links`. A missing
 * link is `forbidden` — there is no account to scope the listing to.
 *
 * For each inbox it computes `configured` (via {@link isInboxConfigured}, which
 * needs the decrypted secrets), the static `capabilities` matrix, and the
 * public `identifier`. Secrets are decrypted only to derive the boolean and are
 * never returned.
 */
export async function listInboxesHandler(
  db: DB,
  input: ListInboxesInput,
  ctx: AtlasRequestContext,
): Promise<ListInboxesResult> {
  // D27 — resolve the single axis account bound to this Atlas org.
  const [link] = await db
    .select({ accountId: schema.atlasUserLinks.accountId })
    .from(schema.atlasUserLinks)
    .where(
      and(
        eq(schema.atlasUserLinks.atlasOrgId, ctx.atlasOrgId),
        like(schema.atlasUserLinks.atlasAppUserId, 'atlas-bot:%'),
      ),
    )
    .limit(1);
  if (!link || link.accountId === null) {
    throw new MessagingToolError(
      'forbidden',
      'Atlas org is not linked to an axis account — connect Axis first.',
    );
  }

  const conditions: SQL[] = [
    eq(schema.inboxes.accountId, link.accountId),
    isNull(schema.inboxes.deletedAt),
  ];
  if (input.channelType) {
    conditions.push(eq(schema.inboxes.channelType, input.channelType));
  }
  if (input.enabledOnly) {
    conditions.push(eq(schema.inboxes.enabled, true));
  }

  const rows = await db
    .select({
      id: schema.inboxes.id,
      name: schema.inboxes.name,
      channelType: schema.inboxes.channelType,
      enabled: schema.inboxes.enabled,
      config: schema.inboxes.config,
      secrets: schema.inboxes.secrets,
      updatedAt: schema.inboxes.updatedAt,
    })
    .from(schema.inboxes)
    .where(and(...conditions))
    .orderBy(asc(schema.inboxes.name));

  const inboxes: ListInboxesItem[] = rows.map((row) => {
    const channelType = row.channelType as ChannelType;
    const decrypted = safeDecryptSecrets(row.secrets);
    return {
      id: row.id,
      name: row.name,
      channelType,
      enabled: row.enabled,
      configured: isInboxConfigured(channelType, row.config, decrypted),
      capabilities: capabilitiesForChannel(channelType),
      identifier: identifierForInbox(channelType, row.config),
      updatedAt: row.updatedAt,
    };
  });

  return { inboxes };
}

// ──────────────────────────────────────────────────────────────────────────────
// messaging.upsert_conversation_and_send (T-05 — journey-outbound D3/D4/D5/D6)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Channels with a real outbound sender in axis-back. Anything else (sms /
 * instagram / messenger / webchat / api) has no sender, so a forced send is
 * refused with `CHANNEL_NOT_IMPLEMENTED` (D20) rather than silently faking
 * success on the Atlas side.
 */
const OUTBOUND_CHANNELS: readonly ChannelType[] = ['whatsapp', 'email', 'telegram'];

const messageContentTypeSchema = z.enum([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'location',
  'template',
]);

export const upsertAndSendInputSchema = z
  .object({
    inboxId: uuid,
    contact: z
      .object({
        // Resolution ladder (D4), most-specific first.
        axisContactId: uuid.optional(),
        externalContactRef: z
          .object({ source: z.string().min(1), externalId: z.string().min(1) })
          .strict()
          .optional(),
        identifier: z
          .object({
            phone: z.string().min(1).optional(),
            email: z.string().min(1).optional(),
            telegramUserId: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        // Used only when creating a brand-new contact.
        name: z.string().optional(),
      })
      .strict(),
    message: z
      .object({
        // Empty content is valid for a template send (the body lives in the
        // provider template, referenced by `templateRef`).
        content: z.string().default(''),
        contentType: messageContentTypeSchema.default('text'),
        // Email subject — stored on metadata (messages has no subject column).
        subject: z.string().optional(),
        // WhatsApp/Twilio approved-template reference (24h-window bypass, D16).
        templateRef: z
          .object({
            provider: z.string().min(1),
            sid: z.string().min(1),
            variables: z.record(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    conversationStrategy: z.enum(['reuse-open', 'always-new']).default('reuse-open'),
    metadata: z
      .object({
        atlasJourneyRunId: z.string().min(1),
        atlasNodeId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type UpsertAndSendInput = z.infer<typeof upsertAndSendInputSchema>;

export interface UpsertAndSendResult {
  conversationId: string;
  messageId: string;
  createdNewConversation: boolean;
  createdNewContact: boolean;
}

/**
 * Translate a provider failure (HTTP status and/or provider-specific code) into
 * a structured {@link ErrCode} per D14 so Atlas can apply its per-error retry
 * policy.
 *
 * Outbound dispatch in axis-back is asynchronous (the send happens in a BullMQ
 * channel job, see `messages/routes.ts:dispatchOutbound`), so this handler never
 * observes a provider error synchronously — the message is "accepted" once it is
 * inserted and the `message.created` event is emitted (D18). This mapper is
 * therefore exported for (a) the channel job / a future synchronous send path
 * and (b) the delivery webhook, which both need to label a failure with the same
 * vocabulary. Twilio 63016 (freeform outside the 24h session window) →
 * OUTSIDE_24H_WINDOW; HTTP 429 / Twilio 63018 → rate-limited; any 5xx →
 * transient (retriable); everything else → rejected (non-retriable).
 */
export function mapProviderError(args: {
  httpStatus?: number;
  providerCode?: number | string;
}): ErrCode {
  const { httpStatus } = args;
  const code =
    typeof args.providerCode === 'string' ? Number(args.providerCode) : args.providerCode;
  if (code === 63016) return ERR.OUTSIDE_24H_WINDOW;
  if (httpStatus === 429 || code === 63018) return ERR.PROVIDER_RATE_LIMITED;
  if (httpStatus !== undefined && httpStatus >= 500) return ERR.PROVIDER_TRANSIENT;
  return ERR.PROVIDER_REJECTED;
}

/**
 * Composite key under which the Atlas federation reference is remembered on a
 * resolved/created contact. axis-back has no `entity_links` table (that lives
 * Atlas-side, Phase 12.2.18), so the "create entity_link" step of D4 is realised
 * by stamping `contacts.custom_fields.atlasExternalRef = '<source>:<externalId>'`
 * — a self-contained mapping the next upsert can look up directly.
 */
function externalRefKeyOf(
  ref: { source: string; externalId: string } | undefined,
): string | null {
  return ref ? `${ref.source}:${ref.externalId}` : null;
}

/**
 * Resolve (or create) the axis contact for an outbound journey send, following
 * the D4 ladder: explicit axis id → remembered external ref → phone/email match
 * → create. A phone/email match back-fills the external-ref mapping so later
 * sends short-circuit on step 2. Throws `CONTACT_RESOLUTION_FAILED` when an
 * explicit `axisContactId` is unknown or when there is nothing to resolve or
 * create a contact from.
 */
async function resolveContactForUpsert(
  db: DB,
  accountId: string,
  contact: UpsertAndSendInput['contact'],
): Promise<{ contactId: string; createdNewContact: boolean }> {
  // (1) explicit axis contact id.
  if (contact.axisContactId) {
    const [row] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.id, contact.axisContactId),
          eq(schema.contacts.accountId, accountId),
          isNull(schema.contacts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new MessagingToolError(
        'not_found',
        `contact ${contact.axisContactId} not found in account`,
        ERR.CONTACT_RESOLUTION_FAILED,
      );
    }
    return { contactId: row.id, createdNewContact: false };
  }

  const externalRefKey = externalRefKeyOf(contact.externalContactRef);

  // (2) remembered Atlas external ref (entity-link analog on custom_fields).
  if (externalRefKey) {
    const [row] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.accountId, accountId),
          isNull(schema.contacts.deletedAt),
          sql`${schema.contacts.customFields}->>'atlasExternalRef' = ${externalRefKey}`,
        ),
      )
      .limit(1);
    if (row) return { contactId: row.id, createdNewContact: false };
  }

  // (3) phone/email identifier match.
  const phone = contact.identifier?.phone ?? null;
  const email = contact.identifier?.email ?? null;
  if (phone || email) {
    const idConds: SQL[] = [];
    if (phone) idConds.push(eq(schema.contacts.phone, phone));
    if (email) idConds.push(eq(schema.contacts.email, email));
    const [row] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.accountId, accountId),
          isNull(schema.contacts.deletedAt),
          idConds.length === 1 ? idConds[0]! : or(...idConds)!,
        ),
      )
      .limit(1);
    if (row) {
      // Remember the Atlas ref so future sends resolve on step 2 (D4).
      if (externalRefKey) {
        await db
          .update(schema.contacts)
          .set({
            customFields: sql`coalesce(${schema.contacts.customFields}, '{}'::jsonb) || ${sql.raw(
              `'${JSON.stringify({ atlasExternalRef: externalRefKey })}'::jsonb`,
            )}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.contacts.id, row.id));
      }
      return { contactId: row.id, createdNewContact: false };
    }
  }

  // (4) create a fresh contact — requires at least one anchor to be useful.
  const telegramUserId = contact.identifier?.telegramUserId ?? null;
  if (!phone && !email && !telegramUserId && !externalRefKey) {
    throw new MessagingToolError(
      'bad_request',
      'no contact identifier to resolve or create a contact',
      ERR.CONTACT_RESOLUTION_FAILED,
    );
  }
  const [created] = await db
    .insert(schema.contacts)
    .values({
      accountId,
      name: contact.name ?? null,
      phone,
      email,
      customFields: externalRefKey ? { atlasExternalRef: externalRefKey } : {},
    })
    .returning({ id: schema.contacts.id });
  if (!created) {
    throw new MessagingToolError(
      'bad_request',
      'failed to create contact',
      ERR.CONTACT_RESOLUTION_FAILED,
    );
  }
  return { contactId: created.id, createdNewContact: true };
}

/**
 * Resolve the conversation to send into. `reuse-open` reuses the most recently
 * updated open conversation on the same contact+inbox; otherwise (or with
 * `always-new`) it opens a fresh one, copying the inbox `defaultBotId` so the
 * thread stays Atlas-managed.
 */
async function resolveConversationForUpsert(
  db: DB,
  args: {
    accountId: string;
    contactId: string;
    inboxId: string;
    defaultBotId: string | null;
    strategy: 'reuse-open' | 'always-new';
  },
): Promise<{ conversationId: string; createdNewConversation: boolean }> {
  if (args.strategy === 'reuse-open') {
    const [existing] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.contactId, args.contactId),
          eq(schema.conversations.inboxId, args.inboxId),
          eq(schema.conversations.status, 'open'),
          isNull(schema.conversations.deletedAt),
        ),
      )
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(1);
    if (existing) return { conversationId: existing.id, createdNewConversation: false };
  }

  const [created] = await db
    .insert(schema.conversations)
    .values({
      accountId: args.accountId,
      contactId: args.contactId,
      inboxId: args.inboxId,
      status: 'open',
      assignedBotId: args.defaultBotId,
    })
    .returning({ id: schema.conversations.id });
  if (!created) throw new Error('upsert_and_send: failed to create conversation');
  return { conversationId: created.id, createdNewConversation: true };
}

/**
 * Atomic "find-or-create contact + conversation, then send" entry point for the
 * Atlas journey outbound handlers (D3). Single MCP call so Atlas never races a
 * separate resolve + send.
 *
 * Order of checks (deviates slightly from the spec's numbering to honour D20):
 * inbox existence → enabled → channel-implemented → configured. The
 * channel-implemented gate runs BEFORE `configured` so a stub channel (sms /
 * instagram / messenger) surfaces the actionable `CHANNEL_NOT_IMPLEMENTED`
 * rather than a misleading "configure it" — there is no sender to configure.
 *
 * Idempotency (D5): a prior message carrying the same
 * `metadata.atlas_journey_run_id` + `metadata.atlas_node_id` short-circuits and
 * returns the existing conversation+message, so a BullMQ retry re-runs the
 * handler without duplicating the send. The partial unique index
 * `messages_atlas_journey_dedup_idx` (T-04) is the DB-level backstop under a
 * concurrent double-insert.
 *
 * Loop prevention (D6): the inserted message stamps
 * `metadata.source='atlas-journey'`; the Atlas connector envelope builder (T-06)
 * carries it through so the trigger matcher (T-15) skips self-originated turns.
 *
 * Dispatch is asynchronous: the message is inserted and `message.created` is
 * emitted (the existing outbound hook enqueues the channel job). Success here
 * means "accepted for delivery" (D18) — provider failures arrive later via
 * webhook and are mapped with {@link mapProviderError}.
 */
export async function upsertAndSendHandler(
  db: DB,
  _app: FastifyInstance,
  input: UpsertAndSendInput,
  ctx: AtlasRequestContext,
): Promise<UpsertAndSendResult> {
  // D27 — resolve the single axis account bound to this Atlas org.
  const [link] = await db
    .select({ accountId: schema.atlasUserLinks.accountId })
    .from(schema.atlasUserLinks)
    .where(
      and(
        eq(schema.atlasUserLinks.atlasOrgId, ctx.atlasOrgId),
        like(schema.atlasUserLinks.atlasAppUserId, 'atlas-bot:%'),
      ),
    )
    .limit(1);
  if (!link || link.accountId === null) {
    throw new MessagingToolError(
      'forbidden',
      'Atlas org is not linked to an axis account — connect Axis first.',
    );
  }
  const accountId = link.accountId;

  // Inbox resolution + gating.
  const [inbox] = await db
    .select({
      id: schema.inboxes.id,
      channelType: schema.inboxes.channelType,
      enabled: schema.inboxes.enabled,
      config: schema.inboxes.config,
      secrets: schema.inboxes.secrets,
      defaultBotId: schema.inboxes.defaultBotId,
    })
    .from(schema.inboxes)
    .where(
      and(
        eq(schema.inboxes.id, input.inboxId),
        eq(schema.inboxes.accountId, accountId),
        isNull(schema.inboxes.deletedAt),
      ),
    )
    .limit(1);
  if (!inbox) {
    throw new MessagingToolError(
      'not_found',
      `inbox ${input.inboxId} not found`,
      ERR.INBOX_NOT_FOUND,
    );
  }
  if (!inbox.enabled) {
    throw new MessagingToolError('conflict', `inbox ${inbox.id} is disabled`, ERR.INBOX_DISABLED);
  }
  const channelType = inbox.channelType as ChannelType;
  if (!OUTBOUND_CHANNELS.includes(channelType)) {
    throw new MessagingToolError(
      'bad_request',
      `channel ${channelType} has no outbound sender`,
      ERR.CHANNEL_NOT_IMPLEMENTED,
    );
  }
  if (!isInboxConfigured(channelType, inbox.config, safeDecryptSecrets(inbox.secrets))) {
    throw new MessagingToolError(
      'conflict',
      `inbox ${inbox.id} is not configured for sending`,
      ERR.INBOX_NOT_CONFIGURED,
    );
  }

  // Idempotency (D5) — a previous send for the same run+node returns as-is.
  const [existingMsg] = await db
    .select({
      id: schema.messages.id,
      conversationId: schema.messages.conversationId,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.accountId, accountId),
        sql`${schema.messages.metadata}->>'atlas_journey_run_id' = ${input.metadata.atlasJourneyRunId}`,
        sql`${schema.messages.metadata}->>'atlas_node_id' = ${input.metadata.atlasNodeId}`,
      ),
    )
    .limit(1);
  if (existingMsg) {
    return {
      conversationId: existingMsg.conversationId,
      messageId: existingMsg.id,
      createdNewConversation: false,
      createdNewContact: false,
    };
  }

  const { contactId, createdNewContact } = await resolveContactForUpsert(
    db,
    accountId,
    input.contact,
  );

  // Telegram delivery keys off a contact identity (chatId), not contacts.phone
  // (dispatchOutbound reads contact_identities for telegram). Ensure it exists.
  if (channelType === 'telegram' && input.contact.identifier?.telegramUserId) {
    await db
      .insert(schema.contactIdentities)
      .values({
        contactId,
        channel: 'telegram',
        identifier: input.contact.identifier.telegramUserId,
      })
      .onConflictDoNothing();
  }

  const { conversationId, createdNewConversation } = await resolveConversationForUpsert(db, {
    accountId,
    contactId,
    inboxId: inbox.id,
    defaultBotId: inbox.defaultBotId,
    strategy: input.conversationStrategy,
  });

  const bot = await getOrCreateAtlasBotUser(db, accountId);

  // metadata keys are snake_case so the partial unique index (T-04) and the
  // connector envelope builder (T-06) read them consistently.
  const metadata: Record<string, unknown> = {
    source: 'atlas-journey',
    atlas_journey_run_id: input.metadata.atlasJourneyRunId,
    atlas_node_id: input.metadata.atlasNodeId,
  };
  if (input.message.subject) metadata.subject = input.message.subject;
  if (input.message.templateRef) metadata.template = input.message.templateRef;

  const now = new Date();
  const [msg] = await db
    .insert(schema.messages)
    .values({
      conversationId,
      inboxId: inbox.id,
      accountId,
      senderType: 'bot',
      senderId: bot.id,
      content: input.message.content,
      contentType: input.message.contentType,
      metadata,
    })
    .returning();
  if (!msg) throw new Error('upsert_and_send: failed to insert message');

  await db
    .update(schema.conversations)
    .set({ lastMessageAt: now, updatedAt: now, waitingForAgentSince: null })
    .where(eq(schema.conversations.id, conversationId));

  // Same outbound bridge as send_message: the `message.created` subscriber
  // (bots/outbound-hook) enqueues the channel job.
  eventBus.emitEvent({
    type: 'message.created',
    inboxId: inbox.id,
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
      createdAt: msg.createdAt,
      sender: { name: bot.name, email: bot.email },
    },
    meta: { atlasAppUserId: ctx.atlasAppUserId, atlasOrgId: ctx.atlasOrgId },
  });

  return { conversationId, messageId: msg.id, createdNewConversation, createdNewContact };
}
