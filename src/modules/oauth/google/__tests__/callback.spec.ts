import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ExchangeCodeImpl,
  GetUserInfoImpl,
} from '../routes.js';

interface DbStub {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

interface AppBuildOptions {
  selectRows?: unknown[];
  exchangeCodeImpl?: ExchangeCodeImpl;
  getUserInfoImpl?: GetUserInfoImpl;
}

interface AppBuildResult {
  app: FastifyInstance;
  db: DbStub;
}

// Same module-reset pattern as authorize.spec.ts — each buildTestApp reads
// `config.GOOGLE_OAUTH_*` and `config.FRONT_URL` afresh, so per-test env stubs
// take effect on import. The `db` stub is here for parity with authorize but
// the callback flow doesn't touch DB until T-19.
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

  await app.register(googleOAuthRoutes, {
    exchangeCodeImpl: options.exchangeCodeImpl,
    getUserInfoImpl: options.getUserInfoImpl,
  });
  await app.ready();
  return { app, db: { select, from, where, limit } };
}

function stubAllEnv(): void {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '1234.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'GOCSPX-test-secret');
  vi.stubEnv(
    'GOOGLE_OAUTH_REDIRECT_URI',
    'https://axis-back.onrender.com/api/v1/oauth/google/callback',
  );
  vi.stubEnv('FRONT_URL', 'https://axis.example.com');
}

function clearEnvVar(name: string): void {
  vi.stubEnv(name, '');
  delete process.env[name];
}

async function makeValidState(overrides: {
  ts?: number;
  inboxId?: string | null;
  inboxName?: string;
  accountId?: string;
  userId?: string;
} = {}): Promise<string> {
  const { signState } = await import('../state.js');
  return signState({
    accountId: overrides.accountId ?? 'acc-callback',
    userId: overrides.userId ?? 'usr-callback',
    inboxName: overrides.inboxName ?? 'Gmail Teste',
    inboxId: overrides.inboxId ?? null,
    nonce: 'a'.repeat(32),
    ts: overrides.ts ?? Date.now(),
  });
}

describe('GET /api/v1/oauth/google/callback — state validation (T-17)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubAllEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects missing state with 400 + "state-invalid"', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/callback?code=abc',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('state-invalid');
    } finally {
      await app.close();
    }
  });

  it('rejects malformed state (single-segment) with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/callback?code=abc&state=not-a-state',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('state-invalid');
    } finally {
      await app.close();
    }
  });

  it('rejects state with tampered HMAC with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const valid = await makeValidState();
      // Flip the signature segment by appending junk — HMAC must reject.
      const [payloadB64] = valid.split('.');
      const tampered = `${payloadB64}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=abc&state=${encodeURIComponent(tampered)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('state-invalid');
    } finally {
      await app.close();
    }
  });

  it('rejects expired state (>10 min) with 400', async () => {
    const { app } = await buildTestApp();
    try {
      const stale = await makeValidState({
        ts: Date.now() - 11 * 60 * 1000,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=abc&state=${encodeURIComponent(stale)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('state-invalid');
    } finally {
      await app.close();
    }
  });

  it('redirects 302 to front error URL on ?error=access_denied with a valid state', async () => {
    const { app } = await buildTestApp();
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(typeof location).toBe('string');
      const url = new URL(location as string);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://axis.example.com/settings/inboxes/oauth/callback',
      );
      expect(url.searchParams.get('error')).toBe('access_denied');
    } finally {
      await app.close();
    }
  });

  it('passes through arbitrary error codes (e.g. server_error) on the redirect', async () => {
    const { app } = await buildTestApp();
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=server_error&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get('error')).toBe('server_error');
    } finally {
      await app.close();
    }
  });

  it('state validation runs before error redirect (invalid state + ?error= still 400)', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/callback?error=access_denied&state=garbage',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('state-invalid');
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/oauth/google/callback — env not configured (T-17)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 503 when FRONT_URL is missing', async () => {
    stubAllEnv();
    clearEnvVar('FRONT_URL');
    const { app } = await buildTestApp();
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
    stubAllEnv();
    clearEnvVar('GOOGLE_OAUTH_CLIENT_ID');
    const { app } = await buildTestApp();
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when GOOGLE_OAUTH_REDIRECT_URI is missing', async () => {
    stubAllEnv();
    clearEnvVar('GOOGLE_OAUTH_REDIRECT_URI');
    const { app } = await buildTestApp();
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/oauth/google/callback — code exchange (T-18)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubAllEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('happy path: calls exchangeCode + getUserInfo exactly once with the right args', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//refresh-test',
      accessToken: 'ya29.access-test',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'test@gmail.com',
    });
    const { app } = await buildTestApp({ exchangeCodeImpl, getUserInfoImpl });
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_CODE_123&state=${encodeURIComponent(state)}`,
      });
      // T-19 will replace the persist fall-through; until then the route
      // returns 501. T-18's contract is "Google calls happen exactly once
      // each with the right args" — the persist branch is out of scope.
      expect(res.statusCode).toBe(501);
      expect(exchangeCodeImpl).toHaveBeenCalledTimes(1);
      expect(exchangeCodeImpl).toHaveBeenCalledWith('AUTH_CODE_123');
      expect(getUserInfoImpl).toHaveBeenCalledTimes(1);
      expect(getUserInfoImpl).toHaveBeenCalledWith('ya29.access-test');
    } finally {
      await app.close();
    }
  });

  it('returns 400 "code-missing" when code is absent (state valid, no error)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>();
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app } = await buildTestApp({ exchangeCodeImpl, getUserInfoImpl });
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('code-missing');
      expect(exchangeCodeImpl).not.toHaveBeenCalled();
      expect(getUserInfoImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 502 when exchangeCode throws GoogleOAuthError', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>();
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app } = await buildTestApp({ exchangeCodeImpl, getUserInfoImpl });
    // Import client AFTER buildTestApp so we share the same module-cache
    // instance the route imported — `instanceof GoogleOAuthError` only
    // matches when both sides reference the same class.
    const { GoogleOAuthError } = await import('../client.js');
    exchangeCodeImpl.mockRejectedValueOnce(
      new GoogleOAuthError('bad request', 400, 'invalid_grant'),
    );
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(502);
      expect(exchangeCodeImpl).toHaveBeenCalledTimes(1);
      // userinfo must NOT be reached when the token exchange fails.
      expect(getUserInfoImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 502 when getUserInfo throws GoogleOAuthError', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//refresh-test',
      accessToken: 'ya29.access-test',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app } = await buildTestApp({ exchangeCodeImpl, getUserInfoImpl });
    const { GoogleOAuthError } = await import('../client.js');
    getUserInfoImpl.mockRejectedValueOnce(
      new GoogleOAuthError('unauthorized', 401),
    );
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(502);
      expect(exchangeCodeImpl).toHaveBeenCalledTimes(1);
      expect(getUserInfoImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does not call exchangeCode when state is invalid', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>();
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app } = await buildTestApp({ exchangeCodeImpl, getUserInfoImpl });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/callback?code=AUTH_CODE&state=garbage',
      });
      expect(res.statusCode).toBe(400);
      expect(exchangeCodeImpl).not.toHaveBeenCalled();
      expect(getUserInfoImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not call exchangeCode when ?error= is present (front error redirect)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>();
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app } = await buildTestApp({ exchangeCodeImpl, getUserInfoImpl });
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(exchangeCodeImpl).not.toHaveBeenCalled();
      expect(getUserInfoImpl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
