import { describe, expect, it } from 'vitest';
import { parseGmailConfig, parseGmailSecrets } from '../gmail-config.js';

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

  it('rejects invalid email format on gmailEmail', () => {
    const raw = { provider: 'gmail', gmailEmail: 'not-an-email' };
    expect(parseGmailConfig(raw)).toEqual({});
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
