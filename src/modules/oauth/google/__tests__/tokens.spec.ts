import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { decryptJSON, encryptJSON } from '../../../../crypto.js';
import { GoogleOAuthError, InvalidGrantError } from '../client.js';
import { GmailReauthRequiredError } from '../errors.js';
import type { GmailInboxLike } from '../tokens.js';
import { getValidAccessToken } from '../tokens.js';

const ACCESS_TOKEN = 'ya29.fresh-access-token';
const REFRESH_TOKEN = 'REDACTED-refresh-token';

function buildInbox(
  expiresAt: string,
  config: Record<string, unknown> = { provider: 'gmail' },
): GmailInboxLike {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    config,
    secrets: encryptJSON({
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      expiresAt,
    }),
  };
}

// For the happy path, `app` is structural only — we never reach a property access on it.
const fakeApp = {} as FastifyInstance;

interface DbStub {
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  selectFrom: ReturnType<typeof vi.fn>;
  selectWhere: ReturnType<typeof vi.fn>;
  selectLimit: ReturnType<typeof vi.fn>;
}

interface RedisStub {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

interface AppBuildResult {
  app: FastifyInstance;
  db: DbStub;
  redis: RedisStub;
}

/**
 * Build an app stub with chainable drizzle `update` + `select` and an
 * ioredis-shaped `redis` whose `set` defaults to `'OK'` (lock acquired).
 *
 * The select chain returns `selectRows` — pass a reference so the test can
 * mutate it after each `update().set()` call to simulate the row being
 * rotated by a concurrent refresh.
 */
function buildAppWithDb(selectRows: unknown[] = []): AppBuildResult {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  const selectLimit = vi.fn().mockResolvedValue(selectRows);
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const redisSet = vi.fn().mockResolvedValue('OK');
  const redisDel = vi.fn().mockResolvedValue(1);

  return {
    app: {
      db: { update, select },
      redis: { set: redisSet, del: redisDel },
    } as unknown as FastifyInstance,
    db: { update, set, where, select, selectFrom, selectWhere, selectLimit },
    redis: { set: redisSet, del: redisDel },
  };
}

describe('getValidAccessToken — happy path (no refresh)', () => {
  it('returns the cached access token when expiresAt is comfortably in the future', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T13:00:00.000Z'); // +1 hour
    const refresh = vi.fn();

    const token = await getValidAccessToken(fakeApp, inbox, {
      now: () => now,
      refresh: refresh as unknown as never,
    });

    expect(token).toBe(ACCESS_TOKEN);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats anything more than 60s before expiry as still fresh', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    // 61s ahead of `now` — just outside the 60s safety buffer.
    const inbox = buildInbox('2026-05-05T12:01:01.000Z');
    const refresh = vi.fn();

    const token = await getValidAccessToken(fakeApp, inbox, {
      now: () => now,
      refresh: refresh as unknown as never,
    });

    expect(token).toBe(ACCESS_TOKEN);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats exactly 60s ahead of now as still fresh (boundary inclusive)', async () => {
    // Spec § 4: refresh when `Date.now() > expiresAt - 60_000` — strict `>`,
    // so `now == expiresAt - 60_000` (i.e. 60s ahead) must NOT trigger refresh.
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:01:00.000Z');
    const refresh = vi.fn();

    const token = await getValidAccessToken(fakeApp, inbox, {
      now: () => now,
      refresh: refresh as unknown as never,
    });

    expect(token).toBe(ACCESS_TOKEN);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('getValidAccessToken — lazy refresh', () => {
  const NEW_ACCESS_TOKEN = 'ya29.NEW-access-token';

  it('calls refreshAccessToken with the decrypted refresh token when within the 60s buffer', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    // 30s ahead of `now` — inside the 60s safety buffer → must refresh.
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    const refresh = vi.fn().mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      expiresIn: 3600,
    });
    const { app } = buildAppWithDb();

    const token = await getValidAccessToken(app, inbox, {
      now: () => now,
      refresh,
    });

    expect(token).toBe(NEW_ACCESS_TOKEN);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(REFRESH_TOKEN);
  });

  it('refreshes when the access token is already past expiry', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    // 5 minutes stale.
    const inbox = buildInbox('2026-05-05T11:55:00.000Z');
    const refresh = vi.fn().mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      expiresIn: 3600,
    });
    const { app } = buildAppWithDb();

    const token = await getValidAccessToken(app, inbox, {
      now: () => now,
      refresh,
    });

    expect(token).toBe(NEW_ACCESS_TOKEN);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('persists the new tokens encrypted with the original refresh token and a recomputed expiresAt', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    const refresh = vi.fn().mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      expiresIn: 3600,
    });
    const { app, db } = buildAppWithDb();

