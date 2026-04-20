import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { ingestWithHooks } from './post-ingest';

const inboxParam = z.object({ inboxId: z.string().uuid() });

/** Visitor IDs MUST follow `vis_<32+ hex chars>` — server-issued or rejected. */
const VISITOR_ID_RE = /^vis_[a-f0-9]{32,}$/;

const sessionBody = z.object({
  widgetToken: z.string().min(1).max(200),
  // Optional: client may pass a previously-server-issued ID. If absent or invalid,
  // server issues a fresh one. This blocks visitor enumeration / hijack.
  visitorId: z.string().regex(VISITOR_ID_RE).optional(),
  identify: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().email().optional(),
    })
    .optional(),
});

const sendBody = z.object({
  widgetToken: z.string().min(1).max(200),
  visitorId: z.string().regex(VISITOR_ID_RE),
  content: z.string().min(1).max(20_000),
  channelMsgId: z.string().min(1).max(255),
});

interface WidgetConfig {
  widgetToken?: string;
  primaryColor?: string;
  greeting?: string;
  /** Allowlist of origins permitted to call the /session endpoint (Origin header). */
  allowedOrigins?: string[];
}

function readWidgetConfig(raw: unknown): WidgetConfig {
  if (!raw || typeof raw !== 'object') return {};
  return raw as WidgetConfig;
}

function generateVisitorId(): string {
  return `vis_${randomBytes(16).toString('hex')}`;
}

/**
 * Origin check for /session — sensitive (returns JWT). Allowlisted via inbox.config.allowedOrigins.
 * In dev (no list configured) we accept anything but log a warning.
 * For /webhooks/webchat/* (read-only POST that mints no token) we keep CORS open: false-positive
 * cost low and visitor sites can be on any domain.
 */
function originAllowed(req: FastifyRequest, allowed: string[] | undefined): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return true; // server-to-server / curl OK
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(origin);
}

