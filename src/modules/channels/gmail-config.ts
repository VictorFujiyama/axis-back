import { z } from 'zod';

import { isValidTimezone } from './inbox-cap-time.js';

export const DEFAULT_GMAIL_DAILY_SEND_CAP = 50;
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/**
 * Per-field `.catch()` is intentional — a single invalid value (e.g. a stale
 * row with `dailySendCap: 99999` written by a pre-validation path) should NOT
 * wipe out the rest of the config in the read path. Invalid fields drop to
 * undefined; `effective*()` resolvers fall back to defaults.
 */
export const GmailConfigSchema = z
  .object({
    provider: z.literal('gmail'),
    gmailEmail: z.string().email().optional().catch(undefined),
    gmailHistoryId: z.string().nullable().optional().catch(undefined),
    needsReauth: z.boolean().optional().catch(undefined),
    fromName: z.string().min(1).max(120).optional().catch(undefined),
    /**
     * Max emails per day for this inbox. Counts both manual and journey sends —
     * the cap is meant to protect against the real Gmail outbound limit (Free
     * tier: 500/day, Workspace: 2000/day). `0` means fully paused (no sends).
     * `undefined`/`null` means no cap (callers must log/metric a Gmail inbox
     * with no cap as a deviation from policy).
     */
    dailySendCap: z.number().int().min(0).max(10000).optional().catch(undefined),
    /**
     * IANA timezone used to compute the local "day" the cap counter resets.
     * Validated against the runtime's timezone database via luxon — invalid
     * zones (e.g. abbreviations like "EST") fall through to DEFAULT_TIMEZONE
     * via `effectiveTimezone()` rather than wiping the parse.
     */
    timezone: z
      .string()
      .refine(isValidTimezone, 'invalid IANA timezone')
      .optional()
      .catch(undefined),
  })
  .passthrough();

export type GmailConfig = z.infer<typeof GmailConfigSchema>;

export function parseGmailConfig(raw: unknown): GmailConfig | Record<string, never> {
  return GmailConfigSchema.safeParse(raw).data ?? {};
}

/**
 * Resolves the effective cap to apply at runtime. Returns:
 *  - `null` when no cap should be enforced (legacy/non-Gmail inboxes that
 *    weren't migrated, or explicit opt-out by setting undefined).
 *  - the user-configured value otherwise (including 0 = fully paused).
 */
export function effectiveDailySendCap(cfg: GmailConfig | Record<string, never>): number | null {
  const v = (cfg as GmailConfig).dailySendCap;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export function effectiveTimezone(cfg: GmailConfig | Record<string, never>): string {
  const v = (cfg as GmailConfig).timezone;
  return typeof v === 'string' && isValidTimezone(v) ? v : DEFAULT_TIMEZONE;
}

export const GmailSecretsSchema = z
  .object({
    refreshToken: z.string().min(1),
    accessToken: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .passthrough();

export type GmailSecrets = z.infer<typeof GmailSecretsSchema>;

export function parseGmailSecrets(raw: unknown): GmailSecrets | Record<string, never> {
  return GmailSecretsSchema.safeParse(raw).data ?? {};
}
