import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { messages } from './messages';
import { users } from './users';

/**
 * Internal reactions on messages — visible only to agents (never sent back
 * to the contact). One emoji per (message, user, emoji). Removing is a DELETE.
 */
export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export type MessageReaction = typeof messageReactions.$inferSelect;
export type NewMessageReaction = typeof messageReactions.$inferInsert;
