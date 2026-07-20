import { relations } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inboxes } from './inboxes';
import { users } from './users';

// Append-only version history for inbox playbooks (Fase 3, T-A.1). Every save
// through the versioning endpoints writes a new row here; `inbox_playbooks`
// keeps only the current content. Revert = new version with old content, so
// history stays linear (no branching).
export const inboxPlaybookVersions = pgTable(
  'inbox_playbook_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inbox_playbook_versions_inbox_version_unq').on(t.inboxId, t.version),
    index('inbox_playbook_versions_inbox_created_idx').on(t.inboxId, t.createdAt),
  ],
);

export const inboxPlaybookVersionsRelations = relations(inboxPlaybookVersions, ({ one }) => ({
  inbox: one(inboxes, {
    fields: [inboxPlaybookVersions.inboxId],
    references: [inboxes.id],
  }),
  createdByUser: one(users, {
    fields: [inboxPlaybookVersions.createdBy],
    references: [users.id],
  }),
}));

export type InboxPlaybookVersion = typeof inboxPlaybookVersions.$inferSelect;
export type NewInboxPlaybookVersion = typeof inboxPlaybookVersions.$inferInsert;
