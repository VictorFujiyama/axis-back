import type { FastifyInstance } from 'fastify';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { dispatchOutbound } from '../messages/routes';

/**
 * Bot reply outbound bridge.
 *
 * Built-in bots (and bot-respond endpoint) insert bot messages directly via
 * `insertBotMessage`, which emits `message.created` on the event bus but does
 * NOT enqueue the channel outbound job. Without this, bot replies live only
 * in the DB (visible in the Axis UI) but never reach the customer via
 * WhatsApp/Telegram/Email.
 *
 * This hook listens for `message.created` with senderType === 'bot' and
 * calls the existing `dispatchOutbound` to enqueue the right channel job.
 */
export function registerBotOutboundHook(app: FastifyInstance): void {
  eventBus.onEvent(async (event: RealtimeEvent) => {
    if (event.type !== 'message.created') return;
    if (event.message.senderType !== 'bot') return;
    try {
      await dispatchOutbound(app, event.conversationId, event.message.id);
    } catch (err) {
      app.log.warn(
        { err, conversationId: event.conversationId, messageId: event.message.id },
        'bot-outbound-hook: dispatchOutbound failed',
      );
    }
  });
}
