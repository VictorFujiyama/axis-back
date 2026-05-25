import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AtlasSubscriber, type ConnectorEvent } from '@atlas/connectors';
import { schema } from '@blossom/db';
import { config } from '../../config';

/**
 * Phase 12.2 — inbound push route (`POST /atlas-events`, Berg doc Phase 4d).
 *
 * Atlas POSTs here whenever it writes a memory / makes a decision for the
 * connector org. `AtlasSubscriber` (SDK `subscriber.ts`) verifies the HMAC
 * (`${t}.${orgId}.${rawBody}`, two headers — L-601/L-608), parses the
 * `ConnectorEvent` envelope, cross-checks the signed org-id header against
 * `envelope.org_id` (#8 — subscriber.ts returns 400 on mismatch), then runs
 * `onAtlasActivity`, which persists one `atlas_activity` row so the axis-back
 * UI can surface "Atlas remembered X about this customer".
 *
 * Result contract (SDK): 200 handled · 401 sig fail · 400 malformed envelope
 * / org-id mismatch · hook throw rethrows → Fastify 500 (Atlas retries). We
 * map `{status, body}` straight onto the reply.
 *
 * Raw body (#7 — L-607): the bytes Atlas signed MUST equal the bytes we
 * verify, so we capture them via a PLUGIN-SCOPED `application/json`
 * content-type parser (NOT `fp`-wrapped — Fastify encapsulation keeps this
 * override off the global Twilio-urlencoded / JSON API parsers; precedent
 * mcp-server.ts:76-91). `req.rawBody` is a Buffer; `AtlasSubscriber` wants a
 * UTF-8 string, hence `.toString('utf8')`. We never re-stringify a parsed
 * object. The parser yields `undefined` for `request.body` (the subscriber
 * parses `rawBody` itself), which also lets malformed JSON reach the handler
 * so the SDK returns its uniform 400 rather than Fastify's own error shape.
 *
 * Off by default: when `ATLAS_CONNECTOR_ENABLED=false` (or the HMAC secret is
 * unset) the plugin registers no route, so `/atlas-events` falls through to
 * Fastify's default 404. The boot precheck in config.ts (T-003) throws if the
 * connector is enabled without `ATLAS_HMAC_SECRET`.
 *
 * Idempotent: `atlas_activity.event_id` is UNIQUE; a re-pushed event
 * `onConflictDoNothing`s onto the same row (Atlas reuses its own activity id,
 * L-603 mirror) — still a 200, the hook didn't throw.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function atlasInboundRoutes(app: FastifyInstance): Promise<void> {
  if (!config.ATLAS_CONNECTOR_ENABLED || !config.ATLAS_HMAC_SECRET) {
    return;
  }

  const subscriber = new AtlasSubscriber({
    hmacSecret: config.ATLAS_HMAC_SECRET,
    onAtlasActivity: async (event: ConnectorEvent) => {
      await app.db
        .insert(schema.atlasActivity)
        .values({
          eventId: event.event_id,
          kind: event.kind,
          orgId: event.org_id,
          summary: event.summary,
          envelope: event as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing({ target: schema.atlasActivity.eventId });
    },
  });

  // Plugin-scoped raw-body capture (see header comment): stash the signed
  // bytes, yield `undefined` for the parsed body.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBody = body;
      done(null, undefined);
    },
  );

  app.post('/atlas-events', async (req, reply) => {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const result = await subscriber.handle({
      rawBody,
      headers: {
        get: (name: string): string | null => {
          const value = req.headers[name.toLowerCase()];
          if (Array.isArray(value)) return value[0] ?? null;
          return value ?? null;
        },
      },
    });
    return reply.code(result.status).send(result.body);
  });
}
