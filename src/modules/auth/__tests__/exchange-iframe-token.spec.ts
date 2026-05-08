import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// T-031: round-trip integration test for POST /api/auth/exchange-iframe-token.
// Auth is the JWT in the body (no X-API-Key — see Phase 0 spec line 68).
// Mints an `atlas-iframe` JWT shaped exactly like Atlas's signAxisIframeToken,
// posts it, and asserts the response matches axis-front's LoginResponseDirect
// shape so api.ts:exchangeAtlasIframeToken (T-030) parses cleanly.
//
// Pattern mirrors atlas-routes.spec.ts (T-019) and atlas-iframe-auth.spec.ts
// (T-021): vi.resetModules + vi.stubEnv, fresh fastify per test, db/redis
// stubbed because the goal is the route contract — full DB integration is
// covered by T-032/T-033 E2E.

const TEST_SECRET = 'test-axis-jwt-secret-' + 'a'.repeat(32);
const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const TEST_EMAIL = 'agent@example.com';
const TEST_USER_NAME = 'Agent Smith';

interface SignOptions {
  axisUserId?: string;
  axisEmail?: string;
  kind?: string;
  iat?: number;
  exp?: number;
  secret?: string;
}

function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mirror of Atlas's signAxisIframeToken (apps/web/src/server/lib/axis-jwt.ts in
// atlas-company-os) — keeps the test honest about what bytes axis-back accepts.
function signTestToken(options: SignOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    kind: options.kind ?? 'atlas-iframe',
    axis_user_id: options.axisUserId ?? TEST_USER_ID,
    axis_email: options.axisEmail ?? TEST_EMAIL,
    iat: options.iat ?? now,
    exp: options.exp ?? now + 5 * 60,
  };
  const secret = options.secret ?? TEST_SECRET;
  const headerB64 = toBase64Url(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64'),
  );
  const payloadB64 = toBase64Url(
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  );
  const sig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64');
  return `${headerB64}.${payloadB64}.${toBase64Url(sig)}`;
}

interface AppBuildOptions {
  // One row-set per `app.db.select()` call, in order. The route triggers three
  // selects: (1) preHandler resolves the user, (2) the route refetches the
  // user record for response fields, (3) account memberships for the response.
  selectRows?: unknown[][];
}

interface AppBuildResult {
  app: FastifyInstance;
  redisSet: ReturnType<typeof vi.fn>;
}

async function buildTestApp(options: AppBuildOptions = {}): Promise<AppBuildResult> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt.js');
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth.js');
  const { default: atlasIframeAuthPlugin } = await import(
    '../../../plugins/atlas-iframe-auth.js'
  );
  const { authRoutes } = await import('../routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);
  await app.register(atlasAuthPlugin);
  await app.register(atlasIframeAuthPlugin);

  // Each select() call returns a fresh chain that resolves (via .then) to the
  // next batch of rows. Drizzle queries are thenables, so this matches both the
  // .where().limit(1) pattern (preHandler + user re-fetch) and the
  // .innerJoin().where() pattern (account memberships).
  const rowsPerCall = options.selectRows ?? [[]];
  let callCount = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerCall[callCount] ?? [];
    callCount++;
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  });
  app.decorate('db', { select } as unknown as FastifyInstance['db']);

  // issueRefreshTokenWithUser writes one key via app.redis.set.
  const redisSet = vi.fn().mockResolvedValue('OK');
  app.decorate('redis', { set: redisSet } as unknown as FastifyInstance['redis']);

  await app.register(authRoutes);
  await app.ready();
  return { app, redisSet };
}

