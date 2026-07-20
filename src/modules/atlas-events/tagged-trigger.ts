import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';

/**
 * [crm-T-03] Emit a `conversation.tagged` realtime event for each freshly
 * applied tag. The `enqueue.ts` listener resolves the tag name against
 * `TAG_ROUTE_MAP` (case-insensitive): `meeting-ready`, `nurture` and legacy
 * `qualified` (alias of meeting-ready) route to `buildLeadQualifiedEnvelope`
 * (T-02); `unqualified` and other tag names are no-ops at the connector layer.
 *
 * Idempotency: pass ONLY the tagIds that actually inserted (via
 * `.returning(...)` on `.onConflictDoNothing()` or the success branch of a
 * try/catch on '23505') so a no-op insert never re-fires the qualifying event.
 * `taggedAt` is captured once per call so a single batch of tags shares one
 * timestamp; re-tagging after a delete yields a fresh `event_id`
 * (`conv_<id>:lead_qualified:<ms>`) for legitimate re-engagement (D6), while
 * replay of the same envelope dedupes on `(source_app, event_id)` at Atlas.
 *
 * A missing conversation row (race with delete) yields zero emits — never
 * throws on the hot path.
 */
export async function emitConversationTagged(
  db: DB,
  args: { conversationId: string; tagIds: string[]; taggedAt?: string },
): Promise<void> {
  if (args.tagIds.length === 0) return;
  const [conv] = await db
    .select({ inboxId: schema.conversations.inboxId })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, args.conversationId))
    .limit(1);
  if (!conv) return;
  const taggedAt = args.taggedAt ?? new Date().toISOString();
  for (const tagId of args.tagIds) {
    eventBus.emitEvent({
      type: 'conversation.tagged',
      inboxId: conv.inboxId,
      conversationId: args.conversationId,
      tagId,
      taggedAt,
    });
  }
}
