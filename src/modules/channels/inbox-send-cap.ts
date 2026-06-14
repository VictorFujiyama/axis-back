import type { Job, Queue } from 'bullmq';
import type Redis from 'ioredis';

import { nextMidnightMs, todayDateKey } from './inbox-cap-time.js';
import { releaseSlot, reserveSlot, type ReserveOutcome } from './inbox-cap-script.js';

export const HARD_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;
export const MIN_DELAY_MS = 60 * 1000;
export const DEFAULT_JITTER_MS = 5 * 60 * 1000;
const BACKLOG_SET_TTL_SECONDS = 16 * 24 * 60 * 60;

export const PAUSE_REASONS = ['cap-zero', 'needs-reauth', 'manual'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export function counterKey(inboxId: string, timezone: string, nowMs: number): string {
  return `inbox:${inboxId}:sent:${todayDateKey(timezone, nowMs)}-${timezone}`;
}

export function idempotencyKey(inboxId: string, messageId: string): string {
  return `inbox:${inboxId}:msg:${messageId}:counted`;
}

export function pausedKey(inboxId: string): string {
  return `inbox:${inboxId}:paused`;
}

export function backlogSetKey(inboxId: string): string {
  return `inbox:${inboxId}:backlog:jobIds`;
}

export interface ReserveForInboxInput {
  inboxId: string;
  messageId: string;
  cap: number;
  timezone: string;
  nowMs: number;
}

export async function reserveForInbox(
  redis: Redis,
  input: ReserveForInboxInput,
): Promise<ReserveOutcome> {
  return reserveSlot(
    redis,
    {
      counterKey: counterKey(input.inboxId, input.timezone, input.nowMs),
      idempotencyKey: idempotencyKey(input.inboxId, input.messageId),
      pausedKey: pausedKey(input.inboxId),
    },
    { cap: input.cap },
  );
}

export interface ReleaseForInboxInput {
  inboxId: string;
  messageId: string;
  /**
   * Timezone + UTC ms of the moment the reserve was made. NOT the moment
   * of release. Crossing midnight between reserve and release would DECR
   * the wrong day's counter and leak yesterday's capacity.
   */
  timezone: string;
  reservedAtMs: number;
}

export async function releaseForInbox(
  redis: Redis,
  input: ReleaseForInboxInput,
): Promise<void> {
  await releaseSlot(redis, {
    counterKey: counterKey(input.inboxId, input.timezone, input.reservedAtMs),
    idempotencyKey: idempotencyKey(input.inboxId, input.messageId),
    pausedKey: pausedKey(input.inboxId),
  });
}

export async function isInboxPaused(redis: Redis, inboxId: string): Promise<boolean> {
  return (await redis.get(pausedKey(inboxId))) === '1';
}

export async function getPauseReason(
  redis: Redis,
  inboxId: string,
): Promise<PauseReason | null> {
  const raw = await redis.get(`${pausedKey(inboxId)}:reason`);
  return (PAUSE_REASONS as readonly string[]).includes(raw ?? '') ? (raw as PauseReason) : null;
}

export async function pauseInbox(
  redis: Redis,
  inboxId: string,
  reason: PauseReason,
): Promise<void> {
  await redis
    .multi()
    .set(pausedKey(inboxId), '1')
    .set(`${pausedKey(inboxId)}:reason`, reason)
    .exec();
}

export async function resumeInbox(redis: Redis, inboxId: string): Promise<void> {
  await redis.multi().del(pausedKey(inboxId)).del(`${pausedKey(inboxId)}:reason`).exec();
}

export async function trackBacklogJob(
  redis: Redis,
  inboxId: string,
  jobId: string,
): Promise<void> {
  const key = backlogSetKey(inboxId);
  await redis.sadd(key, jobId);
  await redis.expire(key, BACKLOG_SET_TTL_SECONDS);
}

export async function untrackBacklogJob(
  redis: Redis,
  inboxId: string,
  jobId: string,
): Promise<void> {
  await redis.srem(backlogSetKey(inboxId), jobId);
}

export async function listBacklogJobs(redis: Redis, inboxId: string): Promise<string[]> {
  return redis.smembers(backlogSetKey(inboxId));
}

export async function backlogDepth(redis: Redis, inboxId: string): Promise<number> {
  return redis.scard(backlogSetKey(inboxId));
}

export async function currentSendCount(
  redis: Redis,
  inboxId: string,
  timezone: string,
  nowMs: number,
): Promise<number> {
  const raw = await redis.get(counterKey(inboxId, timezone, nowMs));
  return raw == null ? 0 : Number.parseInt(raw, 10) || 0;
}

export function computeDelayMs(
  timezone: string,
  nowMs: number,
  jitterMaxMs: number = DEFAULT_JITTER_MS,
  rng: () => number = Math.random,
): number {
  const base = nextMidnightMs(timezone, nowMs) - nowMs;
  const jitter =
    jitterMaxMs > 0
      ? Math.min(Math.floor(rng() * jitterMaxMs), jitterMaxMs - 1)
      : 0;
  // Clamp base to MIN_DELAY first, THEN add jitter — keeps jitter spread
  // even when base is below MIN_DELAY (avoids thundering herd at clamp).
  return Math.max(MIN_DELAY_MS, base) + jitter;
}

export class BacklogFullError extends Error {
  readonly code = 'BACKLOG_FULL';
  readonly messageCreatedAtMs: number;
  readonly nowMs: number;
  constructor(messageCreatedAtMs: number, nowMs: number) {
    super(
      `backlog hard limit exceeded: createdAt ${new Date(messageCreatedAtMs).toISOString()}, now ${new Date(nowMs).toISOString()}, age ${nowMs - messageCreatedAtMs}ms (limit ${HARD_LIMIT_MS}ms)`,
    );
    this.name = 'BacklogFullError';
    this.messageCreatedAtMs = messageCreatedAtMs;
    this.nowMs = nowMs;
  }
}

export function enforceHardLimitForEnqueue(
  messageCreatedAtMs: number,
  nowMs: number,
  delayMs: number,
): void {
  const projectedAge = nowMs + delayMs - messageCreatedAtMs;
  if (projectedAge >= HARD_LIMIT_MS) {
    throw new BacklogFullError(messageCreatedAtMs, nowMs);
  }
}

export function enforceHardLimitAtWorker(messageCreatedAtMs: number, nowMs: number): void {
  const age = nowMs - messageCreatedAtMs;
  if (age >= HARD_LIMIT_MS) {
    throw new BacklogFullError(messageCreatedAtMs, nowMs);
  }
}

export interface PromoteBacklogResult {
  promoted: number;
  skipped: number;
  removed: number;
}

/**
 * Iterates the inbox's backlog SET and promotes each delayed job with a
 * fresh jitter so they don't all fire at the same instant. Jobs that no
 * longer exist in the queue are SREM'd as cleanup.
 */
export async function promoteBacklog(
  redis: Redis,
  queue: Queue,
  inboxId: string,
  jitterMaxMs: number = DEFAULT_JITTER_MS,
  rng: () => number = Math.random,
): Promise<PromoteBacklogResult> {
  const jobIds = await listBacklogJobs(redis, inboxId);
  let promoted = 0;
  let skipped = 0;
  let removed = 0;
  for (const jobId of jobIds) {
    const job: Job | undefined = await queue.getJob(jobId);
    if (!job) {
      await untrackBacklogJob(redis, inboxId, jobId);
      removed += 1;
      continue;
    }
    const state = await job.getState();
    if (state !== 'delayed' && state !== 'waiting') {
      // already running / completed / failed — drop from set
      await untrackBacklogJob(redis, inboxId, jobId);
      removed += 1;
      continue;
    }
    const jitter = jitterMaxMs > 0 ? Math.min(Math.floor(rng() * jitterMaxMs), jitterMaxMs - 1) : 0;
    try {
      await job.changeDelay(jitter);
      promoted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { promoted, skipped, removed };
}
