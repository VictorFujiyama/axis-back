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

const connectionsMock = vi.hoisted(() => ({
  upsertConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getConnectionByOrg: vi.fn(),
}));
vi.mock('../../atlas-events/connections', () => connectionsMock);

const connectorMock = vi.hoisted(() => ({ clearConnectorCache: vi.fn() }));
vi.mock('../../atlas-events/connector', () => connectorMock);

const handshakeMock = vi.hoisted(() => ({ runHandshake: vi.fn() }));
vi.mock('../../../scripts/atlas-handshake', () => handshakeMock);

// T-00a: stub argon2 hashing — the bot password is random throwaway, so the
// real (intentionally slow) hash buys the test nothing.
const passwordMock = vi.hoisted(() => ({ hashPassword: vi.fn() }));
vi.mock('../../auth/password', () => passwordMock);

type StubRow = { accountId: string; name?: string; role?: string };

/**
 * Membership lookup stub. Covers both chains the routes use:
 *   register:       `select({...}).from(accountUsers).where(eq(...))`
 *   user-accounts:  `select({...}).from(accountUsers).innerJoin(accounts, …).where(eq(...))`
 * Both terminate at the same `where`, which resolves the rows. Register only
 * reads `.accountId` off each row, so the extra `name`/`role` fields are inert.
 */
function makeDb(rows: StubRow[]): FastifyInstance['db'] {
  const where = vi.fn().mockResolvedValue(rows);
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ where, innerJoin }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as FastifyInstance['db'];
}

