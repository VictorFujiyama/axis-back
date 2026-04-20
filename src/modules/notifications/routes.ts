import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unreadOnly: z.coerce.boolean().default(false),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/notifications',
    { preHandler: app.requireAuth },
    async (req) => {
      const q = listQuery.parse(req.query);
      const where = [eq(schema.notifications.userId, req.user.sub), eq(schema.notifications.accountId, req.user.accountId)];
      if (q.unreadOnly) where.push(isNull(schema.notifications.readAt));
      const rows = await app.db
        .select()
        .from(schema.notifications)
        .where(and(...where))
        .orderBy(desc(schema.notifications.createdAt))
        .limit(q.limit);

      const [{ count: unread }] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, req.user.sub),
            eq(schema.notifications.accountId, req.user.accountId),
            isNull(schema.notifications.readAt),
          ),
        );
      return { items: rows, unread };
    },
  );

  app.post(
    '/api/v1/notifications/:id/read',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      await app.db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.userId, req.user.sub),
            eq(schema.notifications.accountId, req.user.accountId),
          ),
        );
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/notifications/read-all',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      await app.db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(schema.notifications.userId, req.user.sub),
            eq(schema.notifications.accountId, req.user.accountId),
            isNull(schema.notifications.readAt),
          ),
        );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/notifications',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      await app.db
        .delete(schema.notifications)
        .where(and(eq(schema.notifications.userId, req.user.sub), eq(schema.notifications.accountId, req.user.accountId)));
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/notifications/read',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      await app.db
        .delete(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, req.user.sub),
            eq(schema.notifications.accountId, req.user.accountId),
            isNotNull(schema.notifications.readAt),
          ),
        );
      return reply.code(204).send();
    },
  );
}
