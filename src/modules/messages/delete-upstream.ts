import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import {
  deleteTelegramMessage,
  parseTelegramConfig,
  parseTelegramSecrets,
} from '../channels/telegram-sender';

interface Capability {
  /** True if this channel supports deleting for everyone at all. */
  supported: boolean;
  /** Optional: max age in milliseconds after which the upstream provider refuses. */
  maxAgeMs?: number;
  /** Short human-readable reason when `supported: false`. */
  reason?: string;
}

// 48h — Telegram Bot API deleteMessage window for bot-sent messages.
const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Describes what "delete for everyone" means per channel. Kept in one place so
 * frontend and backend share the same source of truth (re-exported via a small
 * public shape in the API response).
 */
export function deleteCapabilityForChannel(channelType: string): Capability {
  switch (channelType) {
    case 'webchat':
      // The widget fetches from our own DB; soft-deleting on our side IS the
      // upstream delete. No time limit.
      return { supported: true };
    case 'telegram':
      return { supported: true, maxAgeMs: TELEGRAM_DELETE_WINDOW_MS };
    default:
      // Email/SMS can't be recalled. Twilio WhatsApp/IG/Messenger don't expose
      // a delete endpoint. API channel: up to the integrator — not ours to call.
      return { supported: false, reason: 'channel does not support upstream deletion' };
  }
}

/**
 * Calls the channel provider to remove the message from the customer's side.
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` when the
 * provider refused (out-of-window, already deleted, etc).
 * Throws only on genuine backend errors the caller should log.
 */
export async function deleteMessageUpstream(
  app: FastifyInstance,
  messageId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await app.db
    .select({
      channelMsgId: schema.messages.channelMsgId,
      inboxId: schema.messages.inboxId,
      conversationId: schema.messages.conversationId,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  if (!row) return { ok: false, reason: 'message not found' };

  const [inbox] = await app.db
    .select()
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, row.inboxId))
    .limit(1);
  if (!inbox) return { ok: false, reason: 'inbox not found' };

  const cap = deleteCapabilityForChannel(inbox.channelType);
  if (!cap.supported) return { ok: false, reason: cap.reason ?? 'unsupported channel' };
  if (cap.maxAgeMs && Date.now() - row.createdAt.getTime() > cap.maxAgeMs) {
    return { ok: false, reason: 'message is older than the channel allows' };
  }

  switch (inbox.channelType) {
    case 'webchat':
      // The soft-delete done by the caller is already visible to the visitor
      // on the next widget fetch — nothing more to do here.
      return { ok: true };

    case 'telegram': {
      if (!row.channelMsgId) {
        // Message never reached the channel (e.g. still queued or failed) —
        // nothing to recall.
        return { ok: true };
      }
      const cfg = parseTelegramConfig(inbox.config);
      const secrets = inbox.secrets
        ? parseTelegramSecrets(decryptJSON(inbox.secrets))
        : parseTelegramSecrets({});
      // chat_id for Telegram = the contact's channel identifier.
      const [ci] = await app.db
        .select({ identifier: schema.contactIdentities.identifier })
        .from(schema.contactIdentities)
        .innerJoin(
          schema.conversations,
          eq(schema.conversations.contactId, schema.contactIdentities.contactId),
        )
        .where(
          and(
            eq(schema.conversations.id, row.conversationId),
            eq(schema.contactIdentities.channel, 'telegram'),
          ),
        )
        .limit(1);
      if (!ci?.identifier) return { ok: false, reason: 'contact chat_id not found' };
      return deleteTelegramMessage(
        { chatId: ci.identifier, channelMsgId: row.channelMsgId, inboxId: row.inboxId },
        cfg,
        secrets,
        { log: app.log },
      );
    }

    default:
      return { ok: false, reason: 'unsupported channel' };
  }
}
