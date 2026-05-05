import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

interface DbStub {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

interface AppBuildOptions {
  selectRows?: unknown[];
}

interface AppBuildResult {
  app: FastifyInstance;
  db: DbStub;
}

// Mirrors the buildTestApp helpers in authorize.spec.ts / callback.spec.ts:
// vi.resetModules + dynamic import so the route reads a fresh `config`
// singleton with stubbed env vars per-test. The reauth route only needs the
// chainable select stub for the ownership lookup; no insert/update path here.
async function buildTestApp(
  options: AppBuildOptions = {},
): Promise<AppBuildResult> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../../plugins/jwt.js');
  const { googleOAuthRoutes } = await import('../routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  const limit = vi.fn().mockResolvedValue(options.selectRows ?? []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  app.decorate('db', { select } as unknown as FastifyInstance['db']);

  await app.register(googleOAuthRoutes);
  await app.ready();
  return { app, db: { select, from, where, limit } };
}

function stubOAuthEnv(): void {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '1234.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'GOCSPX-test-secret');
  vi.stubEnv(
    'GOOGLE_OAUTH_REDIRECT_URI',
    'https://axis-back.onrender.com/api/v1/oauth/google/callback',
  );
}

function signJwt(
  app: FastifyInstance,
  overrides: Partial<{
    sub: string;
    email: string;
    role: 'admin' | 'agent';
    accountId: string;
  }> = {},
): string {
  return app.jwt.sign({
    sub: overrides.sub ?? 'usr-aaaa',
    email: overrides.email ?? 'agent@example.com',
    role: overrides.role ?? 'admin',
    accountId: overrides.accountId ?? 'acc-bbbb',
  });
}

const VALID_INBOX_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('POST /api/v1/oauth/google/reauthorize (T-22)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubOAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects missing JWT with 401', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        payload: { inboxId: VALID_INBOX_ID },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid JWT with 401', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: 'Bearer not.a.valid.token' },
        payload: { inboxId: VALID_INBOX_ID },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a missing body with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects a non-uuid inboxId with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: `Bearer ${token}` },
        payload: { inboxId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the inbox does not exist (or is deleted)', async () => {
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const token = signJwt(app, { accountId: 'acc-self' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: `Bearer ${token}` },
        payload: { inboxId: VALID_INBOX_ID },
      });
      expect(res.statusCode).toBe(403);
      expect(db.select).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the inbox belongs to a different account', async () => {
    // The where clause filters by accountId, so a cross-account row doesn't
    // come back from the stub; this asserts the where call ran (i.e. the
    // accountId scope is in place) and that the response is 403.
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const token = signJwt(app, { accountId: 'acc-self' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: `Bearer ${token}` },
        payload: { inboxId: VALID_INBOX_ID },
      });
      expect(res.statusCode).toBe(403);
      expect(db.where).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('redirects 302 to /authorize with inboxName + inboxId on the happy path', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        {
          id: VALID_INBOX_ID,
          accountId: 'acc-owner',
          name: 'Atendimento Gmail',
          channelType: 'email',
          config: { provider: 'gmail', needsReauth: true },
          deletedAt: null,
        },
      ],
    });
    try {
      const token = signJwt(app, {
        sub: 'usr-owner-1',
        accountId: 'acc-owner',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: `Bearer ${token}` },
        payload: { inboxId: VALID_INBOX_ID },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(typeof location).toBe('string');

      // Spec § 6: redirect to `/api/v1/oauth/google/authorize?inboxName=<name>
      // &inboxId=<inboxId>`. We expect a relative URL (same origin); construct
      // a base for parsing.
      const url = new URL(location as string, 'http://localhost');
      expect(url.pathname).toBe('/api/v1/oauth/google/authorize');
      expect(url.searchParams.get('inboxName')).toBe('Atendimento Gmail');
      expect(url.searchParams.get('inboxId')).toBe(VALID_INBOX_ID);
    } finally {
      await app.close();
    }
  });

  it('uses the inbox name from the DB row, not from the request', async () => {
    // Even if a future client tries to override the name, the route reads it
    // from the DB row (the inbox's actual name) per spec § 6.
    const { app } = await buildTestApp({
      selectRows: [
        {
          id: VALID_INBOX_ID,
          accountId: 'acc-owner',
          name: 'Real DB Name',
          channelType: 'email',
          config: { provider: 'gmail', needsReauth: true },
          deletedAt: null,
        },
      ],
    });
    try {
      const token = signJwt(app, { accountId: 'acc-owner' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/google/reauthorize',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          inboxId: VALID_INBOX_ID,
          inboxName: 'Hacker Override Name',
        },
      });
      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string, 'http://localhost');
      expect(url.searchParams.get('inboxName')).toBe('Real DB Name');
    } finally {
      await app.close();
    }
  });
});
