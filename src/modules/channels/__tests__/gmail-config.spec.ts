import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GMAIL_DAILY_SEND_CAP,
  DEFAULT_TIMEZONE,
  effectiveDailySendCap,
  effectiveTimezone,
  parseGmailConfig,
  parseGmailSecrets,
} from '../gmail-config.js';

describe('parseGmailConfig', () => {
  it('accepts a valid Gmail config shape', () => {
    const raw = {
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      gmailHistoryId: '987654321',
      needsReauth: false,
      fromName: 'Atendimento Empresa',
    };
    expect(parseGmailConfig(raw)).toEqual(raw);
  });

  it('accepts a Gmail config with null gmailHistoryId on bootstrap', () => {
    const raw = {
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      gmailHistoryId: null,
      needsReauth: false,
    };
    expect(parseGmailConfig(raw)).toEqual(raw);
  });

  it('returns {} when provider is missing', () => {
    expect(parseGmailConfig({ gmailEmail: 'support@example.com' })).toEqual({});
  });

  it('returns {} when provider is not gmail', () => {
    expect(parseGmailConfig({ provider: 'postmark' })).toEqual({});
  });

  it('returns {} for non-object input', () => {
    expect(parseGmailConfig(null)).toEqual({});
    expect(parseGmailConfig(undefined)).toEqual({});
    expect(parseGmailConfig('nope')).toEqual({});
  });

  it('preserves extra fields via passthrough', () => {
    const raw = {
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      somethingExtra: 'kept',
      nested: { deep: 1 },
    };
    expect(parseGmailConfig(raw)).toEqual(raw);
  });

  it('drops invalid gmailEmail but preserves rest of config (per-field catch)', () => {
    const raw = { provider: 'gmail', gmailEmail: 'not-an-email', fromName: 'X' };
    const out = parseGmailConfig(raw);
    expect(out.provider).toBe('gmail');
    expect(out.gmailEmail).toBeUndefined();
    expect(out.fromName).toBe('X');
  });

  describe('dailySendCap', () => {
    it('accepts integer in [0, 10000]', () => {
      const raw = { provider: 'gmail', gmailEmail: 'a@b.com', dailySendCap: 50 };
      expect(parseGmailConfig(raw)).toEqual(raw);
    });
    it('accepts 0 (paused) and 10000 (max)', () => {
      expect(parseGmailConfig({ provider: 'gmail', dailySendCap: 0 }).dailySendCap).toBe(0);
      expect(parseGmailConfig({ provider: 'gmail', dailySendCap: 10000 }).dailySendCap).toBe(10000);
    });
    it('drops negative cap to undefined (preserves rest)', () => {
      const out = parseGmailConfig({ provider: 'gmail', dailySendCap: -1 });
      expect(out.provider).toBe('gmail');
      expect(out.dailySendCap).toBeUndefined();
    });
    it('drops > 10000 cap to undefined', () => {
      const out = parseGmailConfig({ provider: 'gmail', dailySendCap: 10001 });
      expect(out.dailySendCap).toBeUndefined();
    });
    it('drops float cap to undefined', () => {
      const out = parseGmailConfig({ provider: 'gmail', dailySendCap: 1.5 });
      expect(out.dailySendCap).toBeUndefined();
    });
    it('omits cap when absent', () => {
      const out = parseGmailConfig({ provider: 'gmail' });
      expect(out.dailySendCap).toBeUndefined();
    });
  });

  describe('timezone', () => {
    it('accepts valid IANA zones', () => {
      expect(parseGmailConfig({ provider: 'gmail', timezone: 'America/Sao_Paulo' }).timezone).toBe(
        'America/Sao_Paulo',
      );
      expect(parseGmailConfig({ provider: 'gmail', timezone: 'Europe/Lisbon' }).timezone).toBe(
        'Europe/Lisbon',
      );
    });
    it('drops "Foo/Bar" timezone but preserves rest (v2 fix + v8 lenient)', () => {
      // Regex shape passes; luxon rejects. With per-field catch, the bad
      // timezone falls to undefined and effectiveTimezone() uses DEFAULT.
      const out = parseGmailConfig({ provider: 'gmail', timezone: 'Foo/Bar', fromName: 'X' });
      expect(out.timezone).toBeUndefined();
      expect(out.fromName).toBe('X');
    });
    it('drops "EST" abbreviation (not canonical IANA)', () => {
      const out = parseGmailConfig({ provider: 'gmail', timezone: 'EST' });
      expect(out.timezone).toBeUndefined();
      expect(out.provider).toBe('gmail');
    });
    it('omits timezone when absent', () => {
      const out = parseGmailConfig({ provider: 'gmail' });
      expect(out.timezone).toBeUndefined();
    });
  });
});

