import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { users } from './users';

/**
 * Outbound webhook subscriptions. Tenant configures which events to receive on
 * which URL. Secret is encrypted at rest; signing uses Stripe-style
 * `t=<unix_ts>,v1=<hex_hmac>` to give replay protection.
 *
 * Delivery is via BullMQ with retry — see queue WEBHOOK_DELIVERY + worker.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** Encrypted via crypto.encryptJSON. */
    secret: text('secret').notNull(),
    /** Array of event types: `message.created`, `conversation.created`, etc. */
    events: jsonb('events').notNull().default([]),
    active: boolean('active').notNull().default(true),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastFailureReason: text('last_failure_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_subscriptions_active_idx').on(t.active)],
);

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
