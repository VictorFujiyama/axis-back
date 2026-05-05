import { describe, expect, it } from 'vitest';
import { parseGmailConfig } from '../gmail-config.js';

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
