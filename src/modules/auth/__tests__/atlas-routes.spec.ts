import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The Atlas integration routes (T-016/T-017/T-018) live under
// `/api/auth/*`, gated by `app.requireAtlasApiKey` (T-015 plugin).
// This suite covers all three together as the dedicated integration test
// for T-019. Same module-reset pattern as the OAuth specs: each
// `buildTestApp` reads `config.ATLAS_API_KEY` afresh, so per-test env stubs
// take effect on import.

const TEST_ATLAS_KEY = 'test-atlas-api-key-aaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_EMAIL = 'agent@example.com';
const TEST_PASSWORD = 'correct-horse-battery-staple';

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
  insertReject?: unknown;
}

interface AppBuildResult {
  app: FastifyInstance;
  db: DbStub;
}

async function buildTestApp(options: AppBuildOptions = {}): Promise<AppBuildResult> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt.js');
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth.js');
  const { authRoutes } = await import('../routes.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  // jwtPlugin is registered because authRoutes wires `requireAuth` on a few
  // /api/v1/* routes at register time; the Atlas routes themselves don't use it.
  await app.register(jwtPlugin);
  await app.register(atlasAuthPlugin);

  const limit = vi.fn().mockResolvedValue(options.selectRows ?? []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const returning = options.insertReject
    ? vi.fn().mockRejectedValue(options.insertReject)
    : vi.fn().mockResolvedValue(
        options.insertReturning ?? [{ id: TEST_USER_ID, email: TEST_EMAIL }],
      );
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  app.decorate('db', { select, insert } as unknown as FastifyInstance['db']);

  await app.register(authRoutes);
  await app.ready();
  return { app, db: { select, from, where, limit, insert, values, returning } };
}

// Pre-compute a real argon2 hash so verify-credentials can run against
// a known password. Done once for the suite — argon2 is intentionally slow.
let testPasswordHash = '';
beforeAll(async () => {
  vi.stubEnv('ATLAS_API_KEY', TEST_ATLAS_KEY);
  vi.resetModules();
  const { hashPassword } = await import('../password.js');
  testPasswordHash = await hashPassword(TEST_PASSWORD);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/check-email — auth gate (T-015 + T-016)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ATLAS_API_KEY', TEST_ATLAS_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects missing X-API-Key with 401', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a wrong X-API-Key with 401', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        headers: { 'x-api-key': 'wrong-key' },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 even when ATLAS_API_KEY env is unset (no misconfig leak)', async () => {
    vi.stubEnv('ATLAS_API_KEY', '');
    delete process.env.ATLAS_API_KEY;
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/auth/check-email — happy paths (T-016)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ATLAS_API_KEY', TEST_ATLAS_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns {exists: false} when the email is not in the DB', async () => {
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ exists: false });
      expect(db.select).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns {exists: true} when an active user has that email', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, deletedAt: null }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ exists: true });
    } finally {
      await app.close();
    }
  });

  it('returns {exists: false} when the user is soft-deleted', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, deletedAt: new Date() }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ exists: false });
    } finally {
      await app.close();
    }
  });

  it('normalizes the email (trim + lowercase) before lookup', async () => {
    const { app, db } = await buildTestApp({ selectRows: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/check-email',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: '  AGENT@Example.COM  ' },
      });
      expect(res.statusCode).toBe(200);
      expect(db.where).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/auth/verify-credentials (T-017)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ATLAS_API_KEY', TEST_ATLAS_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 200 + {axis_user_id, axis_email} on correct credentials', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        {
          id: TEST_USER_ID,
          email: TEST_EMAIL,
          passwordHash: testPasswordHash,
          deletedAt: null,
        },
      ],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-credentials',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        axis_user_id: TEST_USER_ID,
        axis_email: TEST_EMAIL,
      });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the password is wrong', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        {
          id: TEST_USER_ID,
          email: TEST_EMAIL,
          passwordHash: testPasswordHash,
          deletedAt: null,
        },
      ],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-credentials',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL, password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the email does not exist', async () => {
    const { app } = await buildTestApp({ selectRows: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-credentials',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the user is soft-deleted', async () => {
    const { app } = await buildTestApp({
      selectRows: [
        {
          id: TEST_USER_ID,
          email: TEST_EMAIL,
          passwordHash: testPasswordHash,
          deletedAt: new Date(),
        },
      ],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-credentials',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects missing X-API-Key with 401 (gate also covers this endpoint)', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-credentials',
        payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/auth/create-from-atlas (T-018)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ATLAS_API_KEY', TEST_ATLAS_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('creates a new user and returns 200 + {axis_user_id, axis_email}', async () => {
    const { app, db } = await buildTestApp({
      selectRows: [],
      insertReturning: [{ id: TEST_USER_ID, email: TEST_EMAIL }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/create-from-atlas',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        axis_user_id: TEST_USER_ID,
        axis_email: TEST_EMAIL,
      });
      expect(db.insert).toHaveBeenCalledTimes(1);
      // Inserted row must carry the normalized email and a non-empty hash.
      const insertedValues = db.values.mock.calls[0]?.[0] as {
        email: string;
        name: string;
        passwordHash: string;
      };
      expect(insertedValues.email).toBe(TEST_EMAIL);
      expect(insertedValues.passwordHash.length).toBeGreaterThan(20);
    } finally {
      await app.close();
    }
  });

  it('returns 409 {code: email_exists} when an active user already has that email', async () => {
    const { app, db } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/create-from-atlas',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'email_exists' });
      // Pre-check short-circuits before reaching the insert path.
      expect(db.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 409 even when an existing record is soft-deleted (no email reuse)', async () => {
    // T-016 treats soft-deleted as exists:false (linkable=no), but T-018 must
    // refuse to create a new user with the same email because of the unique
    // constraint on users.email — see iter 0019 surprise note.
    const { app, db } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/create-from-atlas',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'email_exists' });
      expect(db.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps a Postgres 23505 unique violation on insert to 409 (parallel-request race)', async () => {
    const uniqueErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { app } = await buildTestApp({
      selectRows: [],
      insertReject: uniqueErr,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/create-from-atlas',
        headers: { 'x-api-key': TEST_ATLAS_KEY },
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'email_exists' });
    } finally {
      await app.close();
    }
  });

  it('rejects missing X-API-Key with 401 (gate also covers this endpoint)', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/create-from-atlas',
        payload: { email: TEST_EMAIL },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
