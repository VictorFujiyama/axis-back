import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExpiredStateError,
  InvalidStateError,
  signState,
  verifyState,
  type StatePayload,
} from '../state.js';

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

describe('verifyState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(basePayload.ts));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a freshly signed payload', () => {
    const state = signState(basePayload);
    expect(verifyState(state)).toEqual(basePayload);
  });

  it('round-trips a payload with inboxId set (reauthorize flow)', () => {
    const reauth: StatePayload = {
      ...basePayload,
      inboxId: '11111111-2222-3333-4444-555555555555',
    };
    const state = signState(reauth);
    expect(verifyState(state)).toEqual(reauth);
  });

  it('throws InvalidStateError when the string has no dot', () => {
    expect(() => verifyState('notvalid')).toThrow(InvalidStateError);
  });

  it('throws InvalidStateError when the string has more than one dot', () => {
    expect(() => verifyState('a.b.c')).toThrow(InvalidStateError);
  });

  it('throws InvalidStateError when the HMAC is tampered', () => {
    const state = signState(basePayload);
    const [payloadB64, sig] = state.split('.');
    const tamperedSig = sig!.slice(0, -2) + (sig!.endsWith('A') ? 'BB' : 'AA');
    expect(() => verifyState(`${payloadB64}.${tamperedSig}`)).toThrow(
      InvalidStateError,
    );
  });

  it('throws InvalidStateError when the payload is tampered (HMAC stops matching)', () => {
    const state = signState(basePayload);
    const [, sig] = state.split('.');
    const otherPayload = Buffer.from(
      JSON.stringify({ ...basePayload, accountId: 'attacker' }),
      'utf8',
    ).toString('base64url');
    expect(() => verifyState(`${otherPayload}.${sig}`)).toThrow(
      InvalidStateError,
    );
  });

  it('throws InvalidStateError when the HMAC length differs from expected', () => {
    const state = signState(basePayload);
    const [payloadB64] = state.split('.');
    expect(() => verifyState(`${payloadB64}.short`)).toThrow(InvalidStateError);
  });

  it('throws InvalidStateError when the payload b64 is malformed JSON', () => {
    // Build a state where the HMAC is valid for "not json" content.
    const garbageB64 = Buffer.from('not json', 'utf8').toString('base64url');
    // Use signState's algorithm by signing a real payload then swapping the
    // payload portion — that gives a known-bad-JSON payload with a
    // signature that won't match (still surfaces as InvalidStateError, just
    // via the HMAC branch). To hit the JSON branch, recompute the HMAC over
    // the garbage payload directly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', process.env.JWT_SECRET ?? 'dev_jwt_secret_change_me')
      .update(garbageB64)
      .digest()
      .toString('base64url');
    expect(() => verifyState(`${garbageB64}.${sig}`)).toThrow(InvalidStateError);
  });

  it('throws ExpiredStateError when ts is older than 10 minutes', () => {
    const state = signState(basePayload);
    vi.setSystemTime(new Date(basePayload.ts + 10 * 60 * 1000 + 1));
    expect(() => verifyState(state)).toThrow(ExpiredStateError);
  });

  it('accepts ts exactly at the 10-minute boundary', () => {
    const state = signState(basePayload);
    vi.setSystemTime(new Date(basePayload.ts + 10 * 60 * 1000));
    expect(() => verifyState(state)).not.toThrow();
  });

  it('accepts a slightly future ts (clock skew tolerance only — past direction)', () => {
    // Forward-skewed ts (within tolerance) should still verify; we don't
    // reject "ts in the future" because that punishes legitimate clock skew.
    const state = signState({ ...basePayload, ts: basePayload.ts + 1000 });
    expect(() => verifyState(state)).not.toThrow();
  });

  it('InvalidStateError and ExpiredStateError are distinct error classes', () => {
    expect(new InvalidStateError('x')).toBeInstanceOf(Error);
    expect(new ExpiredStateError('x')).toBeInstanceOf(Error);
    expect(new InvalidStateError('x')).not.toBeInstanceOf(ExpiredStateError);
    expect(new ExpiredStateError('x')).not.toBeInstanceOf(InvalidStateError);
  });
});
