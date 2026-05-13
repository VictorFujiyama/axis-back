import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { users } from './users';

export const atlasUserLinks = pgTable(
  'atlas_user_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    axisUserId: uuid('axis_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    atlasAppUserId: text('atlas_app_user_id').notNull(),
    atlasOrgId: text('atlas_org_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('atlas_user_links_unique').on(t.accountId, t.atlasOrgId, t.atlasAppUserId),
    index('atlas_user_links_account_idx').on(t.accountId),
    index('atlas_user_links_axis_user_idx').on(t.axisUserId),
  ],
);

export const atlasUserLinksRelations = relations(atlasUserLinks, ({ one }) => ({
  account: one(accounts, {
    fields: [atlasUserLinks.accountId],
    references: [accounts.id],
  }),
  axisUser: one(users, {
    fields: [atlasUserLinks.axisUserId],
    references: [users.id],
  }),
}));

export type AtlasUserLink = typeof atlasUserLinks.$inferSelect;
export type NewAtlasUserLink = typeof atlasUserLinks.$inferInsert;
