import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// T-021: round-trip test for the atlas-iframe-auth plugin (T-020).
// Mints a JWT with the same HS256 shape Atlas signs (axis-jwt.ts in
// atlas-company-os), exercises the `requireAtlasIframeAuth` preHandler via a
// stub protected route, and asserts `req.atlasIframeUser` is resolved from the
// payload's `axis_user_id`. Uses the same `vi.resetModules` + `vi.stubEnv`
// pattern as `src/modules/auth/__tests__/atlas-routes.spec.ts` so each test
// reads a fresh `config` singleton and a known AXIS_JWT_SECRET.

const TEST_SECRET = 'test-axis-jwt-secret-' + 'a'.repeat(32);
const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_EMAIL = 'agent@example.com';

interface SignOptions {
  axisUserId?: string;
  axisEmail?: string;
  kind?: string;
  iat?: number;
  exp?: number;
  secret?: string;
}

// Minimal mirror of Atlas's signAxisIframeToken (apps/web/src/server/lib/
// axis-jwt.ts) — the verifier is what's under test, so reproducing the signer
// here keeps the test honest about what bytes it accepts.
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

function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface AppBuildOptions {
  selectRows?: unknown[];
}

interface AppBuildResult {
  app: FastifyInstance;
}

async function buildTestApp(options: AppBuildOptions = {}): Promise<AppBuildResult> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: atlasIframeAuthPlugin } = await import('../atlas-iframe-auth.js');

  const app = Fastify({ logger: false });
  await app.register(sensible);

  const limit = vi.fn().mockResolvedValue(options.selectRows ?? []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  app.decorate('db', { select } as unknown as FastifyInstance['db']);

  await app.register(atlasIframeAuthPlugin);

  // Stub protected route: the preHandler is the unit under test; the handler
  // just echoes back what landed on `req.atlasIframeUser` so assertions can
  // verify resolution.
  app.post(
    '/test/protected',
    { preHandler: app.requireAtlasIframeAuth },
    async (req) => ({
      userId: req.atlasIframeUser?.id,
      email: req.atlasIframeUser?.email,
    }),
  );

  await app.ready();
  return { app };
}

beforeAll(() => {
  vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('requireAtlasIframeAuth — happy path (T-020/T-021)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('resolves req.atlasIframeUser from a valid token + DB row', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ userId: TEST_USER_ID, email: TEST_EMAIL });
    } finally {
      await app.close();
    }
  });
});

describe('requireAtlasIframeAuth — rejects bad tokens', () => {
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
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the signature was made with a different secret', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      const token = signTestToken({ secret: 'wrong-secret-' + 'b'.repeat(32) });
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the payload kind is not "atlas-iframe"', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      const token = signTestToken({ kind: 'session' });
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the token is expired', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      const past = Math.floor(Date.now() / 1000) - 60;
      const token = signTestToken({ iat: past - 600, exp: past });
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the token is malformed (not three parts)', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: 'not-a-real-jwt' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('requireAtlasIframeAuth — DB resolution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AXIS_JWT_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 401 when no user matches the payload axis_user_id', async () => {
    const { app } = await buildTestApp({ selectRows: [] });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the matched user is soft-deleted', async () => {
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: new Date() }],
    });
    try {
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('requireAtlasIframeAuth — misconfig does not leak', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 401 (same response as bad token) when AXIS_JWT_SECRET is unset', async () => {
    vi.stubEnv('AXIS_JWT_SECRET', '');
    delete process.env.AXIS_JWT_SECRET;
    const { app } = await buildTestApp({
      selectRows: [{ id: TEST_USER_ID, email: TEST_EMAIL, deletedAt: null }],
    });
    try {
      // Even if the caller sends a syntactically valid token, the missing
      // server-side secret must short-circuit to 401 with no distinguishing
      // signal — see T-020 historic notes on "don't leak misconfig".
      const token = signTestToken();
      const res = await app.inject({
        method: 'POST',
        url: '/test/protected',
        payload: { atlas_token: token },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('verifyAtlasIframeTokenWithSecret — pure verifier', () => {
  it('round-trips a valid token to its payload', async () => {
    const { verifyAtlasIframeTokenWithSecret } = await import(
      '../atlas-iframe-auth.js'
    );
    const token = signTestToken();
    const payload = verifyAtlasIframeTokenWithSecret(token, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe('atlas-iframe');
    expect(payload?.axis_user_id).toBe(TEST_USER_ID);
    expect(payload?.axis_email).toBe(TEST_EMAIL);
  });

  it('returns null for a tampered payload (signature mismatch)', async () => {
    const { verifyAtlasIframeTokenWithSecret } = await import(
      '../atlas-iframe-auth.js'
    );
    const token = signTestToken();
    const parts = token.split('.');
    // Flip a single char in the payload segment to break the signature without
    // changing length — exercises the timingSafeEqual branch.
    const tamperedPayload =
      parts[1]!.slice(0, -1) + (parts[1]!.endsWith('A') ? 'B' : 'A');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    expect(verifyAtlasIframeTokenWithSecret(tampered, TEST_SECRET)).toBeNull();
  });

  it('returns null when the token does not have three segments', async () => {
    const { verifyAtlasIframeTokenWithSecret } = await import(
      '../atlas-iframe-auth.js'
    );
    expect(verifyAtlasIframeTokenWithSecret('a.b', TEST_SECRET)).toBeNull();
    expect(
      verifyAtlasIframeTokenWithSecret('a.b.c.d', TEST_SECRET),
    ).toBeNull();
  });
});
