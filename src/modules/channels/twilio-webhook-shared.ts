import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChannelType } from '@blossom/shared-types';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { config as appConfig } from '../../config';
import { ingestWithHooks } from './post-ingest';
import { parseTwilioSecrets } from './twilio-shared';
import { verifyTwilioSignature } from './whatsapp-signature';

const inboxParam = z.object({ inboxId: z.string().uuid() });

const twilioInbound = z
  .object({
    MessageSid: z.string().min(1),
    From: z.string().min(1),
    To: z.string().min(1),
    Body: z.string().default(''),
    NumMedia: z.string().default('0'),
    MediaUrl0: z.string().url().optional(),
    MediaContentType0: z.string().optional(),
    ProfileName: z.string().optional(),
  })
  .passthrough();

const twilioStatus = z
  .object({
    MessageSid: z.string().min(1),
    MessageStatus: z.enum([
      'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'undelivered',
    ]),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional(),
  })
  .passthrough();

function stripPrefix(prefix: string, value: string): string {
  return value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : value;
}
function fullUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.hostname}${req.url}`;
}
function contentTypeFromMime(mime?: string): 'text' | 'image' | 'audio' | 'video' | 'document' {
  if (!mime) return 'text';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Register a Twilio-style channel adapter: inbound + status callback under
 * `/webhooks/<prefix>/:inboxId[/status]`. Works for Instagram and Messenger —
 * WhatsApp keeps its own file to avoid touching its already-reviewed code.
 */
export function registerTwilioChannel(
  app: FastifyInstance,
  prefix: 'instagram' | 'messenger',
  channelType: ChannelType,
): void {
  const readSecrets = async (inbox: typeof schema.inboxes.$inferSelect) => {
    if (!inbox.secrets) return null;
    try {
      return parseTwilioSecrets(decryptJSON(inbox.secrets));
    } catch (err) {
      app.log.error({ err, inboxId: inbox.id }, `${prefix}: cannot decrypt secrets`);
      return null;
    }
  };

  app.post(
    `/webhooks/${prefix}/:inboxId`,
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || !inbox.enabled || inbox.channelType !== channelType) {
        return reply.notFound(`Inbox not found or not configured for ${prefix}`);
      }

      const secrets = await readSecrets(inbox);
      if (!secrets?.authToken) {
        if (appConfig.NODE_ENV === 'production' || !appConfig.ALLOW_UNSIGNED_WEBHOOKS) {
          return reply.unauthorized('authToken not configured');
        }
        app.log.warn(
          { inboxId },
          `${prefix} webhook: no authToken — accepted because ALLOW_UNSIGNED_WEBHOOKS=true`,
        );
      } else {
        const sig = req.headers['x-twilio-signature'];
        const params = req.body as Record<string, string | string[]>;
        if (!verifyTwilioSignature(secrets.authToken, fullUrl(req), params, sig)) {
          app.log.warn({ inboxId, ip: req.ip }, `${prefix}: invalid signature`);
          return reply.unauthorized('Invalid Twilio signature');
        }
      }

      const body = twilioInbound.parse(req.body);
      const identifier = stripPrefix(prefix, body.From);
      const name = body.ProfileName?.trim() || identifier;
      const numMedia = Number.parseInt(body.NumMedia, 10) || 0;

      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: channelType,
          from: {
            identifier,
            name,
            metadata: { twilioFrom: body.From, profileName: body.ProfileName },
          },
          content: body.Body || (numMedia > 0 ? '(mídia)' : '(sem conteúdo)'),
          contentType: numMedia > 0 ? contentTypeFromMime(body.MediaContentType0) : 'text',
          mediaUrl: body.MediaUrl0,
          mediaMimeType: body.MediaContentType0,
          channelMsgId: body.MessageSid,
          metadata: { numMedia, from: body.From, to: body.To },
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

  app.post(
    `/webhooks/${prefix}/:inboxId/status`,
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || inbox.channelType !== channelType) return reply.notFound();

      const secrets = await readSecrets(inbox);
      if (secrets?.authToken) {
        const sig = req.headers['x-twilio-signature'];
        const params = req.body as Record<string, string | string[]>;
        if (!verifyTwilioSignature(secrets.authToken, fullUrl(req), params, sig)) {
          return reply.unauthorized('Invalid Twilio signature');
        }
      } else if (
        appConfig.NODE_ENV === 'production' ||
        !appConfig.ALLOW_UNSIGNED_WEBHOOKS
      ) {
        return reply.unauthorized('authToken not configured');
      }

      const body = twilioStatus.parse(req.body);
      const patch: Record<string, unknown> = {};
      if (body.MessageStatus === 'delivered') patch.deliveredAt = new Date();
      else if (body.MessageStatus === 'read') patch.readAt = new Date();
      else if (body.MessageStatus === 'failed' || body.MessageStatus === 'undelivered') {
        patch.failedAt = new Date();
        patch.failureReason =
          body.ErrorMessage ?? (body.ErrorCode ? `twilio ${body.ErrorCode}` : 'failed');
      }
      if (Object.keys(patch).length > 0) {
        await app.db
          .update(schema.messages)
          .set(patch)
          .where(
            and(
              eq(schema.messages.inboxId, inboxId),
              eq(schema.messages.channelMsgId, body.MessageSid),
            ),
          );
      }
      return reply.code(204).send();
    },
  );
}
