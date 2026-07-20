import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-A.4: GET /api/v1/inbox-playbooks/:inboxId/versions (keyset, desc) and
// POST /api/v1/inbox-playbooks/:inboxId/revert (new version with old content).

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const INBOX_ID = '99999999-8888-4777-8666-555555555555';

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'for', 'innerJoin', 'leftJoin']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

function versionRow(version: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
    version,
    content: `conteúdo do playbook na versão ${version}`,
    note: null,
    createdBy: TEST_USER_ID,
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    ...overrides,
  };
}

function currentPlaybook(version = 3) {
  return {
    inboxId: INBOX_ID,
    content: `conteúdo do playbook na versão ${version}`,
    etag: 'etag-current-123',
    version,
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

interface DbOptions {
  /** Pre-tx inbox scope check ([] => 404). */
  inboxRow?: unknown[];
  /** GET: rows returned by the versions listing select. */
  versionRows?: unknown[];
  /** Revert: in-tx select results, in call order (playbook FOR UPDATE, then target version). */
  txSelects?: unknown[][];
}

const versionInsertValues = vi.fn();
const playbookUpdateSet = vi.fn();

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { inboxPlaybookRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  const selectResults = [options.inboxRow ?? [{ id: INBOX_ID }], options.versionRows ?? []];
  let selectCall = 0;
  const dbSelect = vi
    .fn()
    .mockImplementation(() => chain(selectResults[selectCall++] ?? []));

  const txSelects = options.txSelects ?? [];
  let txSelectCall = 0;
  const tx = {
    select: vi.fn().mockImplementation(() => chain(txSelects[txSelectCall++] ?? [])),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        versionInsertValues(vals);
        return chain(undefined);
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((vals: unknown) => {
        playbookUpdateSet(vals);
        return { where: vi.fn().mockReturnValue(chain(undefined)) };
      }),
    })),
  };

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

function authHeader(app: FastifyInstance): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'admin@example.com',
    role: 'admin',
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

describe('GET /api/v1/inbox-playbooks/:inboxId/versions (T-A.4)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists versions and reports nextCursor=null when the page is not full', async () => {
    const app = await buildTestApp({ versionRows: [versionRow(3), versionRow(2), versionRow(1)] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/versions`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
      expect(json.nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns nextCursor when more pages exist (limit+1 fetched)', async () => {
    // limit=2 → route fetches 3; the extra row signals another page.
    const app = await buildTestApp({ versionRows: [versionRow(5), versionRow(4), versionRow(3)] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/versions?limit=2`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.versions.map((v: { version: number }) => v.version)).toEqual([5, 4]);
      expect(json.nextCursor).toBe(4);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an inbox outside the account', async () => {
    const app = await buildTestApp({ inboxRow: [] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/versions`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/v1/inbox-playbooks/:inboxId/revert (T-A.4)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a NEW version with the old content and a revert note', async () => {
    const app = await buildTestApp({
      txSelects: [[currentPlaybook(3)], [versionRow(1)]],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/revert`,
        headers: { authorization: authHeader(app) },
        payload: { toVersion: 1 },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.version).toBe(4);
      expect(json.playbook.content).toBe('conteúdo do playbook na versão 1');
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxId: INBOX_ID,
          version: 4,
          content: 'conteúdo do playbook na versão 1',
          note: 'Revertido da v1',
          createdBy: TEST_USER_ID,
        }),
      );
      expect(playbookUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'conteúdo do playbook na versão 1', version: 4 }),
      );
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the target version does not exist', async () => {
    const app = await buildTestApp({ txSelects: [[currentPlaybook(3)], []] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/revert`,
        headers: { authorization: authHeader(app) },
        payload: { toVersion: 99 },
      });
      expect(res.statusCode).toBe(404);
      expect(versionInsertValues).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the inbox has no playbook at all', async () => {
    const app = await buildTestApp({ txSelects: [[]] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/revert`,
        headers: { authorization: authHeader(app) },
        payload: { toVersion: 1 },
      });
      expect(res.statusCode).toBe(404);
      expect(versionInsertValues).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-positive toVersion with 400', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/inbox-playbooks/${INBOX_ID}/revert`,
        headers: { authorization: authHeader(app) },
        payload: { toVersion: 0 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
