import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';

import {
  RESERVE_SLOT_LUA,
  releaseSlot,
  reserveSlot,
  type ReserveSlotKeys,
} from '../inbox-cap-script.js';

const KEYS: ReserveSlotKeys = {
  counterKey: 'inbox:abc:sent:2026-06-13-America/Sao_Paulo',
  idempotencyKey: 'inbox:abc:msg:msg-1:counted',
  pausedKey: 'inbox:abc:paused',
};

let redis: Redis;

beforeEach(() => {
  redis = new RedisMock() as unknown as Redis;
});

afterEach(async () => {
  await redis.flushall();
  await redis.quit();
});

describe('reserveSlot — happy path', () => {
  it('ok on first reserve, INCR counter, SET idempotency', async () => {
    const out = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(out).toBe('ok');
    expect(await redis.get(KEYS.counterKey)).toBe('1');
    expect(await redis.get(KEYS.idempotencyKey)).toBe('1');
  });

  it('counts up to cap inclusive', async () => {
    for (let i = 0; i < 50; i++) {
      const out = await reserveSlot(
        redis,
        { ...KEYS, idempotencyKey: `inbox:abc:msg:m${i}:counted` },
        { cap: 50 },
      );
      expect(out).toBe('ok');
    }
    expect(await redis.get(KEYS.counterKey)).toBe('50');
  });
});

describe('reserveSlot — over cap', () => {
  it('returns over-cap and ROLLS BACK counter (DECR)', async () => {
    for (let i = 0; i < 50; i++) {
      await reserveSlot(
        redis,
        { ...KEYS, idempotencyKey: `inbox:abc:msg:m${i}:counted` },
        { cap: 50 },
      );
    }
    expect(await redis.get(KEYS.counterKey)).toBe('50');

    const over = await reserveSlot(
      redis,
      { ...KEYS, idempotencyKey: 'inbox:abc:msg:m51:counted' },
      { cap: 50 },
    );
    expect(over).toBe('over-cap');
    // crucial: rollback means counter stays at 50, NOT 51
    expect(await redis.get(KEYS.counterKey)).toBe('50');
    // idempotency NOT set for over-cap so retry can re-attempt next day
    expect(await redis.get('inbox:abc:msg:m51:counted')).toBeNull();
  });

  it('cap=0 returns over-cap from very first call', async () => {
    const out = await reserveSlot(redis, KEYS, { cap: 0 });
    expect(out).toBe('over-cap');
    expect(await redis.get(KEYS.counterKey)).toBe('0');
  });
});

describe('reserveSlot — idempotency (retry-safe)', () => {
  it('same messageId twice returns ok then reserved-already, counter increments only once', async () => {
    const first = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(first).toBe('ok');
    const second = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(second).toBe('reserved-already');
    expect(await redis.get(KEYS.counterKey)).toBe('1');
  });

  it('reserved-already short-circuits before paused check is reached for the same message?', async () => {
    // Order matters per Lua: paused check is FIRST. So even reserved msg
    // returns 'paused' if inbox got paused after the first reserve.
    await reserveSlot(redis, KEYS, { cap: 50 });
    await redis.set(KEYS.pausedKey, '1');
    const second = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(second).toBe('paused');
  });
});

describe('reserveSlot — paused', () => {
  it('returns paused without INCR when paused flag is set', async () => {
    await redis.set(KEYS.pausedKey, '1');
    const out = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(out).toBe('paused');
    expect(await redis.get(KEYS.counterKey)).toBeNull();
    expect(await redis.get(KEYS.idempotencyKey)).toBeNull();
  });

  it('paused=0 is treated as not-paused (only literal "1" pauses)', async () => {
    await redis.set(KEYS.pausedKey, '0');
    const out = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(out).toBe('ok');
  });

  it('after clearing paused, next reserve goes ok', async () => {
    await redis.set(KEYS.pausedKey, '1');
    expect(await reserveSlot(redis, KEYS, { cap: 50 })).toBe('paused');
    await redis.del(KEYS.pausedKey);
    expect(await reserveSlot(redis, KEYS, { cap: 50 })).toBe('ok');
  });
});

