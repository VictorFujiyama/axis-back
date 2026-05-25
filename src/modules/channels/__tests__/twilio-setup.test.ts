import { describe, expect, it } from 'vitest';
import { toE164 } from '../twilio-setup';

describe('toE164', () => {
  it('strips spaces from a number typed with formatting', () => {
    // The bug that broke webhook auto-config: "+1 218 217 4957" never matched
    // Twilio's sender_id "whatsapp:+12182174957".
    expect(toE164('+1 218 217 4957')).toBe('+12182174957');
  });

  it('strips dashes and parens', () => {
    expect(toE164('+1 (218) 217-4957')).toBe('+12182174957');
  });

  it('adds a leading + when missing', () => {
    expect(toE164('12182174957')).toBe('+12182174957');
  });

  it('strips a whatsapp: prefix', () => {
    expect(toE164('whatsapp:+12182174957')).toBe('+12182174957');
  });

  it('strips whatsapp: prefix together with spaces', () => {
    expect(toE164('whatsapp:+55 11 99999-9999')).toBe('+5511999999999');
  });

  it('leaves an already-clean E164 number unchanged', () => {
    expect(toE164('+5511999999999')).toBe('+5511999999999');
  });
});
