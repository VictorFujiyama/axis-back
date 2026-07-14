import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';

/**
 * Backfills `conversations.assigned_bot_id` on open/pending/snoozed threads of
 * an inbox when `default_bot_id` transitions from `null` to a real bot uuid
 * (or from bot A to bot B while some threads still have `assigned_bot_id`
 * `null`). Without this, `helpers.ts:ingestIncomingMessage` — the only other
 * writer of `assigned_bot_id` — only stamps the field at conversation CREATION
 * time (line 279-296). If the operator configures the bot AFTER threads
 * exist, those threads stay `assigned_bot_id=null` forever and the assigned-
 * bot chat flow (dispatchBot @ helpers.ts:415) is silently skipped for them.
 *
 * Contract:
 * - Only updates rows where `assigned_bot_id IS NULL` — NEVER overwrites an
 *   explicit prior assignment. Operators change assigned bot per-conv via
 *   the human-assign UI, not via this backfill.
 * - Only touches non-resolved conversations (open/pending/snoozed). Resolved
 *   threads stay closed.
 * - No-op when `newBotId` is `null` (removing the default bot must NOT
 *   silently unassign live threads).
 * - Returns the count of rows updated so callers can log observability.
 */
export async function backfillAssignedBotIdOnBotChange(
  db: DB,
  inboxId: string,
  newBotId: string | null,
): Promise<number> {
  if (!newBotId) return 0;
  const rows = await db
    .update(schema.conversations)
    .set({ assignedBotId: newBotId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.conversations.inboxId, inboxId),
        isNull(schema.conversations.assignedBotId),
        inArray(schema.conversations.status, ['open', 'pending', 'snoozed']),
      ),
    )
    .returning({ id: schema.conversations.id });
  return rows.length;
}
