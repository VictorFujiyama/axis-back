import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema } from '@blossom/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config';

/**
 * One-time backfill endpoint (D34) — `POST /api/v1/internal/backfill/inbox-playbook`.
 *
 * The atlas→axis migration script (Ralph T-19) copies each `messaging_playbooks`
 * row from Atlas into axis `inbox_playbooks`. It is internal and short-lived, so
 * it authenticates with a shared HMAC secret rather than a user JWT:
 *
 *   X-Backfill-Signature: hex(hmac-sha256(rawBody, BACKFILL_SHARED_SECRET))
 *
 * Like the Atlas connector inbound route (inbound-routes.ts), we verify the HMAC
 * over the EXACT bytes the client signed — captured via a PLUGIN-SCOPED
 * `application/json` content-type parser (Fastify encapsulation keeps this off
 * the global JSON/urlencoded parsers; precedent mcp-server.ts / inbound-routes.ts)
 * — never a re-stringified parsed object whose key order / whitespace could drift
 * from what the script hashed.
 *
 * Idempotent: UPSERT on the `inbox_playbooks.inbox_id` PK (re-running the
 * migration is safe). `?dryRun=true` validates + echoes the would-be write
 * without touching the DB (D38 staging inspection).
 *
 * Off by default: when `BACKFILL_SHARED_SECRET` is unset the route returns 503
 * "backfill not configured" — no signature can ever verify, so the migration
 * window stays closed until an operator provisions the secret.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const backfillBody = z.object({
  inboxId: z.string().uuid(),
  content: z.string().min(1).max(10000),
  etag: z.string().min(1),
  version: z.number().int().positive().default(1),
});

function headerValue(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Constant-time compare of the provided hex signature against the expected
 * HMAC. Returns false on any length mismatch (timingSafeEqual throws on
 * differing lengths) so a malformed header can't crash the handler.
 */
function signatureMatches(rawBody: Buffer, provided: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function backfillRoutes(app: FastifyInstance): Promise<void> {
  // Plugin-scoped raw-body capture: stash the signed bytes, yield `undefined`
  // for the parsed body (we JSON.parse the raw bytes ourselves below so a
  // malformed payload returns our uniform 400 rather than Fastify's shape).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBody = body;
      done(null, undefined);
    },
  );

  app.post('/api/v1/internal/backfill/inbox-playbook', async (req, reply) => {
    const secret = config.BACKFILL_SHARED_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: 'backfill not configured' });
    }

    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const sig = headerValue(req, 'x-backfill-signature');
    if (!sig || !signatureMatches(rawBody, sig, secret)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid json' });
    }

    const parsed = backfillBody.safeParse(json);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }

    const { inboxId, content, etag, version } = parsed.data;

    const dryRun = (req.query as { dryRun?: string } | undefined)?.dryRun === 'true';
    if (dryRun) {
      return reply.send({ ok: true, dryRun: true, wouldUpsert: parsed.data });
    }

    // Idempotent UPSERT keyed on the inbox_id PK. version follows the source
    // row (EXCLUDED.version) so D11 stale detection stays aligned with Atlas.
    await app.db
      .insert(schema.inboxPlaybooks)
      .values({ inboxId, content, etag, version })
      .onConflictDoUpdate({
        target: schema.inboxPlaybooks.inboxId,
        set: { content, etag, version, updatedAt: new Date() },
      });

    return reply.send({ ok: true, inboxId });
  });
}
