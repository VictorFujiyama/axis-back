import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../../config.js';
import { signState } from './state.js';

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
      const { inboxName } = parsed.data;

      const state = signState({
        accountId: req.user.accountId,
        userId: req.user.sub,
        inboxName,
        inboxId: null,
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
}
