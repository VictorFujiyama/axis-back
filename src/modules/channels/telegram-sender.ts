import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';

const TelegramSecretsSchema = z
  .object({
    botToken: z.string().min(1).optional(),
    /** Optional X-Telegram-Bot-Api-Secret-Token value; set on setWebhook. */
    webhookSecret: z.string().min(1).optional(),
  })
  .passthrough();

const TelegramConfigSchema = z
  .object({
    apiBase: z.string().url().optional(),
    defaultBotId: z.string().uuid().optional(),
  })
  .passthrough();

type TelegramSecrets = z.infer<typeof TelegramSecretsSchema>;
type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

export function parseTelegramConfig(raw: unknown): TelegramConfig {
  return TelegramConfigSchema.safeParse(raw).data ?? {};
}
export function parseTelegramSecrets(raw: unknown): TelegramSecrets {
  return TelegramSecretsSchema.safeParse(raw).data ?? {};
}

export interface SendTelegramInput {
  messageId: string;
  conversationId: string;
  inboxId: string;
  /** Telegram chat id (contact identifier on this channel). */
  chatId: string;
  text: string;
  replyToChannelMsgId?: string | null;
}

interface SendDeps {
  db: DB;
  log: FastifyBaseLogger;
}

/**
 * Outbound to Telegram. Same retry contract as email/whatsapp:
 *  - 4xx terminal
 *  - 5xx/network re-queued by BullMQ
 *  - Success: stashes `result.message_id` as channelMsgId and sets deliveredAt
 *    (Telegram has no per-message delivered/read webhook — ack == delivered).
 */
export async function sendOutboundTelegram(
  input: SendTelegramInput,
  config: TelegramConfig,
  secrets: TelegramSecrets,
  { db, log }: SendDeps,
): Promise<void> {
  const [existing] = await db
    .select({
      deliveredAt: schema.messages.deliveredAt,
      failedAt: schema.messages.failedAt,
      channelMsgId: schema.messages.channelMsgId,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, input.messageId))
    .limit(1);
  if (existing?.deliveredAt || existing?.failedAt || existing?.channelMsgId) {
    log.debug({ messageId: input.messageId }, 'telegram.send: already handled, skip');
    return;
  }

  if (!secrets.botToken) {
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: 'no botToken configured' })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  const apiBase = (config.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
  const url = `${apiBase}/bot${encodeURIComponent(secrets.botToken)}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
  };
  if (input.replyToChannelMsgId) {
    const asNumber = Number(input.replyToChannelMsgId);
    if (Number.isFinite(asNumber)) {
      body.reply_to_message_id = asNumber;
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn({ err, inboxId: input.inboxId }, 'telegram.send: network — will retry');
    throw err;
  }

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
    error_code?: number;
  };

  if (res.ok && data.ok && data.result?.message_id) {
    await db
      .update(schema.messages)
      .set({
        channelMsgId: String(data.result.message_id),
        deliveredAt: new Date(),
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  if (res.status >= 400 && res.status < 500) {
    log.error(
      { inboxId: input.inboxId, status: res.status, code: data.error_code, description: data.description },
      'telegram.send: 4xx (permanent)',
    );
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: data.description ?? `telegram ${res.status}`,
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  throw new Error(`telegram ${res.status}: ${data.description ?? 'server error'}`);
}

export type { TelegramSecrets, TelegramConfig };
