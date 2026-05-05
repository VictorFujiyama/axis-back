import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { decryptJSON } from '../crypto';
import { eventBus } from '../realtime/event-bus';
import { QUEUE_NAMES, type BotDispatchJob, type EmailOutboundJob, type MediaMirrorJob, type WhatsAppOutboundJob, type TelegramOutboundJob, type TwilioMetaOutboundJob } from './index';
import { mirrorTwilioMedia } from '../lib/twilio-media';
import { registerSnoozeWorker } from '../modules/conversations/snooze-worker';
import { registerScheduledMessageWorker } from '../modules/messages/scheduled-worker';
import { dispatchOutbound } from '../modules/messages/routes';
import { registerWebhookWorker } from '../modules/webhooks/worker';
import { registerCampaignWorkers } from '../modules/campaigns/runner';
import { deliverBotWebhook } from '../modules/bots/dispatcher-fn';
import { handleBotFallback } from '../modules/bots/fallback';
import {
  parseEmailConfig,
  parseEmailSecrets,
  sendViaPostmark,
} from '../modules/channels/email-sender';
import {
  parseWhatsAppConfig,
  parseWhatsAppSecrets,
  sendOutboundWhatsApp,
} from '../modules/channels/whatsapp-sender';
import {
  parseTelegramConfig,
  parseTelegramSecrets,
  sendOutboundTelegram,
} from '../modules/channels/telegram-sender';
import {
  parseTwilioConfig,
  parseTwilioSecrets,
  sendOutboundTwilio,
} from '../modules/channels/twilio-shared';
import { registerGmailSyncWorker } from './workers/gmail-sync';
import { config as appConfig } from '../config';

/**
 * Mark `messages.failedAt` when a BullMQ outbound job exhausts all retries.
 * The senders set failedAt themselves on permanent (4xx) failures and skip
 * doing so on transient (5xx/network) ones — those throw and BullMQ retries.
 * Without this handler, retries-exhausted messages stay in a "ghost" state
 * (no failedAt, no channelMsgId) and the manual /retry endpoint can't act.
 */
function markFailedOnExhaust<T extends { messageId: string; conversationId: string; inboxId: string }>(
  worker: Worker<T>,
  app: FastifyInstance,
  label: string,
): void {
  worker.on('failed', (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 5;
    if (job.attemptsMade < maxAttempts) return;
    const failureReason = `${label}: ${err.message?.slice(0, 480) ?? 'transient retries exhausted'}`;
    const failedAt = new Date();
    void app.db
      .update(schema.messages)
      .set({ failedAt, failureReason })
      .where(
        and(
          eq(schema.messages.id, job.data.messageId),
          isNull(schema.messages.deliveredAt),
          isNull(schema.messages.failedAt),
        ),
      )
      .returning({ id: schema.messages.id })
      .then((rows) => {
        // Notify open clients so the failed bubble appears without a refresh.
        // Skip emit if the row was already terminal — no real change happened.
        if (rows.length === 0) return;
        eventBus.emitEvent({
          type: 'message.updated',
          inboxId: job.data.inboxId,
          conversationId: job.data.conversationId,
          messageId: job.data.messageId,
          changes: { failedAt, failureReason },
        });
      })
      .catch((e) => {
        app.log.error(
          { err: e, messageId: job.data.messageId },
          `${label}: failed-to-mark-failed`,
        );
      });
  });
}

