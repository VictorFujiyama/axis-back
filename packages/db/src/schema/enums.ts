import { pgEnum } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['admin', 'supervisor', 'agent']);

export const accountStatusEnum = pgEnum('account_status', ['active', 'suspended']);

export const userStatusEnum = pgEnum('user_status', ['online', 'busy', 'offline']);

export const channelTypeEnum = pgEnum('channel_type', [
  'whatsapp',
  'email',
  'instagram',
  'messenger',
  'telegram',
  'webchat',
  'sms',
  'api',
]);

export const conversationStatusEnum = pgEnum('conversation_status', [
  'open',
  'pending',
  'resolved',
  'snoozed',
]);

export const conversationPriorityEnum = pgEnum('conversation_priority', [
  'low',
  'medium',
  'high',
  'urgent',
]);

export const senderTypeEnum = pgEnum('sender_type', ['contact', 'user', 'bot', 'system']);

export const botTypeEnum = pgEnum('bot_type', ['external', 'builtin']);

export const messageContentTypeEnum = pgEnum('message_content_type', [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'location',
  'template',
]);