    await getValidAccessToken(app, inbox, { now: () => now, refresh });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledTimes(1);
    expect(db.where).toHaveBeenCalledTimes(1);

    const setArg = db.set.mock.calls[0]![0] as {
      secrets: string;
      updatedAt: Date;
    };
    expect(typeof setArg.secrets).toBe('string');
    expect(setArg.updatedAt).toBeInstanceOf(Date);

    const decrypted = decryptJSON(setArg.secrets) as {
      refreshToken: string;
      accessToken: string;
      expiresAt: string;
    };
    // Google often does not re-issue the refresh token; we keep the original.
    expect(decrypted.refreshToken).toBe(REFRESH_TOKEN);
    expect(decrypted.accessToken).toBe(NEW_ACCESS_TOKEN);
    // `expiresAt = now + expiresIn * 1000` as ISO 8601 with the `Z` suffix.
    expect(decrypted.expiresAt).toBe('2026-05-05T13:00:00.000Z');
  });

  it('honors a different expiresIn returned by the refresh response', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    const refresh = vi.fn().mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      expiresIn: 1800, // 30 min
    });
    const { app, db } = buildAppWithDb();

    await getValidAccessToken(app, inbox, { now: () => now, refresh });

    const setArg = db.set.mock.calls[0]![0] as { secrets: string };
    const decrypted = decryptJSON(setArg.secrets) as { expiresAt: string };
    expect(decrypted.expiresAt).toBe('2026-05-05T12:30:00.000Z');
  });
});

