import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { decryptJSON } from '../crypto';
import { QUEUE_NAMES, type BotDispatchJob, type EmailOutboundJob, type WhatsAppOutboundJob, type TelegramOutboundJob, type TwilioMetaOutboundJob } from './index';
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
  sendOutboundEmail,
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
import { config as appConfig } from '../config';

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
  app.queues.registerWorker<EmailOutboundJob>(
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
      await sendOutboundEmail(
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

  // WhatsApp outbound worker
  app.queues.registerWorker<WhatsAppOutboundJob>(
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

  // Telegram outbound worker
  app.queues.registerWorker<TelegramOutboundJob>(
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

  // Instagram + Messenger outbound via Twilio — share the sender, differ only in prefix.
  for (const [queueName, prefix] of [
    [QUEUE_NAMES.INSTAGRAM_OUTBOUND, 'instagram'],
    [QUEUE_NAMES.MESSENGER_OUTBOUND, 'messenger'],
  ] as const) {
    app.queues.registerWorker<TwilioMetaOutboundJob>(
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
  }

  registerSnoozeWorker(app);
  registerScheduledMessageWorker(app, dispatchOutbound);
  registerWebhookWorker(app);
  registerCampaignWorkers(app);

  app.log.info('queue workers registered');
}
