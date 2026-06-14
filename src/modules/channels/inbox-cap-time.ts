import { DateTime } from 'luxon';

export const IANA_TZ_PATTERN = /^[A-Za-z]+(?:[/_][A-Za-z0-9_+-]+){1,2}$/;
const SINGLE_TOKEN_WHITELIST = new Set(['UTC']);

export class InvalidTimezoneError extends Error {
  readonly code = 'INVALID_TIMEZONE';
  readonly timezone: string;
  constructor(tz: string, reason?: string) {
    super(reason ? `invalid timezone: ${tz} (${reason})` : `invalid timezone: ${tz}`);
    this.name = 'InvalidTimezoneError';
    this.timezone = tz;
  }
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  if (SINGLE_TOKEN_WHITELIST.has(tz)) return DateTime.local().setZone(tz).isValid;
  if (!IANA_TZ_PATTERN.test(tz)) return false;
  return DateTime.local().setZone(tz).isValid;
}

export function assertValidTimezone(tz: string): asserts tz is string {
  if (!isValidTimezone(tz)) throw new InvalidTimezoneError(tz);
}

export function todayDateKey(timezone: string, nowMs: number): string {
  const dt = DateTime.fromMillis(nowMs, { zone: timezone });
  if (!dt.isValid) throw new InvalidTimezoneError(timezone, dt.invalidReason ?? undefined);
  return dt.toFormat('yyyy-LL-dd');
}

export function nextMidnightMs(timezone: string, nowMs: number): number {
  const dt = DateTime.fromMillis(nowMs, { zone: timezone });
  if (!dt.isValid) throw new InvalidTimezoneError(timezone, dt.invalidReason ?? undefined);
  const next = dt.plus({ days: 1 }).startOf('day');
  if (
    !next.isValid ||
    next.hour !== 0 ||
    next.minute !== 0 ||
    next.second !== 0 ||
    next.millisecond !== 0
  ) {
    throw new InvalidTimezoneError(
      timezone,
      `next midnight is not 00:00:00.000 local — DST shift produced ${next.toISO() ?? 'invalid'}`,
    );
  }
  return next.toMillis();
}

export function jitterMs(maxMs: number, rng: () => number = Math.random): number {
  if (maxMs <= 0) return 0;
  const raw = Math.floor(rng() * maxMs);
  return Math.min(raw, maxMs - 1);
}
