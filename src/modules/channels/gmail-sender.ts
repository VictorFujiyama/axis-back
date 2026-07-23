import type { FastifyBaseLogger } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus.js';
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
  messageId?: string;
  threadingHints?: ThreadingHints;
}

/**
 * Codifica um valor para caber num cabeçalho RFC 5322 (que é 7-bit ASCII).
 * ASCII puro passa direto; qualquer não-ASCII vira encoded-word RFC 2047
 * (`=?UTF-8?B?<base64>?=`). Sem isso, o assunto com acento saía cru no header
 * e o cliente de e-mail interpretava os bytes UTF-8 como latin1 — o clássico
 * "Construção" → "ConstruÃƒÂ§ÃƒÂ£o". O corpo não sofria porque tem
 * `Content-Type: charset=UTF-8`; cabeçalho não tem esse mecanismo.
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

function formatFrom(addr: ComposeMimeFrom): string {
  if (addr.name && addr.name.length > 0) {
    // Nome ASCII vira quoted-string; com acento vira encoded-word RFC 2047
    // (sem aspas — encoded-word não pode ficar dentro de quoted-string).
    // eslint-disable-next-line no-control-regex
    const display = /^[\x00-\x7F]*$/.test(addr.name)
      ? `"${escapeQuoted(addr.name)}"`
      : encodeHeaderValue(addr.name);
    return `${display} <${addr.email}>`;
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
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  // Truthy guard — empty string silently drops the header. Callers must
  // generate a valid non-empty RFC 5322 msg-id (see RFC_MSG_ID_DOMAIN
  // construction in sendViaGmail).
  if (opts.messageId) {
    lines.push(`Message-ID: ${opts.messageId}`);
  }
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

/** RFC 5322 Message-ID domain. Se um dia mudar de domain principal, este valor
 *  vira opaque token compat porque o Message-ID vira reverse-lookup por uuid. */
const RFC_MSG_ID_DOMAIN = 'axisbrasil.ai';

export type GmailSendOutcome =
  | { kind: 'delivered'; httpStatus: 200 }
  | { kind: 'reauth-required'; httpStatus: 401 }
  | { kind: 'recipient-rejected'; httpStatus: number; reason: string }
  | { kind: 'inbox-throttled'; httpStatus: 403 | 429; reason: string }
  | { kind: 'transient'; httpStatus: number; reason: string };

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
  /**
   * Called once per terminal Gmail send result so the worker can update Redis
   * cap state (release / pause / track success). Best-effort: invoked AFTER
   * DB writes have settled but before the function returns. The 5xx path
   * throws before invoking (no result to classify yet).
   */
  onSendResult?: (outcome: GmailSendOutcome) => Promise<void> | void;
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

  const rfcMessageId = `<${input.messageId}@${RFC_MSG_ID_DOMAIN}>`;

  const mime = composeMimeRfc5322({
    from: { email: gmailEmail, name: fromName },
    to: input.contactEmail,
    subject: input.subject,
    body: input.text,
    messageId: rfcMessageId,
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
    error?: { code?: number; message?: string; status?: string };
  };

  if (res.ok) {
    const deliveredAt = new Date();
    // Convention: camelCase for Gmail-native fields (mirrors gmail-parse.ts
    // inbound side); Atlas-native stampings (`atlas_journey_run_id`,
    // `atlas_node_id`) live in the same JSONB blob but use snake_case
    // (matches upsert_and_send in atlas-mcp/tools.ts). Mixed casing is
    // intentional per-provider — do not normalize without touching both sides.
    const gmailPatch = { gmailMessageId: data.id, gmailThreadId: data.threadId };
    await db
      .update(schema.messages)
      .set({
        channelMsgId: rfcMessageId,
        metadata: sql`COALESCE(${schema.messages.metadata}, '{}'::jsonb) || ${JSON.stringify(gmailPatch)}::jsonb`,
        deliveredAt,
      })
      .where(eq(schema.messages.id, input.messageId));
    // Notify open clients so the "sending" spinner clears without a refresh.
    // Twilio-side channels emit on the status callback; for HTTP-only sends
    // (Gmail, Postmark) the sender owns the broadcast.
    eventBus.emitEvent({
      type: 'message.updated',
      inboxId: input.inboxId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      changes: { deliveredAt },
    });
    await deps.onSendResult?.({ kind: 'delivered', httpStatus: 200 });
    return;
  }

  // 401 Unauthorized after a freshly-resolved access token means the refresh
  // token itself is no longer trusted by Google (revoked, scopes pulled,
  // account suspended). Flip `needsReauth` so the UI surfaces the banner
  // and permanently fail the message — BullMQ must NOT retry a credential
  // problem.
  if (res.status === 401) {
    const patchedConfig = { ...(config as GmailConfig), needsReauth: true };
    await db
      .update(schema.inboxes)
      .set({ config: patchedConfig, updatedAt: new Date() })
      .where(eq(schema.inboxes.id, input.inboxId));
    await db
      .update(schema.messages)
      .set({
        failedAt: new Date(),
        failureReason: 'gmail oauth expired — reauthorize',
      })
      .where(eq(schema.messages.id, input.messageId));
    log.error(
      { inboxId: input.inboxId, status: 401 },
      'gmail.send: 401 — needsReauth set, message marked failed',
    );
    await deps.onSendResult?.({ kind: 'reauth-required', httpStatus: 401 });
    return;
  }

  // Other 4xx (400 invalid argument, 403 forbidden, 404 not found, …) are
  // permanent failures: mark the message and stop. Reason prefers Google's
  // error.message so agents can see the actual problem; falls back to
  // `gmail <status>` when the body is empty or non-JSON.
  if (res.status >= 400 && res.status < 500) {
    const reason = data.error?.message ?? `gmail ${res.status}`;
    await db
      .update(schema.messages)
      .set({ failedAt: new Date(), failureReason: reason })
      .where(eq(schema.messages.id, input.messageId));
    log.error(
      { inboxId: input.inboxId, status: res.status, data },
      'gmail.send: 4xx (permanent)',
    );
    // 403 (forbidden — typically inbox-level: scope revoked, quota policy)
    // and 429 (rate-limited at the project or inbox) consume capacity that
    // should be returned to the day's bucket — the slot wasn't a real send.
    // Everything else (400 invalid recipient, 404, …) is a recipient/payload
    // problem and the slot is consumed legitimately.
    const isInboxLevel = res.status === 403 || res.status === 429;
    if (isInboxLevel) {
      await deps.onSendResult?.({
        kind: 'inbox-throttled',
        httpStatus: res.status as 403 | 429,
        reason,
      });
    } else {
      await deps.onSendResult?.({
        kind: 'recipient-rejected',
        httpStatus: res.status,
        reason,
      });
    }
    return;
  }

  // 5xx — transient. Throw so BullMQ retries with the configured backoff.
  log.warn(
    { inboxId: input.inboxId, status: res.status, data },
    'gmail.send: 5xx — will retry',
  );
  throw new Error(`gmail ${res.status}: ${data.error?.message ?? 'server error'}`);
}
