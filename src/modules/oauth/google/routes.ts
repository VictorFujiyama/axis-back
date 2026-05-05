import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { config } from '../../../config.js';
import {
  ExpiredStateError,
  InvalidStateError,
  signState,
  verifyState,
} from './state.js';

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

export async function googleOAuthRoutes(app: FastifyInstance): Promise<void> {
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
    try {
      verifyState(state);
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

    // T-18 will exchange the code here. Until then, surface a 501 so any
    // accidental hit (e.g. a manual run with a real Google round-trip) fails
    // loudly rather than hanging.
    return reply.notImplemented('code exchange not implemented (T-18)');
  });
}