describe('reserveSlot — TTL', () => {
  it('counter gets TTL on first INCR (default 26h)', async () => {
    await reserveSlot(redis, KEYS, { cap: 50 });
    const ttl = await redis.ttl(KEYS.counterKey);
    expect(ttl).toBeGreaterThan(60 * 60); // >1h
    expect(ttl).toBeLessThanOrEqual(26 * 60 * 60); // <=26h
  });

  it('idempotency key gets matching TTL', async () => {
    await reserveSlot(redis, KEYS, { cap: 50 });
    const ttl = await redis.ttl(KEYS.idempotencyKey);
    expect(ttl).toBeGreaterThan(60 * 60);
    expect(ttl).toBeLessThanOrEqual(26 * 60 * 60);
  });

  it('respects custom TTL args', async () => {
    await reserveSlot(redis, KEYS, {
      cap: 50,
      counterTtlSeconds: 100,
      idempotencyTtlSeconds: 200,
    });
    expect(await redis.ttl(KEYS.counterKey)).toBeLessThanOrEqual(100);
    expect(await redis.ttl(KEYS.idempotencyKey)).toBeLessThanOrEqual(200);
  });

  it('subsequent INCR does NOT reset TTL', async () => {
    await reserveSlot(
      redis,
      { ...KEYS, idempotencyKey: 'inbox:abc:msg:m1:counted' },
      { cap: 50, counterTtlSeconds: 100 },
    );
    const ttl1 = await redis.ttl(KEYS.counterKey);
    await reserveSlot(
      redis,
      { ...KEYS, idempotencyKey: 'inbox:abc:msg:m2:counted' },
      { cap: 50, counterTtlSeconds: 999 },
    );
    const ttl2 = await redis.ttl(KEYS.counterKey);
    // Should still reflect original TTL (decayed), not reset to 999
    expect(ttl2).toBeLessThanOrEqual(ttl1);
  });
});

describe('reserveSlot — input validation', () => {
  it('throws on non-integer cap', async () => {
    await expect(reserveSlot(redis, KEYS, { cap: 1.5 })).rejects.toThrow(/integer/);
  });
  it('throws on negative cap', async () => {
    await expect(reserveSlot(redis, KEYS, { cap: -1 })).rejects.toThrow(/non-negative/);
  });
});

describe('releaseSlot', () => {
  it('DECRs counter and DELs idempotency', async () => {
    await reserveSlot(redis, KEYS, { cap: 50 });
    await reserveSlot(redis, { ...KEYS, idempotencyKey: 'inbox:abc:msg:m2:counted' }, { cap: 50 });
    expect(await redis.get(KEYS.counterKey)).toBe('2');

    await releaseSlot(redis, KEYS);
    expect(await redis.get(KEYS.counterKey)).toBe('1');
    expect(await redis.get(KEYS.idempotencyKey)).toBeNull();
  });

  it('release allows the same messageId to reserve again', async () => {
    await reserveSlot(redis, KEYS, { cap: 50 });
    await releaseSlot(redis, KEYS);
    const out = await reserveSlot(redis, KEYS, { cap: 50 });
    expect(out).toBe('ok'); // not 'reserved-already'
  });

  it('does NOT push counter negative on double-release', async () => {
    await reserveSlot(redis, KEYS, { cap: 50 });
    expect(await redis.get(KEYS.counterKey)).toBe('1');
    await releaseSlot(redis, KEYS);
    expect(await redis.get(KEYS.counterKey)).toBe('0');
    await releaseSlot(redis, KEYS); // second release — must be safe
    expect(await redis.get(KEYS.counterKey)).toBe('0');
  });

  it('release without prior reserve is safe (no negative counter)', async () => {
    await releaseSlot(redis, KEYS);
    const raw = await redis.get(KEYS.counterKey);
    // Either null (never set) or '0' (set but not decremented past zero)
    expect(raw === null || raw === '0').toBe(true);
  });
});

describe('reserveSlot — idempotency-expiry cross-day', () => {
  it('after idem key expires (TTL passes), same messageId can reserve again as fresh', async () => {
    await reserveSlot(redis, KEYS, { cap: 50, idempotencyTtlSeconds: 1 });
    expect(await redis.get(KEYS.idempotencyKey)).toBe('1');
    // Simulate TTL elapsing by explicit DEL (mock doesn't tick wall clock)
    await redis.del(KEYS.idempotencyKey);
    // Counter also "reset" (new day = different counterKey in prod)
    const NEW_DAY_KEYS = {
      ...KEYS,
      counterKey: 'inbox:abc:sent:2026-06-14-America/Sao_Paulo',
    };
    const out = await reserveSlot(redis, NEW_DAY_KEYS, { cap: 50 });
    expect(out).toBe('ok');
    expect(await redis.get(NEW_DAY_KEYS.counterKey)).toBe('1');
  });
});

describe('Lua source — sanity', () => {
  it('script string is exported (for ops/debug)', () => {
    expect(RESERVE_SLOT_LUA).toContain('paused');
    expect(RESERVE_SLOT_LUA).toContain('over-cap');
    expect(RESERVE_SLOT_LUA).toContain('reserved-already');
    expect(RESERVE_SLOT_LUA).toContain('INCR');
    expect(RESERVE_SLOT_LUA).toContain('DECR');
  });
});
