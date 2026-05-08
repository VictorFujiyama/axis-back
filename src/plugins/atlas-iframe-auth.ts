import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema } from '@blossom/db';
import { config } from '../config';

/**
 * Atlas signs short-lived (5min) HS256 tokens with AXIS_JWT_SECRET and embeds
 * them in the messaging iframe URL. axis-front POSTs them to
 * /api/auth/exchange-iframe-token (T-031); this preHandler verifies the
 * signature, asserts the kind/payload shape, resolves the Axis user, and
 * exposes it on req.atlasIframeUser for the route handler.
 *
 * Manual HS256 mirrors the Atlas-side signing
 * (apps/web/src/server/lib/axis-jwt.ts in atlas-company-os) — no new lib dep
 * and no conflict with the existing @fastify/jwt singleton, which uses
 * JWT_SECRET (axis-back's own session secret), not AXIS_JWT_SECRET.
 */

export interface AtlasIframePayload {
  kind: 'atlas-iframe';
  axis_user_id: string;
  axis_email: string;
  iat: number;
  exp: number;
}

export interface AtlasIframeUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAtlasIframeAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifyAtlasIframeToken: (token: string) => AtlasIframePayload | null;
  }
  interface FastifyRequest {
    atlasIframeUser?: AtlasIframeUser;
  }
}

function fromBase64Url(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export function verifyAtlasIframeTokenWithSecret(
  token: string,
  secret: string,
): AtlasIframePayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return null;

  let header: unknown;
  try {
    header = JSON.parse(fromBase64Url(encodedHeader).toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== 'HS256' ||
    (header as { typ?: unknown }).typ !== 'JWT'
  ) {
    return null;
  }

  const expectedSig = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const providedSig = fromBase64Url(encodedSig);
  if (expectedSig.length !== providedSig.length) return null;
  if (!timingSafeEqual(expectedSig, providedSig)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (
    p.kind !== 'atlas-iframe' ||
    typeof p.axis_user_id !== 'string' ||
    typeof p.axis_email !== 'string' ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number'
  ) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (p.exp < now) return null;

  return {
    kind: 'atlas-iframe',
    axis_user_id: p.axis_user_id,
    axis_email: p.axis_email,
    iat: p.iat,
    exp: p.exp,
  };
}

async function plugin(app: FastifyInstance): Promise<void> {
  app.decorate('verifyAtlasIframeToken', (token: string) => {
    const secret = config.AXIS_JWT_SECRET;
    if (!secret) return null;
    return verifyAtlasIframeTokenWithSecret(token, secret);
  });

  app.decorate('requireAtlasIframeAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = config.AXIS_JWT_SECRET;
    if (!secret) {
      // Don't leak misconfiguration — same response as a bad token.
      return reply.unauthorized('Invalid or missing token');
    }
    const body = req.body as { atlas_token?: unknown } | undefined;
    const token =
      body && typeof body.atlas_token === 'string' ? body.atlas_token : null;
    if (!token) {
      return reply.unauthorized('Invalid or missing token');
    }
    const payload = verifyAtlasIframeTokenWithSecret(token, secret);
    if (!payload) {
      return reply.unauthorized('Invalid or missing token');
    }
    const [user] = await app.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        deletedAt: schema.users.deletedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, payload.axis_user_id))
      .limit(1);
    if (!user || user.deletedAt) {
      return reply.unauthorized('Invalid or missing token');
    }
    req.atlasIframeUser = { id: user.id, email: user.email };
  });
}

export default fp(plugin, { name: 'atlas-iframe-auth' });
