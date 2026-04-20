import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { twilioSignature, verifyTwilioSignature } from '../whatsapp-signature';

const AUTH = 'test-auth-token-12345';
const URL = 'https://example.com/webhooks/whatsapp/abc';

function ref(authToken: string, fullUrl: string, params: Record<string, string>): string {
  // Reference implementation per Twilio docs (single-value version).
  const sorted = Object.keys(params).sort();
  const concat = sorted.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', authToken).update(fullUrl + concat).digest('base64');
}

describe('twilioSignature', () => {
  it('matches the reference implementation for a typical payload', () => {
    const params = {
      MessageSid: 'SMabc123',
      From: 'whatsapp:+5511999999999',
      To: 'whatsapp:+14155550000',
      Body: 'Olá!',
    };
    expect(twilioSignature(AUTH, URL, params)).toBe(ref(AUTH, URL, params));
  });

  it('sorts keys alphabetically before concatenating', () => {
    const a = { B: '2', A: '1', C: '3' };
    const b = { A: '1', B: '2', C: '3' };
    expect(twilioSignature(AUTH, URL, a)).toBe(twilioSignature(AUTH, URL, b));
    expect(twilioSignature(AUTH, URL, a)).toBe(ref(AUTH, URL, b));
  });

  it('handles repeated keys (string[]) by concatenating each occurrence', () => {
    const sig = twilioSignature(AUTH, URL, { MediaUrl: ['u1', 'u2'] });
    // Manual: sortedKeys = ['MediaUrl'], values flatMap → ['MediaUrlu1', 'MediaUrlu2']
    const expected = createHmac('sha1', AUTH).update(`${URL}MediaUrlu1MediaUrlu2`).digest('base64');
    expect(sig).toBe(expected);
  });

  it('treats undefined values as empty string', () => {
    // @ts-expect-error testing forgiving runtime
    const sig = twilioSignature(AUTH, URL, { Foo: undefined });
    const expected = createHmac('sha1', AUTH).update(`${URL}Foo`).digest('base64');
    expect(sig).toBe(expected);
  });

  it('produces different signature for different URL', () => {
    const s1 = twilioSignature(AUTH, URL, { A: '1' });
    const s2 = twilioSignature(AUTH, URL + '?x=1', { A: '1' });
    expect(s1).not.toBe(s2);
  });
});

describe('verifyTwilioSignature', () => {
  const params = { MessageSid: 'SM123', From: 'whatsapp:+551199', Body: 'Olá' };

  it('returns true for a valid signature', () => {
    const sig = twilioSignature(AUTH, URL, params);
    expect(verifyTwilioSignature(AUTH, URL, params, sig)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    expect(verifyTwilioSignature(AUTH, URL, params, 'bogus')).toBe(false);
  });

  it('returns false for missing signature header', () => {
    expect(verifyTwilioSignature(AUTH, URL, params, undefined)).toBe(false);
  });

  it('returns false when header is an array (per Twilio spec)', () => {
    const sig = twilioSignature(AUTH, URL, params);
    expect(verifyTwilioSignature(AUTH, URL, params, [sig, sig])).toBe(false);
  });

  it('returns false when params are tampered', () => {
    const sig = twilioSignature(AUTH, URL, params);
    expect(
      verifyTwilioSignature(AUTH, URL, { ...params, Body: 'tampered' }, sig),
    ).toBe(false);
  });

  it('returns false when authToken differs', () => {
    const sig = twilioSignature(AUTH, URL, params);
    expect(verifyTwilioSignature('different', URL, params, sig)).toBe(false);
  });

  it('returns false when URL differs (proxy/host mismatch)', () => {
    const sig = twilioSignature(AUTH, URL, params);
    expect(verifyTwilioSignature(AUTH, URL + '/x', params, sig)).toBe(false);
  });
});
