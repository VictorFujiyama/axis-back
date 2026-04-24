import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { broadcastPresence } from '../../realtime/ws-routes';

// Chatwoot nests the body under `profile:` so we accept the same shape for
// drop-in compatibility with clients/tests built against the reference.
const availabilityBody = z.object({
  profile: z.object({
    account_id: z.string().uuid(),
    availability: z.enum(['online', 'busy', 'offline']),
  }),
});

const autoOfflineBody = z.object({
  profile: z.object({
    account_id: z.string().uuid(),
    auto_offline: z.boolean().optional(),
  }),
});

/**
 * Returns the full /auth/me-shaped user payload so clients can reuse the same
 * handler after mutation.
 */
async function buildUserPayload(app: FastifyInstance, userId: string, currentAccountId: string) {
  const [user] = await app.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) return null;

  const memberships = await app.db
    .select({
      accountId: schema.accountUsers.accountId,
      role: schema.accountUsers.role,
      accountName: schema.accounts.name,
      availability: schema.accountUsers.availability,
      autoOffline: schema.accountUsers.autoOffline,
    })
    .from(schema.accountUsers)
    .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
    .where(eq(schema.accountUsers.userId, userId));

  const current = memberships.find((m) => m.accountId === currentAccountId);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: current?.role ?? user.role,
    status: user.status,
    avatarUrl: user.avatarUrl,
    accountId: currentAccountId,
    accountName: current?.accountName ?? '',
    accounts: memberships.map((m) => ({
      id: m.accountId,
      name: m.accountName,
      role: m.role,
      availability: m.availability,
      auto_offline: m.autoOffline,
    })),
  };
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  // Set availability (online | busy | offline) for the current user in a specific account.
  // Mirrors Chatwoot's POST /api/v1/profile/availability.
  app.post(
    '/api/v1/profile/availability',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = availabilityBody.parse(req.body);
      // Reject cross-account writes — always scope to the account in the token.
      if (body.profile.account_id !== req.user.accountId) {
        return reply.forbidden('Cannot change availability for a different account');
      }

      const [membership] = await app.db
        .update(schema.accountUsers)
        .set({ availability: body.profile.availability, updatedAt: new Date() })
        .where(
          and(
            eq(schema.accountUsers.userId, req.user.sub),
            eq(schema.accountUsers.accountId, body.profile.account_id),
          ),
        )
        .returning({ id: schema.accountUsers.id });
      if (!membership) return reply.notFound();

      // Sync chosen status to Redis and broadcast.
      await app.presence.setStatus(req.user.accountId, req.user.sub, body.profile.availability);
      void broadcastPresence(app, req.user.accountId);

      const payload = await buildUserPayload(app, req.user.sub, req.user.accountId);
      if (!payload) return reply.notFound();
      return reply.send(payload);
    },
  );

  // Toggle auto_offline. When false, the chosen availability sticks even when
  // the socket drops (Chatwoot parity).
  app.post(
    '/api/v1/profile/auto_offline',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = autoOfflineBody.parse(req.body);
      if (body.profile.account_id !== req.user.accountId) {
        return reply.forbidden('Cannot change auto_offline for a different account');
      }

      const [membership] = await app.db
        .update(schema.accountUsers)
        .set({ autoOffline: body.profile.auto_offline ?? false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.accountUsers.userId, req.user.sub),
            eq(schema.accountUsers.accountId, body.profile.account_id),
          ),
        )
        .returning({ id: schema.accountUsers.id });
      if (!membership) return reply.notFound();

      // auto_offline flips change who's counted as "sticky" in getAvailableUsers —
      // rebroadcast so other agents see the recalculated list.
      void broadcastPresence(app, req.user.accountId);

      const payload = await buildUserPayload(app, req.user.sub, req.user.accountId);
      if (!payload) return reply.notFound();
      return reply.send(payload);
    },
  );
}
