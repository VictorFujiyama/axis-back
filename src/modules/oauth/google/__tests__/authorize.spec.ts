import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The route reads `config.GOOGLE_OAUTH_*` (singleton, parsed once at import).
// Tests use vi.resetModules + vi.stubEnv so each `buildTestApp` call sees a
// fresh config. JWT_SECRET stays set via the loaded `.env` so signing/verifying
// in the same fresh module graph stays consistent between the JWT plugin and
// the route's signState helper.
async function buildTestApp(): Promise<FastifyInstance> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../../plugins/jwt.js');
  const { googleOAuthRoutes } = await import('../routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);
  await app.register(googleOAuthRoutes);
  await app.ready();
  return app;
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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

  it('redirects 302 to Google consent URL with state on happy path', async () => {
    const app = await buildTestApp();
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

      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(typeof location).toBe('string');
      const url = new URL(location as string);
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
    const app = await buildTestApp();
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

      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
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
    const app = await buildTestApp();
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
      const state1 = new URL(res1.headers.location as string).searchParams.get(
        'state',
      );
      const state2 = new URL(res2.headers.location as string).searchParams.get(
        'state',
      );
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
    const app = await buildTestApp();
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
