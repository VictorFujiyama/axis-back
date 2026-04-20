import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { ingestWithHooks } from './post-ingest';

const inboxParam = z.object({ inboxId: z.string().uuid() });

const inboundBody = z.object({
  from: z.object({
    identifier: z.string().min(1).max(255),
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(5).max(30).optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  content: z.string().min(1).max(20_000),
  contentType: z
    .enum(['text', 'image', 'audio', 'video', 'document', 'location'])
    .default('text'),
  mediaUrl: z.string().url().optional(),
  mediaMimeType: z.string().optional(),
  channelMsgId: z.string().min(1).max(255),
});

interface ApiSecrets {
  apiToken?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function apiChannelRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhooks/api/:inboxId',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);

      if (!inbox || !inbox.enabled || inbox.channelType !== 'api') {
        return reply.notFound('Inbox not found or not configured for API channel');
      }

      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.unauthorized('Missing bearer token');
      }
      const token = auth.slice('Bearer '.length).trim();

      if (!inbox.secrets) {
        return reply.unauthorized('Inbox secrets not configured');
      }
      let secrets: ApiSecrets;
      try {
        secrets = decryptJSON<ApiSecrets>(inbox.secrets);
      } catch (err) {
        app.log.error({ err, inboxId }, 'failed to decrypt inbox secrets');
        return reply.internalServerError();
      }
      if (!secrets.apiToken || !constantTimeEqual(token, secrets.apiToken)) {
        app.log.warn(
          { inboxId, ip: req.ip, ua: req.headers['user-agent'] },
          'webhook: invalid bearer token',
        );
        return reply.unauthorized('Invalid token');
      }

      const body = inboundBody.parse(req.body);

      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: 'api',
          from: body.from,
          content: body.content,
          contentType: body.contentType,
          mediaUrl: body.mediaUrl,
          mediaMimeType: body.mediaMimeType,
          channelMsgId: body.channelMsgId,
        },
        inbox.config,
        inbox.defaultBotId,
      );

      if (result.blocked) {
        return reply.code(200).send({ accepted: false, reason: 'blocked' });
      }

      return reply.code(result.deduped ? 200 : 201).send({
        contactId: result.contactId,
        conversationId: result.conversationId,
        messageId: result.messageId,
        deduped: result.deduped,
      });
    },
  );
}