describe('getValidAccessToken — Redis lock for concurrent refresh (T-13)', () => {
  const NEW_ACCESS_TOKEN = 'ya29.NEW-access-token';
  const INBOX_ID = '11111111-1111-1111-1111-111111111111';
  const LOCK_KEY = `gmail-token-refresh:${INBOX_ID}`;

  it('acquires the lock with NX+PX(30s) before refreshing, then releases it', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    const refresh = vi.fn().mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      expiresIn: 3600,
    });
    const { app, redis } = buildAppWithDb();

    const token = await getValidAccessToken(app, inbox, {
      now: () => now,
      refresh,
    });

    expect(token).toBe(NEW_ACCESS_TOKEN);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(LOCK_KEY, '1', 'PX', 30_000, 'NX');
    // Lock acquired before refresh fires.
    expect(redis.set.mock.invocationCallOrder[0]!).toBeLessThan(
      refresh.mock.invocationCallOrder[0]!,
    );
    // Lock released exactly once after the work.
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(LOCK_KEY);
  });

  it('releases the lock even when the refresh call throws', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    const boom = new Error('refresh exploded');
    const refresh = vi.fn().mockRejectedValue(boom);
    const { app, redis, db } = buildAppWithDb();

    await expect(
      getValidAccessToken(app, inbox, { now: () => now, refresh }),
    ).rejects.toThrow('refresh exploded');

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(LOCK_KEY);
    // No DB write when refresh fails.
    expect(db.update).not.toHaveBeenCalled();
  });

  it('loser of the race awaits ~200ms and re-reads tokens from DB', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    // Simulate the winner having already rotated the secrets in DB.
    const rotatedRow = {
      id: INBOX_ID,
      secrets: encryptJSON({
        refreshToken: REFRESH_TOKEN,
        accessToken: NEW_ACCESS_TOKEN,
        expiresAt: '2026-05-05T13:00:00.000Z',
      }),
    };
    const { app, redis, db } = buildAppWithDb([rotatedRow]);
    redis.set.mockResolvedValueOnce(null); // lock not acquired
    const refresh = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const token = await getValidAccessToken(app, inbox, {
      now: () => now,
      refresh,
      sleep,
    });

    expect(token).toBe(NEW_ACCESS_TOKEN);
    // Loser path never refreshes.
    expect(refresh).not.toHaveBeenCalled();
    // Loser waits ~200ms before re-reading.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200);
    // Loser SELECTs the inbox row (chain reached `.limit`).
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.selectLimit).toHaveBeenCalledWith(1);
    // Loser does not touch the DB write path or release a lock it doesn't hold.
    expect(db.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('two concurrent calls produce exactly one refresh request', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');

    // Shared mutable state: the row both calls would see.
    // The winner's `update().set()` mutates `rowState.secrets`; the loser's
    // `select()` reads `[rowState]` — same object reference, so the post-refresh
    // value is observable.
    const rowState = { id: INBOX_ID, secrets: inbox.secrets };
    const { app, redis, db } = buildAppWithDb([rowState]);
    redis.set
      .mockResolvedValueOnce('OK') // call 1 wins
      .mockResolvedValueOnce(null); // call 2 loses
    db.set.mockImplementation((arg: { secrets: string }) => {
      rowState.secrets = arg.secrets;
      return { where: db.where };
    });

    const refresh = vi.fn().mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      expiresIn: 3600,
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const [a, b] = await Promise.all([
      getValidAccessToken(app, inbox, { now: () => now, refresh, sleep }),
      getValidAccessToken(app, inbox, { now: () => now, refresh, sleep }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledTimes(1);
    // Winner returns the new token from refresh; loser returns the same
    // token re-read from the rotated DB row.
    expect(a).toBe(NEW_ACCESS_TOKEN);
    expect(b).toBe(NEW_ACCESS_TOKEN);
  });
});

describe('getValidAccessToken — invalid_grant → reauth (T-14)', () => {
  it('catches InvalidGrantError, patches config.needsReauth=true, and throws GmailReauthRequiredError', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z', {
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      fromName: 'Support',
    });
    const refresh = vi.fn().mockRejectedValue(
      new InvalidGrantError('Token has been expired or revoked.', 400),
    );
    const { app, db, redis } = buildAppWithDb();

    await expect(
      getValidAccessToken(app, inbox, { now: () => now, refresh }),
    ).rejects.toBeInstanceOf(GmailReauthRequiredError);

    // No access-token write happened.
    // Only one update call: the config patch flipping needsReauth.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledTimes(1);
    const setArg = db.set.mock.calls[0]![0] as {
      config: Record<string, unknown>;
      secrets?: string;
      updatedAt: Date;
    };
    expect(setArg.secrets).toBeUndefined();
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    // Existing config fields preserved; needsReauth flipped on.
    expect(setArg.config).toEqual({
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      fromName: 'Support',
      needsReauth: true,
    });

    // Lock acquired AND released even on the failure path.
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('starts from an empty/legacy config object and still emits needsReauth: true', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    // Legacy row with no `config.provider` set — parseGmailConfig returns {}.
    const inbox = buildInbox('2026-05-05T12:00:30.000Z', {});
    const refresh = vi.fn().mockRejectedValue(
      new InvalidGrantError('Token has been expired or revoked.', 400),
    );
    const { app, db } = buildAppWithDb();

    await expect(
      getValidAccessToken(app, inbox, { now: () => now, refresh }),
    ).rejects.toBeInstanceOf(GmailReauthRequiredError);

    const setArg = db.set.mock.calls[0]![0] as {
      config: Record<string, unknown>;
    };
    expect(setArg.config.needsReauth).toBe(true);
  });

  it('non-invalid_grant 4xx errors propagate without flipping needsReauth', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z', { provider: 'gmail' });
    const refresh = vi.fn().mockRejectedValue(
      new GoogleOAuthError('unauthorized_client', 401, 'unauthorized_client'),
    );
    const { app, db, redis } = buildAppWithDb();

    await expect(
      getValidAccessToken(app, inbox, { now: () => now, refresh }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);

    // Did NOT patch needsReauth.
    expect(db.update).not.toHaveBeenCalled();
    expect(db.set).not.toHaveBeenCalled();
    // Lock still released.
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('GmailReauthRequiredError exposes inboxId so callers can identify the row', async () => {
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const inbox = buildInbox('2026-05-05T12:00:30.000Z');
    const refresh = vi.fn().mockRejectedValue(
      new InvalidGrantError('Token has been expired or revoked.', 400),
    );
    const { app } = buildAppWithDb();

    await expect(
      getValidAccessToken(app, inbox, { now: () => now, refresh }),
    ).rejects.toMatchObject({
      name: 'GmailReauthRequiredError',
      inboxId: inbox.id,
    });
  });
});
