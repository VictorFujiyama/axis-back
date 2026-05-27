import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signRequest, type ConnectorEvent } from '@atlas/connectors';
import type { DB } from '@blossom/db';

// T-014/T-06: GET /atlas-connector/backfill. The HMAC/gating/cursor-validation
// paths are exercised through a real Fastify app (dynamic-import + stubEnv,
// L-418 / T-012 precedent); the cursor-walk + contacts-first + anti-leak logic
// is unit-tested against `backfillPage` with a chainable mock db + injected
// builders so we don't have to mock the T-004a builders' own queries.
//
// Per-account (T-06): the route resolves the HMAC secret + account + org from
// the connection keyed by the signed `x-atlas-org-id` header. We mock
// `getConnectionByOrg` (enqueue.spec pattern) — connected for ATLAS_ORG_ID,
// unknown otherwise — so a `verifyRequest` against the connection's secret runs
// without DB/crypto.
//
// `signRequest` is a pure value fn (no L-617 instanceof trap) — importing the
// top-level SDK copy is fine.

const TEST_SECRET = 'test-atlas-hmac-secret-' + 'a'.repeat(32);
const ATLAS_ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const ACCOUNT_ID = '33333333-4444-5555-6666-777777777777';

// Per-account connection store (T-06). Mock so the route resolves a per-org
// secret/account/org without DB or crypto.
const connectionsMock = vi.hoisted(() => ({ getConnectionByOrg: vi.fn() }));
vi.mock('../../atlas-events/connections', () => connectionsMock);

/** A decrypted `atlas_connections` view (what `getConnectionByOrg` returns). */
function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atlas-conn-1',
    atlasAccountId: ACCOUNT_ID,
    atlasOrgId: ATLAS_ORG_ID,
    status: 'active' as const,
    secrets: { hmacSecret: TEST_SECRET, mcpBearer: 'mcp-bearer-xyz' },
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

type Row = { id: string; createdAt: Date; conversationId?: string };
const crow = (id: string, iso: string): Row => ({ id, createdAt: new Date(iso) });
const mrow = (id: string, iso: string, conversationId: string): Row => ({
  id,
  createdAt: new Date(iso),
  conversationId,
});

/** Mock select→from→where→orderBy→limit; limit() resolves the canned rows and
 * captures the where condition so anti-leak filtering can be asserted. */
function makeWalkDb(rows: Row[]) {
  const whereConds: unknown[] = [];
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn((cond: unknown) => (whereConds.push(cond), { orderBy }));
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DB, whereConds, limit };
}

const fakeContact = (id: string) =>
  Promise.resolve({ event_id: `contact_${id}`, kind: 'contact' } as unknown as ConnectorEvent);
const fakeTurn = (i: { conversationId: string; messageId: string }) =>
  Promise.resolve({
    event_id: `msg_${i.messageId}`,
    kind: 'conversation_turn',
    source_ref: { id: i.messageId, parent_id: i.conversationId },
  } as unknown as ConnectorEvent);

