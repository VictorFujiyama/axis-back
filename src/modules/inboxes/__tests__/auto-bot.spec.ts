import { describe, expect, it, vi } from 'vitest';

import { applyAutoBotForInbox, type DbOrTx } from '../auto-bot';

/**
 * Mock the drizzle chain used by applyAutoBotForInbox, in call order:
 *   select(...).from(...).where(...).limit(1)            — inbox, bot lookups
 *   update(...).set(...).where(...)                       — key columns / defaultBotId / bot.enabled
 *   insert(...).values(...).returning()                   — bot creation
 *   insert(...).values(...)                               — audit log (awaited, no .returning())
 *
 * `selectLimits` feeds the two lookups in order: [inbox], [bot].
 * `insertReturnings` feeds the bot-creation .returning() call.
 */
function makeDb(opts: { selectLimits?: unknown[][]; insertReturnings?: unknown[][] }) {
  const selectLimit = vi.fn();
  for (const rs of opts.selectLimits ?? []) selectLimit.mockResolvedValueOnce(rs);
  const where = vi.fn().mockReturnValue({ limit: selectLimit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const insertReturning = vi.fn();
  for (const rs of opts.insertReturnings ?? []) insertReturning.mockResolvedValueOnce(rs);
  const insertValues = vi.fn().mockImplementation(() => {
    const thenable = Promise.resolve(undefined) as Promise<undefined> & {
      returning?: typeof insertReturning;
    };
    thenable.returning = insertReturning;
    return thenable;
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: { select, insert, update } as unknown as DbOrTx,
    spies: { select, insert, insertValues, update, updateSet },
  };
}

const INBOX_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR_ID = '33333333-3333-3333-3333-333333333333';
const BOT_ID = '44444444-4444-4444-4444-444444444444';

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Inbox',
    botLlmApiKeyEnc: null as string | null,
    botLlmProvider: null as string | null,
    defaultBotId: null as string | null,
    deletedAt: null as Date | null,
    ...overrides,
  };
}

function botRow(overrides: Record<string, unknown> = {}) {
  return { id: BOT_ID, name: 'Atlas Assistant', botType: 'builtin', enabled: true, ...overrides };
}

describe('applyAutoBotForInbox', () => {
  it('creates a builtin bot with playbookSource=inline when key + provider are present (no playbook needed)', async () => {
    const { db, spies } = makeDb({
      selectLimits: [[inboxRow()], []],
      insertReturnings: [[{ id: BOT_ID }]],
    });

    const result = await applyAutoBotForInbox(db, {
      inboxId: INBOX_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_ID,
      reason: 'enable',
      newApiKey: 'sk-test-key',
      newProvider: 'anthropic',
    });

    expect(result).toEqual({ action: 'created', botId: BOT_ID });

    // First insert is the bot row, with builtin defaults (D18) + encrypted secret (D16).
    const botValues = spies.insertValues.mock.calls[0]![0] as Record<string, any>;
    expect(botValues.name).toBe('Atlas Assistant');
    expect(botValues.botType).toBe('builtin');
    expect(botValues.enabled).toBe(true);
    expect(typeof botValues.secret).toBe('string');
    expect(botValues.secret.length).toBeGreaterThan(0);
    expect(botValues.config.provider).toBe('anthropic');
    expect(botValues.config.model).toBe('claude-sonnet-4-5-20250929');
    expect(botValues.config.playbookSource).toBe('inline');
    // No playbook read anymore — the prompt is a non-empty builtin default
    // (builtinBotConfigSchema requires systemPrompt.min(1)).
    expect(typeof botValues.config.systemPrompt).toBe('string');
    expect(botValues.config.systemPrompt.length).toBeGreaterThan(0);

    // defaultBotId wired on the inbox.
    const setCalls = spies.updateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(setCalls.some((s) => s.defaultBotId === BOT_ID)).toBe(true);

    // Audit row for the creation.
    const auditValues = spies.insertValues.mock.calls[1]![0] as Record<string, any>;
    expect(auditValues.action).toBe('bot.auto_created');
    expect(auditValues.entityId).toBe(BOT_ID);
  });

  it('never queries inbox_playbooks (exactly two selects: inbox + bot)', async () => {
    const { db, spies } = makeDb({
      selectLimits: [[inboxRow({ botLlmApiKeyEnc: 'enc', botLlmProvider: 'anthropic', defaultBotId: BOT_ID })], [botRow()]],
    });

    await applyAutoBotForInbox(db, {
      inboxId: INBOX_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_ID,
      reason: 'enable',
    });

    expect(spies.select).toHaveBeenCalledTimes(2);
  });

  it('disables the bot and clears columns when the key is removed (newApiKey=null)', async () => {
    const { db, spies } = makeDb({
      selectLimits: [[inboxRow({ botLlmApiKeyEnc: 'enc', botLlmProvider: 'anthropic', defaultBotId: BOT_ID })], [botRow()]],
    });

    const result = await applyAutoBotForInbox(db, {
      inboxId: INBOX_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_ID,
      reason: 'disable',
      newApiKey: null,
      newProvider: null,
    });

    expect(result).toEqual({ action: 'disabled', botId: BOT_ID });
    const setCalls = spies.updateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    // First update clears the key columns.
    expect(setCalls[0]).toMatchObject({ botLlmApiKeyEnc: null, botLlmProvider: null });
    expect(setCalls.some((s) => s.enabled === false)).toBe(true);
    const auditValues = spies.insertValues.mock.calls[0]![0] as Record<string, any>;
    expect(auditValues.action).toBe('bot.auto_disabled');
  });

  it('rotates the secret when a new key is provided for an active bot', async () => {
    const { db, spies } = makeDb({
      selectLimits: [[inboxRow({ botLlmApiKeyEnc: 'old-enc', botLlmProvider: 'anthropic', defaultBotId: BOT_ID })], [botRow()]],
    });

    const result = await applyAutoBotForInbox(db, {
      inboxId: INBOX_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_ID,
      reason: 'rotate-key',
      newApiKey: 'sk-new-key',
      newProvider: 'anthropic',
    });

    expect(result).toEqual({ action: 'updated', botId: BOT_ID });
    const setCalls = spies.updateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const botSet = setCalls.find((s) => s.enabled === true && typeof s.secret === 'string');
    expect(botSet).toBeTruthy();
    const auditValues = spies.insertValues.mock.calls[0]![0] as Record<string, any>;
    expect(auditValues.action).toBe('bot.key_rotated');
  });

  it('disables the bot when the inbox is soft-deleted', async () => {
    const { db, spies } = makeDb({
      selectLimits: [[inboxRow({ botLlmApiKeyEnc: 'enc', botLlmProvider: 'anthropic', defaultBotId: BOT_ID, deletedAt: new Date('2026-06-01T00:00:00Z') })], [botRow()]],
    });

    const result = await applyAutoBotForInbox(db, {
      inboxId: INBOX_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_ID,
      reason: 'inbox-deleted',
    });

    expect(result).toEqual({ action: 'disabled', botId: BOT_ID });
    const auditValues = spies.insertValues.mock.calls[0]![0] as Record<string, any>;
    expect(auditValues.action).toBe('bot.auto_disabled');
    expect(auditValues.changes.reason).toBe('inbox-deleted');
  });

  it('is a no-op when an active bot is unchanged', async () => {
    const { db, spies } = makeDb({
      selectLimits: [[inboxRow({ botLlmApiKeyEnc: 'enc', botLlmProvider: 'anthropic', defaultBotId: BOT_ID })], [botRow()]],
    });

    const result = await applyAutoBotForInbox(db, {
      inboxId: INBOX_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_ID,
      reason: 'enable',
    });

    expect(result).toEqual({ action: 'noop', botId: BOT_ID });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });
});
