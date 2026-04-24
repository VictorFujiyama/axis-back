import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { schema, type DB } from '@blossom/db';

export type PresenceKind = 'User' | 'Contact';
export type Availability = 'online' | 'busy' | 'offline';

// Widget pings every 60s — contacts need a longer presence window than agents.
const USER_PRESENCE_DURATION = Number(process.env.PRESENCE_DURATION ?? 20);
const CONTACT_PRESENCE_DURATION = Number(process.env.CONTACT_PRESENCE_DURATION ?? 90);
// Long enough to survive normal inactivity, short enough to evict dead accounts
// so the key doesn't accumulate user_ids of revoked memberships forever.
const KEY_TTL_SECONDS = 24 * 60 * 60;

function presenceKey(accountId: string, kind: PresenceKind): string {
  return kind === 'Contact'
    ? `online_presence::contact::${accountId}`
    : `online_presence::user::${accountId}`;
}

function statusKey(accountId: string): string {
  return `online_status::${accountId}`;
}

export class OnlineStatusTracker {
  constructor(
    private readonly redis: Redis,
    private readonly db: DB,
  ) {}

  // ---------- presence (heartbeat) ----------

  async updatePresence(accountId: string, kind: PresenceKind, id: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const key = presenceKey(accountId, kind);
    await this.redis.zadd(key, now, id);
    // Refresh TTL so keys for abandoned accounts eventually fall off.
    await this.redis.expire(key, KEY_TTL_SECONDS);
  }

  async getPresence(accountId: string, kind: PresenceKind, id: string): Promise<boolean> {
    const score = await this.redis.zscore(presenceKey(accountId, kind), id);
    if (!score) return false;
    const duration = kind === 'Contact' ? CONTACT_PRESENCE_DURATION : USER_PRESENCE_DURATION;
    return Number(score) > Math.floor(Date.now() / 1000) - duration;
  }

  async removePresence(accountId: string, kind: PresenceKind, id: string): Promise<void> {
    await this.redis.zrem(presenceKey(accountId, kind), id);
  }

  // ---------- chosen status (online | busy | offline) ----------

  async setStatus(accountId: string, userId: string, status: Availability): Promise<void> {
    const key = statusKey(accountId);
    await this.redis.hset(key, userId, status);
    await this.redis.expire(key, KEY_TTL_SECONDS);
  }

  async clearStatus(accountId: string, userId: string): Promise<void> {
    await this.redis.hdel(statusKey(accountId), userId);
  }

  async getStatus(accountId: string, userId: string): Promise<Availability | null> {
    const v = await this.redis.hget(statusKey(accountId), userId);
    return (v as Availability | null) ?? null;
  }

  // ---------- aggregates consumed by presence.update broadcast ----------

  async getAvailableContacts(accountId: string): Promise<Record<string, 'online'>> {
    const ids = await this.getAvailableContactIds(accountId);
    return Object.fromEntries(ids.map((id) => [id, 'online' as const]));
  }

  async getAvailableContactIds(accountId: string): Promise<string[]> {
    const key = presenceKey(accountId, 'Contact');
    const rangeStart = Math.floor(Date.now() / 1000) - CONTACT_PRESENCE_DURATION;
    // Trim stale entries so the set doesn't grow unbounded.
    await this.redis.zremrangebyscore(key, '-inf', `(${rangeStart}`);
    return this.redis.zrangebyscore(key, rangeStart, '+inf');
  }

  async getAvailableUsers(accountId: string): Promise<Record<string, Availability>> {
    const userIds = await this.getAvailableUserIds(accountId);
    if (userIds.length === 0) return {};

    const statuses = await this.redis.hmget(statusKey(accountId), ...userIds);
    const out: Record<string, Availability> = {};
    for (let i = 0; i < userIds.length; i++) {
      const id = userIds[i]!;
      const cached = statuses[i] as Availability | null;
      out[id] = cached ?? (await this.getAvailabilityFromDb(accountId, id));
    }
    return out;
  }

  /**
   * Users counted as "available" for the presence broadcast:
   *  - those with a live socket heartbeat, OR
   *  - those whose account_users.auto_offline is false (status sticks across socket drops).
   */
  async getAvailableUserIds(accountId: string): Promise<string[]> {
    const key = presenceKey(accountId, 'User');
    const rangeStart = Math.floor(Date.now() / 1000) - USER_PRESENCE_DURATION;
    // Evict stale entries so the zset doesn't grow unbounded for long-lived accounts.
    await this.redis.zremrangebyscore(key, '-inf', `(${rangeStart}`);
    const liveIds = await this.redis.zrangebyscore(key, rangeStart, '+inf');

    const stickyRows = await this.db
      .select({ userId: schema.accountUsers.userId })
      .from(schema.accountUsers)
      .where(
        and(
          eq(schema.accountUsers.accountId, accountId),
          eq(schema.accountUsers.autoOffline, false),
        ),
      );
    const stickyIds = stickyRows.map((r) => r.userId);

    return Array.from(new Set([...liveIds, ...stickyIds]));
  }

  /**
   * Fallback for when the status hash is empty for a user — reads the persisted
   * availability and caches it back into Redis.
   */
  private async getAvailabilityFromDb(accountId: string, userId: string): Promise<Availability> {
    const [row] = await this.db
      .select({ availability: schema.accountUsers.availability })
      .from(schema.accountUsers)
      .where(
        and(
          eq(schema.accountUsers.accountId, accountId),
          eq(schema.accountUsers.userId, userId),
        ),
      )
      .limit(1);
    const availability: Availability = (row?.availability as Availability) ?? 'offline';
    await this.setStatus(accountId, userId, availability);
    return availability;
  }
}
