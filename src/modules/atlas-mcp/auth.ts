import { verifyOutboundSignature } from '../webhooks/sign';

export interface VerifyMcpResult {
  ok: boolean;
  error?: string;
}

/**
 * Inbound MCP HMAC verification. Reuses Phase B primitive (`verifyOutboundSignature`)
 * so Atlas-side signs with the same Stripe-style `t=<ts>,v1=<hex>` shape.
 *
 * Signature header from `X-Atlas-Signature`. Body MUST be the raw bytes as sent
 * on the wire — caller passes `request.rawBody.toString('utf8')` after the
 * plugin-scoped content-type-parser captures it (see T-015a).
 */
export function verifyMcpRequest(
  signatureHeader: string | string[] | undefined,
  rawBody: string,
  secret: string,
): VerifyMcpResult {
  const headerValue = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!headerValue) {
    return { ok: false, error: 'missing X-Atlas-Signature header' };
  }
  if (!verifyOutboundSignature(headerValue, rawBody, secret)) {
    return { ok: false, error: 'invalid signature' };
  }
  return { ok: true };
}
