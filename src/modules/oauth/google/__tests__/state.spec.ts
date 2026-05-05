import { describe, expect, it } from 'vitest';
import { signState, type StatePayload } from '../state.js';

const basePayload: StatePayload = {
  accountId: 'acc-1',
  userId: 'usr-1',
  inboxName: 'Gmail Teste',
  inboxId: null,
  nonce: 'a'.repeat(32),
  ts: 1_730_000_000_000,
};

describe('signState', () => {
  it('is deterministic given the same payload', () => {
    expect(signState(basePayload)).toBe(signState(basePayload));
  });

  it('produces different outputs when nonce differs', () => {
    const a = signState(basePayload);
    const b = signState({ ...basePayload, nonce: 'b'.repeat(32) });
    expect(a).not.toBe(b);
  });

  it('produces different outputs when ts differs', () => {
    const a = signState(basePayload);
    const b = signState({ ...basePayload, ts: basePayload.ts + 1 });
    expect(a).not.toBe(b);
  });

  it('produces different outputs when accountId differs (HMAC covers all payload fields)', () => {
    const a = signState(basePayload);
    const b = signState({ ...basePayload, accountId: 'acc-2' });
    expect(a).not.toBe(b);
  });

  it('returns the format <base64url>.<base64url>', () => {
    const out = signState(basePayload);
    const parts = out.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('encodes the payload as base64url JSON in part 1 (round-trips back)', () => {
    const out = signState(basePayload);
    const [payloadB64] = out.split('.');
    const decoded = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    );
    expect(decoded).toEqual(basePayload);
  });

  it('handles a payload with an inboxId set (reauthorize flow)', () => {
    const reauth: StatePayload = {
      ...basePayload,
      inboxId: '11111111-2222-3333-4444-555555555555',
    };
    const out = signState(reauth);
    const [payloadB64] = out.split('.');
    const decoded = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    );
    expect(decoded.inboxId).toBe(reauth.inboxId);
    expect(out).not.toBe(signState(basePayload));
  });
});