export function registerWorkers(app: FastifyInstance): void {
  // Bot dispatcher worker — with fallback on final failure
  const botWorker = app.queues.registerWorker<BotDispatchJob>(
    QUEUE_NAMES.BOT_DISPATCH,
    async (job) => {
      await deliverBotWebhook(job.data, { db: app.db, log: app.log });
    },
    10,
  );
  botWorker.on('failed', (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 4;
    if (job.attemptsMade >= maxAttempts) {
      void handleBotFallback(
        {
          conversationId: job.data.conversationId,
          botId: job.data.botId,
          accountId: job.data.accountId,
          reason: err.name === 'AbortError' ? 'timeout' : 'max_retries',
          error: err.message?.slice(0, 500),
        },
        { db: app.db, log: app.log },
      ).catch((fallbackErr) => {
        app.log.error(
          { err: fallbackErr, conversationId: job.data.conversationId, botId: job.data.botId },
          'CRITICAL: bot fallback handler failed — conversation may be stuck in pending without agent notification',
        );
      });
    }
  });

  // Email outbound worker
  const emailWorker = app.queues.registerWorker<EmailOutboundJob>(
    QUEUE_NAMES.EMAIL_OUTBOUND,
    async (job) => {
      const data = job.data;
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, data.inboxId))
        .limit(1);
      if (!inbox) throw new Error('inbox not found');
      const cfg = parseEmailConfig(inbox.config);
      let secrets = parseEmailSecrets({});
      if (inbox.secrets) {
        try {
          secrets = parseEmailSecrets(decryptJSON(inbox.secrets));
        } catch (err) {
          app.log.error({ err, inboxId: inbox.id }, 'email worker: cannot decrypt secrets');
          throw err;
        }
      }
      await sendViaPostmark(
        {
          messageId: data.messageId,
          conversationId: data.conversationId,
          inboxId: data.inboxId,
          contactEmail: data.contactEmail,
          subject: data.subject,
          text: data.text,
        },
        cfg,
        secrets,
        data.inReplyToMessageId,
        { db: app.db, log: app.log },
      );
    },
    5,
  );
  markFailedOnExhaust(emailWorker, app, 'email');

  // WhatsApp outbound worker
  const whatsappWorker = app.queues.registerWorker<WhatsAppOutboundJob>(
    QUEUE_NAMES.WHATSAPP_OUTBOUND,
    async (job) => {
      const data = job.data;
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, data.inboxId))
        .limit(1);
      if (!inbox) throw new Error('inbox not found');
      const cfg = parseWhatsAppConfig(inbox.config);
      let secrets = parseWhatsAppSecrets({});
      if (inbox.secrets) {
        try {
          secrets = parseWhatsAppSecrets(decryptJSON(inbox.secrets));
        } catch (err) {
          app.log.error({ err, inboxId: inbox.id }, 'whatsapp worker: cannot decrypt secrets');
          throw err;
        }
      }
      const statusCallbackUrl = appConfig.PUBLIC_API_URL
        ? `${appConfig.PUBLIC_API_URL.replace(/\/$/, '')}/webhooks/whatsapp/${data.inboxId}/status`
        : null;
      await sendOutboundWhatsApp(
        {
          messageId: data.messageId,
          conversationId: data.conversationId,
          inboxId: data.inboxId,
          contactPhone: data.contactPhone,
          text: data.text,
          mediaUrl: data.mediaUrl,
        },
        cfg,
        secrets,
        statusCallbackUrl,
        { db: app.db, log: app.log },
      );
    },
    5,
  );
  markFailedOnExhaust(whatsappWorker, app, 'whatsapp');

  // Telegram outbound worker
  const telegramWorker = app.queues.registerWorker<TelegramOutboundJob>(
    QUEUE_NAMES.TELEGRAM_OUTBOUND,
    async (job) => {
      const data = job.data;
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, data.inboxId))
        .limit(1);
      if (!inbox) throw new Error('inbox not found');
      const cfg = parseTelegramConfig(inbox.config);
      let secrets = parseTelegramSecrets({});
      if (inbox.secrets) {
        try {
          secrets = parseTelegramSecrets(decryptJSON(inbox.secrets));
        } catch (err) {
          app.log.error({ err, inboxId: inbox.id }, 'telegram worker: cannot decrypt secrets');
          throw err;
        }
      }
      await sendOutboundTelegram(
        {
          messageId: data.messageId,
          conversationId: data.conversationId,
          inboxId: data.inboxId,
          chatId: data.chatId,
          text: data.text,
          replyToChannelMsgId: data.replyToChannelMsgId,
        },
        cfg,
        secrets,
        { db: app.db, log: app.log },
      );
    },
    10,
  );
  markFailedOnExhaust(telegramWorker, app, 'telegram');

  // Instagram + Messenger outbound via Twilio — share the sender, differ only in prefix.
  for (const [queueName, prefix] of [
    [QUEUE_NAMES.INSTAGRAM_OUTBOUND, 'instagram'],
    [QUEUE_NAMES.MESSENGER_OUTBOUND, 'messenger'],
  ] as const) {
    const twilioMetaWorker = app.queues.registerWorker<TwilioMetaOutboundJob>(
      queueName,
      async (job) => {
        const data = job.data;
        const [inbox] = await app.db
          .select()
          .from(schema.inboxes)
          .where(eq(schema.inboxes.id, data.inboxId))
          .limit(1);
        if (!inbox) throw new Error('inbox not found');
        const cfg = parseTwilioConfig(inbox.config);
        let secrets = parseTwilioSecrets({});
        if (inbox.secrets) {
          try {
            secrets = parseTwilioSecrets(decryptJSON(inbox.secrets));
          } catch (err) {
            app.log.error({ err, inboxId: inbox.id, prefix }, 'twilio worker: decrypt failed');
            throw err;
          }
        }
        const statusCallbackUrl = appConfig.PUBLIC_API_URL
          ? `${appConfig.PUBLIC_API_URL.replace(/\/$/, '')}/webhooks/${prefix}/${data.inboxId}/status`
          : null;
        await sendOutboundTwilio(
          prefix,
          {
            messageId: data.messageId,
            conversationId: data.conversationId,
            inboxId: data.inboxId,
            contactAddress: data.contactAddress,
            text: data.text,
            mediaUrl: data.mediaUrl,
          },
          cfg,
          secrets,
          statusCallbackUrl,
          { db: app.db, log: app.log },
        );
      },
      5,
    );
    markFailedOnExhaust(twilioMetaWorker, app, prefix);
  }

  // Media mirror worker — pulls inbound provider-hosted media (Twilio CDN
  // requires Basic Auth and rotates URLs hourly) into our R2 storage so the
  // browser can render it directly. Runs async so the inbound webhook can
  // ack in <300ms instead of waiting on download+upload (~500ms-2s sync).
  const mediaMirrorWorker = app.queues.registerWorker<MediaMirrorJob>(
    QUEUE_NAMES.MEDIA_MIRROR,
    async (job) => {
      const data = job.data;
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, data.inboxId))
        .limit(1);
      if (!inbox) throw new Error('inbox not found');

      const cfg = parseWhatsAppConfig(inbox.config);
      if (!cfg.accountSid) throw new Error('inbox missing twilio accountSid');

      let secrets;
      try {
        secrets = parseWhatsAppSecrets(inbox.secrets ? decryptJSON(inbox.secrets) : {});
      } catch (err) {
        app.log.error({ err, inboxId: inbox.id }, 'media mirror: cannot decrypt secrets');
        throw err;
      }
      if (!secrets.authToken) throw new Error('inbox missing twilio authToken');

      const finalUrl = await mirrorTwilioMedia({
        twilioUrl: data.twilioUrl,
        mimeType: data.mimeType ?? undefined,
        accountId: data.accountId,
        twilioAccountSid: cfg.accountSid,
        twilioAuthToken: secrets.authToken,
      });

      // Single atomic update — if the worker crashes between two writes the
      // row would land with the new URL but stuck in mediaPending=true and
      // BullMQ retry would burn a fresh R2 object. The `-` jsonb operator
      // strips the pending key without clobbering siblings.
      await app.db
        .update(schema.messages)
        .set({
          mediaUrl: finalUrl,
          mediaMimeType: data.mimeType ?? undefined,
          metadata: sql`${schema.messages.metadata} - 'mediaPending'`,
        })
        .where(eq(schema.messages.id, data.messageId));

      eventBus.emitEvent({
        type: 'message.media-ready',
        inboxId: data.inboxId,
        conversationId: data.conversationId,
        messageId: data.messageId,
        mediaUrl: finalUrl,
        mediaMimeType: data.mimeType ?? null,
      });
    },
    5,
  );
  mediaMirrorWorker.on('failed', (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 5;
    if (job.attemptsMade < maxAttempts) return;
    // All retries exhausted — drop the pending flag and stamp a failure
    // breadcrumb so the front can render a "mídia indisponível" hint
    // instead of spinning forever. Empty mediaUrl on the WS payload is
    // the failure sentinel for open clients.
    void app.db
      .update(schema.messages)
      .set({
        metadata: sql`(${schema.messages.metadata} - 'mediaPending') || jsonb_build_object('mediaMirrorFailed', true)`,
      })
      .where(eq(schema.messages.id, job.data.messageId))
      .then(() => {
        eventBus.emitEvent({
          type: 'message.media-ready',
          inboxId: job.data.inboxId,
          conversationId: job.data.conversationId,
          messageId: job.data.messageId,
          mediaUrl: '',
          mediaMimeType: job.data.mimeType ?? null,
        });
      })
      .catch((e) => {
        app.log.error(
          { err: e, messageId: job.data.messageId },
          'media mirror: failed-to-mark-failed',
        );
      });
    app.log.warn(
      { err: err.message, messageId: job.data.messageId, attempts: job.attemptsMade },
      'media mirror: retries exhausted',
    );
  });

  registerSnoozeWorker(app);
  registerScheduledMessageWorker(app, dispatchOutbound);
  registerWebhookWorker(app);
  registerCampaignWorkers(app);
  registerGmailSyncWorker(app);

  app.log.info('queue workers registered');
}
