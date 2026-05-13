import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3200),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY must be 32 chars (ASCII) or 64 hex chars'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3201')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  ENABLED_MODULES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  TWILIO_API_URL: z
    .string()
    .url()
    .default('https://api.twilio.com')
    .refine(
      (v) =>
        process.env.NODE_ENV !== 'production' || v.startsWith('https://'),
      { message: 'TWILIO_API_URL must use https:// in production' },
    ),
  PUBLIC_API_URL: z.string().url().optional(),
  // Opt-in flag to accept unsigned webhooks in non-production (dev/staging).
  // Without this, missing authToken rejects the webhook. Prevents staging envs
  // that forgot NODE_ENV=production from becoming an open forgery surface.
  ALLOW_UNSIGNED_WEBHOOKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Outbound email (transcripts). Optional: if SMTP_HOST is unset, transcript
  // routes reject with 503 "SMTP not configured" so the frontend surfaces the
  // real reason instead of dropping silently.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // LLM provider API keys (global fallback — per-bot keys take priority)
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  BOT_LLM_TIMEOUT_MS: z.coerce.number().default(30_000),
  // Google OAuth (only required when a Gmail email channel is in use).
  // Routes under /api/v1/oauth/google/* return 503 when any of these is missing.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  // Public base URL of the frontend — used by the OAuth callback to redirect
  // the user back into the app after Google consent. Required for /oauth/google/*.
  FRONT_URL: z.string().url().optional(),
  // Shared secret presented by Atlas as `X-API-Key` on /api/auth/* endpoints
  // dedicated to Atlas linking (check-email, verify-credentials,
  // create-from-atlas). Optional so dev/test envs without the integration boot
  // fine; the requireAtlasApiKey middleware refuses requests when unset.
  ATLAS_API_KEY: z.string().optional(),
  // Base URL of the Atlas instance the playbook fetcher targets
  // (e.g. http://localhost:3010 in dev). When unset, the fetcher returns
  // null without making any network call, so bots silently fall back to
  // `cfg.systemPrompt`. Pairs with ATLAS_API_KEY for `X-API-Key` auth.
  ATLAS_BASE_URL: z.string().url().optional(),
  // Shared HMAC secret used to sign outbound messaging events posted to
  // Atlas at `${ATLAS_BASE_URL}${ATLAS_EVENTS_ENDPOINT}`. When unset, the
  // atlas-events enqueuer subscribes no listeners and the worker is a
  // no-op — the integration is "off" without touching Atlas.
  ATLAS_EVENTS_HMAC_SECRET: z.string().min(16).optional(),
  // Path on Atlas where the atlas-events worker POSTs envelopes. Default is
  // the Phase B endpoint `/api/messaging/events` that ships in prod today.
  // Flip to `/api/connectors/messaging/events` once Phase 12 connector
  // receiver lands Atlas-side — pair with USE_PHASE_12_ENVELOPE=true so the
  // payload shape matches.
  ATLAS_EVENTS_ENDPOINT: z.string().default('/api/messaging/events'),
  // HS256 secret shared with Atlas to verify the short-lived `atlas_token`
  // JWTs Atlas signs for the messaging iframe (kind: "atlas-iframe"). Atlas
  // calls it `AXIS_JWT_SECRET` on its side. Optional so envs without the
  // integration boot fine; the requireAtlasIframeAuth middleware refuses
  // requests when unset.
  AXIS_JWT_SECRET: z.string().optional(),
  // Master switch for the Phase D MCP server route (/mcp). Default false so
  // dormant envs without the integration boot fine. Flip to true in Render
  // once Atlas Phase 11+12 are merged and the `mcp_servers` row is provisioned.
  // Mirrors the ALLOW_UNSIGNED_WEBHOOKS enum-string pattern instead of
  // `z.coerce.boolean()` because the latter coerces `'false'` → `true`.
  MCP_SERVER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Shared HMAC secret Atlas signs MCP requests with (header `X-Atlas-Signature`).
  // Kept separate from ATLAS_EVENTS_HMAC_SECRET for separation of concerns
  // (rotating one channel must not invalidate the other). Required only when
  // MCP_SERVER_ENABLED=true AND MCP_AUTH_MODE='hmac'; for MCP_AUTH_MODE='both'
  // the boot check WARNS rather than throws (Bearer-only runtime, HMAC
  // fallback unavailable but boot succeeds).
  ATLAS_MCP_HMAC_SECRET: z.string().min(16).optional(),
  // Static Bearer token Atlas Phase 11 attaches via `mcp_servers.headers`
  // JSON `{"Authorization":{"ref":"env://MCP_AXIS_API_KEY"}}`. Required when
  // MCP_SERVER_ENABLED=true AND MCP_AUTH_MODE in ['bearer','both']. Phase 11
  // resolves headers once at worker boot, so HMAC dynamic per-request signing
  // isn't viable without patching `@atlas/mcp` (out of scope) — Bearer is the
  // primary auth path for Phase D Activation.
  MCP_AXIS_API_KEY: z.string().min(16).optional(),
  // Auth mode for the inbound MCP `/mcp` route preHandler. `bearer` accepts
  // only `Authorization: Bearer <MCP_AXIS_API_KEY>`. `hmac` accepts only
  // `X-Atlas-Signature` (Phase B HMAC primitive). `both` (default during
  // migration) tries Bearer first, falls through to HMAC if the Authorization
  // header is absent; if Bearer header is present-but-invalid it fails hard
  // without HMAC fallback. Kept as a runtime kill-switch — see LESSONS L-505.
  MCP_AUTH_MODE: z.enum(['hmac', 'bearer', 'both']).default('both'),
  // Phase D.1 envelope shape toggle. `false` (default) keeps the Phase B
  // literal mapping (`type: 'message_sent' | 'handoff_to_human' |
  // 'conversation_resolved'`) that the in-prod `/api/messaging/events`
  // endpoint accepts. Flip to `true` once Atlas Phase 12 connector receiver
  // ships and pair with ATLAS_EVENTS_ENDPOINT=/api/connectors/messaging/events.
  // Worker `serializeJob` dual-shape narrowing handles both during drain.
  // Enum-string instead of `z.coerce.boolean()` because the latter coerces
  // the literal string `'false'` to `true` (any non-empty string is truthy).
  USE_PHASE_12_ENVELOPE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export const config: Config = envSchema.parse(process.env);

