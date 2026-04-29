import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { config as appConfig } from '../../config';
import { ingestWithHooks } from './post-ingest';
import { parseWhatsAppSecrets, parseWhatsAppConfig } from './whatsapp-sender';
import { verifyTwilioSignature } from './whatsapp-signature';
import { eventBus } from '../../realtime/event-bus';
import { QUEUE_NAMES, type MediaMirrorJob } from '../../queue';

const inboxParam = z.object({ inboxId: z.string().uuid() });

/** Twilio sends application/x-www-form-urlencoded. Fastify parses to flat object. */
const twilioInbound = z
  .object({
    MessageSid: z.string().min(1),
    From: z.string().min(1), // whatsapp:+5511999...
    To: z.string().min(1),
    Body: z.string().default(''),
    NumMedia: z.string().default('0'),
    MediaUrl0: z.string().url().optional(),
    MediaContentType0: z.string().optional(),
    ProfileName: z.string().optional(),
    WaId: z.string().optional(),
  })
  .passthrough();

const twilioStatus = z
  .object({
    MessageSid: z.string().min(1),
    MessageStatus: z.enum([
      'queued',
      'sending',
      'sent',
      'delivered',
      'read',
      'failed',
      'undelivered',
    ]),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional(),
  })
  .passthrough();

function stripWaPrefix(value: string): string {
  return value.replace(/^whatsapp:/i, '');
}

function phoneDigits(value: string): string {
  return stripWaPrefix(value).replace(/[^\d]/g, '');
}

/** Absolute URL Twilio called (needed verbatim for signature).
 *
 * Uses Fastify's trustProxy-aware `req.hostname` and `req.protocol` so an
 * attacker can't tamper with `Host:` to match a previously-signed URL. When
 * trustProxy is on, these reflect X-Forwarded-* only if the request arrived
 * via a trusted proxy; direct requests fall back to the socket's local addr. */
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

async function readSecretsOrFail(
  app: FastifyInstance,
  inbox: typeof schema.inboxes.$inferSelect,
): Promise<{ authToken?: string } | null> {
  if (!inbox.secrets) return null;
  try {
    return parseWhatsAppSecrets(decryptJSON(inbox.secrets));
  } catch (err) {
    app.log.error({ err, inboxId: inbox.id }, 'whatsapp webhook: cannot decrypt secrets');
    return null;
  }
}

