import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { Queue } from 'bullmq';
import { DateTime } from 'luxon';

import {
  promoteBacklog,
  BacklogFullError,
  DEFAULT_JITTER_MS,
  HARD_LIMIT_MS,
  MIN_DELAY_MS,
  backlogDepth,
  backlogSetKey,
  computeDelayMs,
  counterKey,
  currentSendCount,
  enforceHardLimitAtWorker,
  enforceHardLimitForEnqueue,
  getPauseReason,
  idempotencyKey,
  isInboxPaused,
  listBacklogJobs,
  pauseInbox,
  pausedKey,
  releaseForInbox,
  reserveForInbox,
  resumeInbox,
  trackBacklogJob,
  untrackBacklogJob,
} from '../inbox-send-cap.js';

const INBOX = 'inbox-abc';
const TZ = 'America/Sao_Paulo';
const NOW = DateTime.fromISO('2026-06-13T14:00:00', { zone: TZ }).toMillis();

let redis: Redis;

beforeEach(() => {
  redis = new RedisMock() as unknown as Redis;
});

afterEach(async () => {
  await redis.flushall();
  await redis.quit();
});

describe('key naming', () => {
  it('counter key includes inboxId + date + timezone', () => {
    const key = counterKey(INBOX, TZ, NOW);
    expect(key).toBe('inbox:inbox-abc:sent:2026-06-13-America/Sao_Paulo');
  });
  it('counter key is timezone-scoped (different tz → different key on same UTC instant)', () => {
    const a = counterKey(INBOX, 'America/Sao_Paulo', NOW);
    const b = counterKey(INBOX, 'America/New_York', NOW);
    expect(a).not.toBe(b);
  });
  it('idempotency key includes messageId', () => {
    expect(idempotencyKey(INBOX, 'msg-1')).toBe('inbox:inbox-abc:msg:msg-1:counted');
  });
  it('paused + backlog set keys are inbox-scoped', () => {
    expect(pausedKey(INBOX)).toBe('inbox:inbox-abc:paused');
    expect(backlogSetKey(INBOX)).toBe('inbox:inbox-abc:backlog:jobIds');
  });
});

describe('reserveForInbox', () => {
  it('happy path: ok then reserved-already', async () => {
    const first = await reserveForInbox(redis, {
      inboxId: INBOX,
      messageId: 'm1',
      cap: 50,
      timezone: TZ,
      nowMs: NOW,
    });
    expect(first).toBe('ok');
    const second = await reserveForInbox(redis, {
      inboxId: INBOX,
      messageId: 'm1',
      cap: 50,
      timezone: TZ,
      nowMs: NOW,
    });
    expect(second).toBe('reserved-already');
  });

  it('over cap blocks further messages', async () => {
    for (let i = 0; i < 50; i++) {
      await reserveForInbox(redis, {
        inboxId: INBOX,
        messageId: `m${i}`,
        cap: 50,
        timezone: TZ,
        nowMs: NOW,
      });
    }
    const over = await reserveForInbox(redis, {
      inboxId: INBOX,
      messageId: 'm51',
      cap: 50,
      timezone: TZ,
      nowMs: NOW,
    });
    expect(over).toBe('over-cap');
  });

  it('paused inbox returns paused, never INCRs counter', async () => {
    await pauseInbox(redis, INBOX, 'cap-zero');
    const out = await reserveForInbox(redis, {
      inboxId: INBOX,
      messageId: 'm1',
      cap: 50,
      timezone: TZ,
      nowMs: NOW,
    });
    expect(out).toBe('paused');
    expect(await currentSendCount(redis, INBOX, TZ, NOW)).toBe(0);
  });
});

