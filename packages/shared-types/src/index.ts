export type UserRole = 'admin' | 'supervisor' | 'agent';
export type UserStatus = 'online' | 'busy' | 'offline';

export type ChannelType =
  | 'whatsapp'
  | 'email'
  | 'instagram'
  | 'messenger'
  | 'telegram'
  | 'webchat'
  | 'sms'
  | 'api';

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'snoozed';
export type ConversationPriority = 'low' | 'medium' | 'high' | 'urgent';

export type SenderType = 'contact' | 'user' | 'bot' | 'system';

export type MessageContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'location'
  | 'template';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptime: number;
  checks: {
    db: 'ok' | 'down';
    redis: 'ok' | 'down';
  };
}
