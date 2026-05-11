import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import { schema, type DB } from '@blossom/db';

import { processBuiltinBot, type ProcessInput } from '../builtin-processor';
import { fetchPlaybook } from '../playbook-fetcher';
import { callLLM } from '../llm-client';

vi.mock('../playbook-fetcher', () => ({
  fetchPlaybook: vi.fn(),
}));

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

const mockedFetchPlaybook = vi.mocked(fetchPlaybook);
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
const REMOTE_MARKDOWN = '# Remote Playbook\nYou are a REMOTE-FIXTURE assistant.';

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
  /** When set, the FIRST insert whose values.event matches this string rejects. */
  rejectInsertForEvent?: string;
}

function buildDb(opts: BuildDbOpts): DbMock {
  const conv = opts.conv ?? makeConvRow();
  const history = opts.history ?? makeHistoryRow();
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];

  // SELECT chain — three terminal `.limit(...)` calls (conversation, bot, history).
  const limit = vi
    .fn()
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
  let rejectedOnce = false;
  const insert = vi.fn().mockImplementation((table: unknown) => {
    return {
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ table, values });
        const shouldReject =
          opts.rejectInsertForEvent !== undefined &&
          !rejectedOnce &&
          values['event'] === opts.rejectInsertForEvent;
        if (shouldReject) rejectedOnce = true;
        const promise = shouldReject
          ? Promise.reject(new Error('bot_events insert simulated failure'))
          : Promise.resolve([{ id: 'inserted-row' }]);
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
  // messages insert, keeping the test focused on the playbook/llm path.
  const updateReturning = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  return {
    db: { select, insert, update } as unknown as DB,
    insertCalls,
  };
}

function makeApp(): { redis: Redis; log: FastifyBaseLogger; logWarn: ReturnType<typeof vi.fn> } {
  const logWarn = vi.fn();
  return {
    redis: {} as unknown as Redis,
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

describe('processBuiltinBot — playbook integration', () => {
  beforeEach(() => {
    mockedFetchPlaybook.mockReset();
    mockedCallLLM.mockReset();
    mockedCallLLM.mockResolvedValue({
      content: 'bot reply',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
  });

  it('(a) playbookSource defaults to inline: callLLM uses cfg.systemPrompt and no playbook_fetch event is logged', async () => {
    // `playbookSource` omitted → zod default 'inline' kicks in at parseBuiltinConfig.
    const { db, insertCalls } = buildDb({ bot: makeBotRow(makeBaseConfig()) });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log, redis: app.redis });

    expect(mockedFetchPlaybook).not.toHaveBeenCalled();
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(INLINE_PROMPT);
    expect(findPlaybookFetchInsert(insertCalls)).toBeUndefined();
  });

  it("(b) playbookSource 'atlas' + fetch returns 200: callLLM uses remote markdown and event payload records success", async () => {
    mockedFetchPlaybook.mockResolvedValue({
      markdown: REMOTE_MARKDOWN,
      source: 'atlas-fresh',
      etag: 'abcdef1234567890',
    });
    const { db, insertCalls } = buildDb({
      bot: makeBotRow(makeBaseConfig({ playbookSource: 'atlas' })),
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log, redis: app.redis });

    expect(mockedFetchPlaybook).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(REMOTE_MARKDOWN);

    const evt = findPlaybookFetchInsert(insertCalls);
    expect(evt).toBeDefined();
    expect(evt!['event']).toBe('playbook_fetch');
    expect(evt!['status']).toBe('success');
    expect(evt!['direction']).toBe('outbound');
    expect(evt!['accountId']).toBe(INPUT.accountId);
    const payload = evt!['payload'] as Record<string, unknown>;
    expect(payload['source']).toBe('atlas-fresh');
    expect(payload['fallback']).toBe(false);
    // Spec: etag truncated to 8 chars in the payload, not 16.
    expect(payload['etag']).toBe('abcdef12');
  });

  it("(c) playbookSource 'atlas' + fetch returns null: falls back to cfg.systemPrompt with payload.reason='returned-null'", async () => {
    mockedFetchPlaybook.mockResolvedValue(null);
    const { db, insertCalls } = buildDb({
      bot: makeBotRow(makeBaseConfig({ playbookSource: 'atlas' })),
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log, redis: app.redis });

    expect(mockedFetchPlaybook).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(INLINE_PROMPT);

    const evt = findPlaybookFetchInsert(insertCalls);
    expect(evt).toBeDefined();
    expect(evt!['status']).toBe('failed');
    const payload = evt!['payload'] as Record<string, unknown>;
    expect(payload['fallback']).toBe(true);
    expect(payload['reason']).toBe('returned-null');
    expect(payload['errorPreview']).toBeUndefined();
  });

  it("(d) playbookSource 'atlas' + fetcher throws: falls back to cfg.systemPrompt with payload.reason='threw'", async () => {
    mockedFetchPlaybook.mockRejectedValue(new Error('boom: unexpected failure'));
    const { db, insertCalls } = buildDb({
      bot: makeBotRow(makeBaseConfig({ playbookSource: 'atlas' })),
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log, redis: app.redis });

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(INLINE_PROMPT);

    const evt = findPlaybookFetchInsert(insertCalls);
    expect(evt).toBeDefined();
    expect(evt!['status']).toBe('failed');
    const payload = evt!['payload'] as Record<string, unknown>;
    expect(payload['fallback']).toBe(true);
    expect(payload['reason']).toBe('threw');
    expect(payload['errorPreview']).toBe('boom: unexpected failure');
  });

  it("(e) playbookSource 'atlas' + bot_events insert throws: bot still calls LLM and logs warn", async () => {
    mockedFetchPlaybook.mockResolvedValue({
      markdown: REMOTE_MARKDOWN,
      source: 'atlas-fresh',
      etag: 'abcdef1234567890',
    });
    const { db, insertCalls } = buildDb({
      bot: makeBotRow(makeBaseConfig({ playbookSource: 'atlas' })),
      // Make the playbook_fetch bot_events insert reject; llm_call insert succeeds.
      rejectInsertForEvent: 'playbook_fetch',
    });
    const app = makeApp();

    await processBuiltinBot(INPUT, { db, log: app.log, redis: app.redis });

    // The .catch on the insert swallows the rejection and surfaces it via log.warn.
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0]![0].systemPrompt).toBe(REMOTE_MARKDOWN);

    const warnCall = app.logWarn.mock.calls.find(
      (call) => call[1] === 'bot_events insert failed (playbook_fetch)',
    );
    expect(warnCall).toBeDefined();

    // Confirm the playbook_fetch row was attempted (even though it rejected),
    // so the caller-side bookkeeping ran.
    expect(findPlaybookFetchInsert(insertCalls)).toBeDefined();
    // schema.botEvents is the table for the playbook_fetch insert.
    const fetchInsert = insertCalls.find(
      (c) => (c.values as Record<string, unknown>)['event'] === 'playbook_fetch',
    );
    expect(fetchInsert!.table).toBe(schema.botEvents);
  });
});
