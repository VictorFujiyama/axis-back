import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@blossom/shared-types';

// T-A.3: POST /api/v1/inbox-playbooks/:inboxId/version — save a new playbook
// version with optimistic concurrency via etag. DB is mocked (repo convention
// for route specs); the real schema behavior is covered by the T-A.1 schema
// integration test.

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const INBOX_ID = '99999999-8888-4777-8666-555555555555';

const CONTENT = 'Você é o Yuji, assistente de vendas. Seja objetivo e amigável.';

/** Awaitable query-builder chain: every builder method returns itself, and
 * awaiting it resolves `result`. */
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'for', 'innerJoin', 'leftJoin']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

interface DbOptions {
  /** Result of the pre-tx inbox scope check ([] => 404). */
  inboxRow?: unknown[];
  /** Result of the in-tx playbook SELECT ... FOR UPDATE ([] => first version). */
  playbookRow?: unknown[];
}

function currentPlaybook(overrides: Record<string, unknown> = {}) {
  return {
    inboxId: INBOX_ID,
    content: 'old content',
    etag: 'etag-current-123',
    version: 4,
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

const versionInsertValues = vi.fn();
const playbookUpsertValues = vi.fn();
const onConflictDoUpdate = vi.fn();

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { inboxPlaybookRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  const selectResults = [options.inboxRow ?? [{ id: INBOX_ID }]];
  let selectCall = 0;
  const dbSelect = vi
    .fn()
    .mockImplementation(() => chain(selectResults[selectCall++] ?? []));

  const txSelectResults = [options.playbookRow ?? []];
  let txSelectCall = 0;
  const tx = {
    select: vi.fn().mockImplementation(() => chain(txSelectResults[txSelectCall++] ?? [])),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        // Two inserts happen in-tx: version row (plain await) and playbook
        // upsert (.onConflictDoUpdate). Route both through capture mocks.
        const c = chain(undefined);
        c.onConflictDoUpdate = (arg: unknown) => {
          onConflictDoUpdate(arg);
          playbookUpsertValues(vals);
          return chain(undefined);
        };
        versionInsertValues(vals);
        return c;
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(chain(undefined)) }),
    })),
  };

  // app.db.insert is used by writeAudit (fire-and-forget).
  const dbInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  app.decorate('db', {
    select: dbSelect,
    insert: dbInsert,
    transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as FastifyInstance['db']);

  await app.register(inboxPlaybookRoutes);
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance, role: UserRole = 'admin'): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'admin@example.com',
    role,
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

describe('POST /api/v1/inbox-playbooks/:inboxId/version (T-A.3)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates version 1 when the inbox has no playbook yet (no etag)', async () => {
    const app = await buildTestApp({ playbookRow: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app) },
        payload: { content: CONTENT },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.version).toBe(1);
      expect(json.playbook).toMatchObject({ inboxId: INBOX_ID, content: CONTENT, version: 1 });
      expect(json.playbook.etag).toHaveLength(16);
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxId: INBOX_ID,
          version: 1,
          content: CONTENT,
          createdBy: TEST_USER_ID,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('bumps to current+1 when the etag matches', async () => {
    const app = await buildTestApp({ playbookRow: [currentPlaybook()] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app) },
        payload: { content: CONTENT, etag: 'etag-current-123', note: 'ajuste de tom' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.version).toBe(5);
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ version: 5, note: 'ajuste de tom' }),
      );
      expect(playbookUpsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ inboxId: INBOX_ID, content: CONTENT }),
      );
    } finally {
      await app.close();
    }
  });

  it('returns 409 when the etag is stale', async () => {
    const app = await buildTestApp({ playbookRow: [currentPlaybook()] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app) },
        payload: { content: CONTENT, etag: 'etag-stale-999' },
      });
      expect(res.statusCode).toBe(409);
      expect(versionInsertValues).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 409 when a playbook exists but no etag was sent', async () => {
    const app = await buildTestApp({ playbookRow: [currentPlaybook()] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app) },
        payload: { content: CONTENT },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an inbox outside the account', async () => {
    const app = await buildTestApp({ inboxRow: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app) },
        payload: { content: CONTENT },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects a too-short content with 400', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app) },
        payload: { content: 'curto' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('requires the admin role', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/version`,
        headers: { authorization: authHeader(app, 'agent') },
        payload: { content: CONTENT },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
