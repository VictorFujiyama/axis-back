import type { FastifyInstance } from 'fastify';
import { decryptJSON } from '../../../crypto.js';
import { parseGmailSecrets } from '../../channels/gmail-config.js';
import { refreshAccessToken } from './client.js';

/**
 * Minimal shape of an inbox row that `getValidAccessToken` operates on.
 * Kept intentionally narrow so tests don't need to fabricate the full
 * Drizzle row. Will grow as later tasks (T-12+) need more fields.
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
}

/** Refresh proactively when the token has less than this much life left. */
const REFRESH_BUFFER_MS = 60_000;

/**
 * Returns a non-expired access token for a Gmail inbox.
 *
 * **T-11 (this iteration):** only the happy path — the cached `accessToken`
 * is returned when `expiresAt` is more than 60s in the future. The lazy
 * refresh path (T-12), the Redis lock (T-13), and `invalid_grant` reauth
 * handling (T-14) extend this function in subsequent tasks.
 */
export async function getValidAccessToken(
  app: FastifyInstance,
  inbox: GmailInboxLike,
  deps: GetValidAccessTokenDeps = {},
): Promise<string> {
  void app;

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

  if (now < expiresAtMs - REFRESH_BUFFER_MS) {
    return parsed.accessToken;
  }

  // Refresh path lands in T-12. Until then, surfacing a clear error keeps any
  // accidental caller from silently shipping an expired token.
  throw new Error('Gmail token refresh path is not implemented yet (T-12)');
}
