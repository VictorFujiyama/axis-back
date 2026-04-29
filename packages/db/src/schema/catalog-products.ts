import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';

/**
 * Products table for the @blossom-modules/catalog module.
 * Multi-tenant: every row scoped to an account; cascade-delete on account drop.
 * Image is a public URL (no upload pipeline yet); price stored as numeric(10,2).
 */
export const moduleCatalogProducts = pgTable(
  'module_catalog_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    brand: text('brand'),
    category: text('category'),
    price: numeric('price', { precision: 10, scale: 2 }).notNull().default('0'),
    description: text('description'),
    imageUrl: text('image_url'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('module_catalog_products_account_id_idx').on(t.accountId),
    index('module_catalog_products_name_idx').on(t.name),
  ],
);
