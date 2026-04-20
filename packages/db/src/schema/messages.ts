import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { conversations } from './conversations';
import { messageContentTypeEnum, senderTypeEnum } from './enums';
import { inboxes } from './inboxes';

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Denormalized for partitioning + composite unique on channel_msg_id
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'restrict' }),
    senderType: senderTypeEnum('sender_type').notNull(),
    senderId: uuid('sender_id'),
    content: text('content'),
    contentType: messageContentTypeEnum('content_type').notNull().default('text'),
    mediaUrl: text('media_url'),
    mediaMimeType: text('media_mime_type'),
    isPrivateNote: boolean('is_private_note').notNull().default(false),
    channelMsgId: text('channel_msg_id'),
    metadata: jsonb('metadata').notNull().default({}),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    // P5 reply/quote — threads responses to an earlier message in the same conversation.
    replyToMessageId: uuid('reply_to_message_id'),
    // P7 scheduled message — when set, message is staged; a worker publishes it at this time.
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    // For analytics: scan messages by date range (and inbox) without joining conversations.
    index('messages_inbox_created_idx').on(t.inboxId, t.createdAt),
    // Composite unique: per inbox, channel_msg_id is unique. Avoids cross-provider collisions.
    unique('messages_inbox_channel_msg_unique').on(t.inboxId, t.channelMsgId),
  ],
);

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
