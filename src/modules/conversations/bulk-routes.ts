import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { userInboxIds } from './access';

const bulkBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(['resolve', 'reopen', 'snooze', 'assign', 'tag']),
  userId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  until: z.coerce.date().optional(),
});

/**
 * Bulk operations on conversations. Single SQL statement per action, scoped
 * to conversations the user can access. Tags do one insert per (conv, tag).
 */
export async function bulkConversationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/conversations/bulk',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = bulkBody.parse(req.body);

      // Scope: agents limited to their inboxes; admin/supervisor unrestricted.
      const restrict = req.user.role === 'agent';
      const allowed = restrict ? await userInboxIds(app, req.user.sub, req.user.accountId) : null;
      const convWhere = and(
        inArray(schema.conversations.id, body.ids),
        eq(schema.conversations.accountId, req.user.accountId),
        ...(restrict ? [inArray(schema.conversations.inboxId, allowed!)] : []),
      );

      const now = new Date();
      let affected = 0;

      if (body.action === 'resolve') {
        const res = await app.db
          .update(schema.conversations)
          .set({ status: 'resolved', resolvedAt: now, resolvedBy: req.user.sub, updatedAt: now })
          .where(convWhere)
          .returning({ id: schema.conversations.id });
        affected = res.length;
      } else if (body.action === 'reopen') {
        const res = await app.db
          .update(schema.conversations)
          .set({ status: 'open', resolvedAt: null, resolvedBy: null, updatedAt: now })
          .where(convWhere)
          .returning({ id: schema.conversations.id });
        affected = res.length;
      } else if (body.action === 'snooze') {
        if (!body.until) return reply.badRequest('until required for snooze');
        const res = await app.db
          .update(schema.conversations)
          .set({ status: 'snoozed', snoozedUntil: body.until, updatedAt: now })
          .where(convWhere)
          .returning({ id: schema.conversations.id });
        affected = res.length;
      } else if (body.action === 'assign') {
        if (!body.userId) return reply.badRequest('userId required for assign');
        const res = await app.db
          .update(schema.conversations)
          .set({ assignedUserId: body.userId, updatedAt: now })
          .where(convWhere)
          .returning({ id: schema.conversations.id });
        affected = res.length;
      } else if (body.action === 'tag') {
        if (!body.tagId) return reply.badRequest('tagId required for tag');
        // Resolve allowed conversation ids first (respect access scope).
        const convs = await app.db
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(convWhere);
        for (const c of convs) {
          try {
            await app.db
              .insert(schema.conversationTags)
              .values({ conversationId: c.id, tagId: body.tagId });
            affected++;
          } catch (err) {
            if ((err as { code?: string }).code !== '23505') throw err;
          }
        }
      }

      return { affected };
    },
  );
}