beforeAll(() => {
  vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const DEFAULT_USER_ROW = {
  id: TEST_USER_ID,
  email: TEST_EMAIL,
  name: TEST_USER_NAME,
  passwordHash: 'irrelevant',
  avatarUrl: null,
  role: 'agent',
  status: 'active',
  deletedAt: null,
};

const DEFAULT_MEMBERSHIP_ROW = {
  accountId: TEST_ACCOUNT_ID,
  role: 'agent',
  accountName: 'Acme',
  availability: 'online',
  autoOffline: false,
};

describe('POST /api/auth/exchange-iframe-token — happy path (T-031)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns {accessToken, refreshToken, user} for a valid token + linked user', async () => {
    const { app, redisSet } = await buildTestApp({
      selectRows: [
        // 1: preHandler resolves the user via axis_user_id
        [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
        // 2: route refetches full user row for response
        [DEFAULT_USER_ROW],
        // 3: account memberships join
        [DEFAULT_MEMBERSHIP_ROW],
      ],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        accessToken: string;
        refreshToken: string;
        user: {
          id: string;
          email: string;
          name: string;
          accountId: string;
          accountName: string;
          accounts: { id: string; name: string }[];
        };
      };
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.split('.').length).toBe(3); // JWT shape
      expect(typeof body.refreshToken).toBe('string');
      expect(body.refreshToken.split('.').length).toBe(3); // userIdB64.accountIdB64.random
      expect(body.user).toMatchObject({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        name: TEST_USER_NAME,
        accountId: TEST_ACCOUNT_ID,
        accountName: 'Acme',
      });
      expect(body.user.accounts).toEqual([
        {
          id: TEST_ACCOUNT_ID,
          name: 'Acme',
          role: 'agent',
          availability: 'online',
          auto_offline: false,
        },
      ]);
      // Refresh token must be persisted in Redis with TTL.
      expect(redisSet).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('picks the first membership when the user has multiple accounts', async () => {
    const SECOND_ACCOUNT_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    const { app } = await buildTestApp({
      selectRows: [
        [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
        [DEFAULT_USER_ROW],
        [
          DEFAULT_MEMBERSHIP_ROW,
          {
            accountId: SECOND_ACCOUNT_ID,
            role: 'admin',
            accountName: 'Beta',
            availability: 'offline',
            autoOffline: true,
          },
        ],
      ],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { user: { accountId: string; accounts: unknown[] } };
      // First membership wins (deterministic single-account login shape).
      expect(body.user.accountId).toBe(TEST_ACCOUNT_ID);
      // All memberships still surfaced in the user.accounts array (matches login).
      expect(body.user.accounts).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/auth/exchange-iframe-token — bad tokens (T-031)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 401 when atlas_token is missing from the body', async () => {
    const { app } = await buildTestApp({
      selectRows: [[{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }]],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the token is signed with the wrong secret', async () => {
    const { app } = await buildTestApp({
      selectRows: [[{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }]],
    });
    try {
      const token = signTestToken({ secret: 'wrong-secret-' + 'b'.repeat(32) });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the token kind is not "atlas-iframe"', async () => {
    const { app } = await buildTestApp({
      selectRows: [[{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }]],
    });
    try {
      const token = signTestToken({ kind: 'session' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the token is expired', async () => {
    const { app } = await buildTestApp({
      selectRows: [[{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }]],
    });
    try {
      const past = Math.floor(Date.now() / 1000) - 60;
      const token = signTestToken({ iat: past - 600, exp: past });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the resolved user no longer exists', async () => {
    const { app } = await buildTestApp({ selectRows: [[]] });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the resolved user is soft-deleted', async () => {
    const { app } = await buildTestApp({
      selectRows: [[{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: new Date() }]],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/auth/exchange-iframe-token — account membership (T-031)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 403 when the user has no account memberships', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
        [DEFAULT_USER_ROW],
        [],
      ],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/auth/exchange-iframe-token — does NOT use X-API-Key', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
    // ATLAS_API_KEY intentionally unset for this test — the endpoint must NOT
    // gate on it (auth is the JWT). See Phase 0 spec line 68.
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('succeeds without an X-API-Key header when the JWT is valid', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
        [DEFAULT_USER_ROW],
        [DEFAULT_MEMBERSHIP_ROW],
      ],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange-iframe-token',
        // Note: no `x-api-key` header.
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
