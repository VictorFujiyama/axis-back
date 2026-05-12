import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@blossom/db';

import { buildMcpServer } from '../server';
import { buildAtlasBotEmail } from '../atlas-bot';
import { eventBus } from '../../../realtime/event-bus';

/**
 * T-015b / T-023 — McpServer factory tests over `InMemoryTransport.createLinkedPair()`.
 *
 * The pair lets a `Client` talk to our `McpServer` without HTTP, which is the
 * point: vitest's `fastify.inject()` cannot exercise SSE / streaming, and a
 * real `app.listen({port:0})` per case is heavier than this test needs. The
 * pattern (decision rationale in `findings/T015b-test-pattern.md`) covers tool
 * registration + handler invocation + error mapping + ctx threading — exactly
 * what T-015b and T-023 introduce. Plugin trust boundaries (HMAC,
 * MCP_SERVER_ENABLED gate, header → ctx) are still covered by
 * `src/plugins/__tests__/mcp-server.spec.ts` via `fastify.inject()`.
 *
 * Drizzle chain mock mirrors `tools.spec.ts` (`makeDb`/`makeWriteDb`) —
 * `.limit()` resolves to the next prepared row set; the dual-shape `where()`
 * on UPDATE returns a Promise decorated with `.returning(...)` so both the
 * timestamp-bump and the `.returning(...)` chain are satisfied by the same
 * mock.
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

function makeWriteDb(opts: {
  selectLimits?: Array<unknown[]>;
  insertReturnings?: Array<unknown[]>;
  updateReturnings?: Array<unknown[]>;
}): DB {
  const selectLimit = vi.fn();
  for (const rs of opts.selectLimits ?? []) selectLimit.mockResolvedValueOnce(rs);
  const orderBy = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit, orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere, innerJoin });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const insertReturning = vi.fn();
  for (const rs of opts.insertReturnings ?? []) insertReturning.mockResolvedValueOnce(rs);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateReturning = vi.fn();
  for (const rs of opts.updateReturnings ?? []) updateReturning.mockResolvedValueOnce(rs);
  const updateWhere = vi.fn().mockImplementation(() => {
    const thenable: Promise<undefined> & { returning?: typeof updateReturning } =
      Promise.resolve(undefined);
    thenable.returning = updateReturning;
    return thenable;
  });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return { select, insert: insertFn, update: updateFn } as unknown as DB;
}

const appStub = {
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
} as unknown as FastifyInstance;

async function connectPair(
  db: DB,
  ctx?: { atlasAppUserId: string; atlasOrgId: string },
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildMcpServer(db, appStub, ctx);
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

const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CONV_ID = '44444444-4444-4444-4444-444444444444';
const INBOX_ID = '55555555-5555-5555-5555-555555555555';
const BOT_USER_ID = '77777777-7777-7777-7777-777777777777';
const ATLAS_APP_USER_ID = 'clerk_user_atlas_xyz';
const ATLAS_ORG_ID = 'atlas_org_abc';

const CTX = { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID };

const CONV_SCOPE_ROW = {
  id: CONV_ID,
  inboxId: INBOX_ID,
  contactId: '88888888-8888-8888-8888-888888888888',
  assignedUserId: null as string | null,
  assignedTeamId: null as string | null,
  assignedBotId: null as string | null,
  status: 'open' as const,
  deletedAt: null as Date | null,
  accountId: ACCOUNT_ID,
};

const BOT_USER_ROW = {
  id: BOT_USER_ID,
  email: buildAtlasBotEmail(ACCOUNT_ID),
  name: 'Atlas Assistant',
};

describe('buildMcpServer — InMemoryTransport pair', () => {
  it('exposes all six messaging.* tools via listTools() (T-015b read + T-023 write)', async () => {
    const db = makeDb([]);
    const { client, close } = await connectPair(db, CTX);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'messaging.assign',
        'messaging.get_thread',
        'messaging.list_threads',
        'messaging.resolve',
        'messaging.search',
        'messaging.send_message',
      ]);
    } finally {
      await close();
    }
  });

  it('calls messaging.get_thread and returns the handler payload as text content', async () => {
    const db = makeDb([[convRow], [msgRow]]);
    const { client, close } = await connectPair(db, CTX);
    try {
      const result = await client.callTool({
        name: 'messaging.get_thread',
        arguments: { id: convRow.id },
      });
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
    const { client, close } = await connectPair(db, CTX);
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

  describe('write tools (T-023)', () => {
    let emitSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
    });
    afterEach(() => {
      emitSpy.mockRestore();
    });

    it('calls messaging.send_message round-trip with ctx threaded — emits message.created with Atlas meta', async () => {
      const insertedMsg = {
        id: 'msg-new',
        conversationId: CONV_ID,
        inboxId: INBOX_ID,
        senderType: 'bot' as const,
        senderId: BOT_USER_ID,
        content: 'hi from atlas',
        contentType: 'text',
        mediaUrl: null,
        mediaMimeType: null,
        isPrivateNote: false,
        createdAt: new Date('2026-05-12T14:00:00Z'),
      };
      const db = makeWriteDb({
        selectLimits: [
          [CONV_SCOPE_ROW], // loadConversationScope
          [{ id: 'link-1' }], // requireAtlasUserLink
          [BOT_USER_ROW], // getOrCreateAtlasBotUser (idempotent hit)
        ],
        insertReturnings: [[insertedMsg]],
      });

      const { client, close } = await connectPair(db, CTX);
      try {
        const result = await client.callTool({
          name: 'messaging.send_message',
          arguments: {
            conversationId: CONV_ID,
            content: 'hi from atlas',
            contentType: 'text',
            isPrivateNote: false,
          },
        });

        expect(result.isError ?? false).toBe(false);
        const content = result.content as Array<{ type: string; text: string }>;
        const payload = JSON.parse(content[0]!.text) as { messageId: string };
        expect(payload.messageId).toBe('msg-new');

        expect(emitSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'message.created',
            conversationId: CONV_ID,
            inboxId: INBOX_ID,
            meta: { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID },
          }),
        );
      } finally {
        await close();
      }
    });

    it('returns isError:true forbidden when ctx is undefined (missing Atlas identity headers)', async () => {
      const db = makeWriteDb({});
      const { client, close } = await connectPair(db /* no ctx */);
      try {
        const result = await client.callTool({
          name: 'messaging.send_message',
          arguments: {
            conversationId: CONV_ID,
            content: 'hi',
            contentType: 'text',
            isPrivateNote: false,
          },
        });
        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const payload = JSON.parse(content[0]!.text) as { error: string };
        expect(payload.error).toBe('forbidden');
        expect(emitSpy).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('maps a missing-required-field zod failure on messaging.assign to isError:true bad_request', async () => {
      const db = makeWriteDb({});
      const { client, close } = await connectPair(db, CTX);
      try {
        const result = await client.callTool({
          name: 'messaging.assign',
          // Neither userId nor teamId provided — the .refine() in
          // assignInputSchema fires inside the wrapper and surfaces a ZodError
          // which mapToolError maps to bad_request.
          arguments: { conversationId: CONV_ID },
        });
        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const payload = JSON.parse(content[0]!.text) as { error: string };
        expect(payload.error).toBe('bad_request');
        expect(emitSpy).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });
  });
});
