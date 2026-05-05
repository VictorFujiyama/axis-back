import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { config } from '../../../config.js';
import { encryptJSON } from '../../../crypto.js';
import { type GmailSyncJob, QUEUE_NAMES } from '../../../queue/index.js';
import { parseGmailConfig } from '../../channels/gmail-config.js';
import {
  exchangeCode,
  type ExchangeCodeResult,
  getUserInfo,
  GoogleOAuthError,
  type UserInfoResult,
} from './client.js';
import {
  ExpiredStateError,
  InvalidStateError,
  signState,
  verifyState,
} from './state.js';

export type ExchangeCodeImpl = (code: string) => Promise<ExchangeCodeResult>;
export type GetUserInfoImpl = (accessToken: string) => Promise<UserInfoResult>;

export interface GoogleOAuthRoutesOptions {
  /** Override the Google token-exchange wrapper. Test-only DI. */
  exchangeCodeImpl?: ExchangeCodeImpl;
  /** Override the Google userinfo wrapper. Test-only DI. */
  getUserInfoImpl?: GetUserInfoImpl;
}

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// gmail.modify is strictly broader than readonly+send: we need it to mark
// messages as read after ingest. userinfo.email captures the authenticated
// address for `config.gmailEmail` and outbound `From`.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const authorizeQuery = z.object({
  inboxName: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(80)),
  inboxId: z.string().uuid().optional(),
});

const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

const reauthorizeBody = z.object({
  inboxId: z.string().uuid(),
});

