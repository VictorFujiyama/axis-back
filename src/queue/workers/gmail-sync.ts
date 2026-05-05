import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';

import { parseGmailConfig } from '../../modules/channels/gmail-config.js';
import {
  parseGmailMessage,
  type GmailMessage,
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

/**
 * Issues `users.history.list?startHistoryId=<id>&historyTypes=messageAdded` and
 * collects the deduped set of new message ids the cursor revealed. The same
 * Gmail message can appear in several history records (label changes, thread
 * reshuffles); we fetch + ingest it exactly once. Returns the response's
 * `historyId` for the worker to persist as the new cursor — this is
 * already-known to be the latest snapshot id at request time, NOT a per-record
 * id, so a single advance covers the entire window.
 *
 * Throws on non-2xx so BullMQ retries (T-38 will discriminate the 404 case to
 * clear the cursor and force a bootstrap). Throws on missing `historyId` to
 * avoid persisting a partial / undefined cursor that would brick subsequent
 * runs.
 */
async function listHistoryEvents(
  accessToken: string,
  startHistoryId: string,
  fetchImpl: typeof fetch,
): Promise<{ messageIds: string[]; historyId: string }> {
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
  return { messageIds, historyId: body.historyId };
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
): IncomingMessage | null {
  const parsed = parseGmailMessage(raw);
  if (!parsed.from) return null;

  const email = parsed.from.email.toLowerCase();
  const name = parsed.from.name?.trim() || (email.split('@')[0] ?? email);

  return {
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

  const parsedConfig = parseGmailConfig(rawConfig);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? getValidAccessToken;
  const ingest = deps.ingest ?? ingestWithHooks;
  const accessToken = await getAccessToken(app, inbox as GmailInboxLike);

  let messageIds: string[];
  let newHistoryId: string;

  if (!parsedConfig.gmailHistoryId) {
    // Bootstrap branch: no cursor stored yet, list recent unread, then capture
    // a fresh `historyId` from `users.getProfile` to seed the incremental path.
    const messages = await listBootstrapMessages(accessToken, fetchImpl);
    messageIds = messages.map((m) => m.id);
    await processMessageIds(
      app,
      inbox,
      messageIds,
      accessToken,
      fetchImpl,
      ingest,
    );
    newHistoryId = await fetchGmailHistoryCursor(accessToken, fetchImpl);
  } else {
    // Incremental branch: read events since the stored cursor. The response's
    // `historyId` is the new cursor value (Gmail returns the latest snapshot id
    // at request time — a single advance covers the entire processed window).
    const result = await listHistoryEvents(
      accessToken,
      parsedConfig.gmailHistoryId,
      fetchImpl,
    );
    messageIds = result.messageIds;
    await processMessageIds(
      app,
      inbox,
      messageIds,
      accessToken,
      fetchImpl,
      ingest,
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
}

/**
 * Per-message worker pass shared by bootstrap and incremental branches:
 * fetch each id in `format=full`, parse, ingest. A single broken message
 * (parser or downstream ingest failure) is logged but does NOT abort the
 * batch — Gmail keeps the message UNREAD until T-39's mark-read fires, so
 * the next cycle naturally retries.
 */
async function processMessageIds(
  app: FastifyInstance,
  inbox: { id: string; config: unknown; defaultBotId: string | null },
  messageIds: string[],
  accessToken: string,
  fetchImpl: typeof fetch,
  ingest: typeof ingestWithHooks,
): Promise<void> {
  for (const id of messageIds) {
    const raw = await fetchFullGmailMessage(id, accessToken, fetchImpl);
    const payload = buildIngestPayload(inbox.id, raw);
    if (!payload) {
      app.log.warn(
        { inboxId: inbox.id, gmailMessageId: raw.id },
        'gmail-sync: no From header, skipping message',
      );
      continue;
    }
    try {
      await ingest(app, payload, inbox.config, inbox.defaultBotId ?? null);
    } catch (err) {
      app.log.warn(
        { err, inboxId: inbox.id, gmailMessageId: raw.id },
        'gmail-sync: ingest failed for message',
      );
    }
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
