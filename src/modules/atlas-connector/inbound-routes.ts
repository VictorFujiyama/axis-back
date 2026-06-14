import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AtlasSubscriber, type ConnectorEvent } from '@atlas/connectors';
import { schema } from '@blossom/db';
import { config } from '../../config';
import { getConnectionByOrg } from '../atlas-events/connections';
import { handleJourneyCancelled, JOURNEY_CANCELLED_KIND } from './cancel-backlog';

/**
 * Phase 12.2 — inbound push route (`POST /atlas-events`, Berg doc Phase 4d).
 *
 * Atlas POSTs here whenever it writes a memory / makes a decision for a
 * connected org. `AtlasSubscriber` (SDK `subscriber.ts`) verifies the HMAC
 * (`${t}.${orgId}.${rawBody}`, two headers — L-601/L-608), parses the
 * `ConnectorEvent` envelope, cross-checks the signed org-id header against
 * `envelope.org_id` (#8 — subscriber.ts returns 400 on mismatch), then runs
 * `onAtlasActivity`, which persists one `atlas_activity` row so the axis-back
 * UI can surface "Atlas remembered X about this customer".
 *
 * Per-account (Connect Flow, T-06): the HMAC secret is no longer a single
 * global env — each connected org carries its own in `atlas_connections`. We
 * resolve it from the signed `x-atlas-org-id` header (`getConnectionByOrg`)
 * BEFORE verifying (the secret is what verifies the request), then build a
 * fresh `AtlasSubscriber` for that org. An org with no connection → 401, same
 * shape as a signature failure (reveals nothing beyond "not a trusted org").
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
 * Off by default: when `ATLAS_URL` is unset (the connector master switch, Connect
 * Flow T-10) the plugin registers no route, so `/atlas-events` falls through to
 * Fastify's default 404. When set, every connected org's secret is resolved
 * per-request from `atlas_connections`.
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

function headerValue(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export async function atlasInboundRoutes(app: FastifyInstance): Promise<void> {
  if (!config.ATLAS_URL) {
    return;
  }

  // Shared dispatch hook — persists one activity row per verified event. The
  // org context comes off the (verified) envelope, so the same closure serves
  // every org's subscriber. Phase 13 also routes `journey_cancelled` to the
  // backlog-cancel handler so a paused/archived/deleted journey drops its
  // daily-cap delayed jobs at axis-back. Activity row is persisted regardless,
  // for traceability — handler errors are LOGGED and swallowed.
  const onAtlasActivity = async (event: ConnectorEvent): Promise<void> => {
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

    if (event.kind === JOURNEY_CANCELLED_KIND) {
      try {
        await handleJourneyCancelled(app, event);
      } catch (err) {
        app.log.warn(
          { err, eventId: event.event_id },
          'atlas-events: journey_cancelled handler failed',
        );
      }
    }
  };

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
    // Resolve the org's connection (→ its HMAC secret) from the signed header
    // before verifying. No connection → 401 (mirrors a signature failure).
    const orgHeader = headerValue(req, 'x-atlas-org-id');
    const connection = orgHeader ? await getConnectionByOrg(app.db, orgHeader) : null;
    if (!connection) {
      return reply.code(401).send({ ok: false, error: 'signature: unknown org' });
    }

    const subscriber = new AtlasSubscriber({
      hmacSecret: connection.secrets.hmacSecret,
      onAtlasActivity,
    });

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
