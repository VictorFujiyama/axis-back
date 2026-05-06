import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';

import { parseGmailConfig } from '../../modules/channels/gmail-config.js';
import {
  downloadGmailAttachmentSafe,
  uploadGmailAttachment,
} from '../../modules/channels/gmail-attachments.js';
import {
  parseGmailMessage,
  type GmailMessage,
  type ParsedGmailAttachment,
} from '../../modules/channels/gmail-parse.js';
import { type IncomingMessage } from '../../modules/channels/helpers.js';
import { ingestWithHooks } from '../../modules/channels/post-ingest.js';
import {
  getValidAccessToken,
  type GmailInboxLike,
} from '../../modules/oauth/google/tokens.js';

import { QUEUE_NAMES, type GmailSyncJob } from '../index.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const FETCH_TIMEOUT_MS = 15_000;
/** Spec § "Sync worker / Bootstrap path": unread messages from the last 7 days. */
const BOOTSTRAP_QUERY = 'is:unread newer_than:7d';
const BOOTSTRAP_MAX_RESULTS = 50;

interface GmailMessageListEntry {
  id: string;
  threadId: string;
}

interface GmailMessageListResponse {
  messages?: GmailMessageListEntry[];
  resultSizeEstimate?: number;
  nextPageToken?: string;
}

interface GmailHistoryListResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{
      message: { id: string; threadId: string; labelIds?: string[] };
    }>;
  }>;
  historyId?: string;
  nextPageToken?: string;
}

export type DownloadAttachmentImpl = (
  messageId: string,
  attachment: ParsedGmailAttachment,
  accessToken: string,
) => Promise<Buffer | null>;

export type UploadAttachmentImpl = (
  buffer: Buffer,
  filename: string,
  mimeType: string,
  accountId: string,
) => Promise<string>;

export interface ProcessGmailSyncJobDeps {
  /** Override `fetch` for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override `getValidAccessToken` for testing. */
  getAccessToken?: (
    app: FastifyInstance,
    inbox: GmailInboxLike,
  ) => Promise<string>;
  /** Override `ingestWithHooks` for testing. Production uses the real helper. */
  ingest?: typeof ingestWithHooks;
  /** Override the attachment download (used by tests / future polyfills).
   * Defaults to `downloadGmailAttachmentSafe`, which enforces the 25 MB cap. */
  downloadAttachment?: DownloadAttachmentImpl;
  /** Override the R2 upload. Defaults to `uploadGmailAttachment`. */
  uploadAttachment?: UploadAttachmentImpl;
}

/**
 * Issues `users.messages.list` with the spec § "Sync worker / Bootstrap path"
 * query and returns the listed `(id, threadId)` pairs. Empty list returns `[]`.
 * Throws on any non-2xx so BullMQ can retry — Gmail rate-limit / transient
 * errors all benefit from the queue's exponential backoff.
 */
async function listBootstrapMessages(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<GmailMessageListEntry[]> {
  const url = new URL(`${GMAIL_API_BASE}/users/me/messages`);
  url.searchParams.set('q', BOOTSTRAP_QUERY);
  url.searchParams.append('labelIds', 'INBOX');
  url.searchParams.set('maxResults', String(BOOTSTRAP_MAX_RESULTS));

  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gmail messages.list ${res.status}`);
  }
  const body = (await res.json()) as GmailMessageListResponse;
  return body.messages ?? [];
}

/**
 * Fetches a single Gmail message in `format=full`. The body is intentionally
 * returned untyped — T-35 wires `parseGmailMessage` against it; for now this
 * function only proves the per-message round-trip in the bootstrap branch.
 */
async function fetchFullGmailMessage(
  messageId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<GmailMessage> {
  const url = new URL(
    `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set('format', 'full');

  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gmail messages.get ${res.status}`);
  }
  return (await res.json()) as GmailMessage;
}

/**
 * Calls `users.getProfile` to read the current per-mailbox `historyId`. We
 * persist this value at the end of a bootstrap run so the next iteration can
 * use the incremental `users.history.list` path instead of re-listing
 * `is:unread newer_than:7d`. Throws on non-2xx so BullMQ retries; throws when
 * the response body is missing `historyId` so we never persist a partial
 * cursor that would silently force another bootstrap next minute.
 */
async function fetchGmailHistoryCursor(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = `${GMAIL_API_BASE}/users/me/profile`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gmail users.getProfile ${res.status}`);
  }
  const body = (await res.json()) as { historyId?: string };
  if (!body.historyId) {
    throw new Error('gmail users.getProfile response missing historyId');
  }
  return body.historyId;
}

