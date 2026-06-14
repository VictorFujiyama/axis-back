import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';

import {
  IANA_TZ_PATTERN,
  InvalidTimezoneError,
  assertValidTimezone,
  isValidTimezone,
  jitterMs,
  nextMidnightMs,
  todayDateKey,
} from '../inbox-cap-time.js';

function ts(iso: string, zone: string): number {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`bad fixture: ${iso} @ ${zone}: ${dt.invalidReason}`);
  return dt.toMillis();
}

describe('isValidTimezone', () => {
  it('accepts common IANA zones', () => {
    expect(isValidTimezone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/Lisbon')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
  });
  it('accepts UTC via single-token whitelist', () => {
    expect(isValidTimezone('UTC')).toBe(true);
  });
  it('rejects ambiguous abbreviations EST/PST (not canonical IANA)', () => {
    expect(isValidTimezone('EST')).toBe(false);
    expect(isValidTimezone('PST')).toBe(false);
  });
  it('rejects junk and shell-injection shapes', () => {
    expect(isValidTimezone('Foo/Bar')).toBe(false);
    expect(isValidTimezone('America/Sao_Paulo; rm -rf')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null as never)).toBe(false);
    expect(isValidTimezone(undefined as never)).toBe(false);
  });
  it('regex matches 3-segment IANA zones', () => {
    expect(IANA_TZ_PATTERN.test('America/Argentina/Buenos_Aires')).toBe(true);
  });
  it('non-existent zones with valid-shape are rejected by luxon check', () => {
    // shape passes regex, but luxon DateTime.setZone returns invalid
    expect(isValidTimezone('xAmerica/Sao_Paulox')).toBe(false);
  });
});

describe('assertValidTimezone', () => {
  it('returns silently for valid zone', () => {
    expect(() => assertValidTimezone('America/Sao_Paulo')).not.toThrow();
  });
  it('throws InvalidTimezoneError with timezone field', () => {
    try {
      assertValidTimezone('Foo/Bar');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTimezoneError);
      expect((err as InvalidTimezoneError).timezone).toBe('Foo/Bar');
      expect((err as InvalidTimezoneError).code).toBe('INVALID_TIMEZONE');
    }
  });
});

describe('todayDateKey', () => {
  it('returns the local day, not UTC', () => {
    const at1amUtc = ts('2026-06-12T01:00:00', 'UTC');
    expect(todayDateKey('America/Sao_Paulo', at1amUtc)).toBe('2026-06-11');
    expect(todayDateKey('UTC', at1amUtc)).toBe('2026-06-12');
  });

  it('zero-pads month/day', () => {
    const t = ts('2026-01-05T12:00:00', 'America/Sao_Paulo');
    expect(todayDateKey('America/Sao_Paulo', t)).toBe('2026-01-05');
  });

  it('throws InvalidTimezoneError for bad zone', () => {
    expect(() => todayDateKey('Foo/Bar', Date.UTC(2026, 5, 12))).toThrow(InvalidTimezoneError);
  });
});

describe('nextMidnightMs', () => {
  it('jumps to next local midnight at 23:30', () => {
    const at2330 = ts('2026-06-12T23:30:00', 'America/Sao_Paulo');
    const expected = ts('2026-06-13T00:00:00', 'America/Sao_Paulo');
    expect(nextMidnightMs('America/Sao_Paulo', at2330)).toBe(expected);
  });

  it('jumps to next local midnight at 00:00 (next day, not same day)', () => {
    const atMidnight = ts('2026-06-12T00:00:00', 'America/Sao_Paulo');
    const expected = ts('2026-06-13T00:00:00', 'America/Sao_Paulo');
    expect(nextMidnightMs('America/Sao_Paulo', atMidnight)).toBe(expected);
  });

  it('DST forward (US spring forward 2026-03-08): next midnight from 2026-03-07 23:30', () => {
    const at = ts('2026-03-07T23:30:00', 'America/New_York');
    const expected = ts('2026-03-08T00:00:00', 'America/New_York');
    const got = nextMidnightMs('America/New_York', at);
    expect(got).toBe(expected);
    expect(got - at).toBe(30 * 60 * 1000);
  });

  it('DST forward: from 2026-03-08 01:30 EST (before transition), next midnight is 9 March', () => {
    const at = ts('2026-03-08T01:30:00', 'America/New_York');
    const expected = ts('2026-03-09T00:00:00', 'America/New_York');
    const got = nextMidnightMs('America/New_York', at);
    expect(got).toBe(expected);
    expect(got - at).toBe((21 * 60 + 30) * 60 * 1000);
  });

  it('DST backward (US fall back 2026-11-01): from 2026-11-01 00:30 EDT', () => {
    const at = ts('2026-11-01T00:30:00', 'America/New_York');
    const expected = ts('2026-11-02T00:00:00', 'America/New_York');
    const got = nextMidnightMs('America/New_York', at);
    expect(got).toBe(expected);
    expect(got - at).toBe((24 * 60 + 30) * 60 * 1000);
  });

  it('DST backward ambiguous local 01:30: nowMs is unambiguous UTC; helper picks the EST instance', () => {
    // 2026-11-01 05:30 UTC = 01:30 EDT (first occurrence) — pre-DST-end
    // 2026-11-01 06:30 UTC = 01:30 EST (second occurrence) — post-DST-end
    const preTransition = ts('2026-11-01T05:30:00', 'UTC');
    const postTransition = ts('2026-11-01T06:30:00', 'UTC');
    const expected = ts('2026-11-02T00:00:00', 'America/New_York');
    expect(nextMidnightMs('America/New_York', preTransition)).toBe(expected);
    expect(nextMidnightMs('America/New_York', postTransition)).toBe(expected);
  });

  it('Asia/Tokyo no-DST sanity: always 24h between consecutive midnights', () => {
    const at1 = ts('2026-06-12T15:00:00', 'Asia/Tokyo');
    const at2 = ts('2026-06-13T15:00:00', 'Asia/Tokyo');
    const m1 = nextMidnightMs('Asia/Tokyo', at1);
    const m2 = nextMidnightMs('Asia/Tokyo', at2);
    expect(m2 - m1).toBe(24 * 60 * 60 * 1000);
  });

  it('Europe/Lisbon DST forward (last Sunday of March 2026 = 29 March)', () => {
    const at = ts('2026-03-28T23:30:00', 'Europe/Lisbon');
    const expected = ts('2026-03-29T00:00:00', 'Europe/Lisbon');
    expect(nextMidnightMs('Europe/Lisbon', at)).toBe(expected);
  });

  it('throws InvalidTimezoneError on bad zone', () => {
    expect(() => nextMidnightMs('Foo/Bar', Date.UTC(2026, 5, 12))).toThrow(InvalidTimezoneError);
  });
});

describe('jitterMs', () => {
  it('returns 0 when maxMs<=0', () => {
    expect(jitterMs(0)).toBe(0);
    expect(jitterMs(-100)).toBe(0);
  });
  it('returns integer in [0, max) clamped even if rng returns 1.0', () => {
    expect(jitterMs(1000, () => 0.5)).toBe(500);
    expect(jitterMs(300_000, () => 0)).toBe(0);
    expect(jitterMs(300_000, () => 0.999)).toBe(299_700);
    expect(jitterMs(1000, () => 1.0)).toBe(999); // clamp
    expect(jitterMs(1000, () => 1.5)).toBe(999); // clamp pathological
  });
});
