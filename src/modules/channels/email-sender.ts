import type { FastifyBaseLogger } from 'fastify';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DB } from '@blossom/db';

const EmailSecretsSchema = z
  .object({ serverToken: z.string().min(1).optional() })
  .passthrough();

const EmailConfigSchema = z
  .object({
    fromEmail: z.string().email().optional(),
    fromName: z.string().min(1).max(120).optional(),
    defaultBotId: z.string().uuid().optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .passthrough();

type EmailSecrets = z.infer<typeof EmailSecretsSchema>;
type EmailConfig = z.infer<typeof EmailConfigSchema>;

export function parseEmailConfig(raw: unknown): EmailConfig {
  return EmailConfigSchema.safeParse(raw).data ?? {};
}
export function parseEmailSecrets(raw: unknown): EmailSecrets {
  return EmailSecretsSchema.safeParse(raw).data ?? {};
}

/** Escapes RFC 5322 quoted-string for the From display name. */
function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

export interface SendEmailInput {
  messageId: string;
  conversationId: string;
  inboxId: string;
  contactEmail: string;
  subject: string;
  text: string;
}

interface SendDeps {
  db: DB;
  log: FastifyBaseLogger;
}

/**
 * Sends an outbound email via Postmark. Best-effort: failures are logged and
 * the message is marked as failed but the HTTP request still returns success
 * (the message is persisted regardless — that's what agents see).
 */
export async function sendViaPostmark(
  input: SendEmailInput,
  config: EmailConfig,
  secrets: EmailSecrets,
  inReplyToMessageId: string | null,
  { db, log }: SendDeps,
): Promise<void> {
  // Idempotency guard: if message was already delivered or marked as permanently failed,
  // skip — protects against BullMQ retry replay AND queue-replay-after-removeOnComplete.
  const [existing] = await db
    .select({
      deliveredAt: schema.messages.deliveredAt,
      failedAt: schema.messages.failedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, input.messageId))
    .limit(1);
  if (existing?.deliveredAt) {
    log.debug({ messageId: input.messageId }, 'email.send: already delivered, skip');
    return;
  }
  if (existing?.failedAt) {
    log.debug({ messageId: input.messageId }, 'email.send: terminally failed, skip');
    return;
  }

  // Permanent failures: missing config — record and DO NOT throw (no retry).
  if (!secrets.serverToken) {
    log.warn({ inboxId: input.inboxId }, 'email.send: no serverToken configured — skipping');
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: 'no serverToken configured' })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  if (!config.fromEmail) {
    log.warn({ inboxId: input.inboxId }, 'email.send: no fromEmail configured');
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: 'no fromEmail configured' })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  const from = config.fromName
    ? `"${escapeQuoted(config.fromName)}" <${config.fromEmail}>`
    : config.fromEmail;

  const body: Record<string, unknown> = {
    From: from,
    To: input.contactEmail,
    Subject: input.subject,
    TextBody: input.text,
    MessageStream: 'outbound',
  };
  if (inReplyToMessageId) {
    body.Headers = [
      { Name: 'In-Reply-To', Value: inReplyToMessageId },
      { Name: 'References', Value: inReplyToMessageId },
    ];
  }

  let res: Response;
  try {
    res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': secrets.serverToken,
        // Postmark dedup — same key returns same response, no double-send.
        'X-PM-Message-Id': input.messageId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Network/timeout = transient → throw so BullMQ retries.
    log.warn({ err, inboxId: input.inboxId }, 'email.send: network — will retry');
    throw err;
  }

  const data = (await res.json().catch(() => ({}))) as {
    MessageID?: string;
    Message?: string;
  };
  if (res.ok) {
    await db
      .update(schema.messages)
      .set({
        channelMsgId: data.MessageID ?? null,
        deliveredAt: new Date(),
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  // 4xx = permanent (auth, validation): mark failed, DO NOT retry.
  if (res.status >= 400 && res.status < 500) {
    log.error(
      { inboxId: input.inboxId, status: res.status, data },
      'email.send: postmark 4xx (permanent)',
    );
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: data.Message ?? `postmark ${res.status}`,
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }
  // 5xx = transient → throw so BullMQ retries.
  log.warn(
    { inboxId: input.inboxId, status: res.status, data },
    'email.send: postmark 5xx — will retry',
  );
  throw new Error(`postmark ${res.status}: ${data.Message ?? 'server error'}`);
}

export interface DispatchEmailDeps {
  db: DB;
  log: FastifyBaseLogger;
  /** Test seam — defaults to `sendViaPostmark` in production. */
  sendPostmarkImpl?: typeof sendViaPostmark;
}

function readProvider(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && 'provider' in raw) {
    const value = (raw as { provider?: unknown }).provider;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * Routes an outbound email send to the right provider based on `config.provider`.
 * Legacy inboxes (no `provider` field) and `'postmark'` route to Postmark.
 * `'gmail'` is reserved for T-48; until then it throws.
 */
export async function dispatchEmailSend(
  input: SendEmailInput,
  rawConfig: unknown,
  rawSecrets: unknown,
  inReplyToMessageId: string | null,
  deps: DispatchEmailDeps,
): Promise<void> {
  const provider = readProvider(rawConfig);

  if (provider === 'gmail') {
    throw new Error('dispatchEmailSend: gmail provider not implemented');
  }

  const config = parseEmailConfig(rawConfig);
  const secrets = parseEmailSecrets(rawSecrets);
  const send = deps.sendPostmarkImpl ?? sendViaPostmark;
  return send(input, config, secrets, inReplyToMessageId, { db: deps.db, log: deps.log });
}

/**
 * Returns the last inbound (from=contact) channel message id in a conversation,
 * used for threading outbound replies via In-Reply-To.
 *
 * Single-row indexed lookup — does NOT load the whole conversation.
 */
export async function lastInboundChannelMsgId(
  db: DB,
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ channelMsgId: schema.messages.channelMsgId })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.senderType, 'contact'),
        isNotNull(schema.messages.channelMsgId),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);
  return row?.channelMsgId ?? null;
}

export type { EmailSecrets, EmailConfig };
