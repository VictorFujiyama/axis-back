import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-05: PATCH /api/v1/inboxes/:id accepts playbook + botLlmApiKey + botLlmProvider
// transactionally (D20). applyAutoBotForInbox and validateApiKey are the two
// collaborators; both are mocked so these route tests stay focused on the HTTP
// contract (validation, feature flag, tx wiring) rather than re-testing T-04.

const applyAutoBotMock = vi.fn();
const validateApiKeyMock = vi.fn();

vi.mock('../auto-bot', async () => {
  const actual = await vi.importActual<typeof import('../auto-bot')>('../auto-bot');
  return {
    ...actual,
    applyAutoBotForInbox: (...args: unknown[]) => applyAutoBotMock(...args),
  };
});

vi.mock('../api-key-validator', () => ({
  validateApiKey: (...args: unknown[]) => validateApiKeyMock(...args),
}));

let lastUpdatePatch: Record<string, unknown> | undefined;

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const INBOX_ID = '99999999-8888-4777-8666-555555555555';

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    name: 'Inbox',
    channelType: 'whatsapp',
    config: {},
    secrets: null,
    defaultBotId: null as string | null,
    enabled: true,
    qualifierEnabled: true,
    accountId: TEST_ACCOUNT_ID,
    botLlmApiKeyEnc: null as string | null,
    botLlmProvider: null as string | null,
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    updatedAt: new Date('2026-06-01T10:00:00.000Z'),
    deletedAt: null as Date | null,
    ...overrides,
  };
}

interface DbOptions {
  /** Row returned by the base UPDATE inside the transaction ([] => 404). */
  updateReturning?: unknown[];
  /** Row returned by the post-tx inbox re-read select. */
  freshInbox?: unknown[];
  /** Row returned by the post-tx playbook content select. */
  playbookRow?: unknown[];
  /** When set, applyAutoBotForInbox rejects with this error (rollback test). */
  autoBotError?: Error;
}

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { inboxRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  // Inside-tx surface: update().set().where().returning(), insert/delete for
  // inbox_playbooks, and the audit insert.
  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((patch: Record<string, unknown>) => {
        lastUpdatePatch = patch;
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(options.updateReturning ?? [inboxRow()]),
          }),
        };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    // beforeRow/afterRow defaultBotId reads (bug #A2 backfill) — null keeps the
    // backfill branch inert so these tests stay focused on the HTTP contract.
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ defaultBotId: null }]),
        }),
      }),
    }),
  };

  // Post-tx app.db.select() is used twice: inbox re-read, then playbook content.
  const selectResults = [options.freshInbox ?? [inboxRow()], options.playbookRow ?? []];
  let selectCall = 0;
  const select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(() => Promise.resolve(selectResults[selectCall++] ?? [])),
      }),
    }),
  }));

  // app.db.insert() is used by writeAudit (fire-and-forget).
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  app.decorate('db', {
    transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    select,
    insert,
  } as unknown as FastifyInstance['db']);

  if (options.autoBotError) {
    applyAutoBotMock.mockRejectedValue(options.autoBotError);
  } else {
    applyAutoBotMock.mockResolvedValue({ action: 'created', botId: 'bot-1' });
  }

  await app.register(inboxRoutes);
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'admin@example.com',
    role: 'admin',
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

const VALID_PLAYBOOK = 'You are a helpful sales assistant for our shop.';

