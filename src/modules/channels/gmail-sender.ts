import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import type { GmailConfig } from './gmail-config.js';
import type { SendEmailInput } from './email-sender.js';

export interface ComposeMimeFrom {
  email: string;
  name?: string;
}

export interface ThreadingHints {
  inReplyTo?: string;
  references?: string;
}

export interface ComposeMimeOptions {
  from: ComposeMimeFrom;
  to: string;
  subject: string;
  body: string;
  threadingHints?: ThreadingHints;
}

function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

function formatFrom(addr: ComposeMimeFrom): string {
  if (addr.name && addr.name.length > 0) {
    return `"${escapeQuoted(addr.name)}" <${addr.email}>`;
  }
  return addr.email;
}

/**
 * Build an RFC 5322 MIME message for outbound Gmail send.
 * UTF-8 plain text only — sufficient for the auto-quote-on-reply contract; no
 * HTML, no multipart, no attachments. Headers use CRLF line endings as required
 * by RFC 5322 § 2.1.
 */
export function composeMimeRfc5322(opts: ComposeMimeOptions): string {
  const lines: string[] = [
    `From: ${formatFrom(opts.from)}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (opts.threadingHints?.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.threadingHints.inReplyTo}`);
  }
  if (opts.threadingHints?.references) {
    lines.push(`References: ${opts.threadingHints.references}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${opts.body}`;
}

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const FETCH_TIMEOUT_MS = 15_000;

export interface SendGmailDeps {
  db: DB;
  log: FastifyBaseLogger;
  /**
   * Resolves a fresh Gmail access token. Production wraps `getValidAccessToken`
   * (closing over `app` + the inbox row) so the sender stays decoupled from
   * the Redis lock + DB rotation that lives inside the token module.
   */
  getAccessToken: () => Promise<string>;
  /** Override `fetch` for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Sends an outbound email via the Gmail REST API. Idempotency mirrors Postmark:
 * pre-check `messages.deliveredAt` / `failedAt`; on 200 stash the Gmail message
 * id as `channelMsgId` and set `deliveredAt`. Error policy (401/4xx/5xx) is
 * layered on in T-46.
 */
export async function sendViaGmail(
  input: SendEmailInput,
  config: GmailConfig | Record<string, never>,
  inReplyToMessageId: string | null,
  threadId: string | null,
  deps: SendGmailDeps,
): Promise<void> {
  const { db, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const [existing] = await db
    .select({
      deliveredAt: schema.messages.deliveredAt,
      failedAt: schema.messages.failedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, input.messageId))
    .limit(1);
  if (existing?.deliveredAt) {
    log.debug({ messageId: input.messageId }, 'gmail.send: already delivered, skip');
    return;
  }
  if (existing?.failedAt) {
    log.debug({ messageId: input.messageId }, 'gmail.send: terminally failed, skip');
    return;
  }

  const accessToken = await deps.getAccessToken();

  const gmailEmail = (config as GmailConfig).gmailEmail;
  const fromName = (config as GmailConfig).fromName;
  if (!gmailEmail) {
    log.warn({ inboxId: input.inboxId }, 'gmail.send: no gmailEmail configured');
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: 'no gmailEmail configured' })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  const mime = composeMimeRfc5322({
    from: { email: gmailEmail, name: fromName },
    to: input.contactEmail,
    subject: input.subject,
    body: input.text,
    threadingHints: inReplyToMessageId
      ? { inReplyTo: inReplyToMessageId, references: inReplyToMessageId }
      : undefined,
  });
  const raw = Buffer.from(mime, 'utf8').toString('base64url');

  const body: Record<string, unknown> = { raw };
  if (threadId) body.threadId = threadId;

  const res = await fetchImpl(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
  };

  if (res.ok) {
    await db
      .update(schema.messages)
      .set({
        channelMsgId: data.id ?? null,
        deliveredAt: new Date(),
      })
      .where(eq(schema.messages.id, input.messageId));
    return;
  }

  // Non-2xx error policy lands in T-46. Until then, surface as a generic throw
  // so BullMQ retries (no permanent-fail path is wired yet).
  throw new Error(`gmail ${res.status}`);
}
