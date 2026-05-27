import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-016: GET /api/v1/atlas/memory — front-facing wrapper over the T-015
// `atlasSearchMemory` client. Gate cases per the route contract:
//  - no auth → 401 (requireAuth)
//  - not configured (ATLAS_MCP_BEARER unset) → 503
//  - happy query → 200 + tier-grouped result, apps:['messaging'] on the wire
//  - contactId enriches the query with the contact's name/email/phone → 200
//  - contactId not in the caller's account → 404 (anti-leak L-615), no fetch
//  - neither query nor contactId → 400
//  - upstream Atlas error → 502 (badGateway)
//
// L-418 dynamic-import pattern: config.ts reads process.env at module load and
// `isAtlasMcpConfigured()` reads the resulting singleton, so each app is built
// after `vi.resetModules()` + the stubbed env. `globalThis.fetch` is stubbed —
// the client defaults to it when no `fetchImpl` dep is injected.

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const CONTACT_ID = '99999999-8888-4777-8666-555555555555';
const BEARER = 'mcp-bearer-' + 'b'.repeat(32);

type ContactRow = { name: string | null; email: string | null; phone: string | null };

function makeDb(contactRows: ContactRow[] = []): { db: FastifyInstance['db']; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn().mockResolvedValue(contactRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as FastifyInstance['db'], limit };
}

/** A fetch stub that records the POSTed JSON-RPC body and returns `response`. */
function makeFetch(response: { ok: boolean; status: number; json: unknown }) {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    (makeFetch as unknown as { lastBody?: unknown }).lastBody = init?.body
      ? JSON.parse(init.body)
      : undefined;
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    } as unknown as Response;
  });
}

const okResult = { jsonrpc: '2.0', id: 1, result: { durable: [], episodic: [], sessions: [] } };

async function buildTestApp(opts: { contactRows?: ContactRow[] } = {}): Promise<{
  app: FastifyInstance;
  db: ReturnType<typeof makeDb>;
}> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { atlasMcpRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);
  const db = makeDb(opts.contactRows);
  app.decorate('db', db.db);
  await app.register(atlasMcpRoutes);
  await app.ready();
  return { app, db };
}

function authHeader(app: FastifyInstance): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'agent@example.com',
    role: 'admin',
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // isAtlasMcpConfigured() needs both. This app registers only the MCP-pull
  // route, so ATLAS_URL being set never pulls in the connector data-plane.
  vi.stubEnv('ATLAS_URL', 'https://atlas-company-os.vercel.app');
  vi.stubEnv('ATLAS_MCP_BEARER', BEARER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/v1/atlas/memory (T-016)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const fetchSpy = makeFetch({ ok: true, status: 200, json: okResult });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/atlas/memory?query=joao' });
      expect(res.statusCode).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 503 when ATLAS_MCP_BEARER is unset (not configured)', async () => {
    // Delete the var (not ''), so config's `.min(20).optional()` sees `undefined`
    // and parses; isAtlasMcpConfigured() then reads it as not configured.
    vi.stubEnv('ATLAS_MCP_BEARER', undefined as unknown as string);
    const fetchSpy = makeFetch({ ok: true, status: 200, json: okResult });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/atlas/memory?query=joao',
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(503);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 400 when neither query nor contactId is given', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/atlas/memory',
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('searches Atlas with apps:[messaging] and returns the tier-grouped result', async () => {
    const fetchSpy = makeFetch({ ok: true, status: 200, json: okResult });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/atlas/memory?query=renova%C3%A7%C3%A3o',
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ durable: [], episodic: [], sessions: [] });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = (makeFetch as unknown as { lastBody: { params: { name: string; arguments: { query: string; apps: string[] } } } }).lastBody;
      expect(body.params.name).toBe('atlas.search_memory');
      expect(body.params.arguments.query).toBe('renovação');
      expect(body.params.arguments.apps).toEqual(['messaging']);
    } finally {
      await app.close();
    }
  });

  it('enriches the query with the account-scoped contact identity (contactId)', async () => {
    const fetchSpy = makeFetch({ ok: true, status: 200, json: okResult });
    vi.stubGlobal('fetch', fetchSpy);
    const { app, db } = await buildTestApp({
      contactRows: [{ name: 'João Silva', email: 'joao@example.com', phone: '+5511999999999' }],
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/atlas/memory?query=renova%C3%A7%C3%A3o&contactId=${CONTACT_ID}`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      expect(db.limit).toHaveBeenCalledOnce();
      const body = (makeFetch as unknown as { lastBody: { params: { arguments: { query: string } } } }).lastBody;
      expect(body.params.arguments.query).toBe('renovação João Silva +5511999999999 joao@example.com');
    } finally {
      await app.close();
    }
  });

  it('returns 404 when contactId is not in the caller account (anti-leak)', async () => {
    const fetchSpy = makeFetch({ ok: true, status: 200, json: okResult });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = await buildTestApp({ contactRows: [] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/atlas/memory?contactId=${CONTACT_ID}`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps an upstream Atlas error to 502', async () => {
    const fetchSpy = makeFetch({
      ok: false,
      status: 500,
      json: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } },
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/atlas/memory?query=joao',
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});