type HistoryListResult =
  | { expired: true }
  | { expired: false; messageIds: string[]; historyId: string };

/**
 * Issues `users.history.list?startHistoryId=<id>&historyTypes=messageAdded` and
 * collects the deduped set of new message ids the cursor revealed. The same
 * Gmail message can appear in several history records (label changes, thread
 * reshuffles); we fetch + ingest it exactly once. Returns the response's
 * `historyId` for the worker to persist as the new cursor — this is
 * already-known to be the latest snapshot id at request time, NOT a per-record
 * id, so a single advance covers the entire window.
 *
 * Throws on non-2xx so BullMQ retries, with one exception (T-38): a 404 means
 * the stored cursor is older than Gmail's ~7-day history retention. There is
 * no point retrying — the cursor is permanently invalid until cleared. Returns
 * `{ expired: true }` so the worker can null `gmailHistoryId` and let the
 * next run take the bootstrap branch. Throws on missing `historyId` to avoid
 * persisting a partial / undefined cursor that would brick subsequent runs.
 */
async function listHistoryEvents(
  accessToken: string,
  startHistoryId: string,
  fetchImpl: typeof fetch,
): Promise<HistoryListResult> {
  const url = new URL(`${GMAIL_API_BASE}/users/me/history`);
  url.searchParams.set('startHistoryId', startHistoryId);
  url.searchParams.set('historyTypes', 'messageAdded');
  url.searchParams.set('labelId', 'INBOX');
  url.searchParams.set('maxResults', '500');

  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) {
    return { expired: true };
  }
  if (!res.ok) {
    throw new Error(`gmail history.list ${res.status}`);
  }
  const body = (await res.json()) as GmailHistoryListResponse;
  if (!body.historyId) {
    throw new Error('gmail history.list response missing historyId');
  }

  const seen = new Set<string>();
  const messageIds: string[] = [];
  for (const record of body.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      const id = added.message?.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        messageIds.push(id);
      }
    }
  }
  return { expired: false, messageIds, historyId: body.historyId };
}

/**
 * Maps a parsed Gmail message into the channel-agnostic `IncomingMessage` shape
 * `ingestWithHooks` accepts. Returns `null` when the message lacks a parseable
 * `From` (no identifier → cannot route to a contact). The `channelMsgId`
 * prefers the RFC `Message-ID` header (matches Postmark dedup) and falls back
 * to Gmail's opaque message id, which is always present.
 */
function buildIngestPayload(
  inboxId: string,
  raw: GmailMessage,
): { payload: IncomingMessage; attachments: ParsedGmailAttachment[] } | null {
  const parsed = parseGmailMessage(raw);
  if (!parsed.from) return null;

  const email = parsed.from.email.toLowerCase();
  const name = parsed.from.name?.trim() || (email.split('@')[0] ?? email);

  const payload: IncomingMessage = {
    inboxId,
    channel: 'email',
    from: { identifier: email, email, name, metadata: {} },
    content: parsed.content || '(sem conteúdo)',
    contentType: 'text',
    channelMsgId: parsed.messageId ?? raw.id,
    threadHints: parsed.threadHints,
    metadata: {
      subject: parsed.subject,
      gmailMessageId: raw.id,
      gmailThreadId: parsed.metadata.gmailThreadId,
      gmailHistoryId: raw.historyId,
    },
  };
  return { payload, attachments: parsed.attachments };
}

/**
 * Process a single `gmail-sync` job. Skip-guards run first (T-33); a healthy
 * inbox without `gmailHistoryId` triggers the bootstrap branch (T-34, this
 * task). The incremental `users.history.list` branch lands in T-37.
 *
 * The processor is exported standalone — separate from `registerGmailSyncWorker`
 * — so unit tests can drive it without spinning up a real BullMQ Worker /
 * Redis connection. Tests inject `fetchImpl` and `getAccessToken` via `deps`;
 * production callers omit them and the real defaults are used.
 */
