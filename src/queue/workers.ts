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
import { dispatchEmailSend } from '../modules/channels/email-sender';
import {
  effectiveDailySendCap,
  effectiveTimezone,
  parseGmailConfig,
} from '../modules/channels/gmail-config';
import {
  BacklogFullError,
  computeDelayMs,
  enforceHardLimitAtWorker,
  enforceHardLimitForEnqueue,
  isInboxPaused,
  pauseInbox,
  releaseForInbox,
  reserveForInbox,
  trackBacklogJob,
  untrackBacklogJob,
} from '../modules/channels/inbox-send-cap';
import { getValidAccessToken } from '../modules/oauth/google/tokens';
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
import {
  subscribeAtlasEvents,
  emitMessageFailed,
  emitMessageSent,
} from '../modules/atlas-events/enqueue';
import {
  inboxOvercapTotal,
  inboxPausedTotal,
  inboxReleaseTotal,
  inboxSendCountTotal,
} from '../metrics';
import { registerAtlasEventsWorker } from '../modules/atlas-events/worker';
import { registerBotOutboundHook } from '../modules/bots/outbound-hook';
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
        // [marketing-T-09] Tell Atlas the send permanently failed (spec D11) so
        // its connector handler can suppress the contact (bounce/complaint, D12).
        // Fire-and-forget + fail-open inside emitMessageFailed — must not affect
        // the failed-marking above.
        void emitMessageFailed(app, {
          messageId: job.data.messageId,
          conversationId: job.data.conversationId,
          inboxId: job.data.inboxId,
          channel: label,
          failureReason,
          failedAt,
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
      await deliverBotWebhook(job.data, { db: app.db, log: app.log, redis: app.redis });
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
      let rawSecrets: unknown = {};
      if (inbox.secrets) {
        try {
          rawSecrets = decryptJSON(inbox.secrets);
        } catch (err) {
          app.log.error({ err, inboxId: inbox.id }, 'email worker: cannot decrypt secrets');
          throw err;
        }
      }

      const gmailConfig = parseGmailConfig(inbox.config);
      const cap = gmailConfig.provider === 'gmail' ? effectiveDailySendCap(gmailConfig) : null;
      const timezone = effectiveTimezone(gmailConfig);
      const source = data.source ?? 'manual';
      const nowMs = Date.now();

      // Cap path only applies to Gmail inboxes with a configured cap. Postmark
      // and Gmail-without-cap fall straight through to dispatchEmailSend.
      if (gmailConfig.provider === 'gmail' && cap != null) {
        // Hard limit (Check 2 of R0.4) — `messages.createdAt` is DB-time.
        const [msg] = await app.db
          .select({ createdAt: schema.messages.createdAt })
          .from(schema.messages)
          .where(eq(schema.messages.id, data.messageId))
          .limit(1);
        if (msg) {
          try {
            enforceHardLimitAtWorker(msg.createdAt.getTime(), nowMs);
          } catch (err) {
            if (err instanceof BacklogFullError) {
              const failedAt = new Date();
              const failureReason = 'backlog hard limit (14d) exceeded';
              await app.db
                .update(schema.messages)
                .set({ failedAt, failureReason })
                .where(eq(schema.messages.id, data.messageId));
              await untrackBacklogJob(app.redis, data.inboxId, job.id ?? '');
              void emitMessageFailed(app, {
                messageId: data.messageId,
                conversationId: data.conversationId,
                inboxId: data.inboxId,
                channel: 'email',
                failureReason,
                failedAt,
              });
              return;
            }
            throw err;
          }
        }

        // Pause check before reserve — paused inbox should never burn slots.
        // Worker enters with this check on retries too, so a cap-to-0 mid-flight
        // still parks the in-flight job rather than firing.
        if (await isInboxPaused(app.redis, data.inboxId)) {
          // Park indefinitely until resume runs promoteBacklog.
          await job.moveToDelayed(nowMs + 24 * 60 * 60 * 1000);
          if (job.id) await trackBacklogJob(app.redis, data.inboxId, job.id);
          return;
        }

        const outcome = await reserveForInbox(app.redis, {
          inboxId: data.inboxId,
          messageId: data.messageId,
          cap,
          timezone,
          nowMs,
        });
        if (outcome === 'paused') {
          await job.moveToDelayed(nowMs + 24 * 60 * 60 * 1000);
          if (job.id) await trackBacklogJob(app.redis, data.inboxId, job.id);
          return;
        }
        if (outcome === 'over-cap') {
          inboxOvercapTotal.inc();
          if (source === 'manual') {
            const failedAt = new Date();
            const failureReason = 'daily cap reached';
            await app.db
              .update(schema.messages)
              .set({ failedAt, failureReason })
              .where(eq(schema.messages.id, data.messageId));
            return;
          }
          // atlas-journey: park until next local midnight + jitter.
          const delay = computeDelayMs(timezone, nowMs);
          // Re-run Check 1 against the projected fire moment.
          if (msg) {
            try {
              enforceHardLimitForEnqueue(msg.createdAt.getTime(), nowMs, delay);
            } catch (err) {
              if (err instanceof BacklogFullError) {
                const failedAt = new Date();
                const failureReason = 'backlog hard limit (14d) exceeded';
                await app.db
                  .update(schema.messages)
                  .set({ failedAt, failureReason })
                  .where(eq(schema.messages.id, data.messageId));
                void emitMessageFailed(app, {
                  messageId: data.messageId,
                  conversationId: data.conversationId,
                  inboxId: data.inboxId,
                  channel: 'email',
                  failureReason,
                  failedAt,
                });
                return;
              }
              throw err;
            }
          }
          await job.moveToDelayed(nowMs + delay);
          if (job.id) await trackBacklogJob(app.redis, data.inboxId, job.id);
          return;
        }
        // 'ok' or 'reserved-already' — fall through to send.
      }

      await dispatchEmailSend(
        {
          messageId: data.messageId,
          conversationId: data.conversationId,
          inboxId: data.inboxId,
          contactEmail: data.contactEmail,
          subject: data.subject,
          text: data.text,
        },
        inbox.config,
        rawSecrets,
        data.inReplyToMessageId,
        {
          db: app.db,
          log: app.log,
          getGmailAccessToken: () => getValidAccessToken(app, inbox),
          // [marketing-T-10] Postmark 4xx bounce → tell Atlas (D11). The sender's
          // permanent-fail path returns normally (no throw), so the
          // markFailedOnExhaust `failed` handler never fires for it — this is the
          // emit site for in-sender permanent failures.
          onPermanentFailure: (p) => void emitMessageFailed(app, p),
          onGmailSendResult: async (outcome) => {
            // Slot accounting (Gmail with cap only):
            //  delivered          → keep slot (legit send), untrack from backlog, emit message.sent
            //  reauth-required    → release slot + pause inbox; backlog stays; emit message.failed
            //  inbox-throttled    → release slot (not a real send); emit message.failed
            //  recipient-rejected → keep slot (bad lead consumed the quota); emit message.failed
            //  transient (5xx)    → not invoked here (throws to BullMQ retry)
            const capActive = cap != null;
            const releaseInput = {
              inboxId: data.inboxId,
              messageId: data.messageId,
              timezone,
              reservedAtMs: nowMs,
            };
            if (outcome.kind === 'delivered') {
              if (capActive) inboxSendCountTotal.inc();
              if (capActive && job.id) {
                await untrackBacklogJob(app.redis, data.inboxId, job.id);
              }
              void emitMessageSent(app, {
                messageId: data.messageId,
                conversationId: data.conversationId,
                inboxId: data.inboxId,
                channel: 'email',
                deliveredAt: new Date(),
              });
            } else if (outcome.kind === 'reauth-required') {
              if (capActive) {
                await releaseForInbox(app.redis, releaseInput);
                await pauseInbox(app.redis, data.inboxId, 'needs-reauth');
                inboxReleaseTotal.inc();
                inboxPausedTotal.inc();
              }
              void emitMessageFailed(app, {
                messageId: data.messageId,
                conversationId: data.conversationId,
                inboxId: data.inboxId,
                channel: 'email',
                failureReason: 'gmail oauth expired — reauthorize',
                failedAt: new Date(),
              });
            } else if (outcome.kind === 'inbox-throttled') {
              if (capActive) {
                await releaseForInbox(app.redis, releaseInput);
                inboxReleaseTotal.inc();
              }
              void emitMessageFailed(app, {
                messageId: data.messageId,
                conversationId: data.conversationId,
                inboxId: data.inboxId,
                channel: 'email',
                failureReason: outcome.reason,
                failedAt: new Date(),
              });
            } else if (outcome.kind === 'recipient-rejected') {
              void emitMessageFailed(app, {
                messageId: data.messageId,
                conversationId: data.conversationId,
                inboxId: data.inboxId,
                channel: 'email',
                failureReason: outcome.reason,
                failedAt: new Date(),
              });
            }
          },
        },
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
        {
          db: app.db,
          log: app.log,
          onPermanentFailure: (p) => void emitMessageFailed(app, p),
        },
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
          {
            db: app.db,
            log: app.log,
            onPermanentFailure: (p) => void emitMessageFailed(app, p),
          },
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
  subscribeAtlasEvents(app);
  registerAtlasEventsWorker(app);
  registerBotOutboundHook(app);

  app.log.info('queue workers registered');
}
