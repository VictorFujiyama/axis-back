import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@blossom/db';

import {
  MessagingToolError,
  assignHandler,
  getThreadHandler,
  listThreadsHandler,
  resolveHandler,
  searchHandler,
  sendMessageHandler,
} from '../tools';
import { buildAtlasBotEmail } from '../atlas-bot';
import { eventBus } from '../../../realtime/event-bus';

/**
 * Mock the drizzle chain used by tools.ts handlers:
 *   select(cols).from(t).where(c).limit(n)                       — getThread (1st)
 *   select(cols).from(t).where(c).orderBy(...).limit(n)          — getThread (2nd), listThreads, search
 *
 * Each call to `.limit()` resolves to the next row-set in `rowSets`, in the
 * order the handler issues its queries (the helpers in
 * `atlas-events/__tests__/build-envelope.spec.ts` use the same shape).
 */
function makeDb(rowSets: Array<unknown[]>): { db: DB; whereSpy: ReturnType<typeof vi.fn> } {
  const limit = vi.fn();
  for (const rs of rowSets) limit.mockResolvedValueOnce(rs);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const whereSpy = vi.fn().mockReturnValue({ limit, orderBy });
  const from = vi.fn().mockReturnValue({ where: whereSpy });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DB, whereSpy };
}

const convRow = {
  id: 'conv-1',
  accountId: 'account-1',
  inboxId: 'inbox-1',
  contactId: 'contact-1',
  assignedUserId: 'user-1',
  assignedTeamId: null as string | null,
  assignedBotId: null as string | null,
  status: 'open' as const,
  createdAt: new Date('2026-05-10T10:00:00Z'),
  updatedAt: new Date('2026-05-12T12:00:00Z'),
};

const msgRow = {
  id: 'msg-1',
  senderType: 'contact' as const,
  senderId: 'contact-1',
  content: 'hello world',
  contentType: 'text',
  isPrivateNote: false,
  createdAt: new Date('2026-05-12T12:00:00Z'),
};

describe('getThreadHandler', () => {
  it('returns conversation + messages when the conversation exists', async () => {
    const { db } = makeDb([[convRow], [msgRow]]);

    const result = await getThreadHandler(db, { id: convRow.id });

    expect(result.conversation).toMatchObject({
      id: 'conv-1',
      accountId: 'account-1',
      inboxId: 'inbox-1',
      status: 'open',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'msg-1',
      senderType: 'contact',
      content: 'hello world',
    });
  });

  it('throws MessagingToolError("not_found") when no conversation matches', async () => {
    const { db } = makeDb([[]]);

    const promise = getThreadHandler(db, {
      id: '00000000-0000-0000-0000-000000000000',
    });

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('listThreadsHandler', () => {
  it('returns conversations with default filter (no inboxId/status/assignee/since)', async () => {
    const rows = [convRow, { ...convRow, id: 'conv-2' }];
    const { db, whereSpy } = makeDb([rows]);

    const result = await listThreadsHandler(db, { limit: 50 });

    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]).toMatchObject({ id: 'conv-1' });
    // Default filter: only the `deletedAt IS NULL` predicate is applied. The
    // and(...conditions) expression is wrapped in a single arg to where.
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('applies status filter when input.status is provided', async () => {
    const resolvedRow = { ...convRow, status: 'resolved' as const };
    const { db, whereSpy } = makeDb([[resolvedRow]]);

    const result = await listThreadsHandler(db, {
      status: 'resolved',
      limit: 50,
    });

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]).toMatchObject({ status: 'resolved' });
    // where() is invoked exactly once with the combined predicate; the
    // resolved-status arg is part of that combined SQL fragment, which we do
    // not introspect further here (drizzle owns that translation).
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });
});

describe('searchHandler', () => {
  it('returns hits when the tsvector query matches messages', async () => {
    const hit = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      inboxId: 'inbox-1',
      senderType: 'contact' as const,
      content: 'hello world',
      createdAt: new Date('2026-05-12T12:00:00Z'),
    };
    const { db } = makeDb([[hit]]);

    const result = await searchHandler(db, { query: 'hello', limit: 20 });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      messageId: 'msg-1',
      content: 'hello world',
    });
  });

  it('returns empty hits when no message matches', async () => {
    const { db } = makeDb([[]]);

    const result = await searchHandler(db, { query: 'nothingmatches', limit: 20 });

    expect(result.hits).toEqual([]);
  });
});

// ─── Write tools (T-022) ──────────────────────────────────────────────────────

const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CONV_ID = '44444444-4444-4444-4444-444444444444';
const INBOX_ID = '55555555-5555-5555-5555-555555555555';
const TARGET_USER_ID = '66666666-6666-6666-6666-666666666666';
const BOT_USER_ID = '77777777-7777-7777-7777-777777777777';
const ATLAS_APP_USER_ID = 'clerk_user_atlas_xyz';
const ATLAS_ORG_ID = 'atlas_org_abc';

const CTX = { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID };

const BOT_USER_ROW = {
  id: BOT_USER_ID,
  email: buildAtlasBotEmail(ACCOUNT_ID),
  name: 'Atlas Assistant',
};

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

/**
 * Drizzle mock for write-tool tests. Each write handler issues a mix of:
 *   - select(...).from(...).[innerJoin(...).]where(...).limit(1)   (scope/link/member lookups)
 *   - insert(...).values(...).returning()                          (sendMessage)
 *   - update(...).set(...).where(...) [.returning(...)]            (sendMessage/assign/resolve)
 *
 * `selectLimits`, `insertReturnings` and `updateReturnings` are sequential
 * queues consumed in call order. The update path is dual-shape: awaiting
 * `where()` directly resolves to `undefined` (sendMessage timestamp bump),
 * while `.returning(...)` resolves to the next entry in `updateReturnings`
 * (assign/resolve).
 */