describe('PATCH /api/v1/inboxes/:id — playbook + key + provider (T-05)', () => {
  beforeEach(() => {
    applyAutoBotMock.mockReset();
    validateApiKeyMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies playbook + key + provider via applyAutoBotForInbox (happy)', async () => {
    const app = await buildTestApp({
      freshInbox: [inboxRow({ botLlmApiKeyEnc: 'enc', botLlmProvider: 'anthropic', defaultBotId: 'bot-1' })],
      playbookRow: [{ content: VALID_PLAYBOOK }],
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { playbook: VALID_PLAYBOOK, botLlmApiKey: 'sk-test', botLlmProvider: 'anthropic' },
      });
      expect(res.statusCode).toBe(200);
      expect(applyAutoBotMock).toHaveBeenCalledTimes(1);
      const callArg = applyAutoBotMock.mock.calls[0]![1] as Record<string, unknown>;
      expect(callArg).toMatchObject({
        inboxId: INBOX_ID,
        accountId: TEST_ACCOUNT_ID,
        newApiKey: 'sk-test',
        newProvider: 'anthropic',
        reason: 'rotate-key',
      });
      const json = res.json();
      expect(json.botLlmApiKeyConfigured).toBe(true);
      expect(json.botLlmProvider).toBe('anthropic');
      expect(json.playbook).toBe(VALID_PLAYBOOK);
    } finally {
      await app.close();
    }
  });

  it('rejects a too-short playbook (< 20 chars) and a too-long one with 400', async () => {
    const app = await buildTestApp();
    try {
      const short = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { playbook: 'too short' },
      });
      expect(short.statusCode).toBe(400);

      const long = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { playbook: 'a'.repeat(10001) },
      });
      expect(long.statusCode).toBe(400);
      expect(applyAutoBotMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects key without provider with 400 (both-or-neither)', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { botLlmApiKey: 'sk-test' },
      });
      expect(res.statusCode).toBe(400);
      expect(applyAutoBotMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('calls validateApiKey when ?validateKey=true and rejects an auth failure', async () => {
    validateApiKeyMock.mockResolvedValue({ ok: false, kind: 'auth', message: 'invalid api key' });
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}?validateKey=true`,
        headers: { authorization: authHeader(app) },
        payload: { playbook: VALID_PLAYBOOK, botLlmApiKey: 'sk-bad', botLlmProvider: 'openai' },
      });
      expect(res.statusCode).toBe(400);
      expect(validateApiKeyMock).toHaveBeenCalledTimes(1);
      expect(validateApiKeyMock).toHaveBeenCalledWith('openai', 'sk-bad', expect.any(String));
      // Validation runs before the transaction → applyAutoBot never reached.
      expect(applyAutoBotMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('surfaces an applyAutoBotForInbox failure out of the transaction (rollback)', async () => {
    // A throw inside the tx callback rejects the transaction → real drizzle
    // rolls back. Here we assert the error escapes (no swallow) so nothing is
    // returned as success.
    const app = await buildTestApp({ autoBotError: new Error('boom') });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { playbook: VALID_PLAYBOOK, botLlmApiKey: 'sk-test', botLlmProvider: 'anthropic' },
      });
      expect(res.statusCode).toBe(500);
      expect(applyAutoBotMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('accepts qualifierEnabled=false, persists it and returns it in the response', async () => {
    const app = await buildTestApp({
      updateReturning: [inboxRow({ qualifierEnabled: false })],
      freshInbox: [inboxRow({ qualifierEnabled: false })],
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { qualifierEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      // The flag reached the UPDATE (not silently discarded by the zod schema).
      expect(lastUpdatePatch).toMatchObject({ qualifierEnabled: false });
      expect(res.json().qualifierEnabled).toBe(false);
      // Plain flag toggle — no playbook feature involvement.
      expect(applyAutoBotMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 400 when the feature flag is off and a playbook field is sent', async () => {
    const { config } = await import('../../../config');
    const prev = config.PLAYBOOK_IN_AXIS_ENABLED;
    (config as { PLAYBOOK_IN_AXIS_ENABLED: boolean }).PLAYBOOK_IN_AXIS_ENABLED = false;
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
        payload: { playbook: VALID_PLAYBOOK },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('feature disabled');
      expect(applyAutoBotMock).not.toHaveBeenCalled();
    } finally {
      (config as { PLAYBOOK_IN_AXIS_ENABLED: boolean }).PLAYBOOK_IN_AXIS_ENABLED = prev;
      await app.close();
    }
  });
});
