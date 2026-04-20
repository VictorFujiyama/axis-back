import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';

export const customFieldTypeEnum = pgEnum('custom_field_type', [
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'boolean',
]);

/**
 * Custom field definitions applied to contacts. Values live in
 * `contacts.custom_fields` JSONB, keyed by `key`.
 */
export const customFieldDefs = pgTable(
  'custom_field_defs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: customFieldTypeEnum('type').notNull(),
    /** For select/multi_select, array of allowed values. */
    options: jsonb('options').notNull().default([]),
    required: boolean('required').notNull().default(false),
    order: integer('order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('custom_field_defs_key_unique').on(t.key)],
);

export type CustomFieldDef = typeof customFieldDefs.$inferSelect;
export type NewCustomFieldDef = typeof customFieldDefs.$inferInsert;
