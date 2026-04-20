import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';
import { config as appConfig } from '../../config';

/**
 * Shared Twilio send for WhatsApp/Instagram/Messenger. Twilio's REST accepts
 * all three on the same `/Messages.json` endpoint — only the `From`/`To`
 * prefix changes (`whatsapp:`, `instagram:`, `messenger:`).
 */

export const TwilioSecretsSchema = z
  .object({ authToken: z.string().min(1).optional() })
  .passthrough();

export const TwilioConfigSchema = z
  .object({
    accountSid: z.string().min(1).optional(),
    fromNumber: z.string().min(1).optional(),
    messagingServiceSid: z.string().min(1).optional(),
    defaultBotId: z.string().uuid().optional(),
  })
  .passthrough();

export type TwilioSecrets = z.infer<typeof TwilioSecretsSchema>;
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;

export interface SendTwilioInput {
  messageId: string;
  conversationId: string;
  inboxId: string;
  contactAddress: string;
  text: string;
  mediaUrl?: string | null;
}

interface SendDeps {
  db: DB;
  log: FastifyBaseLogger;
}

function toTwilioAddress(prefix: string, value: string): string {
  if (value.startsWith(`${prefix}:`)) return value;
  const cleaned = value.replace(/[^\d+A-Za-z_-]/g, '');
  // WhatsApp wants +E164; Instagram/Messenger use opaque IDs (numeric).
  const payload = prefix === 'whatsapp'
    ? (cleaned.startsWith('+') ? cleaned : `+${cleaned}`)
    : cleaned;
  return `${prefix}:${payload}`;
}

/** Idempotency + retry contract identical to email-sender. */
export async function sendOutboundTwilio(
  prefix: 'whatsapp' | 'instagram' | 'messenger',
  input: SendTwilioInput,
  config: TwilioConfig,
  secrets: TwilioSecrets,
  statusCallbackUrl: string | null,
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
    log.debug({ messageId: input.messageId, prefix }, 'twilio.send: already handled');
    return;
  }
  if (!secrets.authToken || !config.accountSid) {
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: !secrets.authToken ? 'no authToken' : 'no accountSid',
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  if (!config.fromNumber && !config.messagingServiceSid) {
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: 'no fromNumber or messagingServiceSid',
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  const body = new URLSearchParams();
  body.set('To', toTwilioAddress(prefix, input.contactAddress));
  body.set('Body', input.text);
  if (config.messagingServiceSid) {
    body.set('MessagingServiceSid', config.messagingServiceSid);
  } else if (config.fromNumber) {
    body.set('From', toTwilioAddress(prefix, config.fromNumber));
  }
  if (input.mediaUrl) body.append('MediaUrl', input.mediaUrl);
  if (statusCallbackUrl) body.set('StatusCallback', statusCallbackUrl);

  const basicAuth = Buffer.from(`${config.accountSid}:${secrets.authToken}`).toString('base64');
  const url = `${appConfig.TWILIO_API_URL}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn({ err, inboxId: input.inboxId, prefix }, 'twilio.send: network — retry');
    throw err;
  }
  const data = (await res.json().catch(() => ({}))) as {
    sid?: string;
    message?: string;
    code?: number;
  };
  if (res.ok) {
    await db
      .update(schema.messages)
      .set({ channelMsgId: data.sid ?? null })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  if (res.status >= 400 && res.status < 500) {
    log.error(
      { inboxId: input.inboxId, prefix, status: res.status, twilioCode: data.code, twilioMessage: data.message },
      'twilio.send: 4xx (permanent)',
    );
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: data.message ?? `twilio ${res.status}` })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  throw new Error(`twilio ${res.status}: ${data.message ?? 'server error'}`);
}

export function parseTwilioConfig(raw: unknown): TwilioConfig {
  return TwilioConfigSchema.safeParse(raw).data ?? {};
}
export function parseTwilioSecrets(raw: unknown): TwilioSecrets {
  return TwilioSecretsSchema.safeParse(raw).data ?? {};
}
