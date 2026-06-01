import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { DB } from '@blossom/db';
import {
  type AtlasRequestContext,
  MessagingToolError,
  assignHandler,
  assignInputObjectSchema,
  assignInputSchema,
  assignUserHandler,
  assignUserInputSchema,
  getInboxPlaybookHandler,
  getInboxPlaybookInputSchema,
  getThreadHandler,
  getThreadInputSchema,
  listThreadsHandler,
  listThreadsInputSchema,
  resolveHandler,
  resolveInputSchema,
  searchHandler,
  searchInputSchema,
  sendMessageHandler,
  sendMessageInputSchema,
  tagHandler,
  tagInputSchema,
  unassignBotHandler,
  unassignBotInputSchema,
} from './tools';

/**
 * Phase D.2/D.3 — MCP server factory.
 *
 * Builds an `McpServer` with the messaging tool suite registered:
 *   - Read (T-015b): `messaging.get_thread`, `messaging.list_threads`,
 *     `messaging.search` — pass-through to handlers that only need `db`.
 *   - Write (T-023): `messaging.send_message`, `messaging.assign`,
 *     `messaging.resolve` — need `app` (for the resolve CSAT enqueue path) and
 *     `ctx` (the Atlas requester binding) to gate access via
 *     `atlas_user_links` and to ride along on emitted events as `meta`.
 *
 * Per-request construction: the Fastify plugin (`src/plugins/mcp-server.ts`)
 * instantiates a fresh server + transport per request (stateless mode). That
 * way each connection carries its own `ctx` built from request headers — no
 * cross-request leakage of identity, and the McpServer captures `ctx` via
 * closure at construction time (the SDK callback signature can't accept extra
 * args). Tests use `InMemoryTransport.createLinkedPair()` (no HTTP) per the
 * L-419 unit-style pattern.
 *
 * Tool naming uses dot notation (`messaging.get_thread`, ...) — Atlas-side
 * `@atlas/mcp/registry-bridge` rewrites these to underscore-prefixed forms
 * (`mcp_<orgId>_messaging_get_thread`) per L-407.
 *
 * Input validation: the SDK validates `args` against the provided raw zod
 * shape before invoking the callback (`inputSchema: <shape>.shape`). Handlers
 * trust their parsed input and never re-validate (L-419 passthrough). The
 * assign tool registers the raw object shape via
 * `assignInputObjectSchema.shape`; the `.refine()` "at least one of
 * userId/teamId" check is enforced inside the wrapper by parsing through
 * `assignInputSchema` and mapping a ZodError to a `bad_request` tool error.
 *
 * Output shape: handlers return plain objects; the wrapper here serialises to
 * the MCP `CallToolResult` shape (`{content: [{type:'text', text}]}`).
 * `MessagingToolError` (e.g. 404 / forbidden / bad_request) maps to
 * `isError: true` so the LLM sees the failure without the SDK treating it as
 * a protocol-level exception.
 */

const SERVER_INFO = {
  name: 'axis-back-messaging',
  version: '0.1.0',
} as const;

function toToolResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toToolError(code: string, message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

const MISSING_CTX_ERROR = new MessagingToolError(
  'forbidden',
  'missing Atlas identity headers (X-Atlas-App-User-Id, X-Atlas-Org-Id) — required for write tools',
);

function requireCtx(ctx: AtlasRequestContext | undefined): AtlasRequestContext {
  if (!ctx) throw MISSING_CTX_ERROR;
  return ctx;
}

function mapToolError(err: unknown):
  | { content: Array<{ type: 'text'; text: string }>; isError: true }
  | null {
  if (err instanceof MessagingToolError) {
    return toToolError(err.code, err.message);
  }
  if (err instanceof ZodError) {
    return toToolError(
      'bad_request',
      err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    );
  }
  return null;
}

export function buildMcpServer(
  db: DB,
  app: FastifyInstance,
  ctx?: AtlasRequestContext,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  // ── Read tools (T-015b) ──────────────────────────────────────────────────
  server.registerTool(
    'messaging.get_thread',
    {
      description:
        'Fetch a conversation by id with up to 50 of its most recent messages (chronological).',
      inputSchema: getThreadInputSchema.shape,
    },
    async (args) => {
      try {
        const result = await getThreadHandler(db, args);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    'messaging.list_threads',
    {
      description:
        'List conversations with optional filters: inboxId, status, assignee, since, limit.',
      inputSchema: listThreadsInputSchema.shape,
    },
    async (args) => {
      try {
        const result = await listThreadsHandler(db, args);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    'messaging.search',
    {
      description:
        'Full-text search across message content. Returns up to `limit` hits ranked by relevance.',
      inputSchema: searchInputSchema.shape,
    },
    async (args) => {
      try {
        const result = await searchHandler(db, args);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // ── messaging.get_inbox_playbook (T-06 — playbook-in-axis) ────────────────
  // A read tool, but it needs `ctx` to enforce the D27 cross-tenant check: the
  // calling Atlas org may only read playbooks of the axis account it is bound
  // to via `atlas_user_links`. Missing identity headers → forbidden, same as
  // the write tools.
  server.registerTool(
    'messaging.get_inbox_playbook',
    {
      description:
        'Fetch the playbook configured for an inbox (axis-back is the source of truth). Returns {exists:true, content, etag, version, updatedAt} or {exists:false} when no playbook is set, the inbox is unknown, or the feature is disabled. Scoped to the caller Atlas org\'s account; reading another account\'s inbox is forbidden.',
      inputSchema: getInboxPlaybookInputSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        const result = await getInboxPlaybookHandler(db, args, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // ── Write tools (T-023) ──────────────────────────────────────────────────
  server.registerTool(
    'messaging.send_message',
    {
      description:
        'Send a message into a conversation as the Atlas assistant. Inserts the row, bumps the conversation timestamp, and triggers outbound channel dispatch via the existing message.created subscriber.',
      inputSchema: sendMessageInputSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        const result = await sendMessageHandler(db, app, args, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    'messaging.assign',
    {
      description:
        'Assign a conversation to a user and/or team. Pass null to clear; omit to leave unchanged. At least one of userId or teamId is required. Clears any existing bot assignment.',
      inputSchema: assignInputObjectSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        // Apply the .refine() ("at least one of userId/teamId") inside the
        // wrapper — the SDK only validates the raw object shape.
        const parsed = assignInputSchema.parse(args);
        const result = await assignHandler(db, app, parsed, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    'messaging.resolve',
    {
      description:
        'Mark a conversation as resolved. Stamps `resolvedBy` with the Atlas-bot user and triggers the CSAT prompt if the inbox is configured for it.',
      inputSchema: resolveInputSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        const result = await resolveHandler(db, app, args, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // ── messaging.tag (T-15) ─────────────────────────────────────────────────
  // Lowercases the input tag name to match `tags.name` storage and keep the
  // T-03 `qualified` trigger case match aligned. Auto-creates the tag in the
  // conversation's account if it does not yet exist globally; cross-account
  // reuse on 23505 falls back to the existing row.
  server.registerTool(
    'messaging.tag',
    {
      description:
        "Add or remove a tag on a conversation. `action: 'add'` upserts the conversation_tags edge (and auto-creates the tag row if needed); `action: 'remove'` deletes the edge. Tagging with name `qualified` fires the lead_qualified envelope to Atlas (same path as the REST/bot/automation tag-insert sites).",
      inputSchema: tagInputSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        const result = await tagHandler(db, app, args, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // ── messaging.unassign_bot (T-16 — Fase G smart handoff) ──────────────────
  // Releases the Atlas-bot from a conversation (bot→human reverse handoff,
  // D29). Scoped to the bot's account (D32); only the assigned bot may release,
  // a different bot is a conflict, an already-free conversation is a no-op.
  server.registerTool(
    'messaging.unassign_bot',
    {
      description:
        "Release the Atlas-bot from a conversation so it returns to the inbox's general queue for a human to pick up. Sets status to 'open' and clears the bot assignment. No-op if the conversation already has no bot; errors if a different bot owns it.",
      inputSchema: unassignBotInputSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        const result = await unassignBotHandler(db, app, args, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // ── messaging.assign_user (T-17 — Fase G smart handoff) ───────────────────
  // Hands a bot-managed conversation off to a specific human agent (D29).
  // Scoped to the bot's account (D31); the target user must exist and belong to
  // that same account (D32), otherwise the assignment is refused.
  server.registerTool(
    'messaging.assign_user',
    {
      description:
        "Assign a bot-managed conversation to a specific human agent (the Atlas-bot hands off to a named user). Sets status to 'open' and clears the bot assignment. The target user must belong to the conversation's account.",
      inputSchema: assignUserInputSchema.shape,
    },
    async (args) => {
      try {
        const bound = requireCtx(ctx);
        const result = await assignUserHandler(db, app, args, bound);
        return toToolResult(result);
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  return server;
}
