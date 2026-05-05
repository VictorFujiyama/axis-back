import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
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
  inboxId: z.string().uuid().optional(),
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
}
