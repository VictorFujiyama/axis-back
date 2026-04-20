import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { contacts } from './contacts';
import { inboxes } from './inboxes';
import { users } from './users';

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'running',
  'completed',
  'cancelled',
  'failed',
]);

export const campaignRecipientStatusEnum = pgEnum('campaign_recipient_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'replied',
]);

/**
 * Bulk outbound campaign. Segments contacts by tag + inbox, enqueues individual
 * deliveries through the same outbound dispatch pipeline used for agent messages
 * so channel-specific retries/signatures apply uniformly.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    inboxId: uuid('inbox_id').notNull().references(() => inboxes.id, { onDelete: 'restrict' }),
    /** Array of tag IDs — contact must have AT LEAST ONE to be included. */
    tagIds: jsonb('tag_ids').notNull().default([]),
    /** Free-text template with merge tags. For WhatsApp, must correspond to an
     * approved Meta template (templateName stored in `templateId`). */
    template: text('template').notNull(),
    templateId: text('template_id'),
    status: campaignStatusEnum('status').notNull().default('draft'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recipientCount: integer('recipient_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_status_idx').on(t.status),
    index('campaigns_scheduled_idx').on(t.scheduledFor),
  ],
);

/**
 * One row per (campaign, contact) — tracks delivery lifecycle per recipient so
 * the report can aggregate entregue/lido/respondido/erro.
 */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: campaignRecipientStatusEnum('status').notNull().default('pending'),
    messageId: uuid('message_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.contactId] }),
    index('campaign_recipients_campaign_status_idx').on(t.campaignId, t.status),
    index('campaign_recipients_message_idx').on(t.messageId),
  ],
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
