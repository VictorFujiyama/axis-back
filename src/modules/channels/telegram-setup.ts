import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config as appConfig } from '../../config';

interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Generate a cryptographically strong secret_token Telegram will echo back in
 * the `X-Telegram-Bot-Api-Secret-Token` header on every inbound webhook.
 * Alphanumeric, fits Telegram's allowed charset (1-256 chars of A-Z a-z 0-9 _ -).
 */
export function generateTelegramWebhookSecret(): string {
  return randomBytes(24).toString('base64url');
}

/** Registers (or re-registers) the webhook URL with Telegram for a given bot.
 * Idempotent: Telegram accepts repeated setWebhook calls for the same URL. */
export async function setTelegramWebhook(params: {
  botToken: string;
  webhookUrl: string;
  secretToken: string;
  log?: FastifyBaseLogger;
}): Promise<{ ok: boolean; description?: string }> {
  const { botToken, webhookUrl, secretToken, log } = params;
  try {
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${botToken}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secretToken,
          // Accept message + edited_message + channel_post so we can surface
          // basic updates. Others are ignored by the webhook handler today.
          allowed_updates: ['message', 'edited_message', 'channel_post'],
          // Don't drop pending updates — if the bot was just created, any
          // pre-existing updates would be irrelevant anyway.
          drop_pending_updates: false,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data = (await res.json().catch(() => ({}))) as TelegramApiResponse;
    if (!res.ok || !data.ok) {
      log?.warn(
        { status: res.status, telegramDescription: data.description },
        'telegram.setWebhook failed',
      );
      return { ok: false, description: data.description ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    log?.warn({ err }, 'telegram.setWebhook network error');
    return { ok: false, description: err instanceof Error ? err.message : 'network error' };
  }
}

/** Removes the webhook for a bot. Called on inbox delete so Telegram doesn't
 * keep hitting our soft-deleted inbox. */
export async function deleteTelegramWebhook(params: {
  botToken: string;
  log?: FastifyBaseLogger;
}): Promise<void> {
  const { botToken, log } = params;
  try {
    await fetch(
      `${TELEGRAM_API_BASE}/bot${botToken}/deleteWebhook?drop_pending_updates=true`,
      { method: 'POST', signal: AbortSignal.timeout(10_000) },
    );
  } catch (err) {
    log?.warn({ err }, 'telegram.deleteWebhook failed (ignored)');
  }
}

/** Builds the inbound webhook URL Telegram should POST to. Requires
 * PUBLIC_API_URL to be set (no fallback — the bot API requires HTTPS). */
export function telegramWebhookUrl(inboxId: string): string | null {
  if (!appConfig.PUBLIC_API_URL) return null;
  const base = appConfig.PUBLIC_API_URL.replace(/\/$/, '');
  return `${base}/webhooks/telegram/${inboxId}`;
}

export interface TelegramBotInfo {
  id: number;
  firstName: string;
  username?: string;
}

/** Validates a bot token by calling Telegram's getMe. Returns bot details on
 * success, null on failure. The browser can't call api.telegram.org directly
 * due to CORS, so the backend does it during inbox creation. */
export async function getTelegramBotInfo(
  botToken: string,
  log?: FastifyBaseLogger,
): Promise<TelegramBotInfo | null> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as TelegramApiResponse<{
      id: number;
      first_name: string;
      username?: string;
      is_bot: boolean;
    }>;
    if (!res.ok || !data.ok || !data.result || !data.result.is_bot) {
      log?.warn(
        { status: res.status, telegramDescription: data.description },
        'telegram.getMe failed',
      );
      return null;
    }
    return {
      id: data.result.id,
      firstName: data.result.first_name,
      username: data.result.username,
    };
  } catch (err) {
    log?.warn({ err }, 'telegram.getMe network error');
    return null;
  }
}
