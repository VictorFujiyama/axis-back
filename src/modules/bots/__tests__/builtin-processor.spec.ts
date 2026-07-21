import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '@blossom/db';

import { processBuiltinBot, type ProcessInput } from '../builtin-processor';
import { callLLM } from '../llm-client';

vi.mock('../llm-client', () => ({
  callLLM: vi.fn(),
  resolveApiKey: vi.fn().mockReturnValue('sk-test'),
}));

vi.mock('../../../crypto', () => ({
  decryptJSON: vi.fn().mockReturnValue('sk-test'),
}));

// emitEvent is a side effect we don't want firing during these unit tests —
// `insertBotMessage` calls it after a successful message insert.
vi.mock('../../../realtime/event-bus', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

const mockedCallLLM = vi.mocked(callLLM);

const INPUT: ProcessInput = {
  conversationId: 'conv-1',
  inboxId: '00000000-0000-4000-8000-000000000001',
  contactId: 'contact-1',
  newMessageId: 'msg-new-1',
  botId: 'bot-1',
  accountId: 'acc-1',
};

const INLINE_PROMPT = 'You are an INLINE-FIXTURE assistant.';

function makeBaseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt: INLINE_PROMPT,
    ...overrides,
  };
}

function makeBotRow(config: Record<string, unknown>) {
  return {
    id: INPUT.botId,
    accountId: INPUT.accountId,
    enabled: true,
    botType: 'builtin',
    secret: 'encrypted-secret-placeholder',
    config,
  };
}

function makeConvRow() {
  return {
    id: INPUT.conversationId,
    assignedBotId: INPUT.botId,
  };
}

function makeHistoryRow(): Array<Record<string, unknown>> {
  // Single contact message — newMessage lookup uses `id === input.newMessageId`.
  return [
    {
      id: INPUT.newMessageId,
      conversationId: INPUT.conversationId,
      content: 'hello bot',
      senderType: 'contact',
      isPrivateNote: false,
    },
  ];
}

interface DbMock {
  db: DB;
  insertCalls: Array<{ table: unknown; values: unknown }>;
}

interface BuildDbOpts {
  conv?: unknown;
  bot: unknown;
  history?: unknown[];
}

function buildDb(opts: BuildDbOpts): DbMock {
  const conv = opts.conv ?? makeConvRow();
  const history = opts.history ?? makeHistoryRow();
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];

  // SELECT chain — terminal `.limit(...)` calls, in invocation order:
  // conversation, bot, history.
  const limit = vi.fn();
  limit
    .mockResolvedValueOnce([conv])
    .mockResolvedValueOnce([opts.bot])
    .mockResolvedValueOnce(history);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ limit, orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  // INSERT chain — values() returns a thenable that's also `.returning()`-able,
  // so both `await insert.values(...).catch(...)` (bot_events) and
  // `await insert.values(...).returning()` (messages) work.
  const insert = vi.fn().mockImplementation((table: unknown) => {
    return {
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ table, values });
        const promise = Promise.resolve([{ id: 'inserted-row' }]);
        return {
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
          finally: promise.finally.bind(promise),
          returning: vi.fn().mockResolvedValue([{ id: 'inserted-row' }]),
        };
      },
    };
  });

  // UPDATE chain — returning() returns [] so insertBotMessage exits before the
  // messages insert, keeping the test focused on the llm path.
  const updateReturning = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  return {
    db: { select, insert, update } as unknown as DB,
    insertCalls,
  };
}

