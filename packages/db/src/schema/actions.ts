import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { contacts } from './contacts';
import { conversations } from './conversations';
import { inboxes } from './inboxes';
import { users } from './users';

export const actionLogStatusEnum = pgEnum('action_log_status', ['success', 'error']);

export const customActions = pgTable('custom_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // unique key (slug-like)
  label: text('label').notNull(), // human display name
  icon: text('icon'), // lucide icon name (optional)
  color: text('color'), // hex (optional, for button)
  // JSON Schema-ish (subset). We keep our own minimal shape:
  //   { fields: [{ key, label, type: 'text'|'textarea'|'select'|'number', required?, options? }] }
  formSchema: jsonb('form_schema').notNull().default({ fields: [] }),
  webhookUrl: text('webhook_url').notNull(),
  // Encrypted HMAC secret used to sign outbound webhook payloads.
  secret: text('secret').notNull(),
  // Optional: restrict to a specific inbox (null = applies to all)
  inboxId: uuid('inbox_id').references(() => inboxes.id, { onDelete: 'cascade' }),
  // Minimum role required to execute (default: agent)
  requiresRole: text('requires_role').notNull().default('agent'),
  // If true, creates a Private Note in the conversation with the result
  postNoteOnSuccess: boolean('post_note_on_success').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const actionLogs = pgTable(
  'action_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => customActions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload').notNull().default({}),
    response: jsonb('response').notNull().default({}),
    status: actionLogStatusEnum('status').notNull(),
    errorMessage: text('error_message'),
    durationMs: text('duration_ms'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('action_logs_action_idx').on(t.actionId, t.executedAt)],
);

export type CustomAction = typeof customActions.$inferSelect;
export type NewCustomAction = typeof customActions.$inferInsert;
export type ActionLog = typeof actionLogs.$inferSelect;
