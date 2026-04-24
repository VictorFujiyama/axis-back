import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
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

      // Enrich with conversation + contact data
      const convIds = rows
        .map((r) => (r.data as { conversationId?: string })?.conversationId)
        .filter((id): id is string => !!id);
      const uniqueConvIds = [...new Set(convIds)];

      type ConvInfo = { id: string; contactId: string; contactName: string | null; lastMessage: string | null; inboxName: string | null };
      const convMap: Record<string, ConvInfo> = {};
      if (uniqueConvIds.length > 0) {
        const convRows = await app.db
          .select({
            id: schema.conversations.id,
            contactId: schema.conversations.contactId,
            contactName: schema.contacts.name,
            inboxName: schema.inboxes.name,
            lastMessage: sql<string | null>`(
              SELECT content FROM messages
              WHERE messages.conversation_id = conversations.id
                AND messages.sender_type != 'system'
              ORDER BY messages.created_at DESC LIMIT 1
            )`.as('last_message'),
          })
          .from(schema.conversations)
          .innerJoin(schema.contacts, eq(schema.contacts.id, schema.conversations.contactId))
          .innerJoin(schema.inboxes, eq(schema.inboxes.id, schema.conversations.inboxId))
          .where(inArray(schema.conversations.id, uniqueConvIds));
        for (const r of convRows) {
          convMap[r.id] = r;
        }
      }

      const items = rows.map((r) => {
        const convId = (r.data as { conversationId?: string })?.conversationId;
        const conv = convId ? convMap[convId] : undefined;
        return {
          ...r,
          contactName: conv?.contactName ?? null,
          contactId: conv?.contactId ?? null,
          lastMessage: conv?.lastMessage ?? null,
          inboxName: conv?.inboxName ?? null,
        };
      });

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
      return { items, unread };
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