export async function googleOAuthRoutes(
  app: FastifyInstance,
  opts: GoogleOAuthRoutesOptions = {},
): Promise<void> {
  const exchange: ExchangeCodeImpl = opts.exchangeCodeImpl ?? exchangeCode;
  const fetchUserInfo: GetUserInfoImpl = opts.getUserInfoImpl ?? getUserInfo;

  app.get(
    '/api/v1/oauth/google/authorize',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (
        !config.GOOGLE_OAUTH_CLIENT_ID ||
        !config.GOOGLE_OAUTH_CLIENT_SECRET ||
        !config.GOOGLE_OAUTH_REDIRECT_URI
      ) {
        return reply.serviceUnavailable('Google OAuth not configured');
      }

      const parsed = authorizeQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.badRequest(
          parsed.error.issues[0]?.message ?? 'invalid query',
        );
      }
      const { inboxName, inboxId } = parsed.data;

      // Reauth branch: confirm the caller owns the target inbox before we let
      // their browser bounce off Google with this id baked into the state.
      // The accountId filter is the security boundary — a missing row means
      // either "doesn't exist" or "belongs to another account", both surface
      // as 403 (don't leak existence).
      if (inboxId) {
        const [owned] = await app.db
          .select()
          .from(schema.inboxes)
          .where(
            and(
              eq(schema.inboxes.id, inboxId),
              eq(schema.inboxes.accountId, req.user.accountId),
              isNull(schema.inboxes.deletedAt),
            ),
          )
          .limit(1);
        if (!owned) {
          return reply.forbidden('Inbox not found or not owned by caller');
        }
      }

      const state = signState({
        accountId: req.user.accountId,
        userId: req.user.sub,
        inboxName,
        inboxId: inboxId ?? null,
        nonce: randomBytes(16).toString('hex'),
        ts: Date.now(),
      });

      const params = new URLSearchParams({
        client_id: config.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: config.GOOGLE_OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return reply.redirect(`${GOOGLE_AUTHORIZE_URL}?${params.toString()}`, 302);
    },
  );

  app.get('/api/v1/oauth/google/callback', async (req, reply) => {
    if (
      !config.GOOGLE_OAUTH_CLIENT_ID ||
      !config.GOOGLE_OAUTH_CLIENT_SECRET ||
      !config.GOOGLE_OAUTH_REDIRECT_URI ||
      !config.FRONT_URL
    ) {
      return reply.serviceUnavailable('Google OAuth not configured');
    }

    const parsed = callbackQuery.safeParse(req.query);
    if (!parsed.success || !parsed.data.state) {
      return reply.badRequest('state-invalid');
    }
    const { state, error } = parsed.data;

    // State validation runs first — even when ?error= is present, an attacker
    // could otherwise bounce off a forged callback to phish the user back to
    // the frontend.
    let payload;
    try {
      payload = verifyState(state);
    } catch (err) {
      if (err instanceof InvalidStateError || err instanceof ExpiredStateError) {
        return reply.badRequest('state-invalid');
      }
      throw err;
    }

    if (error) {
      const params = new URLSearchParams({ error });
      return reply.redirect(
        `${config.FRONT_URL}/settings/inboxes/oauth/callback?${params.toString()}`,
        302,
      );
    }

    const { code } = parsed.data;
    if (!code) {
      return reply.badRequest('code-missing');
    }

    let tokens: ExchangeCodeResult;
    try {
      tokens = await exchange(code);
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        req.log.warn(
          { status: err.status, code: err.code },
          'gmail callback: code exchange failed',
        );
        return reply.badGateway('google oauth exchange failed');
      }
      throw err;
    }

    let userInfo: UserInfoResult;
    try {
      userInfo = await fetchUserInfo(tokens.accessToken);
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        req.log.warn(
          { status: err.status, code: err.code },
          'gmail callback: userinfo failed',
        );
        return reply.badGateway('google userinfo failed');
      }
      throw err;
    }

    const expiresAt = new Date(
      Date.now() + tokens.expiresIn * 1000,
    ).toISOString();
    const secrets = encryptJSON({
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt,
    });

    if (payload.inboxId) {
      // Reauth: rotate secrets and clear needsReauth on the existing row.
      // The accountId+deletedAt filters are defense-in-depth — authorize
      // already gated ownership before issuing the state, but the row could
      // have been deleted in the 10-minute state TTL.
      const [existing] = await app.db
        .select()
        .from(schema.inboxes)
        .where(
          and(
            eq(schema.inboxes.id, payload.inboxId),
            eq(schema.inboxes.accountId, payload.accountId),
            isNull(schema.inboxes.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) {
        return reply.notFound('inbox not found');
      }

      const patchedConfig = {
        ...parseGmailConfig(existing.config),
        needsReauth: false,
      };

      await app.db
        .update(schema.inboxes)
        .set({ secrets, config: patchedConfig, updatedAt: new Date() })
        .where(eq(schema.inboxes.id, payload.inboxId));

      await scheduleGmailSync(app, payload.inboxId);
      return reply.redirect(buildSuccessRedirect(payload.inboxId), 302);
    }

    const inserted = await app.db
      .insert(schema.inboxes)
      .values({
        accountId: payload.accountId,
        name: payload.inboxName,
        channelType: 'email',
        config: {
          provider: 'gmail',
          gmailEmail: userInfo.email,
          gmailHistoryId: null,
          needsReauth: false,
        },
        secrets,
      })
      .returning();
    const created = inserted[0];
    if (!created) {
      // Postgres returned no row from a non-conflicting insert — treat as a
      // server error rather than redirecting with a missing inboxId.
      return reply.internalServerError('inbox insert returned no row');
    }

    await scheduleGmailSync(app, created.id);
    return reply.redirect(buildSuccessRedirect(created.id), 302);
  });

  app.post(
    '/api/v1/oauth/google/reauthorize',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = reauthorizeBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(
          parsed.error.issues[0]?.message ?? 'invalid body',
        );
      }
      const { inboxId } = parsed.data;

      // Same ownership shape as the authorize reauth branch: a missing row
      // (deleted, wrong account) surfaces as 403 — don't leak existence.
      const [owned] = await app.db
        .select()
        .from(schema.inboxes)
        .where(
          and(
            eq(schema.inboxes.id, inboxId),
            eq(schema.inboxes.accountId, req.user.accountId),
            isNull(schema.inboxes.deletedAt),
          ),
        )
        .limit(1);
      if (!owned) {
        return reply.forbidden('Inbox not found or not owned by caller');
      }

      const params = new URLSearchParams({
        inboxName: owned.name,
        inboxId,
      });
      return reply.redirect(
        `/api/v1/oauth/google/authorize?${params.toString()}`,
        302,
      );
    },
  );
}

function buildSuccessRedirect(inboxId: string): string {
  // FRONT_URL is gated by the 503 check at the top of the handler, so it's
  // guaranteed to be set when we get here. Trim a trailing slash so a value
  // like `https://app.example.com/` doesn't produce a double slash.
  const base = config.FRONT_URL!.replace(/\/$/, '');
  const params = new URLSearchParams({ ok: '1', inboxId });
  return `${base}/settings/inboxes/oauth/callback?${params.toString()}`;
}

async function scheduleGmailSync(
  app: FastifyInstance,
  inboxId: string,
): Promise<void> {
  // upsertJobScheduler is idempotent on the scheduler id — same call works for
  // create (first time) and reauth (re-arms an inbox whose schedule may have
  // been drained). Repeats every 60s per spec § "Sync worker".
  await app.queues
    .getQueue<GmailSyncJob>(QUEUE_NAMES.GMAIL_SYNC)
    .upsertJobScheduler(
      `gmail-sync:${inboxId}`,
      { every: 60_000 },
      { name: 'sync', data: { inboxId } },
    );
}
