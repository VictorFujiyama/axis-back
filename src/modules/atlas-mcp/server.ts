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

  return server;
}
