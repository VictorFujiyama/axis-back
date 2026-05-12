import { describe, expect, it } from 'vitest';

import { signOutboundPayload } from '../../webhooks/sign';
import { verifyMcpRequest } from '../auth';

const SECRET = 'deadbeefcafef00ddeadbeefcafef00d';
const BODY = '{"jsonrpc":"2.0","method":"tools/list","id":1}';

describe('verifyMcpRequest', () => {
  it('accepts a freshly-signed payload (header + body + secret match)', () => {
    const header = signOutboundPayload(BODY, SECRET);
    const result = verifyMcpRequest(header, BODY, SECRET);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when signature does not match the body', () => {
    const header = signOutboundPayload(BODY, SECRET);
    const result = verifyMcpRequest(header, BODY + 'tamper', SECRET);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid signature');
  });

  it('rejects when the signature header is missing', () => {
    expect(verifyMcpRequest(undefined, BODY, SECRET)).toEqual({
      ok: false,
      error: 'missing X-Atlas-Signature header',
    });
    expect(verifyMcpRequest('', BODY, SECRET)).toEqual({
      ok: false,
      error: 'missing X-Atlas-Signature header',
    });
  });

  it('rejects when the secret differs', () => {
    const header = signOutboundPayload(BODY, SECRET);
    const result = verifyMcpRequest(header, BODY, 'different-secret-1234567890');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid signature');
  });

  it('normalizes array headers by taking the first entry', () => {
    const header = signOutboundPayload(BODY, SECRET);
    const result = verifyMcpRequest([header, 'second-ignored'], BODY, SECRET);
    expect(result).toEqual({ ok: true });
  });
});
