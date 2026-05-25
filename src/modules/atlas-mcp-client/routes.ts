import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { AtlasMcpError, atlasSearchMemory, isAtlasMcpConfigured } from './client';

/**
 * Phase 12.2 — MCP pull route (`GET /api/v1/atlas/memory`, Berg doc Phase 4f,
 * spec §9 / §C.6).
 *
 * Exposes the read-only `atlas.search_memory` tool (T-015 client) to the
 * axis-back front so the UI can answer "what does Atlas know about this
 * customer". A thin, front-facing wrapper:
 *  - `requireAuth` — same auth as the rest of `/api/v1`.
 *  - gate on {@link isAtlasMcpConfigured} → a clean 503 instead of letting the
 *    client throw (which would surface as a 500). The route is ALWAYS
 *    registered (unlike the inbound/backfill routes which omit themselves when
 *    disabled) so the front gets a stable, explainable answer.
 *  - optional `contactId` enrichment.
 *
 * Anti-leak (L-615): the Atlas search is org-scoped server-side by the bearer,
 * but `contactId` resolves against axis-back's own MULTI-account `contacts`
 * table, so it MUST be scoped to the caller's `accountId` here. A contact from
 * another account → 404 (never looked up cross-account, never fed into the
 * Atlas query).
 *
 * `apps: ['messaging']` — axis-back v1 only cares about its own connector's
 * tier of Atlas memory.
 */

const memoryQuery = z
  .object({
    query: z.string().trim().min(2).max(200).optional(),
    contactId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.query) || Boolean(v.contactId), {
    message: 'query or contactId is required',
  });

export async function atlasMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/atlas/memory',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = memoryQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.badRequest(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      if (!isAtlasMcpConfigured()) {
        return reply.serviceUnavailable('Atlas MCP pull is not configured');
      }

      const { query, contactId } = parsed.data;
      const terms: string[] = [];
      if (query) terms.push(query);

      if (contactId) {
        const [contact] = await app.db
          .select({
            name: schema.contacts.name,
            email: schema.contacts.email,
            phone: schema.contacts.phone,
          })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.id, contactId),
              eq(schema.contacts.accountId, req.user.accountId),
              isNull(schema.contacts.deletedAt),
            ),
          )
          .limit(1);
        if (!contact) {
          return reply.notFound('contact not found');
        }
        for (const term of [contact.name, contact.phone, contact.email]) {
          if (term) terms.push(term);
        }
      }

      const effectiveQuery = terms.join(' ').trim();
      // The schema guarantees query||contactId, but a contact with no
      // name/email/phone and no free-text query leaves nothing to search.
      if (effectiveQuery.length < 2) {
        return reply.badRequest('no searchable terms (contact has no name/email/phone)');
      }

      try {
        return await atlasSearchMemory(effectiveQuery, ['messaging']);
      } catch (err) {
        // The only throw path here is AtlasMcpError (the config gate already
        // passed): network, HTTP, or RPC failure. Map to 502 so the front can
        // tell "Atlas is down/erroring" apart from a client 4xx. Anything else
        // is a bug → rethrow → Fastify 500.
        if (err instanceof AtlasMcpError) {
          app.log.warn(
            { err: err.message, code: err.code },
            '[atlas-mcp] search_memory failed',
          );
          return reply.badGateway('Atlas memory search failed');
        }
        throw err;
      }
    },
  );
}
