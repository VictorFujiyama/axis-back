import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { verifyOutboundSignature } from '../webhooks/sign';

export interface VerifyMcpResult {
  ok: boolean;
  error?: string;
}

/**
 * Subset of the parsed config this module reads. Kept as a structural type so
 * tests don't need to flex the full Zod-parsed singleton — pass a plain object
 * with the four fields below.
 */
export interface McpAuthConfig {
  MCP_AUTH_MODE: 'hmac' | 'bearer' | 'both';
  MCP_AXIS_API_KEY?: string;
  ATLAS_MCP_HMAC_SECRET?: string;
}

/**
 * Inbound MCP auth (Phase D Activation T-004 / T-005).
 *
 * Mode-aware dispatch via `config.MCP_AUTH_MODE`:
 *   - 'bearer': `Authorization: Bearer <key>` only.
 *   - 'hmac'  : `X-Atlas-Signature` only (Phase B Stripe-style HMAC).
 *   - 'both'  : Bearer primary; HMAC fall-through ONLY when the Authorization
 *               header is absent. A present-but-invalid Bearer header fails
 *               hard with no fall-through — the caller explicitly tried Bearer
 *               and we'd otherwise mask the misconfig (R-15).
 *
 * Bearer comparison is constant-time (`crypto.timingSafeEqual`, see L-507).
 * HMAC delegates to the Phase B primitive (`verifyOutboundSignature`,
 * L-104 / L-408).
 */
export function verifyMcpRequest(
  req: FastifyRequest,
  config: McpAuthConfig,
): VerifyMcpResult {
  const mode = config.MCP_AUTH_MODE;

  if (mode === 'bearer') {
    return tryBearerAuth(req, config) ?? { ok: false, error: 'bearer header missing' };
  }
  if (mode === 'hmac') {
    return tryHmacAuth(req, config);
  }

  // 'both' — Bearer primary; HMAC fall-through only when Bearer header absent.
  const bearer = tryBearerAuth(req, config);
  if (bearer !== null) return bearer;
  return tryHmacAuth(req, config);
}

/**
 * Returns `null` when no `Authorization` header is present — the signal
 * in mode='both' to fall through to HMAC. Returns a non-null result when
 * the header IS present (ok=true for valid, ok=false otherwise).
 *
 * Phase 11 compat (L-510): Phase 11 `@atlas/mcp` `resolveHeaders` substitui
 * `{ref:"env://VAR"}` por VALOR LITERAL do env, sem concatenar prefix.
 * Resultado: Atlas envia `Authorization: <key>` (sem `Bearer ` prefix).
 * Aceitamos AMBOS — `Authorization: Bearer <key>` (RFC 6750) E `Authorization: <key>`
 * (Phase 11 raw value) — pra compat sem patch Atlas-side.
 */
function tryBearerAuth(req: FastifyRequest, config: McpAuthConfig): VerifyMcpResult | null {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const expected = config.MCP_AXIS_API_KEY;
  if (!expected) {
    // Boot precheck (T-003) requires MCP_AXIS_API_KEY when mode ∈ {bearer,both}
    // and MCP_SERVER_ENABLED=true — this branch is defense in depth.
    return { ok: false, error: 'bearer auth not configured' };
  }

  // Strip 'Bearer ' prefix if present; otherwise treat full value as token.
  const received = value.startsWith('Bearer ') ? value.slice('Bearer '.length) : value;
  const aBuf = Buffer.from(received, 'utf8');
  const bBuf = Buffer.from(expected, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return { ok: false, error: 'invalid bearer token' };
  }
  if (!timingSafeEqual(aBuf, bBuf)) {
    return { ok: false, error: 'invalid bearer token' };
  }
  return { ok: true };
}

function tryHmacAuth(req: FastifyRequest, config: McpAuthConfig): VerifyMcpResult {
  // mode='both' + ATLAS_MCP_HMAC_SECRET unset is permitted at boot (T-003
  // warns rather than throws). Guard before calling verifyOutboundSignature,
  // which was not designed to receive undefined.
  const secret = config.ATLAS_MCP_HMAC_SECRET;
  if (!secret) {
    return { ok: false, error: 'hmac secret not configured' };
  }

  const headerRaw = req.headers['x-atlas-signature'];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (!headerValue) {
    return { ok: false, error: 'missing X-Atlas-Signature header' };
  }
  const rawBody = req.rawBody?.toString('utf8') ?? '';
  if (!verifyOutboundSignature(headerValue, rawBody, secret)) {
    return { ok: false, error: 'invalid signature' };
  }
  return { ok: true };
}
