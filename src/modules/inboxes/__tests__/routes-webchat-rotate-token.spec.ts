import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decryptJSON } from '../../../crypto';

// T-07: POST /api/v1/inboxes/:id/webchat/rotate-token regenerates the public
// widgetToken (and optionally the hmacToken secret) for a webchat inbox. Scoped
// to inbox members; rejects non-webchat inboxes.

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const INBOX_ID = '99999999-8888-4777-8666-555555555555';

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: 'wt_old', primaryColor: '#7b3fa9' },
    secrets: null as string | null,
    defaultBotId: null as string | null,
    enabled: true,
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
  /** Row(s) returned by the inbox lookup select ([] => 404). */
  inbox?: unknown[];
  /** Row(s) returned by the UPDATE returning() ([] => 404). */
  updateReturning?: unknown[];
  /** Member inbox ids returned for non-admin membership check. */
  memberInboxIds?: string[];
  /** Captures the values passed to update().set(). */
  capture?: { set?: Record<string, unknown> };
}

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { inboxRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  // select() is used by: the inbox lookup (.limit(1)) and the membership lookup
  // (.from().innerJoin().where() awaited directly). One chainable thenable serves
  // both: limit() resolves the inbox row, awaiting the chain resolves member rows.
  const inboxResult = options.inbox ?? [inboxRow()];
  const memberRows = (options.memberInboxIds ?? []).map((inboxId) => ({ inboxId }));
  const select = vi.fn().mockImplementation(() => {
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.innerJoin = () => q;
    q.where = () => q;
    q.limit = () => Promise.resolve(inboxResult);
    q.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(memberRows).then(onF, onR);
    return q;
  });

  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
      if (options.capture) options.capture.set = values;
      return {
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(options.updateReturning ?? [inboxRow()]),
        }),
      };
    }),
  });

  // writeAudit (fire-and-forget) inserts via app.db.insert().
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  app.decorate('db', { select, update, insert } as unknown as FastifyInstance['db']);

  await app.register(inboxRoutes);
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance, role: 'admin' | 'agent' = 'admin'): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'user@example.com',
    role,
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

describe('POST /api/v1/inboxes/:id/webchat/rotate-token (T-07)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rotates the widget token and persists a fresh wt_ value', async () => {
    const capture: { set?: Record<string, unknown> } = {};
    const app = await buildTestApp({ capture });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inboxes/${INBOX_ID}/webchat/rotate-token`,
        headers: { authorization: authHeader(app) },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.widgetToken).toMatch(/^wt_[a-f0-9]{48}$/);
      expect(json.widgetToken).not.toBe('wt_old');
      expect(json.rotatedHmac).toBe(false);
      const persisted = (capture.set?.config as Record<string, unknown>).widgetToken;
      expect(persisted).toBe(json.widgetToken);
      // unrelated config keys are preserved
      expect((capture.set?.config as Record<string, unknown>).primaryColor).toBe('#7b3fa9');
      // secrets untouched when rotateHmac is absent
      expect(capture.set?.secrets).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('also rotates the hmacToken secret when rotateHmac=true', async () => {
    const capture: { set?: Record<string, unknown> } = {};
    const app = await buildTestApp({ capture });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inboxes/${INBOX_ID}/webchat/rotate-token`,
        headers: { authorization: authHeader(app) },
        payload: { rotateHmac: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rotatedHmac).toBe(true);
      const secretsBlob = capture.set?.secrets as string;
      expect(typeof secretsBlob).toBe('string');
      const decoded = decryptJSON<{ hmacToken?: string }>(secretsBlob);
      expect(decoded.hmacToken).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for a missing inbox', async () => {
    const app = await buildTestApp({ inbox: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inboxes/${INBOX_ID}/webchat/rotate-token`,
        headers: { authorization: authHeader(app) },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 400 for a non-webchat inbox', async () => {
    const app = await buildTestApp({ inbox: [inboxRow({ channelType: 'whatsapp' })] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inboxes/${INBOX_ID}/webchat/rotate-token`,
        headers: { authorization: authHeader(app) },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('forbids a non-member agent', async () => {
    const app = await buildTestApp({ memberInboxIds: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inboxes/${INBOX_ID}/webchat/rotate-token`,
        headers: { authorization: authHeader(app, 'agent') },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('requires authentication', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inboxes/${INBOX_ID}/webchat/rotate-token`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