describe('pause / resume / isPaused / getPauseReason', () => {
  it('pauseInbox sets paused=1 + reason atomically', async () => {
    await pauseInbox(redis, INBOX, 'needs-reauth');
    expect(await isInboxPaused(redis, INBOX)).toBe(true);
    expect(await getPauseReason(redis, INBOX)).toBe('needs-reauth');
  });

  it('resumeInbox clears paused + reason', async () => {
    await pauseInbox(redis, INBOX, 'manual');
    await resumeInbox(redis, INBOX);
    expect(await isInboxPaused(redis, INBOX)).toBe(false);
    expect(await getPauseReason(redis, INBOX)).toBeNull();
  });

  it('second pause overwrites the reason', async () => {
    await pauseInbox(redis, INBOX, 'cap-zero');
    expect(await getPauseReason(redis, INBOX)).toBe('cap-zero');
    await pauseInbox(redis, INBOX, 'needs-reauth');
    expect(await getPauseReason(redis, INBOX)).toBe('needs-reauth');
  });

  it('getPauseReason returns null for unknown values (defensive)', async () => {
    await redis.set(`${pausedKey(INBOX)}:reason`, 'garbage');
    expect(await getPauseReason(redis, INBOX)).toBeNull();
  });
});

describe('backlog tracking', () => {
  it('track / untrack / list / depth round-trip', async () => {
    await trackBacklogJob(redis, INBOX, 'job-1');
    await trackBacklogJob(redis, INBOX, 'job-2');
    await trackBacklogJob(redis, INBOX, 'job-3');
    expect(await backlogDepth(redis, INBOX)).toBe(3);
    expect((await listBacklogJobs(redis, INBOX)).sort()).toEqual(['job-1', 'job-2', 'job-3']);

    await untrackBacklogJob(redis, INBOX, 'job-2');
    expect(await backlogDepth(redis, INBOX)).toBe(2);
    expect((await listBacklogJobs(redis, INBOX)).sort()).toEqual(['job-1', 'job-3']);
  });

  it('backlog set has TTL > 14 days (safety buffer)', async () => {
    await trackBacklogJob(redis, INBOX, 'job-1');
    const ttl = await redis.ttl(backlogSetKey(INBOX));
    expect(ttl).toBeGreaterThan(14 * 24 * 60 * 60);
  });

  it('multiple adds re-EXPIRE — TTL stays near 16d', async () => {
    await trackBacklogJob(redis, INBOX, 'job-1');
    const t1 = await redis.ttl(backlogSetKey(INBOX));
    await trackBacklogJob(redis, INBOX, 'job-2');
    const t2 = await redis.ttl(backlogSetKey(INBOX));
    // both within 1s of 16d — TTL should not have decayed below first
    expect(t2).toBeGreaterThanOrEqual(t1 - 1);
  });

  it('depth of empty inbox is 0', async () => {
    expect(await backlogDepth(redis, INBOX)).toBe(0);
  });
});

describe('currentSendCount', () => {
  it('returns 0 for empty counter', async () => {
    expect(await currentSendCount(redis, INBOX, TZ, NOW)).toBe(0);
  });
  it('returns counter value after reserves', async () => {
    await reserveForInbox(redis, { inboxId: INBOX, messageId: 'm1', cap: 50, timezone: TZ, nowMs: NOW });
    await reserveForInbox(redis, { inboxId: INBOX, messageId: 'm2', cap: 50, timezone: TZ, nowMs: NOW });
    expect(await currentSendCount(redis, INBOX, TZ, NOW)).toBe(2);
  });
});

