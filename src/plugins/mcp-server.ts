import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config';
import { verifyMcpRequest } from '../modules/atlas-mcp/auth';
import { buildMcpServer } from '../modules/atlas-mcp/server';
import type { AtlasRequestContext } from '../modules/atlas-mcp/tools';

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
 * Auth (Phase D Activation T-005): mode-aware. `verifyMcpRequest(req, config)`
 * dispatches on `config.MCP_AUTH_MODE` — Bearer (`Authorization: Bearer <key>`),
 * Phase B HMAC (`X-Atlas-Signature`, `verifyOutboundSignature` Stripe-style),
 * or `both` (Bearer primary, HMAC fall-through only when the Authorization
 * header is absent). See `modules/atlas-mcp/auth.ts` for the dispatch logic
 * and L-507 for the constant-time Bearer compare.
 *
 * Identity (T-023): the write tools (`messaging.send_message`, `.assign`,
 * `.resolve`) need to know which Atlas user fired the call so the handler can
 * gate on `atlas_user_links` and stamp the `actors[].app_user_id` on the
 * emitted envelope. We read `X-Atlas-App-User-Id` + `X-Atlas-Org-Id` headers
 * here and pass them as `ctx` into `buildMcpServer`. If either is missing the
 * write tools surface a `forbidden` tool error; read tools work either way.
 *
 * Off by default: when `MCP_SERVER_ENABLED=false` the plugin registers no
 * route, so `/mcp` falls through to Fastify's default 404. The boot precheck
 * in `config.ts` (T-003) throws on misconfigured auth (e.g. mode='hmac' with
 * no HMAC secret, or mode ∈ {bearer,both} with no API key).
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  return undefined;
}

function buildAtlasContext(req: FastifyRequest): AtlasRequestContext | undefined {
  const atlasAppUserId = readSingleHeader(req.headers['x-atlas-app-user-id']);
  const atlasOrgId = readSingleHeader(req.headers['x-atlas-org-id']);
  if (!atlasAppUserId || !atlasOrgId) return undefined;
  return { atlasAppUserId, atlasOrgId };
}

export async function mcpServerPlugin(app: FastifyInstance): Promise<void> {
  if (!config.MCP_SERVER_ENABLED) {
    return;
  }

  // Mode-aware auth gating now happens at boot via T-003 precheck (throws on
  // misconfig). Plugin always registers when MCP_SERVER_ENABLED=true.

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
        const result = verifyMcpRequest(req, config);
        if (!result.ok) {
          return reply.code(401).send({ error: result.error ?? 'unauthorized' });
        }
      },
    },
    async (req, reply) => {
      const ctx = buildAtlasContext(req);
      const server = buildMcpServer(app.db, app, ctx);
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
