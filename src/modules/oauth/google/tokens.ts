import { schema } from '@blossom/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { decryptJSON, encryptJSON } from '../../../crypto.js';
import { parseGmailSecrets } from '../../channels/gmail-config.js';
import { refreshAccessToken } from './client.js';

/**
 * Minimal shape of an inbox row that `getValidAccessToken` operates on.
 * Kept intentionally narrow so tests don't need to fabricate the full
 * Drizzle row. Will grow as later tasks (T-13/T-14) need more fields.
 */
export interface GmailInboxLike {
  id: string;
  secrets: string | null;
}

export interface GetValidAccessTokenDeps {
  /** Override `Date.now()` for testing. */
  now?: () => number;
  /** Override `refreshAccessToken` from `./client.js` for testing. */
  refresh?: typeof refreshAccessToken;
  /** Override the loser-of-race wait. Default is real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Refresh proactively when the token has less than this much life left. */
const REFRESH_BUFFER_MS = 60_000;
/** Per-inbox SETNX lock TTL covering one refresh round-trip. */
const REFRESH_LOCK_TTL_MS = 30_000;
/** Loser of the lock race waits this long before re-reading the row. */
const LOSER_RETRY_DELAY_MS = 200;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Returns a non-expired access token for a Gmail inbox.
 *
 * Refreshes lazily when `Date.now() > expiresAt - 60_000` (spec § 4) and
 * persists the rotated tokens (encrypted) on the inbox row.
 *
 * The Redis SETNX lock (T-13) and `invalid_grant` reauth handling (T-14)
 * extend this function in subsequent tasks.
 */
export async function getValidAccessToken(
  app: FastifyInstance,
  inbox: GmailInboxLike,
  deps: GetValidAccessTokenDeps = {},
): Promise<string> {
  if (!inbox.secrets) {
    throw new Error(`Gmail inbox ${inbox.id} has no secrets configured`);
  }

  const decrypted = decryptJSON(inbox.secrets);
  const parsed = parseGmailSecrets(decrypted);
  if (!('refreshToken' in parsed)) {
    throw new Error(`Gmail inbox ${inbox.id} has malformed secrets`);
  }

  const now = (deps.now ?? Date.now)();
  const expiresAtMs = Date.parse(parsed.expiresAt);

  if (now <= expiresAtMs - REFRESH_BUFFER_MS) {
    return parsed.accessToken;
  }

  // Refresh path. A SETNX lock keyed per-inbox guarantees that concurrent
  // sync + outbound dispatchers don't double-refresh the same token (which
  // would also waste a Google quota slot and risk a `invalid_grant` race).
  const lockKey = `gmail-token-refresh:${inbox.id}`;
  const acquired = await app.redis.set(lockKey, '1', 'PX', REFRESH_LOCK_TTL_MS, 'NX');

  if (acquired !== 'OK') {
    // Loser path: wait briefly so the winner can persist, then re-read.
    const sleep = deps.sleep ?? defaultSleep;
    await sleep(LOSER_RETRY_DELAY_MS);

    const [row] = await app.db
      .select()
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, inbox.id))
      .limit(1);

    if (!row?.secrets) {
      throw new Error(`Gmail inbox ${inbox.id} disappeared while refreshing`);
    }
    const fresh = parseGmailSecrets(decryptJSON(row.secrets));
    if (!('refreshToken' in fresh)) {
      throw new Error(`Gmail inbox ${inbox.id} has malformed secrets after refresh`);
    }
    return fresh.accessToken;
  }

  try {
    const refresh = deps.refresh ?? refreshAccessToken;
    const result = await refresh(parsed.refreshToken);

    const newExpiresAt = new Date(now + result.expiresIn * 1000).toISOString();
    // Google sometimes does not re-issue a refresh token on refresh — keep the
    // original. The new access token + new expiry replace the cached pair.
    const newSecrets = encryptJSON({
      refreshToken: parsed.refreshToken,
      accessToken: result.accessToken,
      expiresAt: newExpiresAt,
    });

    await app.db
      .update(schema.inboxes)
      .set({ secrets: newSecrets, updatedAt: new Date() })
      .where(eq(schema.inboxes.id, inbox.id));

    return result.accessToken;
  } finally {
    await app.redis.del(lockKey);
  }
}
