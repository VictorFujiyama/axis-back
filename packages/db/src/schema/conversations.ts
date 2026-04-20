import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { bots } from './bots';
import { contacts } from './contacts';
import { conversationPriorityEnum, conversationStatusEnum } from './enums';
import { inboxes } from './inboxes';
import { teams } from './teams';
import { users } from './users';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'restrict' }),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedTeamId: uuid('assigned_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    assignedBotId: uuid('assigned_bot_id').references(() => bots.id, {
      onDelete: 'set null',
    }),
    status: conversationStatusEnum('status').notNull().default('open'),
    priority: conversationPriorityEnum('priority').notNull().default('medium'),
    muted: boolean('muted').notNull().default(false),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    waitingForAgentSince: timestamp('waiting_for_agent_since', { withTimezone: true }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_assigned_user_status_idx').on(t.assignedUserId, t.status),
    index('conversations_inbox_status_idx').on(t.inboxId, t.status),
    index('conversations_contact_idx').on(t.contactId),
    // Analytics: scan resolved-in-period without seq scan.
    index('conversations_resolved_at_idx').on(t.resolvedAt),
    index('conversations_created_at_idx').on(t.createdAt),
  ],
);

export const conversationsRelations = relations(conversations, ({ one }) => ({
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  inbox: one(inboxes, { fields: [conversations.inboxId], references: [inboxes.id] }),
  assignedUser: one(users, {
    fields: [conversations.assignedUserId],
    references: [users.id],
  }),
  assignedTeam: one(teams, {
    fields: [conversations.assignedTeamId],
    references: [teams.id],
  }),
  assignedBot: one(bots, { fields: [conversations.assignedBotId], references: [bots.id] }),
}));

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