export async function whatsappChannelRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhooks/whatsapp/:inboxId',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);

      if (!inbox || !inbox.enabled || inbox.channelType !== 'whatsapp') {
        return reply.notFound('Inbox not found or not configured for whatsapp');
      }

      // This webhook only handles Twilio. Cloud API uses a different verification
      // (Meta verify_token + signature). If provider is set to anything else, refuse.
      // Uses parseWhatsAppConfig so the normalized default ('twilio') is compared,
      // matching the sender's provider gate exactly.
      const inboxConfig = parseWhatsAppConfig(inbox.config);
      if (inboxConfig.provider !== 'twilio') {
        app.log.warn(
          { inboxId, provider: inboxConfig.provider },
          'whatsapp webhook: not a twilio inbox',
        );
        return reply.notFound('Inbox is not configured for Twilio');
      }

      const secrets = await readSecretsOrFail(app, inbox);
      if (!secrets?.authToken) {
        // Production ALWAYS requires a signed webhook. Non-prod needs the
        // explicit ALLOW_UNSIGNED_WEBHOOKS opt-in — otherwise any attacker
        // knowing the inboxId can forge inbound messages.
        if (appConfig.NODE_ENV === 'production' || !appConfig.ALLOW_UNSIGNED_WEBHOOKS) {
          app.log.error({ inboxId }, 'whatsapp webhook: missing authToken (signature required)');
          return reply.unauthorized('authToken not configured');
        }
        app.log.warn(
          { inboxId },
          'whatsapp webhook: no authToken — accepted because ALLOW_UNSIGNED_WEBHOOKS=true',
        );
      } else {
        const sig = req.headers['x-twilio-signature'];
        const params = req.body as Record<string, string | string[]>;
        const ok = verifyTwilioSignature(secrets.authToken, fullUrl(req), params, sig);
        if (!ok) {
          app.log.warn({ inboxId, ip: req.ip }, 'whatsapp webhook: invalid signature');
          return reply.unauthorized('Invalid Twilio signature');
        }
      }

      const body = twilioInbound.parse(req.body);
      const fromPhone = phoneDigits(body.From);
      const name = body.ProfileName?.trim() || fromPhone;
      const numMedia = Number.parseInt(body.NumMedia, 10) || 0;

      // Twilio media URLs require Basic Auth and the signed CDN URL behind
      // them rotates ~hourly, so the browser cannot render them directly.
      // We mirror the bytes into R2 in a background worker (MEDIA_MIRROR)
      // instead of awaiting it here — the inline mirror added 500ms-2s of
      // perceived delay before the agent saw the message. The message is
      // inserted with mediaUrl=null + metadata.mediaPending=true so the
      // front renders a skeleton; the worker swaps in the final URL via a
      // `message.media-ready` realtime event when the upload finishes.
      const hasMirrorableMedia =
        numMedia > 0 &&
        !!body.MediaUrl0 &&
        !!secrets?.authToken &&
        !!inboxConfig.accountSid &&
        !!inbox.accountId;

      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: 'whatsapp',
          from: {
            identifier: fromPhone,
            name,
            phone: `+${fromPhone}`,
            metadata: { waId: body.WaId, profileName: body.ProfileName },
          },
          content: body.Body || (numMedia > 0 ? '(mídia)' : '(sem conteúdo)'),
          contentType: numMedia > 0 ? contentTypeFromMime(body.MediaContentType0) : 'text',
          mediaUrl: hasMirrorableMedia ? undefined : body.MediaUrl0,
          mediaMimeType: body.MediaContentType0,
          channelMsgId: body.MessageSid,
          metadata: {
            numMedia,
            from: body.From,
            to: body.To,
            ...(hasMirrorableMedia ? { mediaPending: true } : {}),
          },
        },
        inbox.config,
        inbox.defaultBotId,
      );

      // Enqueue the mirror after the message exists. Skip on dedup — the
      // original ingestion already enqueued (or completed) the mirror.
      if (hasMirrorableMedia && !result.deduped && result.messageId && result.conversationId) {
        const job: MediaMirrorJob = {
          messageId: result.messageId,
          conversationId: result.conversationId,
          inboxId,
          accountId: inbox.accountId!,
          twilioUrl: body.MediaUrl0!,
          mimeType: body.MediaContentType0 ?? null,
        };
        try {
          await app.queues.getQueue<MediaMirrorJob>(QUEUE_NAMES.MEDIA_MIRROR).add('mirror', job);
        } catch (err) {
          app.log.error(
            { err, messageId: job.messageId },
            'whatsapp webhook: failed to enqueue media mirror',
          );
          // The job never made it onto the queue — without this the message
          // would render a skeleton forever. Drop the pending flag and stamp
          // the failure breadcrumb so the front can show the fallback.
          void app.db
            .update(schema.messages)
            .set({
              metadata: sql`(${schema.messages.metadata} - 'mediaPending') || jsonb_build_object('mediaMirrorFailed', true)`,
            })
            .where(eq(schema.messages.id, job.messageId))
            .then(() => {
              eventBus.emitEvent({
                type: 'message.media-ready',
                inboxId: job.inboxId,
                conversationId: job.conversationId,
                messageId: job.messageId,
                mediaUrl: '',
                mediaMimeType: job.mimeType ?? null,
              });
            })
            .catch((dbErr) => {
              app.log.error(
                { err: dbErr, messageId: job.messageId },
                'whatsapp webhook: failed-to-mark-failed after enqueue failure',
              );
            });
        }
      }

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
    '/webhooks/whatsapp/:inboxId/status',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);

      if (!inbox || inbox.channelType !== 'whatsapp') {
        return reply.notFound('Inbox not found');
      }

      const secrets = await readSecretsOrFail(app, inbox);
      if (secrets?.authToken) {
        const sig = req.headers['x-twilio-signature'];
        const params = req.body as Record<string, string | string[]>;
        const ok = verifyTwilioSignature(secrets.authToken, fullUrl(req), params, sig);
        if (!ok) {
          app.log.warn({ inboxId, ip: req.ip }, 'whatsapp status: invalid signature');
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
      if (body.MessageStatus === 'delivered') {
        patch.deliveredAt = new Date();
      } else if (body.MessageStatus === 'read') {
        // Only set readAt — do NOT touch deliveredAt. Twilio sends `delivered`
        // before `read` in normal flow; if it skips, deliveredAt stays null.
        patch.readAt = new Date();
      } else if (
        body.MessageStatus === 'failed' ||
        body.MessageStatus === 'undelivered'
      ) {
        patch.failedAt = new Date();
        patch.failureReason =
          body.ErrorMessage ?? (body.ErrorCode ? `twilio ${body.ErrorCode}` : 'failed');
      }

      if (Object.keys(patch).length > 0) {
        // Filter by inboxId too — matches the composite UNIQUE index
        // (inbox_id, channel_msg_id), so this is an index lookup, not a scan.
        const updated = await app.db
          .update(schema.messages)
          .set(patch)
          .where(
            and(
              eq(schema.messages.inboxId, inboxId),
              eq(schema.messages.channelMsgId, body.MessageSid),
            ),
          )
          .returning({
            id: schema.messages.id,
            conversationId: schema.messages.conversationId,
          });
        const row = updated[0];
        if (row) {
          // Notify clients so the "sending" clock flips to the sent/read check
          // without waiting for a page reload.
          eventBus.emitEvent({
            type: 'message.updated',
            inboxId,
            conversationId: row.conversationId,
            messageId: row.id,
            changes: patch as {
              deliveredAt?: Date;
              readAt?: Date;
              failedAt?: Date;
              failureReason?: string;
            },
          });
        }
      }
      return reply.code(204).send();
    },
  );
}
