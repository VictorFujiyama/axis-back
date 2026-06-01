import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { BotProvider } from './auto-bot';

/**
 * Opt-in LLM API-key smoke validation (D17/D43).
 *
 * Fires a 1-token completion against the provider so an obviously-bad key is
 * caught at PATCH time instead of degrading the first real conversation into a
 * fallback message. Auth failures (401/403) are distinguished from transient /
 * upstream errors so the route can answer 400 ("invalid api key") vs 502.
 */

const SMOKE_TIMEOUT_MS = 5_000;

export type ValidateApiKeyResult =
  | { ok: true }
  | { ok: false; kind: 'auth'; message: string }
  | { ok: false; kind: 'error'; message: string };

export async function validateApiKey(
  provider: BotProvider,
  apiKey: string,
  model: string,
): Promise<ValidateApiKeyResult> {
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey, timeout: SMOKE_TIMEOUT_MS, maxRetries: 0 });
      await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      });
    } else {
      const client = new OpenAI({ apiKey, timeout: SMOKE_TIMEOUT_MS, maxRetries: 0 });
      await client.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      });
    }
    return { ok: true };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { ok: false, kind: 'auth', message: 'invalid api key' };
    }
    return { ok: false, kind: 'error', message: (err as Error)?.message ?? 'provider validation failed' };
  }
}
