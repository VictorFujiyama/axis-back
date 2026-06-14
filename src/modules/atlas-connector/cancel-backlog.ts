import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@blossom/db';
import type { ConnectorEvent } from '@atlas/connectors';
import { getConnectionByOrg } from '../atlas-events/connections.js';
import {
  backlogSetKey,
  listBacklogJobs,
  untrackBacklogJob,
} from '../channels/inbox-send-cap.js';
import { QUEUE_NAMES, type EmailOutboundJob } from '../../queue/index.js';

export const JOURNEY_CANCELLED_KIND = 'journey_cancelled';

interface CancelMetadata {
  journey_id?: string;
  reason?: string;
  run_ids?: string[];
}

export interface CancelBacklogResult {
  /** How many inbox backlog SETs were scanned. */
  scannedInboxes: number;
  /** How many backlog jobIds were inspected. */
  inspectedJobs: number;
  /** How many jobs matched the journey runIds and were cancelled. */
  cancelled: number;
}

/**
 * Phase 13 — drop daily-cap backlog jobs that belong to runs of a journey that
 * Atlas has paused/archived/deleted. Atlas emits `journey_cancelled` with the
 * list of `run_ids` (queued/running/waiting). We resolve the axis account from
 * `atlas_connections` (NOT `atlas_user_links` — that's SSO/per-user, this is
 * per-account boundary), then for every inbox under that account: list the
 * backlog SET, batch-load the messages, SREM + remove jobs whose metadata
 * `atlas_journey_run_id` matches a run id Atlas sent. Idempotent: re-processing
 * the same envelope finds nothing left and returns zeros.
 */
export async function handleJourneyCancelled(
  app: FastifyInstance,
  envelope: ConnectorEvent,
): Promise<CancelBacklogResult> {
  const meta = (envelope.metadata ?? {}) as CancelMetadata;
  const journeyId = meta.journey_id;
  const runIds = Array.isArray(meta.run_ids) ? meta.run_ids.filter((s) => typeof s === 'string') : [];
  if (!journeyId || runIds.length === 0) {
    return { scannedInboxes: 0, inspectedJobs: 0, cancelled: 0 };
  }

  // Resolve account boundary from atlas_connections (per-account, not per-user).
  // `atlasAccountId` is the FK into `accounts.id` — i.e. the axis-side account.
  const connection = await getConnectionByOrg(app.db, envelope.org_id);
  if (!connection?.atlasAccountId) {
    return { scannedInboxes: 0, inspectedJobs: 0, cancelled: 0 };
  }
  const accountId = connection.atlasAccountId;

  // List all inboxes for the account (only Gmail can have backlog, but
  // scanning by accountId stays correct if other providers gain caps later).
  const inboxes = await app.db
    .select({ id: schema.inboxes.id })
    .from(schema.inboxes)
    .where(and(eq(schema.inboxes.accountId, accountId), sql`${schema.inboxes.deletedAt} IS NULL`));

  let inspectedJobs = 0;
  let cancelled = 0;
  const queue = app.queues.getQueue<EmailOutboundJob>(QUEUE_NAMES.EMAIL_OUTBOUND);

  for (const inbox of inboxes) {
    const jobIds = await listBacklogJobs(app.redis, inbox.id);
    if (jobIds.length === 0) continue;

    // BullMQ jobId is the messageId (worker convention). Match metadata via DB
    // in one batch — avoids fetching every job from BullMQ when none qualify.
    const matches = await app.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.id, jobIds),
          sql`${schema.messages.metadata}->>'atlas_journey_run_id' = ANY(${runIds}::text[])`,
        ),
      );
    inspectedJobs += jobIds.length;
    if (matches.length === 0) continue;

    const matchedIds = new Set(matches.map((m) => m.id));
    for (const jobId of jobIds) {
      if (!matchedIds.has(jobId)) continue;
      const job = await queue.getJob(jobId);
      if (job) {
        try {
          await job.remove();
        } catch {
          // job might already be active/completed; SREM still cleans the set
        }
      }
      await untrackBacklogJob(app.redis, inbox.id, jobId);

      // Mark the message failed so the agent UI doesn't show a stuck spinner.
      await app.db
        .update(schema.messages)
        .set({ failedAt: new Date(), failureReason: 'journey cancelled' })
        .where(eq(schema.messages.id, jobId));
      cancelled += 1;
    }
  }

  // Lint-only: kept to silence unused import when no inboxes match.
  void backlogSetKey;

  app.log.info(
    { journeyId, accountId, runs: runIds.length, cancelled, inspectedJobs },
    'atlas-events: journey_cancelled backlog cleanup',
  );

  return { scannedInboxes: inboxes.length, inspectedJobs, cancelled };
}