describe('releaseForInbox', () => {
  it('decrements counter and re-enables messageId reservation', async () => {
    await reserveForInbox(redis, { inboxId: INBOX, messageId: 'm1', cap: 50, timezone: TZ, nowMs: NOW });
    expect(await currentSendCount(redis, INBOX, TZ, NOW)).toBe(1);

    await releaseForInbox(redis, { inboxId: INBOX, messageId: 'm1', timezone: TZ, reservedAtMs: NOW });
    expect(await currentSendCount(redis, INBOX, TZ, NOW)).toBe(0);

    const out = await reserveForInbox(redis, { inboxId: INBOX, messageId: 'm1', cap: 50, timezone: TZ, nowMs: NOW });
    expect(out).toBe('ok'); // not reserved-already
  });

  it('cross-day release DECRs the day of RESERVE, not the day of release', async () => {
    // Reserve at day 1 23:59 SP
    const day1At2359 = DateTime.fromISO('2026-06-13T23:59:00', { zone: TZ }).toMillis();
    await reserveForInbox(redis, {
      inboxId: INBOX,
      messageId: 'm1',
      cap: 50,
      timezone: TZ,
      nowMs: day1At2359,
    });
    expect(await currentSendCount(redis, INBOX, TZ, day1At2359)).toBe(1);

    // Release happens at day 2 00:00:30 SP — uses reservedAtMs from job data
    const day2At0030 = DateTime.fromISO('2026-06-14T00:00:30', { zone: TZ }).toMillis();
    await releaseForInbox(redis, {
      inboxId: INBOX,
      messageId: 'm1',
      timezone: TZ,
      reservedAtMs: day1At2359, // ← day of reserve, NOT day of release
    });

    // Day 1 counter back to 0
    expect(await currentSendCount(redis, INBOX, TZ, day1At2359)).toBe(0);
    // Day 2 counter untouched (was never incremented)
    expect(await currentSendCount(redis, INBOX, TZ, day2At0030)).toBe(0);
  });
});

describe('computeDelayMs', () => {
  it('returns nextMidnight - now + jitter', () => {
    // At 14:00 SP, midnight is 10h away
    const delay = computeDelayMs(TZ, NOW, 0); // zero jitter
    const tenHours = 10 * 60 * 60 * 1000;
    expect(delay).toBe(tenHours);
  });

  it('respects MIN_DELAY when near midnight (no jitter)', () => {
    const at2359 = DateTime.fromISO('2026-06-13T23:59:30', { zone: TZ }).toMillis();
    const delay = computeDelayMs(TZ, at2359, 0);
    // 30s till midnight — below MIN_DELAY (60s); no jitter
    expect(delay).toBe(MIN_DELAY_MS);
  });

  it('default jitter clamped within [0, jitterMax)', () => {
    const delay1 = computeDelayMs(TZ, NOW, 1000, () => 0);
    const delay2 = computeDelayMs(TZ, NOW, 1000, () => 0.999);
    expect(delay2 - delay1).toBeLessThan(1000);
    expect(delay2 - delay1).toBeGreaterThanOrEqual(0);
  });

  it('applies jitter EVEN near-midnight (MIN_DELAY + jitter, not clamped to MIN_DELAY)', () => {
    const at2359 = DateTime.fromISO('2026-06-13T23:59:30', { zone: TZ }).toMillis();
    const delay = computeDelayMs(TZ, at2359, 300_000, () => 0.5);
    // Bug #2 fix: MIN_DELAY (60s) + jitter (150s), not max(MIN_DELAY, ...)
    expect(delay).toBe(MIN_DELAY_MS + 150_000);
  });

  it('two inboxes hitting cap near-midnight get different delays (anti-thundering-herd)', () => {
    const at2359 = DateTime.fromISO('2026-06-13T23:59:30', { zone: TZ }).toMillis();
    let i = 0;
    const fixedRng = () => [0.1, 0.7][i++ % 2] ?? 0; // simulate 2 different inboxes
    const d1 = computeDelayMs(TZ, at2359, 300_000, fixedRng);
    const d2 = computeDelayMs(TZ, at2359, 300_000, fixedRng);
    expect(d1).not.toBe(d2);
  });
});

describe('enforceHardLimitForEnqueue (Check 1)', () => {
  it('passes when projected age < 14d', () => {
    const created = NOW - 13 * 24 * 60 * 60 * 1000; // 13d old
    const delay = 60 * 60 * 1000; // 1h delay
    expect(() => enforceHardLimitForEnqueue(created, NOW, delay)).not.toThrow();
  });

  it('throws BacklogFullError when projected age >= 14d', () => {
    const created = NOW - 13 * 24 * 60 * 60 * 1000;
    const delay = 25 * 60 * 60 * 1000; // 25h delay → projected 14d+1h
    expect(() => enforceHardLimitForEnqueue(created, NOW, delay)).toThrow(BacklogFullError);
  });

  it('boundary at exactly 14d throws (>= semantics)', () => {
    const created = NOW - HARD_LIMIT_MS;
    expect(() => enforceHardLimitForEnqueue(created, NOW, 0)).toThrow(BacklogFullError);
  });
});

