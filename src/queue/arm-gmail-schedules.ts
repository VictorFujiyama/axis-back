import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { QUEUE_NAMES, type GmailSyncJob } from './index.js';

/**
 * On boot, ensure every active Gmail inbox has a repeating gmail-sync job
 * armed in BullMQ. Idempotent via `repeat.key` — calling on every boot is
 * safe (BullMQ dedups by hash and the second arming for the same inbox is
 * a no-op).
 *
 * Why this exists: schedules are normally armed by the OAuth callback when
 * an inbox is created. But if Redis ever loses the scheduler entry (Render
 * Key Value Free's `allkeys-lru` policy used to evict them; could happen
 * again under memory pressure on any plan), or a deploy gap leaves a window
 * where schedules weren't persisted, the inbox stops syncing silently.
 * This boot hook re-arms them — cheap insurance.
 */
export async function armGmailSchedulesOnBoot(
  app: FastifyInstance,
): Promise<void> {
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

    let armed = 0;
    for (const row of rows) {
      const cfg = (row.config ?? {}) as Record<string, unknown>;
      if (cfg.provider !== 'gmail' || cfg.needsReauth === true) continue;
      await queue.add(
        'sync',
        { inboxId: row.id },
        { repeat: { every: 60_000, key: `gmail-sync__${row.id}` } },
      );
      armed++;
    }
    app.log.info({ armed }, 'gmail-sync: boot schedules armed');
  } catch (err) {
    app.log.warn({ err }, 'gmail-sync: failed to arm boot schedules');
  }
}
