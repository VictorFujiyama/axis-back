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
  tagHandler,
  unassignBotHandler,
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
    await expect(promise).rejects.toMatchObject({
      code: 'forbidden',
      message:
        'Atlas user not linked — open /messaging in Atlas web first to activate the link, then retry.',
    });
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

// ─── tagHandler (T-15) ────────────────────────────────────────────────────────

const TAG_ID = '99999999-9999-9999-9999-999999999999';

/**
 * Drizzle mock for `tagHandler`. The handler issues these chains, in order:
 *   - select(...).from(...).innerJoin(...).where(...).limit(1)          loadConversationScope
 *   - select(...).from(...).where(...).limit(1)                         requireAtlasUserLink
 *   - select(...).from(tags).where(name).limit(1)                       resolveTagByName
 *   - insert(tags).values(...).returning(...)                           [add] auto-create when missing
 *   - insert(conversation_tags).values(...).onConflictDoNothing().returning(...)
 *   - select(...).from(conversations).where(...).limit(1)               emitConversationTagged inbox lookup
 *   - delete(conversation_tags).where(...).returning(...)               [remove]
 *
 * `selectLimits` queue feeds every `.limit()` in declaration order. The insert
 * chain supports both shapes — plain `.values().returning(...)` (tag create)
 * AND `.values().onConflictDoNothing().returning(...)` (edge upsert) — by
 * exposing `.returning` AND `.onConflictDoNothing` on the same `values()`
 * builder; each `.returning(...)` call consumes the next entry in
 * `insertReturnings`.
 */
function makeTagDb(opts: {
  selectLimits?: Array<unknown[]>;
  // Each entry is the rowset OR an Error for the corresponding `.returning(...)`
  // resolution; consumed in call order across both tag and edge inserts.
  insertReturnings?: Array<unknown[] | Error>;
  deleteReturnings?: Array<unknown[]>;
}): {
  db: DB;
  insertSpy: ReturnType<typeof vi.fn>;
  onConflictSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const selectLimit = vi.fn();
  for (const rs of opts.selectLimits ?? []) selectLimit.mockResolvedValueOnce(rs);
  const orderBy = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit, orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere, innerJoin });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const insertReturning = vi.fn();
  for (const rs of opts.insertReturnings ?? []) {
    if (rs instanceof Error) insertReturning.mockRejectedValueOnce(rs);
    else insertReturning.mockResolvedValueOnce(rs);
  }
  const onConflictBuilder = { returning: insertReturning };
  const onConflictSpy = vi.fn().mockReturnValue(onConflictBuilder);
  const insertValues = vi.fn().mockReturnValue({
    returning: insertReturning,
    onConflictDoNothing: onConflictSpy,
  });
  const insertSpy = vi.fn().mockReturnValue({ values: insertValues });

  const deleteReturning = vi.fn();
  for (const rs of opts.deleteReturnings ?? []) deleteReturning.mockResolvedValueOnce(rs);
  const deleteWhere = vi.fn().mockReturnValue({ returning: deleteReturning });
  const deleteSpy = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    db: { select, insert: insertSpy, delete: deleteSpy } as unknown as DB,
    insertSpy,
    onConflictSpy,
    deleteSpy,
  };
}

