import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accountStatusEnum, userRoleEnum, userStatusEnum } from './enums';
import { users } from './users';

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  locale: text('locale').notNull().default('pt-BR'),
  status: accountStatusEnum('status').notNull().default('active'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accountUsers = pgTable(
  'account_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull().default('agent'),
    availability: userStatusEnum('availability').notNull().default('offline'),
    autoOffline: boolean('auto_offline').notNull().default(true),
    inviterId: uuid('inviter_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('account_users_account_user_unique').on(t.accountId, t.userId),
    index('account_users_user_idx').on(t.userId),
    index('account_users_account_idx').on(t.accountId),
  ],
);

export const accountsRelations = relations(accounts, ({ many }) => ({
  members: many(accountUsers),
}));

export const accountUsersRelations = relations(accountUsers, ({ one }) => ({
  account: one(accounts, {
    fields: [accountUsers.accountId],
    references: [accounts.id],
  }),
  user: one(users, {
    fields: [accountUsers.userId],
    references: [users.id],
  }),
  inviter: one(users, {
    fields: [accountUsers.inviterId],
    references: [users.id],
    relationName: 'invitedBy',
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type AccountUser = typeof accountUsers.$inferSelect;
export type NewAccountUser = typeof accountUsers.$inferInsert;
