import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';
import { config as appConfig } from '../../config';

const WhatsAppSecretsSchema = z
  .object({ authToken: z.string().min(1).optional() })
  .passthrough();

const WhatsAppConfigSchema = z
  .object({
    // 'twilio' is the only supported provider today. 'cloud' (WhatsApp Business
    // Cloud API via Meta) is collected by the UI but not implemented here yet.
    provider: z.enum(['twilio', 'cloud']).optional().default('twilio'),
    accountSid: z.string().min(1).optional(),
    fromNumber: z.string().min(1).optional(),
    messagingServiceSid: z.string().min(1).optional(),
    defaultBotId: z.string().uuid().optional(),
  })
  .passthrough();

type WhatsAppSecrets = z.infer<typeof WhatsAppSecretsSchema>;
type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;

export function parseWhatsAppConfig(raw: unknown): WhatsAppConfig {
  const result = WhatsAppConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  // Fallback to defaults when input is garbage (null, undefined, primitive).
  return WhatsAppConfigSchema.parse({});
}
export function parseWhatsAppSecrets(raw: unknown): WhatsAppSecrets {
  return WhatsAppSecretsSchema.safeParse(raw).data ?? {};
}

export interface SendWhatsAppInput {
  messageId: string;
  conversationId: string;
  inboxId: string;
  contactPhone: string;
  text: string;
  mediaUrl?: string | null;
}

interface SendDeps {
  db: DB;
  log: FastifyBaseLogger;
}

/** Normalize phone into Twilio's `whatsapp:+E164` format. Accepts already-prefixed. */
function toWhatsAppAddress(phone: string): string {
  if (phone.startsWith('whatsapp:')) return phone;
  const cleaned = phone.replace(/[^\d+]/g, '');
  const withPlus = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  return `whatsapp:${withPlus}`;
}

/**
 * Outbound WhatsApp via Twilio. Mirrors email-sender contract exactly:
 *   - Idempotency guard via deliveredAt/failedAt (protects BullMQ retry replay).
 *   - 4xx = permanent: mark failed, DO NOT throw.
 *   - 5xx / network = transient: throw, BullMQ retries.
 *   - On 201 from Twilio: stash `sid` as channelMsgId; `deliveredAt` is set later
 *     by the status callback, not here (Twilio acks = `queued`, not delivered).
 */
export async function sendOutboundWhatsApp(
  input: SendWhatsAppInput,
  config: WhatsAppConfig,
  secrets: WhatsAppSecrets,
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
  if (existing?.deliveredAt) {
    log.debug({ messageId: input.messageId }, 'whatsapp.send: already delivered, skip');
    return;
  }
  if (existing?.failedAt) {
    log.debug({ messageId: input.messageId }, 'whatsapp.send: terminally failed, skip');
    return;
  }
  if (existing?.channelMsgId) {
    // Already submitted to Twilio at least once; avoid double submission while awaiting status callback.
    log.debug(
      { messageId: input.messageId, channelMsgId: existing.channelMsgId },
      'whatsapp.send: already submitted, skip',
    );
    return;
  }

  if (config.provider && config.provider !== 'twilio') {
    log.warn(
      { inboxId: input.inboxId, provider: config.provider },
      'whatsapp.send: provider not supported by sender',
    );
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: `provider '${config.provider}' not supported (only 'twilio')`,
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  if (!secrets.authToken) {
    log.warn({ inboxId: input.inboxId }, 'whatsapp.send: no authToken configured');
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: 'no authToken configured' })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  if (!config.accountSid) {
    log.warn({ inboxId: input.inboxId }, 'whatsapp.send: no accountSid configured');
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: 'no accountSid configured' })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  if (!config.fromNumber && !config.messagingServiceSid) {
    log.warn({ inboxId: input.inboxId }, 'whatsapp.send: no fromNumber or messagingServiceSid');
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: 'no fromNumber or messagingServiceSid configured',
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  const toAddress = toWhatsAppAddress(input.contactPhone);
  const body = new URLSearchParams();
  body.set('To', toAddress);
  body.set('Body', input.text);
  if (config.messagingServiceSid) {
    body.set('MessagingServiceSid', config.messagingServiceSid);
  } else if (config.fromNumber) {
    body.set('From', toWhatsAppAddress(config.fromNumber));
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
    log.warn({ err, inboxId: input.inboxId }, 'whatsapp.send: network — will retry');
    throw err;
  }

  const data = (await res.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
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
    // Log only safe fields — the `data` blob from Twilio may echo back the
    // contact's phone/Body (PII) or future fields we don't expect.
    log.error(
      { inboxId: input.inboxId, status: res.status, twilioCode: data.code, twilioMessage: data.message },
      'whatsapp.send: twilio 4xx (permanent)',
    );
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: data.message ?? `twilio ${res.status}`,
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  log.warn(
    { inboxId: input.inboxId, status: res.status, twilioCode: data.code, twilioMessage: data.message },
    'whatsapp.send: twilio 5xx — will retry',
  );
  throw new Error(`twilio ${res.status}: ${data.message ?? 'server error'}`);
}

export type { WhatsAppSecrets, WhatsAppConfig };
