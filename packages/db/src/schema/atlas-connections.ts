import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';

/**
 * Per-account Atlas connector binding (Connect Flow — auto-provision, Phase 12.2).
 *
 * When the owner/admin of an Atlas org connects the company to the axis inbox, the connector is
 * provisioned automatically and one row is written here: the axis account ↔ Atlas org mapping plus
 * the encrypted connector secrets. This replaces the old global env config
 * (`ATLAS_ORG_ID`/`ATLAS_HMAC_SECRET`/`ATLAS_SOURCE_ACCOUNT_ID`/`ATLAS_CONNECTOR_ENABLED`).
 *
 * Account-scoped (1 connection per axis account — `atlas_account_id` unique): event emit resolves
 * the connector by account, and inbound `/atlas-events` resolves it by `atlas_org_id` (indexed).
 * `secrets_enc` holds the AES-256-GCM blob (see src/crypto.ts `encryptJSON`) of
 * `{ hmacSecret, mcpBearer }`.
 */
export const atlasConnections = pgTable(
  'atlas_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    atlasAccountId: uuid('atlas_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    atlasOrgId: uuid('atlas_org_id').notNull(),
    // Encrypted { hmacSecret, mcpBearer } via AES-256-GCM (see src/crypto.ts encryptJSON/decryptJSON).
    secretsEnc: text('secrets_enc').notNull(),
    status: text('status').$type<'pending' | 'active' | 'error'>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('atlas_connections_account_unique').on(t.atlasAccountId),
    index('atlas_connections_org_idx').on(t.atlasOrgId),
  ],
);

export const atlasConnectionsRelations = relations(atlasConnections, ({ one }) => ({
  account: one(accounts, {
    fields: [atlasConnections.atlasAccountId],
    references: [accounts.id],
  }),
}));

export type AtlasConnection = typeof atlasConnections.$inferSelect;
export type NewAtlasConnection = typeof atlasConnections.$inferInsert;
