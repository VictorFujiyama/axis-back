import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { signOutboundPayload } from '../../webhooks/sign';
import { verifyMcpRequest, type McpAuthConfig } from '../auth';

// Phase D Activation T-004: auth.spec ports the 5 sacred HMAC cases onto the
// new `(req, config)` signature with `MCP_AUTH_MODE='hmac'`, then adds 6 new
// cases covering the Bearer-only and Both-mode dispatch paths. 11 total.

const HMAC_SECRET = 'deadbeefcafef00ddeadbeefcafef00d';
const BEARER_KEY = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0';
const BODY = '{"jsonrpc":"2.0","method":"tools/list","id":1}';

function makeReq(opts: {
  signature?: string | string[];
  authorization?: string;
  body?: string;
}): FastifyRequest {
  const headers: Record<string, string | string[]> = {};
  if (opts.signature !== undefined) headers['x-atlas-signature'] = opts.signature;
  if (opts.authorization !== undefined) headers['authorization'] = opts.authorization;
  return {
    headers,
    rawBody: Buffer.from(opts.body ?? BODY, 'utf8'),
  } as unknown as FastifyRequest;
}

const HMAC_MODE: McpAuthConfig = {
  MCP_AUTH_MODE: 'hmac',
  ATLAS_MCP_HMAC_SECRET: HMAC_SECRET,
};

const BEARER_MODE: McpAuthConfig = {
  MCP_AUTH_MODE: 'bearer',
  MCP_AXIS_API_KEY: BEARER_KEY,
};

const BOTH_MODE: McpAuthConfig = {
  MCP_AUTH_MODE: 'both',
  MCP_AXIS_API_KEY: BEARER_KEY,
  ATLAS_MCP_HMAC_SECRET: HMAC_SECRET,
};

describe('verifyMcpRequest — HMAC mode (5 sacred cases)', () => {
  it('accepts a freshly-signed payload (header + body + secret match)', () => {
    const sig = signOutboundPayload(BODY, HMAC_SECRET);
    const result = verifyMcpRequest(makeReq({ signature: sig }), HMAC_MODE);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when signature does not match the body', () => {
    const sig = signOutboundPayload(BODY, HMAC_SECRET);
    const result = verifyMcpRequest(
      makeReq({ signature: sig, body: BODY + 'tamper' }),
      HMAC_MODE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid signature');
  });

  it('rejects when the signature header is missing', () => {
    // No header at all.
    expect(verifyMcpRequest(makeReq({}), HMAC_MODE)).toEqual({
      ok: false,
      error: 'missing X-Atlas-Signature header',
    });
    // Empty string header.
    expect(verifyMcpRequest(makeReq({ signature: '' }), HMAC_MODE)).toEqual({
      ok: false,
      error: 'missing X-Atlas-Signature header',
    });
  });

  it('rejects when the secret differs', () => {
    const sig = signOutboundPayload(BODY, HMAC_SECRET);
    const wrongSecret: McpAuthConfig = {
      MCP_AUTH_MODE: 'hmac',
      ATLAS_MCP_HMAC_SECRET: 'different-secret-1234567890',
    };
    const result = verifyMcpRequest(makeReq({ signature: sig }), wrongSecret);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid signature');
  });

  it('normalizes array headers by taking the first entry', () => {
    const sig = signOutboundPayload(BODY, HMAC_SECRET);
    const result = verifyMcpRequest(
      makeReq({ signature: [sig, 'second-ignored'] }),
      HMAC_MODE,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('verifyMcpRequest — Bearer mode (3 cases)', () => {
  it('accepts a valid Bearer token', () => {
    const result = verifyMcpRequest(
      makeReq({ authorization: `Bearer ${BEARER_KEY}` }),
      BEARER_MODE,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects an invalid Bearer token (same length, wrong bytes)', () => {
    // Same length keeps us off the length-mismatch fast-path so we exercise
    // the `timingSafeEqual` byte compare itself.
    const wrong = 'x'.repeat(BEARER_KEY.length);
    const result = verifyMcpRequest(
      makeReq({ authorization: `Bearer ${wrong}` }),
      BEARER_MODE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid bearer token');
  });

  it('rejects when the Authorization header is missing', () => {
    const result = verifyMcpRequest(makeReq({}), BEARER_MODE);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bearer header missing');
  });
});

describe('verifyMcpRequest — Both mode (3 cases)', () => {
  it('accepts a valid Bearer token without invoking HMAC', () => {
    // No X-Atlas-Signature header set — must succeed purely via Bearer.
    const result = verifyMcpRequest(
      makeReq({ authorization: `Bearer ${BEARER_KEY}` }),
      BOTH_MODE,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects an invalid Bearer token WITHOUT falling through to HMAC', () => {
    // Sign a perfectly valid HMAC alongside the bad Bearer; if the dispatcher
    // erroneously fell through after a present-but-invalid Bearer, the call
    // would pass on HMAC. The expectation: 'invalid bearer token', not 'ok'.
    const sig = signOutboundPayload(BODY, HMAC_SECRET);
    const wrong = 'x'.repeat(BEARER_KEY.length);
    const result = verifyMcpRequest(
      makeReq({ authorization: `Bearer ${wrong}`, signature: sig }),
      BOTH_MODE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid bearer token');
  });

  it('falls through to HMAC when the Bearer header is absent', () => {
    const sig = signOutboundPayload(BODY, HMAC_SECRET);
    const result = verifyMcpRequest(makeReq({ signature: sig }), BOTH_MODE);
    expect(result).toEqual({ ok: true });
  });
});
