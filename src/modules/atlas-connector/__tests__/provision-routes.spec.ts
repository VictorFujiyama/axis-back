import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-07: POST /atlas-connector/register — the server-to-server provisioning
// endpoint Atlas calls when an org owner connects their company. Covers the
// X-API-Key gate, account resolution from the axis user's memberships (single,
// explicit choice, ambiguous, not-a-member, none), idempotent upsert, and the
// handshake outcome flowing into the connection status.
//
// Same dynamic-import + module-reset pattern the sibling atlas-connector specs
// use (each case re-parses `config` from the stubbed env). We mock the
// `connections` store (`upsertConnection`), the per-account connector cache
// (`clearConnectorCache`), and `runHandshake` so no DB write, crypto, or network
// happens — the only real DB call is the membership lookup, which the db stub
// answers. Mock paths resolve to the same module ids the route imports.

const API_KEY = 'test-atlas-api-key-aaaaaaaaaaaaaaaaaaaaaaaa';
const ATLAS_ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACCOUNT_A = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_B = '99999999-8888-4777-8666-555544443333';
const OTHER_ACCOUNT = '12121212-3434-4565-8787-989898989898';
const HMAC = 'a'.repeat(40);
const BEARER = 'mcp-bearer-' + 'b'.repeat(20);

const connectionsMock = vi.hoisted(() => ({ upsertConnection: vi.fn() }));
vi.mock('../../atlas-events/connections', () => connectionsMock);

const connectorMock = vi.hoisted(() => ({ clearConnectorCache: vi.fn() }));
vi.mock('../../atlas-events/connector', () => connectorMock);

const handshakeMock = vi.hoisted(() => ({ runHandshake: vi.fn() }));
vi.mock('../../../scripts/atlas-handshake', () => handshakeMock);

/** Membership lookup stub: `select({...}).from(accountUsers).where(eq(...))` → rows. */
function makeDb(memberships: Array<{ accountId: string }>): FastifyInstance['db'] {
  const where = vi.fn().mockResolvedValue(memberships);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as FastifyInstance['db'];
}

async function buildTestApp(memberships: Array<{ accountId: string }>): Promise<FastifyInstance> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth.js');
  const { atlasProvisionRoutes } = await import('../provision-routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('db', makeDb(memberships));
  await app.register(atlasAuthPlugin);
  await app.register(atlasProvisionRoutes);
  await app.ready();
  return app;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    atlasOrgId: ATLAS_ORG_ID,
    axisUserId: USER_ID,
    hmacSecret: HMAC,
    mcpBearer: BEARER,
    ...overrides,
  };
}

function register(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { 'x-api-key': API_KEY },
) {
  return app.inject({
    method: 'POST',
    url: '/atlas-connector/register',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('ATLAS_API_KEY', API_KEY);
  vi.stubEnv('ATLAS_URL', 'https://atlas-company-os.vercel.app');
  connectionsMock.upsertConnection.mockReset();
  connectionsMock.upsertConnection.mockResolvedValue(undefined);
  connectorMock.clearConnectorCache.mockReset();
  handshakeMock.runHandshake.mockReset();
  handshakeMock.runHandshake.mockResolvedValue(null); // success by default
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('POST /atlas-connector/register — auth gate (T-07)', () => {
  it('rejects a missing X-API-Key with 401', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body(), {});
      expect(res.statusCode).toBe(401);
      expect(connectionsMock.upsertConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a wrong X-API-Key with 401', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body(), { 'x-api-key': 'nope' });
      expect(res.statusCode).toBe(401);
      expect(connectionsMock.upsertConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /atlas-connector/register — body validation (T-07)', () => {
  it('rejects a malformed body with 400', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, { atlasOrgId: ATLAS_ORG_ID }); // missing fields
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
      expect(connectionsMock.upsertConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-uuid org id with 400', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body({ atlasOrgId: 'not-a-uuid' }));
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('POST /atlas-connector/register — account resolution (T-07)', () => {
  it('single-membership user → uses that account, handshake → active', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'active' });

      // pending first (G8 crash-safety), then active after the handshake.
      expect(connectionsMock.upsertConnection).toHaveBeenCalledTimes(2);
      expect(connectionsMock.upsertConnection.mock.calls[0]![1]).toMatchObject({
        atlasAccountId: ACCOUNT_A,
        atlasOrgId: ATLAS_ORG_ID,
        secrets: { hmacSecret: HMAC, mcpBearer: BEARER },
        status: 'pending',
      });
      expect(connectionsMock.upsertConnection.mock.calls[1]![1]).toMatchObject({
        atlasAccountId: ACCOUNT_A,
        status: 'active',
      });
      expect(handshakeMock.runHandshake).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ATLAS_ORG_ID, hmacSecret: HMAC }),
      );
      expect(connectorMock.clearConnectorCache).toHaveBeenCalledWith(ACCOUNT_A);
    } finally {
      await app.close();
    }
  });

  it('explicit axisAccountId the user belongs to → uses it', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }, { accountId: ACCOUNT_B }]);
    try {
      const res = await register(app, body({ axisAccountId: ACCOUNT_B }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'active' });
      expect(connectionsMock.upsertConnection.mock.calls[0]![1]).toMatchObject({
        atlasAccountId: ACCOUNT_B,
      });
    } finally {
      await app.close();
    }
  });

  it('explicit axisAccountId the user does NOT belong to → 403, no upsert', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body({ axisAccountId: OTHER_ACCOUNT }));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ ok: false });
      expect(connectionsMock.upsertConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('user with no memberships → 403, no upsert', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await register(app, body());
      expect(res.statusCode).toBe(403);
      expect(connectionsMock.upsertConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('multi-membership without axisAccountId → 409, no upsert', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }, { accountId: ACCOUNT_B }]);
    try {
      const res = await register(app, body());
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false });
      expect(connectionsMock.upsertConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /atlas-connector/register — handshake outcome (T-07)', () => {
  it('handshake failure → 200 ok with status error, persisted as error', async () => {
    handshakeMock.runHandshake.mockRejectedValueOnce(new Error('Atlas handshake failed: 401'));
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'error' });
      expect(connectionsMock.upsertConnection.mock.calls[1]![1]).toMatchObject({
        status: 'error',
      });
    } finally {
      await app.close();
    }
  });

  it('ATLAS_URL unset → skips handshake, connection left pending', async () => {
    // Remove the var entirely — config's ATLAS_URL is `.url().optional()`, so an
    // empty string would fail validation; undefined is the "unset" case.
    vi.stubEnv('ATLAS_URL', undefined as unknown as string);
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const res = await register(app, body());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'pending' });
      // Only the pending upsert ran; no handshake, no second status write.
      expect(connectionsMock.upsertConnection).toHaveBeenCalledTimes(1);
      expect(handshakeMock.runHandshake).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('idempotent: a repeat register succeeds again (active)', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A }]);
    try {
      const first = await register(app, body());
      const second = await register(app, body());
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ok: true, status: 'active' });
    } finally {
      await app.close();
    }
  });
});
