import { and, asc, desc, eq, gte, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';

/**
 * MCP read-tool handlers exposed under `messaging.*` (T-013).
 *
 * Handlers take `db` as first arg + a parsed input object — pure functions,
 * no Fastify coupling. T-015b registers them via SDK `server.tool()` with
 * the exported zod schemas; the SDK validates input before invocation so
 * handlers can trust the shape (L-419 passthrough).
 *
 * V1 read tools are NOT account-scoped: the inbound HMAC gates trust
 * (L-408) and Atlas-side decides which org sees what via `viewable_by` on
 * the indexed envelopes (L-405). Write tools (T-021) reintroduce scoping
 * via `atlas_user_links` because they mutate state.
 */

export class MessagingToolError extends Error {
  readonly code: 'not_found';
  constructor(code: 'not_found', message: string) {
    super(message);
    this.code = code;
    this.name = 'MessagingToolError';
  }
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
