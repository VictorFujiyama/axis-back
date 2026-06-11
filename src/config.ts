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
  // Gmail Push Notifications via Cloud Pub/Sub. When set, OAuth callback
  // chama `users.watch({topicName})` registrando push pra esta inbox; o
  // endpoint POST /api/v1/webhooks/gmail-push valida o JWT OIDC enviado
  // pelo Pub/Sub e enfileira gmail-sync imediato. Sem essas vars, push
  // não ativa e polling de 60s continua sendo o único caminho.
  // - GCP_PROJECT_ID: project que hospeda o topic (mesmo do OAuth)
  // - GMAIL_PUBSUB_TOPIC: full path `projects/<id>/topics/<name>`
  // - GMAIL_PUBSUB_AUDIENCE: URL exata do endpoint webhook (audience
  //   claim do JWT enviado pelo Pub/Sub). Tem que bater EXATAMENTE com
  //   o que está configurado na subscription Push do lado GCP.
  GCP_PROJECT_ID: z.string().optional(),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_PUBSUB_AUDIENCE: z.string().url().optional(),
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
  // ---- Atlas integration (Phase 12.2 — Connector Bridge, per-account) ----
  // Base URL of the Atlas instance the connector emits to / pulls from
  // (e.g. https://atlas-company-os.vercel.app). Distinct from ATLAS_BASE_URL
  // (legacy Phase A/B leg) so the connector and Phase B paths can target
  // different hosts. This is now the connector's MASTER SWITCH: when set, the
  // emit/inbound/backfill paths go live and resolve org + HMAC secret PER
  // ACCOUNT from `atlas_connections` (Connect Flow T-10 retired the per-org env
  // globals ATLAS_ORG_ID/ATLAS_HMAC_SECRET/ATLAS_SOURCE_ACCOUNT_ID and the
  // ATLAS_CONNECTOR_ENABLED/ATLAS_DUAL_EMIT switches — org/secret/source-account
  // are no longer boot config).
  ATLAS_URL: z.string().url().optional(),
  // Bearer token for pulling Atlas memory via the scoped MCP endpoint
  // (POST /api/connectors/atlas-mcp). 43 base64url chars from Berg. Optional —
  // the MCP pull helper no-ops without it; not required for emit/handshake.
  ATLAS_MCP_BEARER: z.string().min(20).optional(),
  // ---- playbook-in-axis feature flag (D37/D40) ----
  // Master switch for the playbook-in-axis feature: axis owns the messaging
  // playbook (inbox_playbooks table) + auto-bot lifecycle, and the Atlas worker
  // reads it via the `messaging.get_inbox_playbook` MCP tool. Default `true`
  // (feature on after deploy). Flip to `false` as a fast rollback WITHOUT a
  // revert: PATCH inbox playbook returns 400 "feature disabled", auto-bot logic
  // is skipped, and the MCP tool returns `{exists: false}` so the Atlas worker
  // degrades gracefully to its legacy `readPlaybook` fallback.
  // Enum-string instead of `z.coerce.boolean()` because the latter coerces the
  // literal string `'false'` to `true` (any non-empty string is truthy) — which
  // would silently defeat the rollback path. Mirrors MCP_SERVER_ENABLED /
  // USE_PHASE_12_ENVELOPE / ALLOW_UNSIGNED_WEBHOOKS above.
  PLAYBOOK_IN_AXIS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // One-time backfill endpoint shared secret (D34). The backfill script signs
  // each request `X-Backfill-Signature: hex(hmac-sha256(rawBody, secret))`; the
  // POST /api/v1/internal/backfill/inbox-playbook route verifies it over the
  // exact signed bytes (no JWT). Optional so envs that never run the one-shot
  // atlas→axis playbook migration boot fine — the route returns 503 when unset.
  // min(32) keeps the HMAC key from being trivially brute-forceable.
  BACKFILL_SHARED_SECRET: z.string().min(32).optional(),
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

// Connect Flow (Phase 12.2 per-account): the connector no longer has a boot
// precheck. ATLAS_URL alone gates the path; org id, HMAC secret, and the source
// account are resolved per request from `atlas_connections`, so a half-config
// can't leak another tenant's traffic — an org with no connection just 401s.

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
