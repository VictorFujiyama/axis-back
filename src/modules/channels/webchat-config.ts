import type {
  WebchatConfig,
  WebchatLocale,
  WebchatPreChatField,
} from '@blossom/shared-types';

export const DEFAULT_PRIMARY_COLOR = '#7b3fa9';
export const DEFAULT_GREETING = 'Olá! Como podemos ajudar?';
export const DEFAULT_TAGLINE = 'Resposta em alguns minutos';
export const DEFAULT_LOCALE: WebchatLocale = 'pt-BR';
export const DEFAULT_AWAY_MESSAGE = 'Estamos ausentes no momento';
export const DEFAULT_PRECHAT_MESSAGE = 'Antes de começar, conte um pouco sobre você';
export const DEFAULT_ATTACHMENT_MAX_MB = 10;
export const DEFAULT_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
];

export interface ResolvedWebchatConfig {
  widgetToken?: string;
  primaryColor: string;
  greeting: string;
  tagline: string;
  greetingEnabled: boolean;
  locale: WebchatLocale;
  allowedOrigins: string[];
  hmac: { enabled: boolean; mandatory: boolean };
  preChat: {
    enabled: boolean;
    message: string;
    fields: { name: WebchatPreChatField; email: WebchatPreChatField };
  };
  availability: { showStatus: boolean; awayMessage: string };
  csat: { enabled: boolean };
  attachments: { enabled: boolean; maxSizeMb: number; allowedTypes: string[] };
  continuityViaEmail: boolean;
  branding: { showPoweredBy: boolean };
}

/**
 * Read and normalize a webchat inbox's `config`, applying spec §3 defaults.
 * Single source of truth for session/send/attachment/csat. Secrets stay out.
 */
export function webchatConfig(raw: unknown): ResolvedWebchatConfig {
  const c: WebchatConfig = raw && typeof raw === 'object' ? (raw as WebchatConfig) : {};
  const name = c.preChat?.fields?.name;
  const email = c.preChat?.fields?.email;
  return {
    widgetToken: c.widgetToken,
    primaryColor: c.primaryColor ?? DEFAULT_PRIMARY_COLOR,
    greeting: c.greeting ?? DEFAULT_GREETING,
    tagline: c.tagline ?? DEFAULT_TAGLINE,
    greetingEnabled: c.greetingEnabled ?? true,
    locale: c.locale ?? DEFAULT_LOCALE,
    allowedOrigins: Array.isArray(c.allowedOrigins) ? c.allowedOrigins : [],
    hmac: {
      enabled: c.hmac?.enabled ?? false,
      mandatory: c.hmac?.mandatory ?? false,
    },
    preChat: {
      enabled: c.preChat?.enabled ?? false,
      message: c.preChat?.message ?? DEFAULT_PRECHAT_MESSAGE,
      fields: {
        name: { enabled: name?.enabled ?? true, required: name?.required ?? true },
        email: { enabled: email?.enabled ?? true, required: email?.required ?? false },
      },
    },
    availability: {
      showStatus: c.availability?.showStatus ?? true,
      awayMessage: c.availability?.awayMessage ?? DEFAULT_AWAY_MESSAGE,
    },
    csat: { enabled: c.csat?.enabled ?? false },
    attachments: {
      enabled: c.attachments?.enabled ?? true,
      maxSizeMb: c.attachments?.maxSizeMb ?? DEFAULT_ATTACHMENT_MAX_MB,
      allowedTypes:
        Array.isArray(c.attachments?.allowedTypes) && c.attachments.allowedTypes.length > 0
          ? c.attachments.allowedTypes
          : DEFAULT_ATTACHMENT_TYPES,
    },
    continuityViaEmail: c.continuityViaEmail ?? false,
    branding: { showPoweredBy: c.branding?.showPoweredBy ?? true },
  };
}

/**
 * Public widget settings returned by /session. Secrets (widgetToken, hmacToken),
 * the origin allowlist, and server-only attachment limits stay server-side.
 */
export function publicWidgetSettings(config: ResolvedWebchatConfig) {
  return {
    primaryColor: config.primaryColor,
    greeting: config.greeting,
    tagline: config.tagline,
    greetingEnabled: config.greetingEnabled,
    locale: config.locale,
    availability: {
      showStatus: config.availability.showStatus,
      awayMessage: config.availability.awayMessage,
    },
    preChat: config.preChat,
    attachments: { enabled: config.attachments.enabled },
    csat: { enabled: config.csat.enabled },
    branding: { showPoweredBy: config.branding.showPoweredBy },
  };
}
