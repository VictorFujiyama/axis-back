import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config';
import { verifyMcpRequest } from '../modules/atlas-mcp/auth';
import { buildMcpServer } from '../modules/atlas-mcp/server';

/**
 * Phase D.2 — MCP server route (`/mcp`).
 *
 * Spike (T-015a) wired the route, body-capture parser, and HMAC preHandler.
 * T-015b swapped the stub handler for a real `McpServer` over the SDK's
 * `StreamableHTTPServerTransport`. Tool registrations live in
 * `src/modules/atlas-mcp/server.ts` (3 read tools: get_thread / list_threads /
 * search). Per-request we spin up a fresh server + transport — stateless mode
 * (`sessionIdGenerator: undefined`) so concurrent calls never share mutable
 * transport state, and the response stream is closed cleanly when the request
 * ends.
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
    async (req, reply) => {
      const server = buildMcpServer(app.db);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Hand the response stream to the transport; Fastify must not try to
      // reply on its own. The transport writes the JSON-RPC reply (and any
      // SSE frames) directly to `reply.raw`.
      reply.hijack();

      // Release transport + server resources when the client disconnects or
      // the transport finishes writing. Idempotent — `close()` on an already
      // closed transport is a no-op.
      reply.raw.on('close', () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        app.log.error({ err }, 'mcp-server: handleRequest failed');
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.end(JSON.stringify({ error: 'internal_error' }));
        } else {
          reply.raw.end();
        }
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      }
    },
  );
}