export async function webchatChannelRoutes(app: FastifyInstance): Promise<void> {
  // Per-route CORS: open by default for widget paths so visitor sites can call us.
  // /session response is JWT-bearing → also enforce Origin allowlist below.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/webhooks/webchat/') || req.url.startsWith('/api/v1/widget/')) {
      const origin = req.headers.origin;
      if (typeof origin === 'string') {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
      }
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Widget-Visitor',
      );
    }
    return payload;
  });

  app.options('/webhooks/webchat/:inboxId', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(204).send(),
  );
  app.options('/api/v1/widget/:inboxId/session', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(204).send(),
  );

  /**
   * Issues a short-lived visitor session (JWT). Validates widgetToken and Origin.
   * Server issues visitorId if missing/invalid — prevents enumeration.
   */
  app.post(
    '/api/v1/widget/:inboxId/session',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);
      const body = sessionBody.parse(req.body);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || !inbox.enabled || inbox.channelType !== 'webchat') {
        return reply.notFound('inbox not found or not webchat');
      }
      const config = readWidgetConfig(inbox.config);
      if (!config.widgetToken || config.widgetToken !== body.widgetToken) {
        return reply.unauthorized('invalid widget token');
      }
      if (!originAllowed(req, config.allowedOrigins)) {
        app.log.warn(
          { inboxId, origin: req.headers.origin },
          'webchat session: origin not allowed',
        );
        return reply.forbidden('origin not allowed');
      }

      // Server-issued visitorId if client didn't provide one (first-time visitor).
      // If client provides one that exists in DB: trust + reuse. If provides new ID
      // that doesn't exist: ALSO issue a new one (anti-enumeration); ignore client value.
      let visitorId = body.visitorId ?? generateVisitorId();

      const [identity] = await app.db
        .select()
        .from(schema.contactIdentities)
        .where(
          and(
            eq(schema.contactIdentities.channel, 'webchat'),
            eq(schema.contactIdentities.identifier, visitorId),
          ),
        )
        .limit(1);

      let contactId: string;
      if (identity) {
        contactId = identity.contactId;
        if (body.identify?.name || body.identify?.email) {
          const [c] = await app.db
            .select({ name: schema.contacts.name, email: schema.contacts.email })
            .from(schema.contacts)
            .where(eq(schema.contacts.id, contactId))
            .limit(1);
          if (c) {
            const patch: Record<string, unknown> = {};
            if (body.identify.name && !c.name) patch.name = body.identify.name;
            if (body.identify.email && !c.email) patch.email = body.identify.email;
            if (Object.keys(patch).length > 0) {
              await app.db
                .update(schema.contacts)
                .set({ ...patch, updatedAt: new Date() })
                .where(eq(schema.contacts.id, contactId));
            }
          }
        }
      } else {
        // Either fresh visitor or client supplied an unknown ID — server-issue regardless.
        if (body.visitorId && body.visitorId !== visitorId) {
          // No-op (we already used the original); kept for clarity.
        }
        // Re-roll visitorId server-side to defeat enumeration: we do NOT trust client-supplied
        // IDs that don't already correspond to a contact.
        if (body.visitorId) visitorId = generateVisitorId();
        const [contact] = await app.db
          .insert(schema.contacts)
          .values({
            name: body.identify?.name,
            email: body.identify?.email,
          })
          .returning({ id: schema.contacts.id });
        if (!contact) throw new Error('contact insert failed');
        contactId = contact.id;
        await app.db.insert(schema.contactIdentities).values({
          contactId,
          channel: 'webchat',
          identifier: visitorId,
          metadata: {
            userAgent: req.headers['user-agent'] ?? null,
            firstSeenAt: new Date().toISOString(),
            origin: req.headers.origin ?? null,
          },
        });
      }

      const sessionToken = app.jwt.sign(
        {
          aud: 'widget',
          inboxId,
          contactId,
          visitorId,
        } as unknown as { sub: string; email: string; role: 'agent'; accountId: string },
        { expiresIn: '12h' },
      );

      return reply.send({
        sessionToken,
        visitorId,
        contactId,
        widgetUrl: `${process.env.WIDGET_PUBLIC_URL ?? ''}/widget/${inboxId}`,
        primaryColor: config.primaryColor ?? '#7b3fa9',
        greeting: config.greeting ?? null,
      });
    },
  );

  /**
   * Inbound widget message — visitor sends a chat line.
   * Rate limit per (inbox, visitorId) instead of per-IP (NAT-friendly).
   */
  app.post(
    '/webhooks/webchat/:inboxId',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => {
            const params = req.params as { inboxId?: string };
            const body = req.body as { visitorId?: string } | null;
            return `webchat:${params.inboxId ?? 'x'}:${body?.visitorId ?? req.ip}`;
          },
        },
      },
    },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);
      const body = sendBody.parse(req.body);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || !inbox.enabled || inbox.channelType !== 'webchat') {
        return reply.notFound('inbox not found or not webchat');
      }
      const config = readWidgetConfig(inbox.config);
      if (!config.widgetToken || config.widgetToken !== body.widgetToken) {
        return reply.unauthorized('invalid widget token');
      }

      // Defensive: visitor must already exist (issued via /session). Random visitorIds
      // sent here without a session are rejected.
      const [identity] = await app.db
        .select({ id: schema.contactIdentities.id })
        .from(schema.contactIdentities)
        .where(
          and(
            eq(schema.contactIdentities.channel, 'webchat'),
            eq(schema.contactIdentities.identifier, body.visitorId),
          ),
        )
        .limit(1);
      if (!identity) {
        return reply.unauthorized('visitor not registered (call /session first)');
      }

      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: 'webchat',
          from: {
            identifier: body.visitorId,
            metadata: { userAgent: req.headers['user-agent'] ?? null },
          },
          content: body.content,
          contentType: 'text',
          channelMsgId: body.channelMsgId,
        },
        inbox.config,
        inbox.defaultBotId,
      );

      if (result.blocked) return reply.code(200).send({ accepted: false, reason: 'blocked' });
      return reply.code(result.deduped ? 200 : 201).send({
        contactId: result.contactId,
        conversationId: result.conversationId,
        messageId: result.messageId,
        deduped: result.deduped,
      });
    },
  );
}
