import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { encryptJSON } from '../../../../crypto.js';
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

// `getValidAccessToken` only touches `app` on the refresh / DB-write paths
// (T-12+). For the T-11 happy path the parameter is structural only, so an
// empty cast is fine — we never reach a property access on it.
const fakeApp = {} as FastifyInstance;

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
});
