import { and, eq, isNull } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { config as appConfig } from '../../config';
import { ingestWithHooks } from './post-ingest';
import { parseTelegramSecrets } from './telegram-sender';

const inboxParam = z.object({ inboxId: z.string().uuid() });

/**
 * Telegram Bot API webhook payload. We only care about message updates.
 * See: https://core.telegram.org/bots/api#update
 */
const telegramUpdate = z
  .object({
    update_id: z.number(),
    message: z
      .object({
        message_id: z.number(),
        from: z
          .object({
            id: z.number(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            username: z.string().optional(),
          })
          .optional(),
        chat: z.object({
          id: z.number(),
          type: z.string(),
          first_name: z.string().optional(),
          title: z.string().optional(),
        }),
        text: z.string().optional(),
        caption: z.string().optional(),
        photo: z.array(z.unknown()).optional(),
        voice: z.unknown().optional(),
        video: z.unknown().optional(),
        document: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

function tsEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function telegramChannelRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhooks/telegram/:inboxId',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox || !inbox.enabled || inbox.channelType !== 'telegram') {
        return reply.notFound('Inbox not found or not configured for telegram');
      }

      // Auth: verify X-Telegram-Bot-Api-Secret-Token against inbox.secrets.webhookSecret.
      let secrets: { webhookSecret?: string; botToken?: string } = {};
      if (inbox.secrets) {
        try {
          secrets = parseTelegramSecrets(decryptJSON(inbox.secrets));
        } catch (err) {
          app.log.error({ err, inboxId }, 'telegram: cannot decrypt secrets');
        }
      }
      if (secrets.webhookSecret) {
        const provided = req.headers['x-telegram-bot-api-secret-token'];
        if (typeof provided !== 'string' || !tsEqualStr(provided, secrets.webhookSecret)) {
          app.log.warn({ inboxId, ip: req.ip }, 'telegram: invalid webhook secret');
          return reply.unauthorized('Invalid secret token');
        }
      } else if (appConfig.NODE_ENV === 'production') {
        app.log.error({ inboxId }, 'telegram: webhookSecret required in production');
        return reply.unauthorized('webhookSecret not configured');
      }

      const body = telegramUpdate.parse(req.body);
      const message = body.message;
      if (!message) {
        // Non-message update (callback_query, edited, etc.) — accept silently.
        return reply.code(204).send();
      }

      const from = message.from;
      const chatId = String(message.chat.id);
      // Contact identifier: prefer user id, fallback to chat id for group chats.
      const identifier = from ? String(from.id) : chatId;
      const name =
        [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
        from?.username ||
        message.chat.title ||
        `Telegram ${identifier}`;

      const hasMedia = !!(
        message.photo?.length ||
        message.voice ||
        message.video ||
        message.document
      );
      const content = message.text ?? message.caption ?? (hasMedia ? '(mídia)' : '(sem conteúdo)');
      const contentType: 'text' | 'image' | 'audio' | 'video' | 'document' = message.photo?.length
        ? 'image'
        : message.voice
        ? 'audio'
        : message.video
        ? 'video'
        : message.document
        ? 'document'
        : 'text';

      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: 'telegram',
          from: {
            identifier,
            name,
            metadata: {
              username: from?.username,
              chatId,
              chatType: message.chat.type,
            },
          },
          content,
          contentType,
          channelMsgId: `${body.update_id}:${message.message_id}`,
          metadata: { chatId, username: from?.username },
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