function makeApp(): { log: FastifyBaseLogger; logWarn: ReturnType<typeof vi.fn> } {
  const logWarn = vi.fn();
  return {
    log: {
      warn: logWarn,
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as FastifyBaseLogger,
    logWarn,
  };
}

function findPlaybookFetchInsert(
  insertCalls: Array<{ table: unknown; values: unknown }>,
): Record<string, unknown> | undefined {
  const hit = insertCalls.find((c) => (c.values as Record<string, unknown>)['event'] === 'playbook_fetch');
  return hit?.values as Record<string, unknown> | undefined;
}

describe('processBuiltinBot — system prompt (single inline path)', () => {
  beforeEach(() => {
    mockedCallLLM.mockReset();
    mockedCallLLM.mockResolvedValue({
      content: 'bot reply',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
  });

  it('callLLM usa cfg.systemPrompt direto e nenhum evento playbook_fetch é gravado', async () => {
    const { db, insertCalls } = buildDb({ bot: makeBotRow(makeBaseConfig()) });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log });

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(INLINE_PROMPT);
    expect(findPlaybookFetchInsert(insertCalls)).toBeUndefined();
  });

  it("config legado com playbookSource 'atlas' é ignorado: cfg.systemPrompt direto, sem lookup", async () => {
    const { db, insertCalls } = buildDb({
      bot: makeBotRow(makeBaseConfig({ playbookSource: 'atlas' })),
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log });

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(INLINE_PROMPT);
    expect(findPlaybookFetchInsert(insertCalls)).toBeUndefined();
  });

  it("config legado com playbookSource 'local' é ignorado: cfg.systemPrompt direto, sem select em inbox_playbooks", async () => {
    const { db, insertCalls } = buildDb({
      bot: makeBotRow(makeBaseConfig({ playbookSource: 'local' })),
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log });

    // buildDb wires exactly 3 selects (conversation, bot, history); an extra
    // inbox_playbooks lookup would shift the history rows and break the run.
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(INLINE_PROMPT);
    expect(findPlaybookFetchInsert(insertCalls)).toBeUndefined();
  });
});

describe('processBuiltinBot — greeting message (bug #A3 regression guard)', () => {
  beforeEach(() => {
    mockedCallLLM.mockReset();
    mockedCallLLM.mockResolvedValue({
      content: 'bot reply from LLM',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
  });

  it('greeting-only turn: returns after greeting insert WITHOUT calling LLM (previously fell through → 2 bot messages)', async () => {
    // Setup: config has greetingMessage, history only carries the contact's
    // brand-new msg (0 prior bot msgs) → greeting branch fires. Before the
    // fix, the function fell through to the LLM path and inserted a SECOND
    // bot msg for the same inbound. See E2E Yuji-182 2026-07-14
    // (19:37:02.608 + 19:37:02.851, 243ms apart). The observable behavior
    // that guards this is that the LLM was NOT called at all on the
    // greeting-only turn.
    const { db } = buildDb({
      bot: makeBotRow(makeBaseConfig({ greetingMessage: 'Olá! Como posso ajudar?' })),
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log });

    // Critical assertion: LLM never called on the first-inbound greeting turn.
    // If the guard `return` after greeting is removed, this fails with
    // `expected 0 to be 0` → `expected 1 to be 0`.
    expect(mockedCallLLM).not.toHaveBeenCalled();
  });

  it('follow-up turn: greeting condition (botMessages.length === 0) is false → LLM path fires', async () => {
    // History carries a prior bot msg + a NEW contact msg. Greeting condition
    // is false, so the function skips section 4 and reaches the LLM path.
    // This test confirms the fix does NOT break follow-up interactions
    // (greeting is not accidentally repeated).
    const history = [
      { id: 'prior-bot-msg', conversationId: INPUT.conversationId, content: 'Olá!', senderType: 'bot', isPrivateNote: false },
      { id: INPUT.newMessageId, conversationId: INPUT.conversationId, content: 'segunda pergunta', senderType: 'contact', isPrivateNote: false },
    ];
    const { db } = buildDb({
      bot: makeBotRow(makeBaseConfig({ greetingMessage: 'Olá! Como posso ajudar?' })),
      history,
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log });

    // Critical assertion: LLM called exactly once on follow-up (not zero,
    // not two).
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
  });
});
