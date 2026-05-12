import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DB } from '@blossom/db';

import { buildMcpServer } from '../server';

/**
 * T-015b — McpServer factory tests over `InMemoryTransport.createLinkedPair()`.
 *
 * The pair lets a `Client` talk to our `McpServer` without HTTP, which is the
 * point: vitest's `fastify.inject()` cannot exercise SSE / streaming, and a
 * real `app.listen({port:0})` per case is heavier than this test needs. The
 * pattern (decision rationale in `findings/T015b-test-pattern.md`) covers tool
 * registration + handler invocation + error mapping — exactly what T-015b
 * introduces. Plugin trust boundaries (HMAC, MCP_SERVER_ENABLED gate) are
 * still covered by `src/plugins/__tests__/mcp-server.spec.ts` via
 * `fastify.inject()`.
 *
 * Drizzle chain mock mirrors `tools.spec.ts` (`makeDb`) — `.limit()` resolves
 * to the next prepared row set.
 */

function makeDb(rowSets: Array<unknown[]>): DB {
  const limit = vi.fn();
  for (const rs of rowSets) limit.mockResolvedValueOnce(rs);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ limit, orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as DB;
}

async function connectPair(db: DB): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, {
    capabilities: {},
  });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

const convRow = {
  id: '11111111-1111-1111-1111-111111111111',
  accountId: 'account-1',
  inboxId: 'inbox-1',
  contactId: 'contact-1',
  assignedUserId: null,
  assignedTeamId: null,
  assignedBotId: null,
  status: 'open',
  createdAt: new Date('2026-05-10T10:00:00Z'),
  updatedAt: new Date('2026-05-12T12:00:00Z'),
};

const msgRow = {
  id: 'msg-1',
  senderType: 'contact',
  senderId: 'contact-1',
  content: 'hello world',
  contentType: 'text',
  isPrivateNote: false,
  createdAt: new Date('2026-05-12T12:00:00Z'),
};

describe('buildMcpServer — InMemoryTransport pair (T-015b)', () => {
  it('exposes the three messaging.* read tools via listTools()', async () => {
    const db = makeDb([]);
    const { client, close } = await connectPair(db);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'messaging.get_thread',
        'messaging.list_threads',
        'messaging.search',
      ]);
    } finally {
      await close();
    }
  });

  it('calls messaging.get_thread and returns the handler payload as text content', async () => {
    const db = makeDb([[convRow], [msgRow]]);
    const { client, close } = await connectPair(db);
    try {
      const result = await client.callTool({
        name: 'messaging.get_thread',
        arguments: { id: convRow.id },
      });
      // CallToolResult.content[0] is `{type:'text', text:'<json>'}`. We
      // deserialise to verify the wrapper preserved the handler return shape.
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      const first = content[0]!;
      expect(first.type).toBe('text');
      const payload = JSON.parse(first.text) as {
        conversation: { id: string; inboxId: string };
        messages: Array<{ id: string; content: string }>;
      };
      expect(payload.conversation.id).toBe(convRow.id);
      expect(payload.conversation.inboxId).toBe('inbox-1');
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]!.content).toBe('hello world');
      expect(result.isError ?? false).toBe(false);
    } finally {
      await close();
    }
  });

  it('maps MessagingToolError("not_found") to isError:true with structured payload', async () => {
    const db = makeDb([[]]);
    const { client, close } = await connectPair(db);
    try {
      const result = await client.callTool({
        name: 'messaging.get_thread',
        arguments: { id: '22222222-2222-2222-2222-222222222222' },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text) as { error: string };
      expect(payload.error).toBe('not_found');
    } finally {
      await close();
    }
  });
});
