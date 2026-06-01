import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-08: DELETE /api/v1/inboxes/:id soft-deletes the inbox and, in the same
// transaction, fires applyAutoBotForInbox with reason 'inbox-deleted' (D33).
// The CASCADE FK doesn't run on a soft-delete, so the auto-bot is what disables
// the builtin bot + clears defaultBotId. applyAutoBotForInbox is mocked here so
// the test stays focused on the route wiring (T-04 already covers its behaviour).

const applyAutoBotMock = vi.fn();

vi.mock('../auto-bot', async () => {
  const actual = await vi.importActual<typeof import('../auto-bot')>('../auto-bot');
  return {
    ...actual,
    applyAutoBotForInbox: (...args: unknown[]) => applyAutoBotMock(...args),
  };
});

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
    defaultBotId: 'bot-1' as string | null,
    enabled: true,
    accountId: TEST_ACCOUNT_ID,
    botLlmApiKeyEnc: 'enc' as string | null,
    botLlmProvider: 'anthropic' as string | null,
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    updatedAt: new Date('2026-06-01T10:00:00.000Z'),
    deletedAt: new Date('2026-06-01T11:00:00.000Z') as Date | null,
    ...overrides,
  };
}

interface DbOptions {
  /** Row returned by the soft-delete UPDATE inside the transaction ([] => 404). */
  updateReturning?: unknown[];
}

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { inboxRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(options.updateReturning ?? [inboxRow()]),
        }),
      }),
    }),
  };

  // app.db.insert() is used by writeAudit (fire-and-forget).
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  app.decorate('db', {
    transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    insert,
  } as unknown as FastifyInstance['db']);

  applyAutoBotMock.mockResolvedValue({ action: 'disabled', botId: 'bot-1' });

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

describe('DELETE /api/v1/inboxes/:id — soft-delete disables auto-bot (T-08)', () => {
  beforeEach(() => {
    applyAutoBotMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fires applyAutoBotForInbox(reason: inbox-deleted) inside the tx', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(204);
      expect(applyAutoBotMock).toHaveBeenCalledTimes(1);
      const callArg = applyAutoBotMock.mock.calls[0]![1] as Record<string, unknown>;
      expect(callArg).toMatchObject({
        inboxId: INBOX_ID,
        accountId: TEST_ACCOUNT_ID,
        actorUserId: TEST_USER_ID,
        reason: 'inbox-deleted',
      });
    } finally {
      await app.close();
    }
  });

  it('returns 404 and never touches the auto-bot when the inbox is missing', async () => {
    const app = await buildTestApp({ updateReturning: [] });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/inboxes/${INBOX_ID}`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(404);
      expect(applyAutoBotMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
