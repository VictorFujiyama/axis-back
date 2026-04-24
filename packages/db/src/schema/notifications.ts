import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { conversations } from './conversations';
import { messages } from './messages';
import { users } from './users';

export const notificationTypeEnum = pgEnum('notification_type', [
  'mention',
  'assign',
  'message_new',
  'sla_breached',
]);

/**
 * Per-user notification. Created by domain events (mention, assign, etc.).
 * In-app `sino` reads this table; future push/email channels use the same table.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    // Denormalized from data.conversationId so the mentions filter can join
    // without a JSONB extract. Nullable because future notification types
    // (system-wide announcements) may not bind to a conversation.
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    // For mention notifications: FK to the exact private note the mention
    // originated from. CASCADE so a deleted message doesn't leave stale
    // entries in the "Menções" sidebar list.
    messageId: uuid('message_id').references(() => messages.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    body: text('body'),
    data: jsonb('data').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_unread_idx').on(t.userId, t.readAt),
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_user_type_conv_idx').on(t.userId, t.type, t.conversationId),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
