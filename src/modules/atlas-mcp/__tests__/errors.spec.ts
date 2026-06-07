import { describe, expect, it } from 'vitest';

import { ERR, type ErrCode } from '../errors';
import { MessagingToolError } from '../tools';

describe('ERR structured error codes (D14)', () => {
  const expected: ErrCode[] = [
    'INBOX_NOT_FOUND',
    'INBOX_DISABLED',
    'INBOX_NOT_CONFIGURED',
    'CONTACT_RESOLUTION_FAILED',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_TRANSIENT',
    'PROVIDER_REJECTED',
    'OUTSIDE_24H_WINDOW',
    'CHANNEL_NOT_IMPLEMENTED',
  ];

  for (const code of expected) {
    it(`exposes ${code}`, () => {
      expect(ERR[code]).toBe(code);
    });
  }

  it('has exactly the 9 expected codes', () => {
    expect(Object.keys(ERR).sort()).toEqual([...expected].sort());
  });
});

describe('MessagingToolError errCode extension', () => {
  it('carries the structured errCode when provided', () => {
    const err = new MessagingToolError(
      'bad_request',
      'outside 24h window',
      ERR.OUTSIDE_24H_WINDOW,
    );
    expect(err.code).toBe('bad_request');
    expect(err.errCode).toBe('OUTSIDE_24H_WINDOW');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MessagingToolError');
  });

  it('stays backward compatible with the two-argument form', () => {
    const err = new MessagingToolError('not_found', 'conversation missing');
    expect(err.code).toBe('not_found');
    expect(err.errCode).toBeUndefined();
  });
});