function makeWriteDb(opts: {
  selectLimits?: Array<unknown[]>;
  insertReturnings?: Array<unknown[]>;
  updateReturnings?: Array<unknown[]>;
}): { db: DB; updateReturning: ReturnType<typeof vi.fn> } {
  const selectLimit = vi.fn();
  for (const rs of opts.selectLimits ?? []) selectLimit.mockResolvedValueOnce(rs);
  const orderBy = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit, orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFrom = vi
    .fn()
    .mockReturnValue({ where: selectWhere, innerJoin });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const insertReturning = vi.fn();
  for (const rs of opts.insertReturnings ?? []) insertReturning.mockResolvedValueOnce(rs);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateReturning = vi.fn();
  for (const rs of opts.updateReturnings ?? []) updateReturning.mockResolvedValueOnce(rs);
  // `where()` is both awaitable (for the no-returning sendMessage timestamp
  // bump) AND chains into `.returning(...)` (assign/resolve). We hand back a
  // resolved Promise decorated with a `returning` method.
  const updateWhere = vi.fn().mockImplementation(() => {
    const thenable: Promise<undefined> & { returning?: typeof updateReturning } =
      Promise.resolve(undefined);
    thenable.returning = updateReturning;
    return thenable;
  });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: { select, insert: insertFn, update: updateFn } as unknown as DB,
    updateReturning,
  };
}

const appStub = {
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
} as unknown as FastifyInstance;

describe('sendMessageHandler', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('inserts a bot message, bumps the conversation, and emits message.created with Atlas meta', async () => {
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
    const { db } = makeWriteDb({
      selectLimits: [
        [CONV_SCOPE_ROW],          // loadConversationScope
        [{ id: 'link-1' }],        // requireAtlasUserLink
        [BOT_USER_ROW],            // getOrCreateAtlasBotUser (idempotent lookup hit)
      ],
      insertReturnings: [[insertedMsg]],
    });

    const result = await sendMessageHandler(
      db,
      appStub,
      {
        conversationId: CONV_ID,
        content: 'hi from atlas',
        contentType: 'text',
        isPrivateNote: false,
      },
      CTX,
    );

    expect(result).toEqual({ messageId: 'msg-new' });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.created',
        conversationId: CONV_ID,
        inboxId: INBOX_ID,
        meta: { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID },
      }),
    );
  });

  it('throws MessagingToolError("forbidden") when atlas_user_link is missing for this Atlas user', async () => {
    const { db } = makeWriteDb({
      selectLimits: [
        [CONV_SCOPE_ROW],          // loadConversationScope
        [],                        // requireAtlasUserLink → empty
      ],
    });

    const promise = sendMessageHandler(
      db,
      appStub,
      {
        conversationId: CONV_ID,
        content: 'hi',
        contentType: 'text',
        isPrivateNote: false,
      },
      CTX,
    );

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('assignHandler', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('updates assignment and emits conversation.assigned when target user is an inbox member', async () => {
    const updatedConv = {
      id: CONV_ID,
      inboxId: INBOX_ID,
      assignedUserId: TARGET_USER_ID,
      assignedTeamId: null,
      assignedBotId: null,
    };
    const { db } = makeWriteDb({
      selectLimits: [
        [CONV_SCOPE_ROW],                  // loadConversationScope
        [{ id: 'link-1' }],                // requireAtlasUserLink
        [{ userId: TARGET_USER_ID }],      // inboxMembers lookup
      ],
      updateReturnings: [[updatedConv]],
    });

    const result = await assignHandler(
      db,
      appStub,
      { conversationId: CONV_ID, userId: TARGET_USER_ID },
      CTX,
    );

    expect(result).toEqual({
      conversationId: CONV_ID,
      assignedUserId: TARGET_USER_ID,
      assignedTeamId: null,
    });
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.assigned',
        conversationId: CONV_ID,
        assignedUserId: TARGET_USER_ID,
        assignedBotId: null,
        meta: { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID },
      }),
    );
  });

  it('throws MessagingToolError("bad_request") when the target user is not a member of the inbox', async () => {
    const { db } = makeWriteDb({
      selectLimits: [
        [CONV_SCOPE_ROW],          // loadConversationScope
        [{ id: 'link-1' }],        // requireAtlasUserLink
        [],                        // inboxMembers lookup → empty
      ],
    });

    const promise = assignHandler(
      db,
      appStub,
      { conversationId: CONV_ID, userId: TARGET_USER_ID },
      CTX,
    );

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'bad_request' });
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('resolveHandler', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('marks the conversation resolved, stamps resolvedBy=atlas-bot, and emits conversation.resolved with Atlas meta', async () => {
    const updatedConv = {
      id: CONV_ID,
      inboxId: INBOX_ID,
      resolvedBy: BOT_USER_ID,
    };
    const { db } = makeWriteDb({
      selectLimits: [
        [CONV_SCOPE_ROW],          // loadConversationScope (status='open')
        [{ id: 'link-1' }],        // requireAtlasUserLink
        [BOT_USER_ROW],            // getOrCreateAtlasBotUser lookup hit
        [{ config: null }],        // inbox config — CSAT disabled, no enqueue
      ],
      updateReturnings: [[updatedConv]],
    });

    const result = await resolveHandler(db, appStub, { conversationId: CONV_ID }, CTX);

    expect(result).toEqual({
      conversationId: CONV_ID,
      status: 'resolved',
      resolvedBy: BOT_USER_ID,
    });
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.resolved',
        conversationId: CONV_ID,
        resolvedBy: BOT_USER_ID,
        meta: { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID },
      }),
    );
  });
});
