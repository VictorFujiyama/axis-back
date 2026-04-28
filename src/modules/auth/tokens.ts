import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@blossom/shared-types';
import { sha256 } from '../../crypto';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  accountId: string;
}

const ACCESS_TTL = '15m';
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Redis stores sha256(token) so a Redis dump doesn't leak usable tokens.
// Key includes userId so we can revoke all tokens of a user (logout everywhere).
function refreshKey(userId: string, token: string): string {
  return `auth:refresh:${userId}:${sha256(token)}`;
}

export function signAccessToken(app: FastifyInstance, payload: AccessTokenPayload): string {
  return app.jwt.sign(payload, { expiresIn: ACCESS_TTL });
}

export async function issueRefreshToken(
  app: FastifyInstance,
  userId: string,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await app.redis.set(refreshKey(userId, token), '1', 'EX', REFRESH_TTL_SECONDS);
  return token;
}

/**
 * Validates a refresh token and rotates it (deletes the used one).
 * Returns the userId if valid, null otherwise.
 *
 * Note: we don't know the userId from the token alone (since key is hashed),
 * so we scan with a known prefix. To avoid SCAN, we encode userId in the
 * token itself: `<userIdB64>.<random>`.
 */
export async function consumeRefreshToken(
  app: FastifyInstance,
  rawToken: string,
): Promise<{ userId: string; accountId: string } | null> {
  const parts = rawToken.split('.');
  if (parts.length !== 3) return null;
  const userIdB64 = parts[0];
  const accountIdB64 = parts[1];
  if (!userIdB64 || !accountIdB64) return null;
  let userId: string;
  let accountId: string;
  try {
    userId = Buffer.from(userIdB64, 'base64url').toString('utf8');
    accountId = Buffer.from(accountIdB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;

  const key = refreshKey(userId, rawToken);
  const exists = await app.redis.get(key);
  if (!exists) return null;
  await app.redis.del(key); // rotate: invalidate old
  return { userId, accountId };
}

// Override issueRefreshToken to embed userId so consume can find it without SCAN.
export async function issueRefreshTokenWithUser(
  app: FastifyInstance,
  userId: string,
  accountId: string,
): Promise<string> {
  const random = randomBytes(32).toString('hex');
  const userIdB64 = Buffer.from(userId, 'utf8').toString('base64url');
  const accountIdB64 = Buffer.from(accountId, 'utf8').toString('base64url');
  const token = `${userIdB64}.${accountIdB64}.${random}`;
  await app.redis.set(refreshKey(userId, token), '1', 'EX', REFRESH_TTL_SECONDS);
  return token;
}

export async function revokeRefreshToken(
  app: FastifyInstance,
  rawToken: string,
): Promise<void> {
  const parts = rawToken.split('.');
  if (parts.length !== 3) return;
  const userIdB64 = parts[0];
  if (!userIdB64) return;
  let userId: string;
  try {
    userId = Buffer.from(userIdB64, 'base64url').toString('utf8');
  } catch {
    return;
  }
  await app.redis.del(refreshKey(userId, rawToken));
}

export async function revokeAllRefreshTokens(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  const stream = app.redis.scanStream({ match: `auth:refresh:${userId}:*`, count: 100 });
  for await (const keys of stream) {
    if ((keys as string[]).length) await app.redis.del(...(keys as string[]));
  }
}
