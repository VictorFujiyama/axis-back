import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { channelTypeEnum } from './enums';
import { users } from './users';

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    avatarUrl: text('avatar_url'),
    customFields: jsonb('custom_fields').notNull().default({}),
    blocked: text('blocked'), // null when not blocked; otherwise reason
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contacts_email_idx').on(t.email),
    index('contacts_phone_idx').on(t.phone),
    index('contacts_last_activity_idx').on(t.lastActivityAt),
  ],
);

export const contactNotes = pgTable(
  'contact_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contact_notes_contact_created_idx').on(t.contactId, t.createdAt)],
);

export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: channelTypeEnum('channel').notNull(),
    identifier: text('identifier').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('contact_identities_channel_identifier_unique').on(t.channel, t.identifier)],
);

export const contactsRelations = relations(contacts, ({ many }) => ({
  identities: many(contactIdentities),
}));

export const contactIdentitiesRelations = relations(contactIdentities, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactIdentities.contactId],
    references: [contacts.id],
  }),
}));

export const contactNotesRelations = relations(contactNotes, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactNotes.contactId],
    references: [contacts.id],
  }),
  author: one(users, {
    fields: [contactNotes.authorId],
    references: [users.id],
  }),
}));

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactIdentity = typeof contactIdentities.$inferSelect;
export type ContactNote = typeof contactNotes.$inferSelect;
export type NewContactNote = typeof contactNotes.$inferInsert;