describe('effectiveDailySendCap', () => {
  it('returns the configured value when present', () => {
    expect(effectiveDailySendCap({ provider: 'gmail', dailySendCap: 100 } as never)).toBe(100);
  });
  it('returns 0 when explicitly 0 (full pause)', () => {
    expect(effectiveDailySendCap({ provider: 'gmail', dailySendCap: 0 } as never)).toBe(0);
  });
  it('returns null when absent', () => {
    expect(effectiveDailySendCap({ provider: 'gmail' } as never)).toBeNull();
  });
  it('returns null on garbage', () => {
    expect(effectiveDailySendCap({} as never)).toBeNull();
    expect(effectiveDailySendCap({ dailySendCap: 'oops' as never } as never)).toBeNull();
  });
});

describe('effectiveTimezone', () => {
  it('returns configured timezone when valid', () => {
    expect(effectiveTimezone({ provider: 'gmail', timezone: 'America/New_York' } as never)).toBe(
      'America/New_York',
    );
  });
  it('falls back to DEFAULT_TIMEZONE when absent', () => {
    expect(effectiveTimezone({ provider: 'gmail' } as never)).toBe(DEFAULT_TIMEZONE);
  });
  it('falls back to DEFAULT_TIMEZONE on invalid', () => {
    expect(effectiveTimezone({ provider: 'gmail', timezone: 'Foo/Bar' } as never)).toBe(
      DEFAULT_TIMEZONE,
    );
  });
  it('sanity: DEFAULT_GMAIL_DAILY_SEND_CAP and DEFAULT_TIMEZONE constants', () => {
    expect(DEFAULT_GMAIL_DAILY_SEND_CAP).toBe(50);
    expect(DEFAULT_TIMEZONE).toBe('America/Sao_Paulo');
  });
});

describe('parseGmailSecrets', () => {
  const valid = {
    refreshToken: '1//0gxxxxxxxxREDACTEDxxxxxxxx',
    accessToken: 'ya29.xxxxxxxxREDACTEDxxxxxxxx',
    expiresAt: '2026-05-05T12:00:00.000Z',
  };

  it('round-trips a valid secrets shape', () => {
    expect(parseGmailSecrets(valid)).toEqual(valid);
  });

  it('returns {} when refreshToken is missing', () => {
    const { refreshToken: _omit, ...rest } = valid;
    expect(parseGmailSecrets(rest)).toEqual({});
  });

  it('returns {} when accessToken is missing', () => {
    const { accessToken: _omit, ...rest } = valid;
    expect(parseGmailSecrets(rest)).toEqual({});
  });

  it('returns {} when expiresAt is missing', () => {
    const { expiresAt: _omit, ...rest } = valid;
    expect(parseGmailSecrets(rest)).toEqual({});
  });

  it('rejects an invalid expiresAt (not ISO 8601)', () => {
    expect(parseGmailSecrets({ ...valid, expiresAt: 'next tuesday' })).toEqual({});
    expect(parseGmailSecrets({ ...valid, expiresAt: '2026-05-05 12:00:00' })).toEqual({});
    expect(parseGmailSecrets({ ...valid, expiresAt: 1_700_000_000_000 })).toEqual({});
  });

  it('returns {} for non-object input', () => {
    expect(parseGmailSecrets(null)).toEqual({});
    expect(parseGmailSecrets(undefined)).toEqual({});
    expect(parseGmailSecrets('nope')).toEqual({});
  });

  it('preserves extra fields via passthrough', () => {
    const raw = { ...valid, scope: 'gmail.modify userinfo.email' };
    expect(parseGmailSecrets(raw)).toEqual(raw);
  });

  it('rejects empty-string token fields', () => {
    expect(parseGmailSecrets({ ...valid, refreshToken: '' })).toEqual({});
    expect(parseGmailSecrets({ ...valid, accessToken: '' })).toEqual({});
  });
});