export async function processGmailSyncJob(
  app: FastifyInstance,
  job: { data: GmailSyncJob },
  deps: ProcessGmailSyncJobDeps = {},
): Promise<void> {
  const { inboxId } = job.data;

  const [inbox] = await app.db
    .select()
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, inboxId))
    .limit(1);

  if (!inbox) {
    app.log.warn({ inboxId }, 'gmail-sync: inbox not found, skipping');
    return;
  }
  if (inbox.deletedAt) {
    app.log.info({ inboxId }, 'gmail-sync: inbox deleted, skipping');
    return;
  }
  if (!inbox.enabled) {
    app.log.info({ inboxId }, 'gmail-sync: inbox disabled, skipping');
    return;
  }

  // Read the raw config: a non-gmail (or pre-provider) inbox would not parse
  // through `parseGmailConfig` cleanly (the schema requires `provider: 'gmail'`).
  // The skip path discriminates on the raw shape before any zod parse.
  const rawConfig = (inbox.config ?? {}) as Record<string, unknown>;
  if (rawConfig.provider !== 'gmail') {
    app.log.info({ inboxId }, 'gmail-sync: provider is not gmail, skipping');
    return;
  }
  if (rawConfig.needsReauth === true) {
    app.log.info({ inboxId }, 'gmail-sync: inbox needsReauth, skipping');
    return;
  }
  if (!inbox.accountId) {
    // Defensive: a Gmail inbox created via the OAuth callback always carries
    // accountId, but legacy / corrupted rows could lack it. Skip rather than
    // throw — `ingestWithHooks` would refuse anyway, and ingest-side throws
    // would loop the BullMQ retry forever.
    app.log.warn(
      { inboxId },
      'gmail-sync: inbox missing accountId, skipping',
    );
    return;
  }
  const inboxAccountId = inbox.accountId;

  const parsedConfig = parseGmailConfig(rawConfig);

  app.log.info(
    {
      inboxId,
      gmailEmail: parsedConfig.gmailEmail,
      gmailHistoryId: parsedConfig.gmailHistoryId ?? null,
      mode: parsedConfig.gmailHistoryId ? 'incremental' : 'bootstrap',
    },
    'gmail-sync: starting',
  );

  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? getValidAccessToken;
  const ingest = deps.ingest ?? ingestWithHooks;
  const downloadAttachment: DownloadAttachmentImpl =
    deps.downloadAttachment ??
    ((messageId, attachment, accessToken) =>
      downloadGmailAttachmentSafe(messageId, attachment, accessToken, {
        fetchImpl,
        logger: app.log,
      }));
  const uploadAttachment: UploadAttachmentImpl =
    deps.uploadAttachment ??
    ((buffer, filename, mimeType, accountId) =>
      uploadGmailAttachment(buffer, filename, mimeType, accountId));
  let accessToken: string;
  try {
    accessToken = await getAccessToken(app, inbox as GmailInboxLike);
    app.log.info({ inboxId }, 'gmail-sync: access token resolved');
  } catch (err) {
    app.log.error({ err, inboxId }, 'gmail-sync: getAccessToken failed');
    throw err;
  }

  // Narrow the inbox for the message-processing helper: `inbox.accountId` was
  // checked above, so we promote it to non-nullable here in one place rather
  // than threading the assertion through every helper signature.
  const inboxForMessages = {
    id: inbox.id,
    accountId: inboxAccountId,
    config: inbox.config,
    defaultBotId: inbox.defaultBotId,
  };

  let messageIds: string[];
  let newHistoryId: string;

  if (!parsedConfig.gmailHistoryId) {
    // Bootstrap branch: no cursor stored yet, list recent unread, then capture
    // a fresh `historyId` from `users.getProfile` to seed the incremental path.
    app.log.info({ inboxId }, 'gmail-sync: bootstrap — listing unread messages');
    const messages = await listBootstrapMessages(accessToken, fetchImpl);
    messageIds = messages.map((m) => m.id);
    app.log.info(
      { inboxId, messageCount: messageIds.length, messageIds },
      'gmail-sync: bootstrap — messages.list returned',
    );
    await processMessageIds(
      app,
      inboxForMessages,
      messageIds,
      accessToken,
      fetchImpl,
      ingest,
      downloadAttachment,
      uploadAttachment,
    );
    newHistoryId = await fetchGmailHistoryCursor(accessToken, fetchImpl);
    app.log.info(
      { inboxId, newHistoryId },
      'gmail-sync: bootstrap — getProfile returned cursor',
    );
  } else {
    // Incremental branch: read events since the stored cursor. The response's
    // `historyId` is the new cursor value (Gmail returns the latest snapshot id
    // at request time — a single advance covers the entire processed window).
    const result = await listHistoryEvents(
      accessToken,
      parsedConfig.gmailHistoryId,
      fetchImpl,
    );
    if (result.expired) {
      // Spec § 7 "Sync worker / Incremental path": 404 from history.list means
      // the cursor is older than Gmail's history retention. Null it and let
      // the next minute's run take the bootstrap branch.
      app.log.warn(
        { inboxId, staleHistoryId: parsedConfig.gmailHistoryId },
        'gmail-sync: history expired, clearing cursor to force bootstrap on next run',
      );
      const resetConfig = { ...parsedConfig, gmailHistoryId: null };
      await app.db
        .update(schema.inboxes)
        .set({ config: resetConfig, updatedAt: new Date() })
        .where(eq(schema.inboxes.id, inboxId));
      return;
    }
    messageIds = result.messageIds;
    app.log.info(
      {
        inboxId,
        messageCount: messageIds.length,
        messageIds,
        startHistoryId: parsedConfig.gmailHistoryId,
        endHistoryId: result.historyId,
      },
      'gmail-sync: incremental — history.list returned',
    );
    await processMessageIds(
      app,
      inboxForMessages,
      messageIds,
      accessToken,
      fetchImpl,
      ingest,
      downloadAttachment,
      uploadAttachment,
    );
    newHistoryId = result.historyId;
  }

  // Persist the cursor regardless of per-message ingest outcomes — a single
  // broken message must not block the cursor or the inbox would be stuck
  // reading the same window forever. Re-processing on the next run is
  // dedup-safe via `channelMsgId` matching in `ingestWithHooks`.
  const patchedConfig = {
    ...parsedConfig,
    gmailHistoryId: newHistoryId,
  };
  await app.db
    .update(schema.inboxes)
    .set({ config: patchedConfig, updatedAt: new Date() })
    .where(eq(schema.inboxes.id, inboxId));

  app.log.info(
    { inboxId, persistedHistoryId: newHistoryId },
    'gmail-sync: complete',
  );
}

