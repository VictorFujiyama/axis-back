import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';

import { parseGmailConfig } from '../../modules/channels/gmail-config.js';
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

export interface ProcessGmailSyncJobDeps {
  /** Override `fetch` for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override `getValidAccessToken` for testing. */
  getAccessToken?: (
    app: FastifyInstance,
    inbox: GmailInboxLike,
  ) => Promise<string>;
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
): Promise<unknown> {
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
  return await res.json();
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

  if (!parsedConfig.gmailHistoryId) {
    // Bootstrap branch: no cursor stored yet, list recent unread + fetch each
    // message in `format=full`. T-35 will feed each parsed message into
    // `ingestWithHooks`; T-36 will persist `gmailHistoryId` via `users.getProfile`
    // after a successful run.
    const fetchImpl = deps.fetchImpl ?? fetch;
    const getAccessToken = deps.getAccessToken ?? getValidAccessToken;
    const accessToken = await getAccessToken(app, inbox as GmailInboxLike);

    const messages = await listBootstrapMessages(accessToken, fetchImpl);
    for (const message of messages) {
      await fetchFullGmailMessage(message.id, accessToken, fetchImpl);
      // T-35: parse the full message and pass it to `ingestWithHooks`.
    }
    return;
  }

  // T-37: incremental path via `users.history.list?startHistoryId=<id>`.
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