async function buildTestApp(opts: {
  buildContact?: typeof fakeContact;
  buildTurn?: typeof fakeTurn;
  db?: DB;
}): Promise<FastifyInstance> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const { atlasBackfillRoutes } = await import('../backfill-routes.js');
  const app = Fastify({ logger: false });
  app.decorate('db', opts.db ?? ({} as DB));
  await app.register(atlasBackfillRoutes, {
    buildContact: opts.buildContact,
    buildTurn: opts.buildTurn,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // Boot precheck still requires these when enabled (the route no longer reads
  // them — T-10 removes them from config).
  vi.stubEnv('ATLAS_CONNECTOR_ENABLED', 'true');
  vi.stubEnv('ATLAS_URL', 'https://atlas-company-os.vercel.app');
  vi.stubEnv('ATLAS_ORG_ID', ATLAS_ORG_ID);
  vi.stubEnv('ATLAS_HMAC_SECRET', TEST_SECRET);
  vi.stubEnv('ATLAS_SOURCE_ACCOUNT_ID', ACCOUNT_ID);
  // Per-org connection lookup: connected for ATLAS_ORG_ID, unknown otherwise.
  connectionsMock.getConnectionByOrg.mockReset();
  connectionsMock.getConnectionByOrg.mockImplementation(async (_db: unknown, org: string) =>
    org === ATLAS_ORG_ID ? fakeConnection() : null,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function signedHeaders() {
  const { signature, orgIdHeader } = signRequest('', ATLAS_ORG_ID, TEST_SECRET);
  return { 'x-atlas-signature': signature, 'x-atlas-org-id': orgIdHeader };
}

describe('atlas backfill route — gating + auth (T-014)', () => {
  it('404 when ATLAS_CONNECTOR_ENABLED=false', async () => {
    vi.stubEnv('ATLAS_CONNECTOR_ENABLED', 'false');
    const app = await buildTestApp({});
    try {
      const res = await app.inject({ method: 'GET', url: '/atlas-connector/backfill' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('401 on a bad signature', async () => {
    const app = await buildTestApp({});
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/atlas-connector/backfill',
        headers: { 'x-atlas-signature': 't=1700000000,v1=deadbeef', 'x-atlas-org-id': ATLAS_ORG_ID },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ ok: false });
    } finally {
      await app.close();
    }
  });

  it('401 when the org has no connection (T-06)', async () => {
    const app = await buildTestApp({});
    try {
      // OTHER org → getConnectionByOrg returns null → 401 before any HMAC work.
      // Sign with a valid secret to prove the rejection is the missing
      // connection, not a bad signature.
      const other = '11111111-2222-3333-4444-555555555555';
      const { signature, orgIdHeader } = signRequest('', other, TEST_SECRET);
      const res = await app.inject({
        method: 'GET',
        url: '/atlas-connector/backfill',
        headers: { 'x-atlas-signature': signature, 'x-atlas-org-id': orgIdHeader },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unknown org' });
    } finally {
      await app.close();
    }
  });

  it('400 on a malformed cursor', async () => {
    const app = await buildTestApp({});
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/atlas-connector/backfill?cursor=not-valid-base64-json',
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'malformed-cursor' });
    } finally {
      await app.close();
    }
  });

  it('valid signed GET → 200 { events, nextCursor } (contacts default phase)', async () => {
    const { db } = makeWalkDb([crow('a', '2026-01-01'), crow('b', '2026-01-02')]);
    const app = await buildTestApp({ db, buildContact: fakeContact, buildTurn: fakeTurn });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/atlas-connector/backfill?limit=2',
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: ConnectorEvent[]; nextCursor: string | null };
      expect(body.events).toHaveLength(2);
      expect(body.events.every((e) => e.kind === 'contact')).toBe(true);
      expect(body.nextCursor).toBeNull(); // short page (2 ≤ limit 2)
    } finally {
      await app.close();
    }
  });
});

describe('backfillPage — walk, contacts-first, anti-leak (T-014)', () => {
  it('contacts phase: full page yields a nextCursor, all kind=contact', async () => {
    const { db, whereConds, limit } = makeWalkDb([
      crow('a', '2026-01-01'),
      crow('b', '2026-01-02'),
      crow('c', '2026-01-03'), // limit+1 → hasMore
    ]);
    const { backfillPage, decodeCursor } = await import('../backfill-routes.js');
    const out = await backfillPage({
      db,
      phase: 'contacts',
      cursor: null,
      limit: 2,
      accountId: ACCOUNT_ID,
      buildContact: fakeContact,
      buildTurn: fakeTurn,
    });
    expect(out.events).toHaveLength(2); // limit+1 trimmed to limit
    expect(out.events.every((e) => e.kind === 'contact')).toBe(true);
    expect(out.nextCursor).not.toBeNull();
    expect(decodeCursor(out.nextCursor!)).toEqual({
      afterCreatedAt: new Date('2026-01-02').toISOString(),
      afterId: 'b',
    });
    expect(limit).toHaveBeenCalledWith(3); // limit + 1
    expect(whereConds.every((c) => c != null)).toBe(true); // account-scoped
  });

  it('contacts phase: short page → nextCursor null', async () => {
    const { db } = makeWalkDb([crow('a', '2026-01-01')]);
    const { backfillPage } = await import('../backfill-routes.js');
    const out = await backfillPage({
      db,
      phase: 'contacts',
      cursor: null,
      limit: 50,
      accountId: ACCOUNT_ID,
      buildContact: fakeContact,
      buildTurn: fakeTurn,
    });
    expect(out.events).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it('messages phase: emits conversation_turn carrying its conversationId', async () => {
    const { db } = makeWalkDb([mrow('m1', '2026-02-01', 'conv-1'), mrow('m2', '2026-02-02', 'conv-2')]);
    const { backfillPage } = await import('../backfill-routes.js');
    const out = await backfillPage({
      db,
      phase: 'messages',
      cursor: null,
      limit: 50,
      accountId: ACCOUNT_ID,
      buildContact: fakeContact,
      buildTurn: fakeTurn,
    });
    expect(out.events.map((e) => e.kind)).toEqual(['conversation_turn', 'conversation_turn']);
    expect(out.events[0]!.source_ref).toMatchObject({ id: 'm1', parent_id: 'conv-1' });
    expect(out.nextCursor).toBeNull();
  });

  it('cursor round-trips through encode/decode', async () => {
    const { encodeCursor, decodeCursor } = await import('../backfill-routes.js');
    const c = { afterCreatedAt: '2026-03-03T00:00:00.000Z', afterId: 'xyz' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('@@not-json@@')).toBeNull();
  });
});