describe('tagHandler', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('action=add: existing tag, new edge → upserts conversation_tags and fires conversation.tagged', async () => {
    const { db, onConflictSpy } = makeTagDb({
      selectLimits: [
        [CONV_SCOPE_ROW],                   // loadConversationScope
        [{ id: 'link-1' }],                 // requireAtlasUserLink
        [{ id: TAG_ID }],                   // resolveTagByName → hit
        [{ inboxId: INBOX_ID }],            // emitConversationTagged inbox lookup
      ],
      insertReturnings: [
        // No tag auto-create needed — resolveTagByName hit.
        [{ tagId: TAG_ID }],                // conversation_tags edge inserted
      ],
    });

    const result = await tagHandler(
      db,
      appStub,
      { conversationId: CONV_ID, tag: 'qualified', action: 'add' },
      CTX,
    );

    expect(result).toEqual({
      conversationId: CONV_ID,
      tagId: TAG_ID,
      tagName: 'qualified',
      action: 'add',
      applied: true,
    });
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.tagged',
        conversationId: CONV_ID,
        inboxId: INBOX_ID,
        tagId: TAG_ID,
      }),
    );
  });

  it('action=add: tag not yet in DB → auto-creates with conv.accountId then upserts the edge', async () => {
    const { db, insertSpy } = makeTagDb({
      selectLimits: [
        [CONV_SCOPE_ROW],                   // loadConversationScope
        [{ id: 'link-1' }],                 // requireAtlasUserLink
        [],                                 // resolveTagByName → miss
        [{ inboxId: INBOX_ID }],            // emitConversationTagged inbox lookup
      ],
      insertReturnings: [
        [{ id: TAG_ID }],                   // tags insert (auto-create)
        [{ tagId: TAG_ID }],                // conversation_tags edge inserted
      ],
    });

    const result = await tagHandler(
      db,
      appStub,
      { conversationId: CONV_ID, tag: 'Qualified', action: 'add' },
      CTX,
    );

    expect(result.tagName).toBe('qualified'); // lowercased
    expect(result.applied).toBe(true);
    // Two distinct .insert(...) calls: one into `tags`, one into `conversation_tags`.
    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('action=add: edge already present → no emit (idempotent re-tag)', async () => {
    const { db, onConflictSpy } = makeTagDb({
      selectLimits: [
        [CONV_SCOPE_ROW],
        [{ id: 'link-1' }],
        [{ id: TAG_ID }],
        // No inbox lookup expected since emit is skipped
      ],
      insertReturnings: [
        [], // onConflictDoNothing returned no rows — edge already there
      ],
    });

    const result = await tagHandler(
      db,
      appStub,
      { conversationId: CONV_ID, tag: 'qualified', action: 'add' },
      CTX,
    );

    expect(result.applied).toBe(false);
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('action=remove: existing tag + edge → deletes and reports applied=true', async () => {
    const { db, deleteSpy } = makeTagDb({
      selectLimits: [
        [CONV_SCOPE_ROW],
        [{ id: 'link-1' }],
        [{ id: TAG_ID }],
      ],
      deleteReturnings: [[{ tagId: TAG_ID }]],
    });

    const result = await tagHandler(
      db,
      appStub,
      { conversationId: CONV_ID, tag: 'qualified', action: 'remove' },
      CTX,
    );

    expect(result).toEqual({
      conversationId: CONV_ID,
      tagId: TAG_ID,
      tagName: 'qualified',
      action: 'remove',
      applied: true,
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled(); // remove never re-fires lead_qualified
  });

  it('throws MessagingToolError("forbidden") when atlas_user_link is missing for this Atlas user', async () => {
    const { db } = makeTagDb({
      selectLimits: [
        [CONV_SCOPE_ROW],          // loadConversationScope
        [],                        // requireAtlasUserLink → empty
      ],
    });

    const promise = tagHandler(
      db,
      appStub,
      { conversationId: CONV_ID, tag: 'qualified', action: 'add' },
      CTX,
    );

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

// ─── unassignBotHandler (T-16 — Fase G smart handoff) ─────────────────────────

const OTHER_ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_BOT_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('unassignBotHandler', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('releases the bot, flips status to open, and emits conversation.assigned (bot→null)', async () => {
    const updatedConv = {
      id: CONV_ID,
      inboxId: INBOX_ID,
      assignedUserId: null,
      assignedTeamId: null,
      assignedBotId: null,
    };
    const { db } = makeWriteDb({
      selectLimits: [
        [{ ...CONV_SCOPE_ROW, assignedBotId: BOT_USER_ID }], // loadConversationScope
        [{ axisUserId: BOT_USER_ID }],                       // resolveAtlasUserLink → bot link
      ],
      updateReturnings: [[updatedConv]],
    });

    const result = await unassignBotHandler(
      db,
      appStub,
      { conversationId: CONV_ID },
      CTX,
    );

    expect(result).toEqual({
      ok: true,
      conversationId: CONV_ID,
      status: 'open',
      unchanged: false,
    });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.assigned',
        conversationId: CONV_ID,
        inboxId: INBOX_ID,
        assignedBotId: null,
        meta: { atlasAppUserId: ATLAS_APP_USER_ID, atlasOrgId: ATLAS_ORG_ID },
      }),
    );
  });

  it('throws MessagingToolError("not_found") when the conversation does not exist', async () => {
    const { db } = makeWriteDb({
      selectLimits: [
        [], // loadConversationScope → empty
      ],
    });

    const promise = unassignBotHandler(db, appStub, { conversationId: CONV_ID }, CTX);

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'not_found' });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws MessagingToolError("forbidden") cross-tenant: bot not linked to the conversation account', async () => {
    const { db } = makeWriteDb({
      selectLimits: [
        [{ ...CONV_SCOPE_ROW, accountId: OTHER_ACCOUNT_ID, assignedBotId: BOT_USER_ID }], // scope (other account)
        [],                                                                               // resolveAtlasUserLink → no link for that account
      ],
    });

    const promise = unassignBotHandler(db, appStub, { conversationId: CONV_ID }, CTX);

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws MessagingToolError("conflict") when a different bot is assigned', async () => {
    const { db } = makeWriteDb({
      selectLimits: [
        [{ ...CONV_SCOPE_ROW, assignedBotId: OTHER_BOT_USER_ID }], // scope: a different bot owns it
        [{ axisUserId: BOT_USER_ID }],                            // resolveAtlasUserLink → our bot
      ],
    });

    const promise = unassignBotHandler(db, appStub, { conversationId: CONV_ID }, CTX);

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'conflict' });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('is idempotent: already unassigned → returns ok unchanged without mutating or emitting', async () => {
    const { db } = makeWriteDb({
      selectLimits: [
        [{ ...CONV_SCOPE_ROW, assignedBotId: null }], // scope: no bot assigned
        [{ axisUserId: BOT_USER_ID }],                // resolveAtlasUserLink → our bot
      ],
    });

    const result = await unassignBotHandler(db, appStub, { conversationId: CONV_ID }, CTX);

    expect(result).toEqual({
      ok: true,
      conversationId: CONV_ID,
      status: 'open',
      unchanged: true,
    });
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
