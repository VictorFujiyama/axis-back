import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// T-09: POST /api/v1/internal/backfill/inbox-playbook — HMAC-gated one-time
// atlas→axis playbook backfill (D34). The DB is mocked: these tests focus on
// the auth/validation/dry-run/idempotency contract, not the real UPSERT.

const TEST_SECRET = 'backfill-secret-at-least-32-chars-long-xx';
const INBOX_ID = '99999999-8888-4777-8666-555555555555';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    inboxId: INBOX_ID,
    content: 'You are a helpful sales assistant for our shop.',
    etag: 'abc123def456',
    version: 3,
    ...overrides,
  };
}

function sign(rawBody: string, secret = TEST_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

interface BuiltApp {
  app: FastifyInstance;
  upsertCalls: Array<{ values: unknown; set: unknown; target: unknown }>;
}

async function buildTestApp(secret: string | null = TEST_SECRET): Promise<BuiltApp> {
  const Fastify = (await import('fastify')).default;
  const { config } = await import('../../../config');
  const { backfillRoutes } = await import('../backfill-routes');

  (config as { BACKFILL_SHARED_SECRET?: string }).BACKFILL_SHARED_SECRET = secret ?? undefined;

  const app = Fastify({ logger: false });

  const upsertCalls: BuiltApp['upsertCalls'] = [];
  const insert = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation((values: unknown) => ({
      onConflictDoUpdate: vi
        .fn()
        .mockImplementation(({ target, set }: { target: unknown; set: unknown }) => {
          upsertCalls.push({ values, target, set });
          return Promise.resolve(undefined);
        }),
    })),
  }));

  app.decorate('db', { insert } as unknown as FastifyInstance['db']);

  await app.register(backfillRoutes);
  await app.ready();
  return { app, upsertCalls };
}

describe('POST /api/v1/internal/backfill/inbox-playbook (T-09)', () => {
  let prevSecret: string | undefined;

  beforeEach(async () => {
    const { config } = await import('../../../config');
    prevSecret = config.BACKFILL_SHARED_SECRET;
  });

  afterEach(async () => {
    const { config } = await import('../../../config');
    (config as { BACKFILL_SHARED_SECRET?: string }).BACKFILL_SHARED_SECRET = prevSecret;
    vi.clearAllMocks();
  });

  it('upserts the playbook when the HMAC signature is valid', async () => {
    const { app, upsertCalls } = await buildTestApp();
    try {
      const raw = JSON.stringify(validBody());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/backfill/inbox-playbook',
        headers: { 'content-type': 'application/json', 'x-backfill-signature': sign(raw) },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, inboxId: INBOX_ID });
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0]!.values).toMatchObject({
        inboxId: INBOX_ID,
        content: 'You are a helpful sales assistant for our shop.',
        etag: 'abc123def456',
        version: 3,
      });
      expect(upsertCalls[0]!.set).toMatchObject({ content: expect.any(String), version: 3 });
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid HMAC signature with 401 and never writes', async () => {
    const { app, upsertCalls } = await buildTestApp();
    try {
      const raw = JSON.stringify(validBody());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/backfill/inbox-playbook',
        headers: { 'content-type': 'application/json', 'x-backfill-signature': 'deadbeef' },
        payload: raw,
      });
      expect(res.statusCode).toBe(401);
      expect(upsertCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('validates without writing when ?dryRun=true', async () => {
    const { app, upsertCalls } = await buildTestApp();
    try {
      const raw = JSON.stringify(validBody());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/backfill/inbox-playbook?dryRun=true',
        headers: { 'content-type': 'application/json', 'x-backfill-signature': sign(raw) },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.dryRun).toBe(true);
      expect(json.wouldUpsert).toMatchObject({ inboxId: INBOX_ID, version: 3 });
      expect(upsertCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('is idempotent — two identical signed requests produce the same upsert', async () => {
    const { app, upsertCalls } = await buildTestApp();
    try {
      const raw = JSON.stringify(validBody());
      const headers = { 'content-type': 'application/json', 'x-backfill-signature': sign(raw) };
      const url = '/api/v1/internal/backfill/inbox-playbook';

      const first = await app.inject({ method: 'POST', url, headers, payload: raw });
      const second = await app.inject({ method: 'POST', url, headers, payload: raw });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(upsertCalls).toHaveLength(2);
      // Same PK target + identical values → ON CONFLICT DO UPDATE converges.
      expect(upsertCalls[0]!.values).toEqual(upsertCalls[1]!.values);
      expect(upsertCalls[0]!.target).toBe(upsertCalls[1]!.target);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when BACKFILL_SHARED_SECRET is unset', async () => {
    const { app, upsertCalls } = await buildTestApp(null);
    try {
      const raw = JSON.stringify(validBody());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/backfill/inbox-playbook',
        headers: { 'content-type': 'application/json', 'x-backfill-signature': sign(raw) },
        payload: raw,
      });
      expect(res.statusCode).toBe(503);
      expect(upsertCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
