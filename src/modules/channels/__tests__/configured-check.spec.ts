import { describe, expect, it } from 'vitest';
import { isInboxConfigured } from '../configured-check';

describe('isInboxConfigured', () => {
  describe('whatsapp', () => {
    it('configured with accountSid + authToken + fromNumber', () => {
      expect(
        isInboxConfigured(
          'whatsapp',
          { accountSid: 'AC123', fromNumber: '+5511999999999' },
          { authToken: 'tok' },
        ),
      ).toBe(true);
    });

    it('configured with messagingServiceSid instead of fromNumber', () => {
      expect(
        isInboxConfigured(
          'whatsapp',
          { accountSid: 'AC123', messagingServiceSid: 'MG123' },
          { authToken: 'tok' },
        ),
      ).toBe(true);
    });

    it('not configured without authToken (secret missing)', () => {
      expect(
        isInboxConfigured('whatsapp', { accountSid: 'AC123', fromNumber: '+55119' }, {}),
      ).toBe(false);
    });

    it('not configured without a sending identity', () => {
      expect(
        isInboxConfigured('whatsapp', { accountSid: 'AC123' }, { authToken: 'tok' }),
      ).toBe(false);
    });
  });

  describe('email', () => {
    it('gmail configured with refreshToken', () => {
      expect(
        isInboxConfigured('email', { provider: 'gmail' }, { refreshToken: 'rt' }),
      ).toBe(true);
    });

    it('gmail not configured without refreshToken', () => {
      expect(
        isInboxConfigured('email', { provider: 'gmail' }, { accessToken: 'at' }),
      ).toBe(false);
    });

    it('postmark (default provider) configured with serverToken', () => {
      expect(isInboxConfigured('email', {}, { serverToken: 'st' })).toBe(true);
    });

    it('postmark not configured without serverToken', () => {
      expect(isInboxConfigured('email', { fromEmail: 'a@b.com' }, {})).toBe(false);
    });
  });

  describe('telegram', () => {
    it('configured with botToken', () => {
      expect(isInboxConfigured('telegram', {}, { botToken: 'bt' })).toBe(true);
    });

    it('not configured without botToken', () => {
      expect(isInboxConfigured('telegram', { apiBase: 'https://x' }, {})).toBe(false);
    });
  });

  describe('channels without outbound sender', () => {
    it('sms always false', () => {
      expect(isInboxConfigured('sms', { foo: 'bar' }, { foo: 'bar' })).toBe(false);
    });
    it('instagram always false', () => {
      expect(isInboxConfigured('instagram', {}, {})).toBe(false);
    });
    it('messenger always false', () => {
      expect(isInboxConfigured('messenger', {}, {})).toBe(false);
    });
    it('webchat always false', () => {
      expect(isInboxConfigured('webchat', {}, {})).toBe(false);
    });
    it('api always false', () => {
      expect(isInboxConfigured('api', {}, {})).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('null config and secrets → false', () => {
      expect(isInboxConfigured('whatsapp', null, null)).toBe(false);
    });
    it('primitive config → false', () => {
      expect(isInboxConfigured('whatsapp', 'garbage', 42)).toBe(false);
    });
    it('empty-string credentials → false', () => {
      expect(
        isInboxConfigured('whatsapp', { accountSid: '', fromNumber: '' }, { authToken: '' }),
      ).toBe(false);
    });
  });
});
