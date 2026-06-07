import type { ChannelType } from '@blossom/shared-types';

/**
 * Decides whether an inbox has the minimum credentials to send outbound on its
 * channel (D2). Used by the Atlas MCP `messaging.list_inboxes` tool to surface a
 * `configured` flag so the journey builder can gate / warn on unconfigured inboxes.
 *
 * IMPORTANT: secrets live in `inboxes.secrets` (AES-256-GCM encrypted text),
 * separate from the public `inboxes.config` jsonb. The caller is responsible for
 * decrypting (`decryptJSON`) before passing `secrets` here. This helper is pure:
 * no health-check, no provider round-trip — it only inspects shape (D2).
 *
 * Channels without an outbound sender (sms/instagram/messenger/webchat/api)
 * always return false.
 */
export function isInboxConfigured(
  channelType: ChannelType,
  config: unknown,
  secrets: unknown,
): boolean {
  const c = asObject(config);
  const s = asObject(secrets);

  switch (channelType) {
    case 'whatsapp':
      // Twilio: account SID + auth token + a sending identity
      // (a from-number OR a messaging service SID).
      return (
        nonEmpty(c.accountSid) &&
        nonEmpty(s.authToken) &&
        (nonEmpty(c.fromNumber) || nonEmpty(c.messagingServiceSid))
      );
    case 'email': {
      const provider = typeof c.provider === 'string' ? c.provider : undefined;
      if (provider === 'gmail') {
        // Gmail OAuth: a refresh token is enough to mint access tokens.
        return nonEmpty(s.refreshToken);
      }
      // Postmark (default) and legacy inboxes without an explicit provider.
      return nonEmpty(s.serverToken);
    }
    case 'telegram':
      return nonEmpty(s.botToken);
    default:
      // sms / instagram / messenger / webchat / api: no outbound sender yet.
      return false;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}
