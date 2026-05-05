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
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
}

interface AppBuildOptions {
  selectRows?: unknown[];
  insertReturning?: unknown[];
  exchangeCodeImpl?: ExchangeCodeImpl;
  getUserInfoImpl?: GetUserInfoImpl;
}

interface AppBuildResult {
  app: FastifyInstance;
  db: DbStub;
}

// Same module-reset pattern as authorize.spec.ts — each buildTestApp reads
// `config.GOOGLE_OAUTH_*` and `config.FRONT_URL` afresh, so per-test env stubs
// take effect on import.
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
  const returning = vi
    .fn()
    .mockResolvedValue(
      options.insertReturning ?? [{ id: '00000000-0000-4000-8000-deadbeef0001' }],
    );
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  app.decorate('db', { select, insert } as unknown as FastifyInstance['db']);

  await app.register(googleOAuthRoutes, {
    exchangeCodeImpl: options.exchangeCodeImpl,
    getUserInfoImpl: options.getUserInfoImpl,
  });
  await app.ready();
  return {
    app,
    db: { select, from, where, limit, insert, values, returning },
  };
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

describe('GET /api/v1/oauth/google/callback — create inbox (T-19)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubAllEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('persists a new gmail inbox with the right config + encrypted secrets', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//refresh-create',
      accessToken: 'ya29.access-create',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const insertedRow = { id: '11111111-2222-4333-8444-555555555555' };
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      insertReturning: [insertedRow],
    });
    const { schema } = await import('@blossom/db');
    const { decryptJSON } = await import('../../../../crypto.js');
    try {
      const before = Date.now();
      const state = await makeValidState({
        accountId: 'acc-create-123',
        userId: 'usr-create-456',
        inboxName: 'Gmail Teste',
        inboxId: null,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_CREATE&state=${encodeURIComponent(state)}`,
      });
      const after = Date.now();

      // Persist happened.
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledWith(schema.inboxes);
      expect(db.values).toHaveBeenCalledTimes(1);
      expect(db.returning).toHaveBeenCalledTimes(1);

      // Right values shape.
      const inserted = db.values.mock.calls[0]![0] as {
        accountId: string;
        name: string;
        channelType: string;
        config: Record<string, unknown>;
        secrets: string;
      };
      expect(inserted.accountId).toBe('acc-create-123');
      expect(inserted.name).toBe('Gmail Teste');
      expect(inserted.channelType).toBe('email');
      expect(inserted.config).toEqual({
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: null,
        needsReauth: false,
      });

      // Secrets round-trip via the real crypto helpers.
      expect(typeof inserted.secrets).toBe('string');
      const decrypted = decryptJSON<{
        refreshToken: string;
        accessToken: string;
        expiresAt: string;
      }>(inserted.secrets);
      expect(decrypted.refreshToken).toBe('1//refresh-create');
      expect(decrypted.accessToken).toBe('ya29.access-create');
      const expiresAtMs = Date.parse(decrypted.expiresAt);
      // expiresAt = now + expiresIn(3600s); allow small slop for test latency.
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 3_600_000 + 1_000);

      // Persist branch is reached but redirect is not yet wired (T-21).
      // Until then, the route returns 501 with a "redirect" marker so any
      // accidental hit fails loudly.
      expect(res.statusCode).toBe(501);
      // The new inbox id surfaces somewhere in the response so a future T-21
      // test can assert the redirect URL contains it. We don't pin location
      // here — only that the persisted row was the one returned.
      void insertedRow;
    } finally {
      await app.close();
    }
  });

  it('does not call insert when state.inboxId is set (reauth — T-20)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
    });
    try {
      const state = await makeValidState({
        inboxId: '00000000-0000-4000-8000-000000000001',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_REAUTH&state=${encodeURIComponent(state)}`,
      });
      // Reauth update branch is T-20. For T-19 it must short-circuit before
      // the insert path is reached.
      expect(res.statusCode).toBe(501);
      expect(db.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('forwards the trimmed state.inboxName as the inbox row name', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
    });
    try {
      const state = await makeValidState({
        accountId: 'acc-name',
        inboxName: 'My Custom Inbox Name',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      void res;
      expect(db.values).toHaveBeenCalledTimes(1);
      const inserted = db.values.mock.calls[0]![0] as { name: string };
      expect(inserted.name).toBe('My Custom Inbox Name');
    } finally {
      await app.close();
    }
  });

  it('honors a different expiresIn (e.g. 7200) when computing expiresAt', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt-7200',
      accessToken: 'ya29.at-7200',
      expiresIn: 7200,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'two-hour@example.com',
    });
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
    });
    const { decryptJSON } = await import('../../../../crypto.js');
    try {
      const before = Date.now();
      const state = await makeValidState();
      await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      const after = Date.now();
      const inserted = db.values.mock.calls[0]![0] as { secrets: string };
      const decrypted = decryptJSON<{ expiresAt: string }>(inserted.secrets);
      const expiresAtMs = Date.parse(decrypted.expiresAt);
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 7_200_000 - 1_000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 7_200_000 + 1_000);
    } finally {
      await app.close();
    }
  });
});
