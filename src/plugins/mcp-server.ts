import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config';
import { verifyMcpRequest } from '../modules/atlas-mcp/auth';

/**
 * Phase D.2 — MCP server route (`/mcp`) spike (T-015a).
 *
 * Skeleton only: route + body capture + HMAC preHandler + stub handler. T-015b
 * swaps the stub for an `McpServer` + `StreamableHTTPServerTransport` and
 * registers the three read tools (T-013) via `server.tool()`.
 *
 * Plugin-scoped, NOT `fp`-wrapped: Fastify encapsulation contains the JSON
 * content-type-parser override and `rawBody` decorator to this plugin's
 * subtree. Other routes (Twilio urlencoded, normal JSON APIs) are unaffected.
 *
 * Auth: shared HMAC (`X-Atlas-Signature`), verified against the raw request
 * bytes — Atlas-side signs the same string (L-408). The verifier reuses the
 * Phase B primitive (`verifyOutboundSignature`) so the on-wire format stays
 * Stripe-style (`t=<unix>,v1=<hex>`).
 *
 * Off by default: when `MCP_SERVER_ENABLED=false` the plugin registers no
 * route, so `/mcp` falls through to Fastify's default 404. The boot check in
 * `config.ts` already refuses to start with the flag on and no secret.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function mcpServerPlugin(app: FastifyInstance): Promise<void> {
  if (!config.MCP_SERVER_ENABLED) {
    return;
  }

  const secret = config.ATLAS_MCP_HMAC_SECRET;
  if (!secret) {
    // The boot check in `config.ts` should have caught this, but guard
    // defensively: registering the route without a secret would 401 every
    // request anyway.
    app.log.warn('mcp-server: MCP_SERVER_ENABLED=true but no secret; skipping route');
    return;
  }

  // Body parsing fix (T-015a step 2): capture raw bytes for HMAC verification
  // while still exposing `request.body` as a parsed object for handler
  // convenience. `verifyOutboundSignature` consumes the body as a string, so
  // we hand it the exact UTF-8 bytes Atlas signed — no risk of whitespace or
  // key-ordering divergence from a re-stringify of the parsed object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBody = body;
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post(
    '/mcp',
    {
      preHandler: async (req, reply) => {
        const raw = req.rawBody?.toString('utf8') ?? '';
        const result = verifyMcpRequest(
          req.headers['x-atlas-signature'],
          raw,
          secret,
        );
        if (!result.ok) {
          return reply.code(401).send({ error: result.error ?? 'unauthorized' });
        }
      },
    },
    async () => {
      // Stub: T-015b replaces this with `transport.handleRequest(...)` after
      // wiring `McpServer.connect(transport)` + tool registrations.
      return { ok: true };
    },
  );
}
