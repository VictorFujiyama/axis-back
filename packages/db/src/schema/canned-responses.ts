import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { users } from './users';
import { inboxes } from './inboxes';

export const cannedVisibilityEnum = pgEnum('canned_visibility', [
  'personal',
  'inbox',
  'global',
]);

/**
 * Canned responses (respostas prontas).
 *
 * Visibility:
 *  - 'personal': only the owner (ownerId NOT NULL) sees/uses it
 *  - 'inbox':    everyone can use it when the current conversation is in `inboxId`
 *  - 'global':   everyone can use it, anywhere
 *
 * `shortcut` is the `/atalho` the user types in the composer. Uniqueness is
 * enforced per owner for personal, per inbox for inbox-scoped, and globally
 * for 'global' — via partial unique indexes.
 */
export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    visibility: cannedVisibilityEnum('visibility').notNull(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    inboxId: uuid('inbox_id').references(() => inboxes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    shortcut: text('shortcut').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('canned_owner_idx').on(t.ownerId),
    index('canned_inbox_idx').on(t.inboxId),
    index('canned_visibility_idx').on(t.visibility),
    // Shortcut uniqueness per (visibility, owner, inbox) — NULL columns distinct by Postgres default.
    unique('canned_shortcut_unique').on(t.visibility, t.ownerId, t.inboxId, t.shortcut),
  ],
);

export type CannedResponse = typeof cannedResponses.$inferSelect;
export type NewCannedResponse = typeof cannedResponses.$inferInsert;
