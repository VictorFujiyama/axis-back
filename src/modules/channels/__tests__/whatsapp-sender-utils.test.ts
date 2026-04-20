import { describe, expect, it } from 'vitest';
import { parseWhatsAppConfig, parseWhatsAppSecrets } from '../whatsapp-sender';

describe('parseWhatsAppConfig', () => {
  it('parses a minimal Twilio config', () => {
    const cfg = parseWhatsAppConfig({
      provider: 'twilio',
      accountSid: 'AC123',
      fromNumber: '+5511999999999',
    });
    expect(cfg.provider).toBe('twilio');
    expect(cfg.accountSid).toBe('AC123');
    expect(cfg.fromNumber).toBe('+5511999999999');
  });

  it('defaults provider to twilio when omitted (back-compat)', () => {
    const cfg = parseWhatsAppConfig({ accountSid: 'AC1', fromNumber: '+551199' });
    expect(cfg.provider).toBe('twilio');
  });

  it('preserves messagingServiceSid', () => {
    const cfg = parseWhatsAppConfig({
      provider: 'twilio',
      accountSid: 'AC1',
      messagingServiceSid: 'MG123',
    });
    expect(cfg.messagingServiceSid).toBe('MG123');
  });

  it('keeps provider="cloud" so sender can detect & reject it', () => {
    const cfg = parseWhatsAppConfig({
      provider: 'cloud',
      phoneNumberId: '123',
      businessAccountId: '456',
    });
    expect(cfg.provider).toBe('cloud');
    // Unknown fields preserved via passthrough
    expect((cfg as Record<string, unknown>).phoneNumberId).toBe('123');
  });

  it('returns default-only object on garbage input', () => {
    // Falls back to defaults (provider=twilio) — no other fields present.
    expect(parseWhatsAppConfig(null)).toEqual({ provider: 'twilio' });
    expect(parseWhatsAppConfig('not an object')).toEqual({ provider: 'twilio' });
    expect(parseWhatsAppConfig(123)).toEqual({ provider: 'twilio' });
  });

  it('rejects empty string accountSid via min(1)', () => {
    const cfg = parseWhatsAppConfig({ accountSid: '' });
    expect(cfg.accountSid).toBeUndefined();
  });
});

describe('parseWhatsAppSecrets', () => {
  it('parses authToken', () => {
    const s = parseWhatsAppSecrets({ authToken: 'token-abc' });
    expect(s.authToken).toBe('token-abc');
  });

  it('returns empty for invalid input', () => {
    expect(parseWhatsAppSecrets(null)).toEqual({});
    expect(parseWhatsAppSecrets({ authToken: '' })).toEqual({});
  });

  it('preserves unknown fields via passthrough (e.g. apiKeySecret)', () => {
    const s = parseWhatsAppSecrets({ authToken: 'a', apiKeySecret: 'b' });
    expect(s.authToken).toBe('a');
    expect((s as Record<string, unknown>).apiKeySecret).toBe('b');
  });
});
