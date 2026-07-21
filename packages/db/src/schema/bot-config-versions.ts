import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bots } from './bots';
import { users } from './users';

// Append-only version history for bot config. Every config save writes a new
// row here; `bots.config` keeps only the current values. Rollback = new version
// with old values, so history stays linear.
export const botsConfigVersions = pgTable(
  'bots_config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    temperature: text('temperature'),
    maxTokens: integer('max_tokens'),
    etag: text('etag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
  },
  (t) => [uniqueIndex('bots_config_versions_bot_version_uniq').on(t.botId, t.version)],
);

export type BotsConfigVersion = typeof botsConfigVersions.$inferSelect;
export type NewBotsConfigVersion = typeof botsConfigVersions.$inferInsert;
