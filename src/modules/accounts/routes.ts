import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { hashPassword } from '../auth/password';
import { signAccessToken, issueRefreshTokenWithUser } from '../auth/tokens';

const createBody = z.object({
  name: z.string().min(1).max(100),
  locale: z.string().default('pt-BR'),
});

const updateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  locale: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
});

const idParams = z.object({ id: z.string().uuid() });

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // List accounts the current user belongs to
  app.get(
    '/api/v1/accounts',
    { preHandler: app.requireAuth },
    async (req) => {
      const memberships = await app.db
        .select({
          id: schema.accounts.id,
          name: schema.accounts.name,
          locale: schema.accounts.locale,
          status: schema.accounts.status,
          role: schema.accountUsers.role,
        })
        .from(schema.accountUsers)
        .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
        .where(eq(schema.accountUsers.userId, req.user.sub));

      return { items: memberships };
    },
  );

  // Get account details (must be member)
  app.get(
    '/api/v1/accounts/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);

      const [membership] = await app.db
        .select({
          accountId: schema.accounts.id,
          name: schema.accounts.name,
          locale: schema.accounts.locale,
          status: schema.accounts.status,
          settings: schema.accounts.settings,
          role: schema.accountUsers.role,
          createdAt: schema.accounts.createdAt,
        })
        .from(schema.accountUsers)
        .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
        .where(
          and(
            eq(schema.accountUsers.userId, req.user.sub),
            eq(schema.accountUsers.accountId, id),
          ),
        )
        .limit(1);

      if (!membership) return reply.notFound('Account not found or not a member');

      return {
        id: membership.accountId,
        name: membership.name,
        locale: membership.locale,
        status: membership.status,
        settings: membership.settings,
        role: membership.role,
        createdAt: membership.createdAt,
      };
    },
  );

  // Create a new account (any authenticated user can create)
  app.post(
    '/api/v1/accounts',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = createBody.parse(req.body);

      const result = await app.db.transaction(async (tx) => {
        const [account] = await tx
          .insert(schema.accounts)
          .values({ name: body.name, locale: body.locale })
          .returning();

        await tx.insert(schema.accountUsers).values({
          accountId: account!.id,
          userId: req.user.sub,
          role: 'admin',
        });

        return account!;
      });

      return reply.code(201).send({
        id: result.id,
        name: result.name,
        locale: result.locale,
        status: result.status,
      });
    },
  );

  // Update account (admin only within that account)
  app.patch(
    '/api/v1/accounts/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);

      // Verify caller is admin of this account
      const [membership] = await app.db
        .select({ role: schema.accountUsers.role })
        .from(schema.accountUsers)
        .where(
          and(
            eq(schema.accountUsers.userId, req.user.sub),
            eq(schema.accountUsers.accountId, id),
          ),
        )
        .limit(1);

      if (!membership) return reply.notFound('Account not found');
      if (membership.role !== 'admin') return reply.forbidden('Admin role required');

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.locale !== undefined) updates.locale = body.locale;
      if (body.settings !== undefined) updates.settings = body.settings;

      if (Object.keys(updates).length === 0) {
        return reply.badRequest('No fields to update');
      }

      updates.updatedAt = new Date();

      const [updated] = await app.db
        .update(schema.accounts)
        .set(updates)
        .where(eq(schema.accounts.id, id))
        .returning();

      return {
        id: updated!.id,
        name: updated!.name,
        locale: updated!.locale,
        status: updated!.status,
        settings: updated!.settings,
      };
    },
  );
}
