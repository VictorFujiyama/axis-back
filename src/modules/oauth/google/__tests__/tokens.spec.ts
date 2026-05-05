import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { decryptJSON, encryptJSON } from '../../../../crypto.js';
import type { GmailInboxLike } from '../tokens.js';
import { getValidAccessToken } from '../tokens.js';

const ACCESS_TOKEN = 'ya29.fresh-access-token';
const REFRESH_TOKEN = 'REDACTED-refresh-token';

function buildInbox(expiresAt: string): GmailInboxLike {
  return {
    id: '11111111-1111-1111-1111-111111111111',
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
}

function buildAppWithDb(): { app: FastifyInstance; db: DbStub } {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return {
    app: { db: { update } } as unknown as FastifyInstance,
    db: { update, set, where },
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
