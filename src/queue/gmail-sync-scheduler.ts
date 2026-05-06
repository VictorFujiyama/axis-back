import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { QUEUE_NAMES, type GmailSyncJob } from './index.js';

const TICK_INTERVAL_MS = 60_000;

/**
 * In-process scheduler for the gmail-sync queue. **TEMPORARY WORKAROUND.**
 *
 * Render Key Value Free runs Redis with `maxmemory-policy allkeys-lru`, which
 * silently evicts BullMQ repeatable-job keys under any memory pressure. The
 * scheduler hash disappears, no future ticks fire, and the inbox stops
 * syncing without any error surfacing.
 *
 * One-shot jobs (queue.add without repeat) are immune: they live in Redis
 * for seconds (until the worker pulls them) and are not candidates for LRU.
 *
 * This module ticks every 60s on the Node.js side, queries the DB for active
 * Gmail inboxes, and enqueues a one-shot sync job per inbox. The DB is the
 * source of truth for "what should sync"; the in-memory tick is just a
 * heartbeat. App restart resumes from the next tick automatically.
 *
 * **Remove this module** once the Redis instance is upgraded to a plan with
 * `noeviction` (Render Key Value Starter or any external Redis like Upstash
 * Pay-as-go). The `queue.add({ repeat })` call already wired in the OAuth
 * callback (`src/modules/oauth/google/routes.ts`) is the long-term path and
 * will work natively once Redis stops evicting scheduler keys.
 */
export function startGmailSyncScheduler(
  app: FastifyInstance,
  intervalMs = TICK_INTERVAL_MS,
): () => void {
  const tick = async () => {
    try {
      const queue = app.queues.getQueue<GmailSyncJob>(QUEUE_NAMES.GMAIL_SYNC);
      const rows = await app.db
        .select({ id: schema.inboxes.id, config: schema.inboxes.config })
        .from(schema.inboxes)
        .where(
          and(
            eq(schema.inboxes.channelType, 'email'),
            eq(schema.inboxes.enabled, true),
            isNull(schema.inboxes.deletedAt),
          ),
        );

      for (const row of rows) {
        const cfg = (row.config ?? {}) as Record<string, unknown>;
        if (cfg.provider !== 'gmail' || cfg.needsReauth === true) continue;
        await queue.add('sync', { inboxId: row.id });
      }
    } catch (err) {
      app.log.warn({ err }, 'gmail-sync scheduler: tick failed');
    }
  };

  // Fire once shortly after boot so freshly-deployed inboxes don't wait a full
  // interval for their first sync.
  const bootTimeout = setTimeout(tick, 5_000);
  const handle = setInterval(tick, intervalMs);

  app.log.info({ intervalMs }, 'gmail-sync scheduler started');

  return () => {
    clearTimeout(bootTimeout);
    clearInterval(handle);
  };
}
