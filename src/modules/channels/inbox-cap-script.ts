import type Redis from 'ioredis';

export type ReserveOutcome = 'paused' | 'reserved-already' | 'over-cap' | 'ok';

const COUNTER_TTL_SECONDS = 26 * 60 * 60;
const IDEM_TTL_SECONDS = 26 * 60 * 60;

export const RESERVE_SLOT_LUA = `
local pausedFlag = redis.call('GET', KEYS[3])
if pausedFlag == '1' then
  return 'paused'
end

local already = redis.call('GET', KEYS[2])
if already == '1' then
  return 'reserved-already'
end

local cap = tonumber(ARGV[1])
local counterTtl = tonumber(ARGV[2])
local idemTtl = tonumber(ARGV[3])

local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], counterTtl)
end

if count > cap then
  redis.call('DECR', KEYS[1])
  return 'over-cap'
end

redis.call('SET', KEYS[2], '1', 'EX', idemTtl)
return 'ok'
`;

export interface ReserveSlotKeys {
  counterKey: string;
  idempotencyKey: string;
  pausedKey: string;
}

export interface ReserveSlotArgs {
  cap: number;
  counterTtlSeconds?: number;
  idempotencyTtlSeconds?: number;
}

export async function reserveSlot(
  redis: Redis,
  keys: ReserveSlotKeys,
  args: ReserveSlotArgs,
): Promise<ReserveOutcome> {
  if (!Number.isInteger(args.cap) || args.cap < 0) {
    throw new TypeError(`cap must be a non-negative integer, got ${args.cap}`);
  }
  const counterTtl = args.counterTtlSeconds ?? COUNTER_TTL_SECONDS;
  const idemTtl = args.idempotencyTtlSeconds ?? IDEM_TTL_SECONDS;
  const raw = await redis.eval(
    RESERVE_SLOT_LUA,
    3,
    keys.counterKey,
    keys.idempotencyKey,
    keys.pausedKey,
    String(args.cap),
    String(counterTtl),
    String(idemTtl),
  );
  if (raw !== 'paused' && raw !== 'reserved-already' && raw !== 'over-cap' && raw !== 'ok') {
    throw new Error(`unexpected Lua return: ${String(raw)}`);
  }
  return raw;
}

export const RELEASE_SLOT_LUA = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then
  redis.call('DECR', KEYS[1])
end
redis.call('DEL', KEYS[2])
return 'ok'
`;

export async function releaseSlot(
  redis: Redis,
  keys: ReserveSlotKeys,
): Promise<void> {
  await redis.eval(RELEASE_SLOT_LUA, 2, keys.counterKey, keys.idempotencyKey);
}