/**
 * Per-message worker pass shared by bootstrap and incremental branches:
 * fetch each id in `format=full`, parse, ingest. A single broken message
 * (parser or downstream ingest failure) is logged but does NOT abort the
 * batch — Gmail keeps the message UNREAD if mark-read is skipped, so the
 * next cycle naturally retries.
 *
 * After a clean ingest, the worker fires `users.messages.modify` to drop the
 * `UNREAD` label (spec § 7 "Mark-read"). That call is best-effort: any
 * failure is logged and swallowed so a transient Gmail blip can't block the
 * batch or the cursor advance. A re-attempted ingest of the same message on
 * the next cycle is dedup-safe via `channelMsgId`.
 */
async function processMessageIds(
  app: FastifyInstance,
  inbox: {
    id: string;
    accountId: string;
    config: unknown;
    defaultBotId: string | null;
  },
  messageIds: string[],
  accessToken: string,
  fetchImpl: typeof fetch,
  ingest: typeof ingestWithHooks,
  downloadAttachment: DownloadAttachmentImpl,
  uploadAttachment: UploadAttachmentImpl,
): Promise<void> {
  for (const id of messageIds) {
    app.log.info(
      { inboxId: inbox.id, gmailMessageId: id },
      'gmail-sync: fetching message',
    );
    const raw = await fetchFullGmailMessage(id, accessToken, fetchImpl);
    const built = buildIngestPayload(inbox.id, raw);
    if (!built) {
      app.log.warn(
        { inboxId: inbox.id, gmailMessageId: raw.id },
        'gmail-sync: no From header, skipping message',
      );
      continue;
    }
    const { payload, attachments } = built;
    app.log.info(
      {
        inboxId: inbox.id,
        gmailMessageId: raw.id,
        from: payload.from.email,
        subject: payload.metadata?.subject,
        attachmentCount: attachments.length,
      },
      'gmail-sync: parsed message, calling ingest',
    );

    await attachPrimaryMedia(
      app,
      payload,
      raw.id,
      attachments,
      inbox.accountId,
      accessToken,
      downloadAttachment,
      uploadAttachment,
    );

    try {
      const result = await ingest(
        app,
        payload,
        inbox.config,
        inbox.defaultBotId ?? null,
      );
      app.log.info(
        {
          inboxId: inbox.id,
          gmailMessageId: raw.id,
          deduped: result.deduped,
          conversationId: result.conversationId,
          messageId: result.messageId,
        },
        'gmail-sync: ingest done',
      );
    } catch (err) {
      app.log.warn(
        { err, inboxId: inbox.id, gmailMessageId: raw.id },
        'gmail-sync: ingest failed for message',
      );
      continue;
    }
    await markGmailMessageRead(app, raw.id, accessToken, fetchImpl);
  }
}

