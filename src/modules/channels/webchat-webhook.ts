import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import multipart from '@fastify/multipart';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { reserveWriteSlot, StorageQuotaExceeded, uploadFile } from '../../lib/storage';
import { ingestWithHooks } from './post-ingest';
import { publicWidgetSettings, webchatConfig } from './webchat-config';

const inboxParam = z.object({ inboxId: z.string().uuid() });

// Hard ceiling on a visitor upload regardless of the per-inbox maxSizeMb — the
// inbox config can lower it but never exceed this. Keeps R2 footprint bounded.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Visitor IDs MUST follow `vis_<32+ hex chars>` — server-issued or rejected. */
const VISITOR_ID_RE = /^vis_[a-f0-9]{32,}$/;

const sessionBody = z.object({
  widgetToken: z.string().min(1).max(200),
  // Optional: client may pass a previously-server-issued ID. If absent or invalid,
  // server issues a fresh one. This blocks visitor enumeration / hijack.
  visitorId: z.string().regex(VISITOR_ID_RE).optional(),
  // Cross-device resume token (spec D11): server-signed link minted in the WS
  // hello. When valid, restores this visitor's existing session/contact.
  resume: z.string().min(1).max(800).optional(),
  identify: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().email().optional(),
      // Identity verification (spec D5): the customer site hashes a stable
      // identifier with the inbox hmacToken and passes both. Validated below.
      identifier: z.string().min(1).max(255).optional(),
      identifierHash: z.string().min(1).max(128).optional(),
    })
    .optional(),
});

const sendBody = z.object({
  widgetToken: z.string().min(1).max(200),
  visitorId: z.string().regex(VISITOR_ID_RE),
  content: z.string().min(1).max(20_000),
  channelMsgId: z.string().min(1).max(255),
});

