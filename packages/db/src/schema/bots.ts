import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { botTypeEnum } from './enums';
import { inboxes } from './inboxes';

export const bots = pgTable('bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  botType: botTypeEnum('bot_type').notNull().default('external'),
  // External bots: webhook URL to receive events. Null for built-in bots.
  webhookUrl: text('webhook_url'),
  // AES-256-GCM encrypted blob (see apps/backend/src/crypto.ts).
  // External: bot's bearer/HMAC secret. Built-in: provider API key.
  secret: text('secret').notNull(),
  // Built-in bot configuration (provider, model, systemPrompt, etc.)
  config: jsonb('config').notNull().default({}),
  inboxId: uuid('inbox_id')
    .notNull()
    .references(() => inboxes.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Bot = typeof bots.$inferSelect;
export type NewBot = typeof bots.$inferInsert;

// ── Bot Events (dispatch audit log) ──────────────────────────────────
export const botEvents = pgTable(
  'bot_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id'),
    event: text('event').notNull(), // 'dispatch', 'response', 'timeout', 'error', 'fallback'
    direction: text('direction').notNull(), // 'outbound' (us → bot) or 'inbound' (bot → us)
    status: text('status').notNull(), // 'success', 'failed', 'timeout'
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    attempt: integer('attempt').default(1),
    payload: jsonb('payload'), // truncated payload sent
    response: jsonb('response'), // truncated response received
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bot_events_bot_created_idx').on(t.botId, t.createdAt),
    index('bot_events_conversation_idx').on(t.conversationId, t.createdAt),
    index('bot_events_status_idx').on(t.status, t.createdAt),
  ],
);

export type BotEvent = typeof botEvents.$inferSelect;
export type NewBotEvent = typeof botEvents.$inferInsert;
