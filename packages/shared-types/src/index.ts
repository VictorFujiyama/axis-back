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

export type WebchatLocale = 'pt-BR' | 'en';

export interface WebchatPreChatField {
  enabled: boolean;
  required: boolean;
}

/** Stored shape of a webchat inbox's `config` (spec §3). Fields are optional as
 * persisted; defaults are applied server-side. Secrets live in `inbox.secrets`. */
export interface WebchatConfig {
  widgetToken?: string;
  primaryColor?: string;
  greeting?: string;
  tagline?: string;
  greetingEnabled?: boolean;
  locale?: WebchatLocale;
  allowedOrigins?: string[];
  hmac?: { enabled?: boolean; mandatory?: boolean };
  preChat?: {
    enabled?: boolean;
    message?: string;
    fields?: { name?: WebchatPreChatField; email?: WebchatPreChatField };
  };
  availability?: { showStatus?: boolean; awayMessage?: string };
  csat?: { enabled?: boolean };
  attachments?: { enabled?: boolean; maxSizeMb?: number; allowedTypes?: string[] };
  continuityViaEmail?: boolean;
  branding?: { showPoweredBy?: boolean };
  backgroundColor?: string | null;
  agentBubbleColor?: string | null;
  themeMode?: WebchatThemeMode;
  bubbleColor?: string | null;
  bubblePosition?: WebchatBubblePosition;
  launcherLabel?: string;
  headerTitle?: string | null;
  headerSubtitle?: string | null;
  showAvatar?: boolean;
  avatarUrl?: string;
}

export type WebchatThemeMode = 'light' | 'dark';
export type WebchatBubblePosition = 'right' | 'left';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptime: number;
  checks: {
    db: 'ok' | 'down';
    redis: 'ok' | 'down';
  };
}
