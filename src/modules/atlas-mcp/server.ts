import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DB } from '@blossom/db';
import {
  MessagingToolError,
  getThreadHandler,
  getThreadInputSchema,
  listThreadsHandler,
  listThreadsInputSchema,
  searchHandler,
  searchInputSchema,
} from './tools';

/**
 * Phase D.2 (T-015b) — MCP server factory.
 *
 * Builds an `McpServer` with the three messaging read tools registered. The
 * Fastify plugin (`src/plugins/mcp-server.ts`) instantiates a fresh server +
 * transport per request (stateless mode) so concurrent connections never share
 * mutable transport state; tests connect via `InMemoryTransport.createLinkedPair()`
 * (no HTTP) per the L-419 unit-style pattern.
 *
 * Tool naming uses dot notation (`messaging.get_thread`, ...) — Atlas-side
 * `@atlas/mcp/registry-bridge` rewrites these to underscore-prefixed forms
 * (`mcp_<orgId>_messaging_get_thread`) per L-407.
 *
 * Input validation: the SDK validates `args` against the provided raw zod
 * shape before invoking the callback (`inputSchema: <shape>.shape`). Handlers
 * trust their parsed input and never re-validate (L-419 passthrough).
 *
 * Output shape: handlers return plain objects; the wrapper here serialises to
 * the MCP `CallToolResult` shape (`{content: [{type:'text', text}]}`).
 * `MessagingToolError` (e.g. 404) maps to `isError: true` so the LLM sees the
 * failure without the SDK treating it as a protocol-level exception.
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

export function buildMcpServer(db: DB): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });

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
        if (err instanceof MessagingToolError) {
          return toToolError(err.code, err.message);
        }
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
      const result = await listThreadsHandler(db, args);
      return toToolResult(result);
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
      const result = await searchHandler(db, args);
      return toToolResult(result);
    },
  );

  return server;
}