async function buildTestApp(rows: StubRow[]): Promise<FastifyInstance> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth.js');
  const { atlasProvisionRoutes } = await import('../provision-routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('db', makeDb(rows));
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

function deregister(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { 'x-api-key': API_KEY },
) {
  return app.inject({
    method: 'POST',
    url: '/atlas-connector/deregister',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

function userAccounts(
  app: FastifyInstance,
  query: Record<string, string>,
  headers: Record<string, string> = { 'x-api-key': API_KEY },
) {
  const qs = new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: qs ? `/atlas-connector/user-accounts?${qs}` : '/atlas-connector/user-accounts',
    headers,
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('ATLAS_API_KEY', API_KEY);
  vi.stubEnv('ATLAS_URL', 'https://atlas-company-os.vercel.app');
  connectionsMock.upsertConnection.mockReset();
  connectionsMock.upsertConnection.mockResolvedValue(undefined);
  connectionsMock.deleteConnection.mockReset();
  connectionsMock.deleteConnection.mockResolvedValue(1);
  connectionsMock.getConnectionByOrg.mockReset();
  connectionsMock.getConnectionByOrg.mockResolvedValue({ atlasAccountId: ACCOUNT_A });
  connectorMock.clearConnectorCache.mockReset();
  handshakeMock.runHandshake.mockReset();
  handshakeMock.runHandshake.mockResolvedValue(null); // success by default
  passwordMock.hashPassword.mockReset();
  passwordMock.hashPassword.mockResolvedValue('hashed-bot-pw');
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

describe('POST /atlas-connector/deregister — auth gate (T-08)', () => {
  it('rejects a missing X-API-Key with 401', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await deregister(app, { atlasOrgId: ATLAS_ORG_ID }, {});
      expect(res.statusCode).toBe(401);
      expect(connectionsMock.deleteConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a wrong X-API-Key with 401', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await deregister(app, { atlasOrgId: ATLAS_ORG_ID }, { 'x-api-key': 'nope' });
      expect(res.statusCode).toBe(401);
      expect(connectionsMock.deleteConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /atlas-connector/deregister — body validation (T-08)', () => {
  it('rejects a missing atlasOrgId with 400', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await deregister(app, {});
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
      expect(connectionsMock.deleteConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-uuid org id with 400', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await deregister(app, { atlasOrgId: 'not-a-uuid' });
      expect(res.statusCode).toBe(400);
      expect(connectionsMock.deleteConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /atlas-connector/deregister — removal (T-08)', () => {
  it('existing connection → deletes by org, clears that account cache, ok', async () => {
    connectionsMock.getConnectionByOrg.mockResolvedValueOnce({ atlasAccountId: ACCOUNT_A });
    const app = await buildTestApp([]);
    try {
      const res = await deregister(app, { atlasOrgId: ATLAS_ORG_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(connectionsMock.deleteConnection).toHaveBeenCalledWith(expect.anything(), {
        atlasOrgId: ATLAS_ORG_ID,
      });
      expect(connectorMock.clearConnectorCache).toHaveBeenCalledWith(ACCOUNT_A);
    } finally {
      await app.close();
    }
  });

  it('idempotent: no existing connection → still ok, no cache clear', async () => {
    connectionsMock.getConnectionByOrg.mockResolvedValueOnce(null);
    connectionsMock.deleteConnection.mockResolvedValueOnce(0);
    const app = await buildTestApp([]);
    try {
      const res = await deregister(app, { atlasOrgId: ATLAS_ORG_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(connectionsMock.deleteConnection).toHaveBeenCalledWith(expect.anything(), {
        atlasOrgId: ATLAS_ORG_ID,
      });
      expect(connectorMock.clearConnectorCache).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /atlas-connector/user-accounts — auth gate (T-09)', () => {
  it('rejects a missing X-API-Key with 401', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A, name: 'Acme', role: 'owner' }]);
    try {
      const res = await userAccounts(app, { axisUserId: USER_ID }, {});
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a wrong X-API-Key with 401', async () => {
    const app = await buildTestApp([{ accountId: ACCOUNT_A, name: 'Acme', role: 'owner' }]);
    try {
      const res = await userAccounts(app, { axisUserId: USER_ID }, { 'x-api-key': 'nope' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /atlas-connector/user-accounts — query validation (T-09)', () => {
  it('rejects a missing axisUserId with 400', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await userAccounts(app, {});
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
    } finally {
      await app.close();
    }
  });

  it('rejects a non-uuid axisUserId with 400', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await userAccounts(app, { axisUserId: 'not-a-uuid' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /atlas-connector/user-accounts — listing (T-09)', () => {
  it('returns the user accounts with id, name and role', async () => {
    const app = await buildTestApp([
      { accountId: ACCOUNT_A, name: 'Acme', role: 'owner' },
      { accountId: ACCOUNT_B, name: 'Globex', role: 'admin' },
    ]);
    try {
      const res = await userAccounts(app, { axisUserId: USER_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        accounts: [
          { accountId: ACCOUNT_A, name: 'Acme', role: 'owner' },
          { accountId: ACCOUNT_B, name: 'Globex', role: 'admin' },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('user with no memberships → empty list, still ok', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await userAccounts(app, { axisUserId: USER_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, accounts: [] });
    } finally {
      await app.close();
    }
  });
});

// ---- POST /atlas-connector/ensure-bot-link (T-00a, D14) ----
// The bot identity provisioning endpoint: mints a synthetic `atlas-bot:<orgId>`
// user + `atlas_user_links` row so the qualifier-agent's MCP write tools resolve
// instead of returning `forbidden`. A richer db stub is needed than the register
// suite's (idempotency select with `.limit`, plus a `transaction`), so these
// cases build the app with a bespoke db. `connections`/`password` are mocked at
// module scope above; the account comes from `getConnectionByOrg`.

const BOT_AXIS_USER_ID = 'cccccccc-dddd-4eee-8fff-000000000000';

function makeBotDb(opts: { existingLink?: { axisUserId: string }; existingUser?: { id: string } } = {}): {
  db: FastifyInstance['db'];
  transaction: ReturnType<typeof vi.fn>;
  insertValues: ReturnType<typeof vi.fn>;
} {
  // Outer idempotency lookup on atlas_user_links.
  const linkLimit = vi.fn().mockResolvedValue(opts.existingLink ? [opts.existingLink] : []);
  const outerSelect = vi.fn(() => ({ from: () => ({ where: () => ({ limit: linkLimit }) }) }));

  // Inside the tx: select the bot user by email, then insert user/membership/link.
  const userLimit = vi.fn().mockResolvedValue(opts.existingUser ? [opts.existingUser] : []);
  const txSelect = vi.fn(() => ({ from: () => ({ where: () => ({ limit: userLimit }) }) }));
  const insertValues = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([{ id: BOT_AXIS_USER_ID }]),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  }));
  const txInsert = vi.fn(() => ({ values: insertValues }));
  const tx = { select: txSelect, insert: txInsert };

  const transaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));
  const db = { select: outerSelect, transaction } as unknown as FastifyInstance['db'];
  return { db, transaction, insertValues };
}

async function buildBotApp(db: FastifyInstance['db']): Promise<FastifyInstance> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth.js');
  const { atlasProvisionRoutes } = await import('../provision-routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('db', db);
  await app.register(atlasAuthPlugin);
  await app.register(atlasProvisionRoutes);
  await app.ready();
  return app;
}

function ensureBotLink(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { 'x-api-key': API_KEY },
) {
  return app.inject({
    method: 'POST',
    url: '/atlas-connector/ensure-bot-link',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('POST /atlas-connector/ensure-bot-link (T-00a, D14)', () => {
  it('rejects a missing X-API-Key with 401, never touches the connection', async () => {
    const { db, transaction } = makeBotDb();
    const app = await buildBotApp(db);
    try {
      const res = await ensureBotLink(app, { atlasOrgId: ATLAS_ORG_ID }, {});
      expect(res.statusCode).toBe(401);
      expect(connectionsMock.getConnectionByOrg).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-uuid org id with 400', async () => {
    const { db, transaction } = makeBotDb();
    const app = await buildBotApp(db);
    try {
      const res = await ensureBotLink(app, { atlasOrgId: 'not-a-uuid' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
      expect(connectionsMock.getConnectionByOrg).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('no connection for the org → 409, no user created', async () => {
    connectionsMock.getConnectionByOrg.mockResolvedValueOnce(null);
    const { db, transaction } = makeBotDb();
    const app = await buildBotApp(db);
    try {
      const res = await ensureBotLink(app, { atlasOrgId: ATLAS_ORG_ID });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('idempotent: an existing bot link returns its axis user, no writes', async () => {
    const { db, transaction } = makeBotDb({ existingLink: { axisUserId: USER_ID } });
    const app = await buildBotApp(db);
    try {
      const res = await ensureBotLink(app, { atlasOrgId: ATLAS_ORG_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, axisUserId: USER_ID });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('no existing link → mints bot user + link in one tx, returns the axis user', async () => {
    const { db, transaction, insertValues } = makeBotDb();
    const app = await buildBotApp(db);
    try {
      const res = await ensureBotLink(app, { atlasOrgId: ATLAS_ORG_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, axisUserId: BOT_AXIS_USER_ID });
      expect(transaction).toHaveBeenCalledTimes(1);
      // The link row must carry the synthetic bot app-user id the worker rides
      // under (`atlas-bot:<orgId>`) so the MCP gate resolves it.
      const insertedLink = insertValues.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => 'atlasAppUserId' in v);
      expect(insertedLink).toMatchObject({
        atlasAppUserId: `atlas-bot:${ATLAS_ORG_ID}`,
        atlasOrgId: ATLAS_ORG_ID,
        accountId: ACCOUNT_A,
      });
    } finally {
      await app.close();
    }
  });
});

// ---- POST /atlas-connector/set-inbox-default-bot (T-19', D27/D30/Gap 3) ----
// Turns the Atlas qualifier-agent on/off for one inbox by pointing
// `inbox.defaultBotId` at a real `bots` row (Gap 3: the FK on
// conversations.assigned_bot_id → bots.id means the default bot must be a `bots`
// row, NOT the synthetic atlas-bot user). The account is resolved from the org's
// connection; the inbox must belong to it (D32). On enable we get-or-create a
// builtin 'Atlas Assistant' bot for (account, inbox); on disable we clear the
// pointer but keep the bots row. The db stub routes the inbox select (1st) and
// the bots select (2nd, enable only) by call order.

const INBOX_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
const EXISTING_BOT_ID = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc';
const NEW_BOT_ID = 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd';

function makeInboxDb(opts: {
  inbox?: { accountId: string | null; defaultBotId: string | null } | null;
  existingBot?: { id: string } | null;
}): {
  db: FastifyInstance['db'];
  insert: ReturnType<typeof vi.fn>;
  insertValues: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateSet: ReturnType<typeof vi.fn>;
} {
  const inboxRows =
    opts.inbox === undefined
      ? [{ id: INBOX_ID, accountId: ACCOUNT_A, defaultBotId: null }]
      : opts.inbox
        ? [{ id: INBOX_ID, ...opts.inbox }]
        : [];
  const botRows = opts.existingBot ? [opts.existingBot] : [];

  let selectCall = 0;
  const select = vi.fn(() => {
    const idx = selectCall++;
    return {
      from: () => ({
        where: () => ({
          // 0 = inbox lookup, 1 = bots get-or-create lookup (enable path only).
          limit: vi.fn().mockResolvedValue(idx === 0 ? inboxRows : botRows),
        }),
      }),
    };
  });

  const returning = vi.fn().mockResolvedValue([{ id: NEW_BOT_ID }]);
  const insertValues = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db = { select, insert, update } as unknown as FastifyInstance['db'];
  return { db, insert, insertValues, update, updateSet };
}

async function buildInboxApp(db: FastifyInstance['db']): Promise<FastifyInstance> {
  return buildBotApp(db);
}

function setInboxDefaultBot(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { 'x-api-key': API_KEY },
) {
  return app.inject({
    method: 'POST',
    url: '/atlas-connector/set-inbox-default-bot',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('POST /atlas-connector/set-inbox-default-bot (T-19-prime, D27/D30/Gap 3)', () => {
  it('rejects a missing X-API-Key with 401, never touches the connection', async () => {
    const { db } = makeInboxDb({});
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true }, {});
      expect(res.statusCode).toBe(401);
      expect(connectionsMock.getConnectionByOrg).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const { db } = makeInboxDb({});
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID }); // missing inboxId/enabled
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
      expect(connectionsMock.getConnectionByOrg).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('no connection for the org → 409', async () => {
    connectionsMock.getConnectionByOrg.mockResolvedValueOnce(null);
    const { db, insert, update } = makeInboxDb({});
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('inbox not found → 404', async () => {
    const { db, insert, update } = makeInboxDb({ inbox: null });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('inbox belongs to another account → 403, no writes (D32)', async () => {
    const { db, insert, update } = makeInboxDb({ inbox: { accountId: OTHER_ACCOUNT, defaultBotId: null } });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ ok: false });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('enable happy: null defaultBotId, no bot → creates bots row, points inbox at it', async () => {
    const { db, insert, insertValues, update, updateSet } = makeInboxDb({
      inbox: { accountId: ACCOUNT_A, defaultBotId: null },
      existingBot: null,
    });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        inboxId: INBOX_ID,
        defaultBotId: NEW_BOT_ID,
        botsRowId: NEW_BOT_ID,
        unchanged: false,
      });
      // Gap 3: the created row is a real builtin `bots` row (FK-safe target).
      expect(insert).toHaveBeenCalledTimes(1);
      expect(insertValues.mock.calls[0]![0]).toMatchObject({
        accountId: ACCOUNT_A,
        inboxId: INBOX_ID,
        name: 'Atlas Assistant',
        botType: 'builtin',
      });
      expect(updateSet.mock.calls[0]![0]).toMatchObject({ defaultBotId: NEW_BOT_ID });
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('re-enable: bots row already exists → reuses it (no insert), points inbox', async () => {
    const { db, insert, update, updateSet } = makeInboxDb({
      inbox: { accountId: ACCOUNT_A, defaultBotId: null },
      existingBot: { id: EXISTING_BOT_ID },
    });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        inboxId: INBOX_ID,
        defaultBotId: EXISTING_BOT_ID,
        botsRowId: EXISTING_BOT_ID,
        unchanged: false,
      });
      expect(insert).not.toHaveBeenCalled();
      expect(updateSet.mock.calls[0]![0]).toMatchObject({ defaultBotId: EXISTING_BOT_ID });
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('enable idempotent: inbox already points at the Atlas bot → unchanged, no writes', async () => {
    const { db, insert, update } = makeInboxDb({
      inbox: { accountId: ACCOUNT_A, defaultBotId: EXISTING_BOT_ID },
      existingBot: { id: EXISTING_BOT_ID },
    });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        inboxId: INBOX_ID,
        defaultBotId: EXISTING_BOT_ID,
        botsRowId: EXISTING_BOT_ID,
        unchanged: true,
      });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('disable happy: clears defaultBotId, leaves the bots row', async () => {
    const { db, insert, update, updateSet } = makeInboxDb({
      inbox: { accountId: ACCOUNT_A, defaultBotId: EXISTING_BOT_ID },
    });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: false });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        inboxId: INBOX_ID,
        defaultBotId: null,
        botsRowId: null,
        unchanged: false,
      });
      // No DELETE of the bots row — only the inbox pointer is cleared.
      expect(insert).not.toHaveBeenCalled();
      expect(updateSet.mock.calls[0]![0]).toMatchObject({ defaultBotId: null });
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('disable idempotent: defaultBotId already null → unchanged, no writes', async () => {
    const { db, insert, update } = makeInboxDb({
      inbox: { accountId: ACCOUNT_A, defaultBotId: null },
    });
    const app = await buildInboxApp(db);
    try {
      const res = await setInboxDefaultBot(app, { atlasOrgId: ATLAS_ORG_ID, inboxId: INBOX_ID, enabled: false });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        inboxId: INBOX_ID,
        defaultBotId: null,
        botsRowId: null,
        unchanged: true,
      });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
