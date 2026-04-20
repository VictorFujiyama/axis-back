import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { conversations } from './conversations';
import { contacts } from './contacts';

/**
 * CSAT/NPS responses. One row per (conversation, cycle). A conversation can
 * have multiple cycles if reopened and re-resolved.
 */
export const csatResponses = pgTable(
  'csat_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** 1-5 for CSAT, 0-10 for NPS. */
    score: integer('score').notNull(),
    /** 'csat' or 'nps'. */
    kind: text('kind').notNull().default('csat'),
    comment: text('comment'),
    respondedAt: timestamp('responded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('csat_conversation_idx').on(t.conversationId),
    index('csat_contact_idx').on(t.contactId),
    index('csat_responded_idx').on(t.respondedAt),
  ],
);

export type CsatResponse = typeof csatResponses.$inferSelect;
export type NewCsatResponse = typeof csatResponses.$inferInsert;
