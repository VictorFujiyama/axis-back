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
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  updateWhere: ReturnType<typeof vi.fn>;
}

interface QueueStub {
  getQueue: ReturnType<typeof vi.fn>;
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
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
  queues: QueueStub;
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
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  app.decorate(
    'db',
    { select, insert, update } as unknown as FastifyInstance['db'],
  );

  // T-41: callback schedules a repeating gmail-sync job after persisting the
  // inbox. Tests assert against `getQueue` + `upsertJobScheduler`; existing
  // tests don't reference these spies so the extension is invisible to them.
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const queueAdd = vi.fn().mockResolvedValue(undefined);
  const queueObj = { upsertJobScheduler, add: queueAdd };
  const getQueue = vi.fn().mockReturnValue(queueObj);
  app.decorate(
    'queues',
    { getQueue } as unknown as FastifyInstance['queues'],
  );

  await app.register(googleOAuthRoutes, {
    exchangeCodeImpl: options.exchangeCodeImpl,
    getUserInfoImpl: options.getUserInfoImpl,
  });
  await app.ready();
  return {
    app,
    db: {
      select,
      from,
      where,
      limit,
      insert,
      values,
      returning,
      update,
      set,
      updateWhere,
    },
    queues: {
      getQueue,
      upsertJobScheduler,
      add: queueAdd,
    },
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
      // After T-21, the persist branch redirects to the front. T-18's
      // contract is "Google calls happen exactly once each with the right
      // args" — the redirect URL is asserted in the T-21 describe.
      expect(res.statusCode).toBe(302);
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

      // Persist branch is reached and T-21 redirects to the front using
      // the inserted row's id. The exact URL shape lives in the T-21
      // describe; here we only need to confirm the persist path runs.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(`inboxId=${insertedRow.id}`);
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
    const existingRow = {
      id: '00000000-0000-4000-8000-000000000001',
      accountId: 'acc-callback',
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: '987',
        needsReauth: true,
      },
    };
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      selectRows: [existingRow],
    });
    try {
      const state = await makeValidState({
        inboxId: '00000000-0000-4000-8000-000000000001',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_REAUTH&state=${encodeURIComponent(state)}`,
      });
      // T-20 routes the reauth branch through update; the insert path must
      // never fire. T-21 then 302s to the front-success URL.
      expect(res.statusCode).toBe(302);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).toHaveBeenCalledTimes(1);
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

describe('GET /api/v1/oauth/google/callback — reauth update (T-20)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubAllEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('updates existing row: secrets rotated + needsReauth cleared, no insert', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//refresh-reauth',
      accessToken: 'ya29.access-reauth',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const existingRow = {
      id: '00000000-0000-4000-8000-aaaa00000001',
      accountId: 'acc-reauth-123',
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: '987654321',
        needsReauth: true,
      },
    };
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      selectRows: [existingRow],
    });
    const { schema } = await import('@blossom/db');
    const { decryptJSON } = await import('../../../../crypto.js');
    try {
      const before = Date.now();
      const state = await makeValidState({
        accountId: 'acc-reauth-123',
        userId: 'usr-reauth-456',
        inboxId: existingRow.id,
        inboxName: 'Gmail Teste',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_REAUTH&state=${encodeURIComponent(state)}`,
      });
      const after = Date.now();

      // No new row created.
      expect(db.insert).not.toHaveBeenCalled();

      // Existing row read once and patched once.
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db.from).toHaveBeenCalledWith(schema.inboxes);
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.update).toHaveBeenCalledWith(schema.inboxes);
      expect(db.set).toHaveBeenCalledTimes(1);

      const patch = db.set.mock.calls[0]![0] as {
        secrets: string;
        config: Record<string, unknown>;
        updatedAt: Date;
      };

      // needsReauth cleared; other config fields preserved verbatim.
      expect(patch.config).toEqual({
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: '987654321',
        needsReauth: false,
      });
      expect(patch.updatedAt).toBeInstanceOf(Date);

      // Secrets rotated to the freshly exchanged tokens.
      const decrypted = decryptJSON<{
        refreshToken: string;
        accessToken: string;
        expiresAt: string;
      }>(patch.secrets);
      expect(decrypted.refreshToken).toBe('1//refresh-reauth');
      expect(decrypted.accessToken).toBe('ya29.access-reauth');
      const expiresAtMs = Date.parse(decrypted.expiresAt);
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 3_600_000 + 1_000);

      // T-21 redirects to the front-success URL after the patch lands.
      expect(res.statusCode).toBe(302);
    } finally {
      await app.close();
    }
  });

  it('flips needsReauth from true to false (regression on the patch shape)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const existingRow = {
      id: '00000000-0000-4000-8000-aaaa00000002',
      accountId: 'acc-reauth-123',
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: null,
        needsReauth: true,
      },
    };
    const { app, db } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      selectRows: [existingRow],
    });
    try {
      const state = await makeValidState({
        accountId: 'acc-reauth-123',
        inboxId: existingRow.id,
      });
      await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_REAUTH&state=${encodeURIComponent(state)}`,
      });
      const patch = db.set.mock.calls[0]![0] as {
        config: { needsReauth: boolean };
      };
      expect(patch.config.needsReauth).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the targeted inbox row no longer exists', async () => {
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
      selectRows: [],
    });
    try {
      const state = await makeValidState({
        accountId: 'acc-reauth-123',
        inboxId: '00000000-0000-4000-8000-aaaa00000003',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_REAUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not touch update on the create branch (no inboxId)', async () => {
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
      const state = await makeValidState({ inboxId: null });
      await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_CREATE&state=${encodeURIComponent(state)}`,
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/oauth/google/callback — front success redirect (T-21)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubAllEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('create branch: 302 to FRONT_URL/.../callback?ok=1&inboxId=<created.id>', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const insertedRow = { id: '11111111-2222-4333-8444-cccccccccccc' };
    const { app } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      insertReturning: [insertedRow],
    });
    try {
      const state = await makeValidState({ inboxId: null });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(typeof location).toBe('string');
      const url = new URL(location as string);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://axis.example.com/settings/inboxes/oauth/callback',
      );
      expect(url.searchParams.get('ok')).toBe('1');
      expect(url.searchParams.get('inboxId')).toBe(insertedRow.id);
    } finally {
      await app.close();
    }
  });

  it('reauth branch: 302 with inboxId pulled from state.inboxId (not from select row)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const stateInboxId = '00000000-0000-4000-8000-bbbb00000001';
    const existingRow = {
      id: stateInboxId,
      accountId: 'acc-reauth-redir',
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: '321',
        needsReauth: true,
      },
    };
    const { app } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      selectRows: [existingRow],
    });
    try {
      const state = await makeValidState({
        accountId: 'acc-reauth-redir',
        inboxId: stateInboxId,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://axis.example.com/settings/inboxes/oauth/callback',
      );
      expect(url.searchParams.get('ok')).toBe('1');
      expect(url.searchParams.get('inboxId')).toBe(stateInboxId);
    } finally {
      await app.close();
    }
  });

  it('redirect URL respects FRONT_URL with a path prefix (no double slash)', async () => {
    vi.stubEnv('FRONT_URL', 'https://axis.example.com/app');
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const { app } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      insertReturning: [{ id: '22222222-3333-4444-8555-666666666666' }],
    });
    try {
      const state = await makeValidState({ inboxId: null });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      // Must not produce `//settings` even when FRONT_URL has a trailing path.
      expect(location).not.toContain('//settings');
      expect(location).toContain(
        'https://axis.example.com/app/settings/inboxes/oauth/callback',
      );
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/oauth/google/callback — schedule gmail-sync (T-41)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubAllEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('create branch: upserts a 60s repeating gmail-sync job keyed by gmail-sync:<inboxId>', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const insertedRow = { id: '33333333-4444-4555-8666-777777777777' };
    const { app, queues } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      insertReturning: [insertedRow],
    });
    try {
      const state = await makeValidState({ inboxId: null });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);

      // Routed to the gmail-sync queue exactly once.
      expect(queues.getQueue).toHaveBeenCalledTimes(1);
      expect(queues.getQueue).toHaveBeenCalledWith('gmail-sync');

      // Scheduler keyed per inbox, repeats every 60s, carries inboxId payload.
      expect(queues.upsertJobScheduler).toHaveBeenCalledTimes(1);
      expect(queues.upsertJobScheduler).toHaveBeenCalledWith(
        `gmail-sync:${insertedRow.id}`,
        { every: 60_000 },
        { name: 'sync', data: { inboxId: insertedRow.id } },
      );
    } finally {
      await app.close();
    }
  });

  it('reauth branch: upserts the same scheduler for the existing inbox (idempotent on inboxId)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const stateInboxId = '00000000-0000-4000-8000-cccc00000001';
    const existingRow = {
      id: stateInboxId,
      accountId: 'acc-reauth-sched',
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        gmailHistoryId: '42',
        needsReauth: true,
      },
    };
    const { app, queues } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      selectRows: [existingRow],
    });
    try {
      const state = await makeValidState({
        accountId: 'acc-reauth-sched',
        inboxId: stateInboxId,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH_REAUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);

      // upsert is idempotent on the scheduler id — calling it on reauth is
      // safe and keeps the schedule healthy if BullMQ ever lost the previous
      // entry (e.g. queue draining for ops).
      expect(queues.getQueue).toHaveBeenCalledWith('gmail-sync');
      expect(queues.upsertJobScheduler).toHaveBeenCalledTimes(1);
      expect(queues.upsertJobScheduler).toHaveBeenCalledWith(
        `gmail-sync:${stateInboxId}`,
        { every: 60_000 },
        { name: 'sync', data: { inboxId: stateInboxId } },
      );
    } finally {
      await app.close();
    }
  });

  it('does NOT schedule when state is invalid', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>();
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app, queues } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/oauth/google/callback?code=AUTH&state=garbage',
      });
      expect(res.statusCode).toBe(400);
      expect(queues.getQueue).not.toHaveBeenCalled();
      expect(queues.upsertJobScheduler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT schedule when ?error= is present (front error redirect)', async () => {
    const { app, queues } = await buildTestApp();
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(queues.getQueue).not.toHaveBeenCalled();
      expect(queues.upsertJobScheduler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT schedule when exchangeCode fails (502)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>();
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>();
    const { app, queues } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
    });
    const { GoogleOAuthError } = await import('../client.js');
    exchangeCodeImpl.mockRejectedValueOnce(
      new GoogleOAuthError('bad request', 400, 'invalid_grant'),
    );
    try {
      const state = await makeValidState();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(502);
      expect(queues.upsertJobScheduler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT schedule when reauth target inbox is missing (404)', async () => {
    const exchangeCodeImpl = vi.fn<ExchangeCodeImpl>().mockResolvedValue({
      refreshToken: '1//rt',
      accessToken: 'ya29.at',
      expiresIn: 3600,
    });
    const getUserInfoImpl = vi.fn<GetUserInfoImpl>().mockResolvedValue({
      email: 'support@example.com',
    });
    const { app, queues } = await buildTestApp({
      exchangeCodeImpl,
      getUserInfoImpl,
      selectRows: [],
    });
    try {
      const state = await makeValidState({
        accountId: 'acc-missing',
        inboxId: '00000000-0000-4000-8000-cccc00000099',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/oauth/google/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(queues.upsertJobScheduler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
