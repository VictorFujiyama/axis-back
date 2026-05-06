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

// The route reads `config.GOOGLE_OAUTH_*` (singleton, parsed once at import).
// Tests use vi.resetModules + vi.stubEnv so each `buildTestApp` call sees a
// fresh config. JWT_SECRET stays set via the loaded `.env` so signing/verifying
// in the same fresh module graph stays consistent between the JWT plugin and
// the route's signState helper.
//
// The reauth branch (T-16) needs `app.db` for the inbox ownership lookup. We
// decorate it with a chainable stub here; tests pass `selectRows` to control
// what the lookup resolves to ([] → not found → 403; [row] → ok).
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

function clearOAuthEnv(): void {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
  vi.stubEnv('GOOGLE_OAUTH_REDIRECT_URI', '');
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
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

describe('GET /api/v1/oauth/google/authorize — create branch (T-15)', () => {
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
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
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
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: 'Bearer not.a.valid.token' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects missing inboxName with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects empty inboxName with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects whitespace-only inboxName with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/authorize?inboxName=${encodeURIComponent('   ')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects inboxName longer than 80 chars with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const longName = 'a'.repeat(81);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/authorize?inboxName=${encodeURIComponent(longName)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 200 JSON {consentUrl} pointing at Google on happy path', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app, {
        sub: 'usr-1234',
        accountId: 'acc-5678',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { consentUrl: string };
      expect(typeof body.consentUrl).toBe('string');
      const url = new URL(body.consentUrl);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('client_id')).toBe(
        '1234.apps.googleusercontent.com',
      );
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://axis-back.onrender.com/api/v1/oauth/google/callback',
      );
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email',
      );

      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(state!.split('.')).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('encodes the JWT identity + inboxName into the signed state', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app, {
        sub: 'usr-state-id',
        accountId: 'acc-state-id',
      });
      const inboxName = 'Atendimento Gmail';
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/authorize?inboxName=${encodeURIComponent(inboxName)}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { consentUrl: string };
      const url = new URL(body.consentUrl);
      const state = url.searchParams.get('state')!;

      const { verifyState } = await import('../state.js');
      const payload = verifyState(state);
      expect(payload.accountId).toBe('acc-state-id');
      expect(payload.userId).toBe('usr-state-id');
      expect(payload.inboxName).toBe(inboxName);
      // T-15 only handles the create branch — inboxId must be null/undefined.
      expect(payload.inboxId ?? null).toBeNull();
      expect(typeof payload.nonce).toBe('string');
      expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof payload.ts).toBe('number');
    } finally {
      await app.close();
    }
  });

  it('produces a different state on each call (fresh nonce + ts)', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const url = '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste';
      const res1 = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      const res2 = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      const state1 = new URL(
        (res1.json() as { consentUrl: string }).consentUrl,
      ).searchParams.get('state');
      const state2 = new URL(
        (res2.json() as { consentUrl: string }).consentUrl,
      ).searchParams.get('state');
      expect(state1).not.toBe(state2);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/oauth/google/authorize — env not configured (T-15)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearOAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 503 when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
    stubOAuthEnv();
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when GOOGLE_OAUTH_CLIENT_SECRET is missing', async () => {
    stubOAuthEnv();
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when GOOGLE_OAUTH_REDIRECT_URI is missing', async () => {
    stubOAuthEnv();
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when all three are missing', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/oauth/google/authorize — reauth branch (T-16)', () => {
  const VALID_INBOX_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    vi.unstubAllEnvs();
    stubOAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects a non-uuid inboxId with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste&inboxId=not-a-uuid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the inbox does not exist (or is deleted)', async () => {
    // Empty selectRows → DB lookup finds nothing.
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const token = signJwt(app, { accountId: 'acc-self' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/authorize?inboxName=Gmail+Teste&inboxId=${VALID_INBOX_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      // The ownership check must have actually run.
      expect(db.select).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the inbox belongs to a different account', async () => {
    // From the route's perspective the where clause already filters by
    // accountId — a cross-account row simply isn't returned. Mirror that here:
    // the stub returns [] and the route returns 403. We additionally assert
    // that the where clause was invoked, i.e. accountId scoping is in place.
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const token = signJwt(app, { accountId: 'acc-self' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/authorize?inboxName=Gmail+Teste&inboxId=${VALID_INBOX_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(db.where).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns 200 JSON with inboxId encoded into the state when the inbox is owned by the caller', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        {
          id: VALID_INBOX_ID,
          accountId: 'acc-owner',
          name: 'Existing Gmail',
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
        method: 'GET',
        url: `/api/v1/oauth/google/authorize?inboxName=Gmail+Teste&inboxId=${VALID_INBOX_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { consentUrl: string };
      const url = new URL(body.consentUrl);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      const state = url.searchParams.get('state')!;
      expect(state).toBeTruthy();

      const { verifyState } = await import('../state.js');
      const payload = verifyState(state);
      expect(payload.inboxId).toBe(VALID_INBOX_ID);
      expect(payload.accountId).toBe('acc-owner');
      expect(payload.userId).toBe('usr-owner-1');
      expect(payload.inboxName).toBe('Gmail Teste');
    } finally {
      await app.close();
    }
  });

  it('does not touch the DB on the create branch (no inboxId)', async () => {
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const token = signJwt(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/authorize?inboxName=Gmail+Teste',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      // Create branch must not perform the ownership lookup.
      expect(db.select).not.toHaveBeenCalled();
      // And the resulting state must encode inboxId=null.
      const body = res.json() as { consentUrl: string };
      const url = new URL(body.consentUrl);
      const { verifyState } = await import('../state.js');
      const payload = verifyState(url.searchParams.get('state')!);
      expect(payload.inboxId ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });
});