const csatBody = z.object({
  widgetToken: z.string().min(1).max(200),
  visitorId: z.string().regex(VISITOR_ID_RE),
  conversationId: z.string().uuid(),
  score: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

function generateVisitorId(): string {
  return `vis_${randomBytes(16).toString('hex')}`;
}

function hexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validates an identifier hash (spec D5). Returns true only when the inbox holds
 * an hmacToken secret and HMAC_SHA256(hmacToken, identifier) === identifierHash.
 */
function identifierHashValid(
  secrets: string | null,
  identifier: string | undefined,
  identifierHash: string | undefined,
): boolean {
  if (!secrets || !identifier || !identifierHash) return false;
  try {
    const { hmacToken } = decryptJSON<{ hmacToken?: unknown }>(secrets);
    if (typeof hmacToken !== 'string' || hmacToken.length === 0) return false;
    const expected = createHmac('sha256', hmacToken).update(identifier).digest('hex');
    return hexEqual(expected, identifierHash);
  } catch {
    return false;
  }
}

/**
 * Decodes a resume token (spec D11) and returns the trusted visitorId it carries,
 * or null when invalid / minted for another inbox. The token is server-signed in
 * the WS hello only for visitors who left an email on a continuity-enabled inbox.
 */
function resumeVisitorId(app: FastifyInstance, inboxId: string, token: string): string | null {
  try {
    const p = app.jwt.verify(token) as unknown as {
      aud?: string;
      inboxId?: string;
      visitorId?: string;
    };
    if (p.aud !== 'widget-resume' || p.inboxId !== inboxId) return null;
    if (typeof p.visitorId !== 'string' || !VISITOR_ID_RE.test(p.visitorId)) return null;
    return p.visitorId;
  } catch {
    return null;
  }
}

/**
 * Origin check shared by /session and /webhooks/webchat. When the inbox has
 * config.allowedOrigins set, only those origins pass; an empty/absent list means
 * universal (the widgetToken stays the primary gate — see spec D3). Requests with
 * no Origin header (server-to-server / curl) are always allowed.
 */
function originAllowed(req: FastifyRequest, allowed: string[] | undefined): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return true; // server-to-server / curl OK
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(origin);
}

export async function webchatChannelRoutes(app: FastifyInstance): Promise<void> {
  // Multipart parser for visitor attachment uploads. Scoped to this plugin.
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    });
  }

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
  app.options('/webhooks/webchat/:inboxId/csat', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(204).send(),
  );
  app.options(
    '/webhooks/webchat/:inboxId/attachment',
    async (_req: FastifyRequest, reply: FastifyReply) => reply.code(204).send(),
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
      const config = webchatConfig(inbox.config);
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

      // Identity verification (spec D5). Only enforced when hmac is enabled and the
      // visitor attempts to identify. mandatory=true rejects any identify whose hash
      // doesn't check out; without hmac the identify proceeds anonymously as before.
      if (config.hmac.enabled && body.identify) {
        const verified = identifierHashValid(
          inbox.secrets,
          body.identify.identifier,
          body.identify.identifierHash,
        );
        if (!verified && config.hmac.mandatory) {
          app.log.warn({ inboxId }, 'webchat session: identity verification required');
          return reply.unauthorized('identity verification required');
        }
      }

      // A valid resume token carries a server-signed visitorId we fully trust —
      // it lets a fresh device (no localStorage) re-open this visitor's session.
      const resumed = body.resume ? resumeVisitorId(app, inboxId, body.resume) : null;

      // Server-issued visitorId if client didn't provide one (first-time visitor).
      // If client provides one that exists in DB: trust + reuse. If provides new ID
      // that doesn't exist: ALSO issue a new one (anti-enumeration); ignore client value.
      let visitorId = resumed ?? body.visitorId ?? generateVisitorId();

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
        // IDs that don't already correspond to a contact. A resumed (server-signed) ID is trusted.
        if (!resumed && body.visitorId) visitorId = generateVisitorId();
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
        ...publicWidgetSettings(config),
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
      const config = webchatConfig(inbox.config);
      if (!config.widgetToken || config.widgetToken !== body.widgetToken) {
        return reply.unauthorized('invalid widget token');
      }
      if (!originAllowed(req, config.allowedOrigins)) {
        app.log.warn(
          { inboxId, origin: req.headers.origin },
          'webchat webhook: origin not allowed',
        );
        return reply.forbidden('origin not allowed');
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

  /**
   * Visitor CSAT submission (spec D8). Auth is widgetToken + visitorId, and the
   * rating is only accepted for a resolved conversation the visitor owns. Score
   * is 1-5 (CSAT); writes to the shared csat module via csatResponses.
   */
  app.post(
    '/webhooks/webchat/:inboxId/csat',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => {
            const params = req.params as { inboxId?: string };
            const body = req.body as { visitorId?: string } | null;
            return `webchat-csat:${params.inboxId ?? 'x'}:${body?.visitorId ?? req.ip}`;
          },
        },
      },
    },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);
      const body = csatBody.parse(req.body);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || !inbox.enabled || inbox.channelType !== 'webchat') {
        return reply.notFound('inbox not found or not webchat');
      }
      const config = webchatConfig(inbox.config);
      if (!config.widgetToken || config.widgetToken !== body.widgetToken) {
        return reply.unauthorized('invalid widget token');
      }
      if (!originAllowed(req, config.allowedOrigins)) {
        app.log.warn({ inboxId, origin: req.headers.origin }, 'webchat csat: origin not allowed');
        return reply.forbidden('origin not allowed');
      }
      if (!config.csat.enabled) {
        return reply.forbidden('csat not enabled');
      }

      const [identity] = await app.db
        .select({ contactId: schema.contactIdentities.contactId })
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

      // Ownership + state: the conversation must belong to this inbox and this
      // visitor's contact, and be resolved before a rating is accepted.
      const [conv] = await app.db
        .select({
          contactId: schema.conversations.contactId,
          inboxId: schema.conversations.inboxId,
          status: schema.conversations.status,
        })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, body.conversationId))
        .limit(1);
      if (!conv || conv.inboxId !== inboxId || conv.contactId !== identity.contactId) {
        return reply.notFound('conversation not found');
      }
      if (conv.status !== 'resolved') {
        return reply.conflict('conversation not resolved');
      }

      const [row] = await app.db
        .insert(schema.csatResponses)
        .values({
          conversationId: body.conversationId,
          contactId: identity.contactId,
          score: body.score,
          kind: 'csat',
          comment: body.comment,
        })
        .returning({ id: schema.csatResponses.id });

      return reply.code(201).send({ id: row?.id });
    },
  );

  /**
   * Visitor attachment upload (spec D9). Multipart; auth is widgetToken + visitorId
   * carried as form fields (sent before the file part). Validates type/size against
   * the inbox's attachments config, stores in R2, then ingests a contact message
   * with mediaUrl/mediaMimeType. The agent sees it in the inbox like any media.
   */
  app.post(
    '/webhooks/webchat/:inboxId/attachment',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => {
            const params = req.params as { inboxId?: string };
            return `webchat-attach:${params.inboxId ?? 'x'}:${req.ip}`;
          },
        },
      },
    },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);

      const r = req as unknown as {
        isMultipart?: () => boolean;
        file?: () => Promise<
          | {
              filename: string;
              mimetype: string;
              toBuffer: () => Promise<Buffer>;
              fields: Record<string, { value?: unknown } | undefined>;
            }
          | undefined
        >;
      };
      if (typeof r.file !== 'function' || (r.isMultipart && !r.isMultipart())) {
        return reply.badRequest('multipart/form-data required');
      }

      const uploaded = await r.file();
      if (!uploaded) {
        return reply.badRequest('missing file field');
      }

      const fields = uploaded.fields ?? {};
      const widgetToken = typeof fields.widgetToken?.value === 'string' ? fields.widgetToken.value : '';
      const visitorId = typeof fields.visitorId?.value === 'string' ? fields.visitorId.value : '';
      const channelMsgId =
        typeof fields.channelMsgId?.value === 'string' ? fields.channelMsgId.value : randomUUID();
      if (!VISITOR_ID_RE.test(visitorId)) {
        return reply.unauthorized('visitor not registered (call /session first)');
      }

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || !inbox.enabled || inbox.channelType !== 'webchat') {
        return reply.notFound('inbox not found or not webchat');
      }
      const config = webchatConfig(inbox.config);
      if (!config.widgetToken || config.widgetToken !== widgetToken) {
        return reply.unauthorized('invalid widget token');
      }
      if (!originAllowed(req, config.allowedOrigins)) {
        app.log.warn(
          { inboxId, origin: req.headers.origin },
          'webchat attachment: origin not allowed',
        );
        return reply.forbidden('origin not allowed');
      }
      if (!config.attachments.enabled) {
        return reply.forbidden('attachments not enabled');
      }
      if (!config.attachments.allowedTypes.includes(uploaded.mimetype)) {
        return reply.code(415).send({ error: `file type "${uploaded.mimetype}" not allowed` });
      }

      const [identity] = await app.db
        .select({ id: schema.contactIdentities.id })
        .from(schema.contactIdentities)
        .where(
          and(
            eq(schema.contactIdentities.channel, 'webchat'),
            eq(schema.contactIdentities.identifier, visitorId),
          ),
        )
        .limit(1);
      if (!identity) {
        return reply.unauthorized('visitor not registered (call /session first)');
      }

      let buf: Buffer;
      try {
        buf = await uploaded.toBuffer();
      } catch {
        return reply.code(413).send({ error: 'file too large' });
      }
      const maxBytes = config.attachments.maxSizeMb * 1024 * 1024;
      if (buf.length > maxBytes) {
        return reply.code(413).send({ error: `file exceeds ${config.attachments.maxSizeMb} MB` });
      }

      try {
        await reserveWriteSlot(app.redis);
      } catch (err) {
        if (err instanceof StorageQuotaExceeded) {
          app.log.warn({ used: err.used, limit: err.limit }, 'webchat attachment: write budget exhausted');
          return reply.code(503).send({ error: 'upload limit reached, try again later' });
        }
        throw err;
      }

      const ext = extname(uploaded.filename).toLowerCase();
      const key = `${inbox.accountId}/${randomUUID()}${ext}`;
      const stored = await uploadFile(buf, key, uploaded.mimetype);

      const contentType = uploaded.mimetype.startsWith('image/') ? 'image' : 'document';
      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: 'webchat',
          from: {
            identifier: visitorId,
            metadata: { userAgent: req.headers['user-agent'] ?? null },
          },
          content: uploaded.filename || 'attachment',
          contentType,
          mediaUrl: stored.url,
          mediaMimeType: uploaded.mimetype,
          channelMsgId,
        },
        inbox.config,
        inbox.defaultBotId,
      );

      if (result.blocked) return reply.code(200).send({ accepted: false, reason: 'blocked' });
      return reply.code(result.deduped ? 200 : 201).send({
        contactId: result.contactId,
        conversationId: result.conversationId,
        messageId: result.messageId,
        mediaUrl: stored.url,
        deduped: result.deduped,
      });
    },
  );
}