describe('promoteBacklog', () => {
  function buildQueue(
    jobsMap: Record<string, { state: string; changeDelay?: ReturnType<typeof vi.fn> }>,
  ): { queue: Queue; getJob: ReturnType<typeof vi.fn> } {
    const getJob = vi.fn(async (id: string) => {
      const j = jobsMap[id];
      if (!j) return undefined;
      return {
        getState: async () => j.state,
        changeDelay: j.changeDelay ?? vi.fn().mockResolvedValue(undefined),
      } as never;
    });
    return { queue: { getJob } as unknown as Queue, getJob };
  }

  it('promotes delayed jobs with jitter and counts result', async () => {
    await trackBacklogJob(redis, INBOX, 'job-a');
    await trackBacklogJob(redis, INBOX, 'job-b');
    const changeA = vi.fn().mockResolvedValue(undefined);
    const changeB = vi.fn().mockResolvedValue(undefined);
    const { queue } = buildQueue({
      'job-a': { state: 'delayed', changeDelay: changeA },
      'job-b': { state: 'delayed', changeDelay: changeB },
    });
    let i = 0;
    const rng = () => [0.1, 0.5][i++ % 2] ?? 0;
    const result = await promoteBacklog(redis, queue, INBOX, 300_000, rng);
    expect(result).toEqual({ promoted: 2, skipped: 0, removed: 0 });
    expect(changeA).toHaveBeenCalledTimes(1);
    expect(changeB).toHaveBeenCalledTimes(1);
    // each got distinct jitter
    const jitterA = changeA.mock.calls[0]?.[0];
    const jitterB = changeB.mock.calls[0]?.[0];
    expect(jitterA).not.toBe(jitterB);
  });

  it('drops jobs that no longer exist in the queue (cleanup)', async () => {
    await trackBacklogJob(redis, INBOX, 'job-gone');
    const { queue } = buildQueue({}); // no jobs
    const result = await promoteBacklog(redis, queue, INBOX);
    expect(result).toEqual({ promoted: 0, skipped: 0, removed: 1 });
    expect(await backlogDepth(redis, INBOX)).toBe(0);
  });

  it('drops jobs in terminal states (cleanup)', async () => {
    await trackBacklogJob(redis, INBOX, 'job-done');
    const { queue } = buildQueue({ 'job-done': { state: 'completed' } });
    const result = await promoteBacklog(redis, queue, INBOX);
    expect(result.removed).toBe(1);
    expect(await backlogDepth(redis, INBOX)).toBe(0);
  });

  it('counts skipped when changeDelay throws', async () => {
    await trackBacklogJob(redis, INBOX, 'job-x');
    const throwing = vi.fn().mockRejectedValue(new Error('locked'));
    const { queue } = buildQueue({ 'job-x': { state: 'delayed', changeDelay: throwing } });
    const result = await promoteBacklog(redis, queue, INBOX);
    expect(result).toEqual({ promoted: 0, skipped: 1, removed: 0 });
  });
});

describe('enforceHardLimitAtWorker (Check 2)', () => {
  it('passes when age < 14d', () => {
    const created = NOW - 13 * 24 * 60 * 60 * 1000;
    expect(() => enforceHardLimitAtWorker(created, NOW)).not.toThrow();
  });

  it('throws BacklogFullError when age >= 14d', () => {
    const created = NOW - HARD_LIMIT_MS - 1;
    expect(() => enforceHardLimitAtWorker(created, NOW)).toThrow(BacklogFullError);
  });

  it('error carries createdAt and nowMs for logging', () => {
    const created = NOW - HARD_LIMIT_MS;
    try {
      enforceHardLimitAtWorker(created, NOW);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BacklogFullError);
      expect((err as BacklogFullError).code).toBe('BACKLOG_FULL');
      expect((err as BacklogFullError).messageCreatedAtMs).toBe(created);
      expect((err as BacklogFullError).nowMs).toBe(NOW);
    }
  });
});
