import { relations } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { inboxes } from './inboxes';

// Source-of-truth playbook per inbox (D1). Mirrors atlas messaging_playbooks shape
// but PK is uuid (FK to inboxes.id) instead of text, enabling direct backfill +
// per-inbox versioning. FK ON DELETE CASCADE handles hard-delete; soft-delete
// cleanup is application-side (D33, D48).
export const inboxPlaybooks = pgTable('inbox_playbooks', {
  inboxId: uuid('inbox_id')
    .primaryKey()
    .references(() => inboxes.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  etag: text('etag').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inboxPlaybooksRelations = relations(inboxPlaybooks, ({ one }) => ({
  inbox: one(inboxes, {
    fields: [inboxPlaybooks.inboxId],
    references: [inboxes.id],
  }),
}));

export type InboxPlaybook = typeof inboxPlaybooks.$inferSelect;
export type NewInboxPlaybook = typeof inboxPlaybooks.$inferInsert;
