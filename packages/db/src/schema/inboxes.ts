import { relations } from 'drizzle-orm';
import { boolean, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { channelTypeEnum } from './enums';
import { users } from './users';

export const inboxes = pgTable('inboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  channelType: channelTypeEnum('channel_type').notNull(),
  // Public, non-sensitive config (channel-specific display fields, flags)
  config: jsonb('config').notNull().default({}),
  // Sensitive creds encrypted via AES-256-GCM (see apps/backend/src/crypto.ts)
  secrets: text('secrets'),
  // Default bot assigned to new conversations in this inbox.
  // FK to bots(id) added in migration SQL (circular: bots → inboxes → bots).
  defaultBotId: uuid('default_bot_id'),
  enabled: boolean('enabled').notNull().default(true),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inboxMembers = pgTable(
  'inbox_members',
  {
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.inboxId, t.userId] })],
);

export const inboxesRelations = relations(inboxes, ({ many }) => ({
  members: many(inboxMembers),
}));

export const inboxMembersRelations = relations(inboxMembers, ({ one }) => ({
  inbox: one(inboxes, { fields: [inboxMembers.inboxId], references: [inboxes.id] }),
  user: one(users, { fields: [inboxMembers.userId], references: [users.id] }),
}));

export type Inbox = typeof inboxes.$inferSelect;
export type NewInbox = typeof inboxes.$inferInsert;