/**
 * Mutates `payload` to carry the first downloadable attachment as
 * `mediaUrl` + `mediaMimeType` + `contentType`. The schema only models a
 * single media slot per message (mirrors Twilio `MediaUrl0`), so additional
 * attachments are dropped with a warn log so operators can spot when a
 * Gmail message arrived with multi-attachments and only one made it through.
 *
 * Per-attachment failures (download throws, upload throws, > 25 MB skip) are
 * logged and swallowed: the message still ingests, just text-only. The
 * alternative (abort ingest on any attachment error) would brick a message
 * forever on a transient `attachments.get` blip.
 */
async function attachPrimaryMedia(
  app: FastifyInstance,
  payload: IncomingMessage,
  gmailMessageId: string,
  attachments: ParsedGmailAttachment[],
  accountId: string,
  accessToken: string,
  downloadAttachment: DownloadAttachmentImpl,
  uploadAttachment: UploadAttachmentImpl,
): Promise<void> {
  if (!attachments.length) return;

  const [primary, ...rest] = attachments;
  if (!primary) return;
  if (rest.length) {
    app.log.warn(
      {
        inboxId: payload.inboxId,
        gmailMessageId,
        droppedCount: rest.length,
      },
      'gmail-sync: multiple attachments — only the first is attached as mediaUrl, additional dropped',
    );
  }

  let buffer: Buffer | null;
  try {
    buffer = await downloadAttachment(gmailMessageId, primary, accessToken);
  } catch (err) {
    app.log.warn(
      { err, inboxId: payload.inboxId, gmailMessageId },
      'gmail-sync: attachment download failed, skipping media on this message',
    );
    return;
  }
  if (!buffer) {
    // `downloadGmailAttachmentSafe` already logged the > 25 MB skip — nothing
    // more to do; the message still ingests, just without media.
    return;
  }

  let url: string;
  try {
    url = await uploadAttachment(
      buffer,
      primary.filename || 'attachment',
      primary.mimeType || 'application/octet-stream',
      accountId,
    );
  } catch (err) {
    app.log.warn(
      { err, inboxId: payload.inboxId, gmailMessageId },
      'gmail-sync: attachment upload failed, skipping media on this message',
    );
    return;
  }

  payload.mediaUrl = url;
  payload.mediaMimeType = primary.mimeType;
  payload.contentType = contentTypeFromMime(primary.mimeType);
}

function contentTypeFromMime(
  mime: string | undefined,
): 'text' | 'image' | 'audio' | 'video' | 'document' {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Best-effort `users.messages.modify` to drop the `UNREAD` label after a
 * successful ingest. Any failure (non-2xx response or thrown fetch) is logged
 * and swallowed — the spec ("Failure here is non-fatal — log and continue.")
 * is explicit. We intentionally do not retry: if mark-read fails, the message
 * stays UNREAD on Gmail; the incremental path won't re-emit it (history events
 * fire on label change, not on the still-unread message), but the dedup
 * contract on `channelMsgId` keeps us safe even on a re-bootstrap.
 */
async function markGmailMessageRead(
  app: FastifyInstance,
  messageId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}/modify`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      app.log.warn(
        { gmailMessageId: messageId, status: res.status },
        'gmail-sync: failed to mark message read (non-2xx, continuing)',
      );
    }
  } catch (err) {
    app.log.warn(
      { err, gmailMessageId: messageId },
      'gmail-sync: failed to mark message read (threw, continuing)',
    );
  }
}

/**
 * Register the gmail-sync worker on the BullMQ queue. The processor runs
 * once per job; the scheduler (set up in T-41 on inbox creation) enqueues
 * one job per minute per Gmail inbox.
 */
export function registerGmailSyncWorker(app: FastifyInstance): void {
  app.queues.registerWorker<GmailSyncJob>(
    QUEUE_NAMES.GMAIL_SYNC,
    async (job) => {
      await processGmailSyncJob(app, job);
    },
    5,
  );
}
