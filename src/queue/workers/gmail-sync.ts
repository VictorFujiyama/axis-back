import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';

import { QUEUE_NAMES, type GmailSyncJob } from '../index.js';

/**
 * Process a single `gmail-sync` job. Skip-guards only — actual Gmail API
 * polling, ingestion, and mark-read land in T-34+. Exported standalone
 * (separate from `registerGmailSyncWorker`) so unit tests can drive the
 * processor without spinning up a real BullMQ Worker / Redis connection.
 */
export async function processGmailSyncJob(
  app: FastifyInstance,
  job: { data: GmailSyncJob },
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

  // T-34+: bootstrap / incremental Gmail poll, ingest, mark-read.
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
