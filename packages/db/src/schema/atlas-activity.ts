import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Atlas-originated activity pushed back to axis-back (Phase 12.2 inbound, Berg doc Phase 4d).
 *
 * Atlas POSTs to `/atlas-events` whenever it writes a memory / makes a decision for the
 * connector org; `AtlasSubscriber` verifies the HMAC and the `onAtlasActivity` hook (T-012)
 * persists one row here so the axis-back UI can surface "Atlas remembered X about this customer".
 *
 * Org-scoped (single Atlas org per connector, V1 — L-611); no account FK by design. Idempotent on
 * `event_id` (Atlas reuses its own activity id), so a re-pushed event upserts onto the same row.
 */
export const atlasActivity = pgTable(
  'atlas_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: text('event_id').notNull(),
    kind: text('kind').notNull(), // 'memory_write' | 'decision' | 'session_turn' | 'delegation_complete'
    orgId: text('org_id').notNull(),
    summary: text('summary'),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull().default({}),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('atlas_activity_event_id_unique').on(t.eventId),
    index('atlas_activity_org_received_idx').on(t.orgId, t.receivedAt),
  ],
);

export type AtlasActivity = typeof atlasActivity.$inferSelect;
export type NewAtlasActivity = typeof atlasActivity.$inferInsert;