// Mode-aware MCP auth precheck. Caught at boot rather than first request so a
// misconfigured deploy crash-loops loudly instead of silently 401-ing every
// Atlas MCP call. `both` + HMAC secret unset is a WARN (Bearer-only runtime),
// not a throw — Felipe can activate Phase D without provisioning HMAC.
if (config.MCP_SERVER_ENABLED) {
  const mode = config.MCP_AUTH_MODE;
  if ((mode === 'bearer' || mode === 'both') && !config.MCP_AXIS_API_KEY) {
    throw new Error(
      `MCP_SERVER_ENABLED=true with MCP_AUTH_MODE=${mode} requires MCP_AXIS_API_KEY (min 16 chars).`,
    );
  }
  if (mode === 'hmac' && !config.ATLAS_MCP_HMAC_SECRET) {
    throw new Error(
      'MCP_SERVER_ENABLED=true with MCP_AUTH_MODE=hmac requires ATLAS_MCP_HMAC_SECRET (min 16 chars).',
    );
  }
  if (mode === 'both' && !config.ATLAS_MCP_HMAC_SECRET) {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] MCP_AUTH_MODE=both but ATLAS_MCP_HMAC_SECRET unset — Bearer-only at runtime, HMAC fallback unavailable.',
    );
  }
}

// Safety net: refuse to boot in production with weak or dev-default secrets.
if (config.NODE_ENV === 'production') {
  const weakDefaults = [/^dev_/, /change_me/i, /__blossom_dummy__/];
  for (const pattern of weakDefaults) {
    if (pattern.test(config.JWT_SECRET) || pattern.test(config.ENCRYPTION_KEY)) {
      throw new Error(
        'Refusing to start in production with weak default secrets. Set strong JWT_SECRET and ENCRYPTION_KEY.',
      );
    }
  }
}
