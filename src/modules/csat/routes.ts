import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const submitBody = z.object({
  conversationId: z.string().uuid(),
  score: z.number().int().min(0).max(10),
  kind: z.enum(['csat', 'nps']).default('csat'),
  comment: z.string().max(2000).optional(),
});

const summaryQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  kind: z.enum(['csat', 'nps']).optional(),
});

export async function csatRoutes(app: FastifyInstance): Promise<void> {
  // Agent-visible: CSAT responses for a given conversation.
  app.get(
    '/api/v1/conversations/:id/csat',
    { preHandler: app.requireAuth },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await app.db
        .select()
        .from(schema.csatResponses)
        .where(eq(schema.csatResponses.conversationId, id));
      return { items: rows };
    },
  );

  // Contact submit (typically proxied by channel webhook parser, but also
  // exposed for manual/internal submission).
  app.post(
    '/api/v1/csat',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = submitBody.parse(req.body);
      const [conv] = await app.db
        .select({ contactId: schema.conversations.contactId })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, body.conversationId))
        .limit(1);
      if (!conv) return reply.notFound();
      const [row] = await app.db
        .insert(schema.csatResponses)
        .values({
          conversationId: body.conversationId,
          contactId: conv.contactId,
          score: body.score,
          kind: body.kind,
          comment: body.comment,
        })
        .returning();
      return reply.code(201).send(row);
    },
  );

  // Dashboard summary — avg by kind + count by score distribution.
  app.get(
    '/api/v1/analytics/csat',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const q = summaryQuery.parse(req.query);
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const to = q.to ? new Date(q.to) : new Date();
      const conds = [
        gte(schema.csatResponses.respondedAt, from),
        sql`${schema.csatResponses.respondedAt} <= ${to}`,
      ];
      if (q.kind) conds.push(eq(schema.csatResponses.kind, q.kind));

      const rows = await app.db
        .select({
          kind: schema.csatResponses.kind,
          score: schema.csatResponses.score,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.csatResponses)
        .where(and(...conds))
        .groupBy(schema.csatResponses.kind, schema.csatResponses.score);

      let total = 0;
      let sum = 0;
      const byScore: Record<number, number> = {};
      for (const r of rows) {
        total += r.count;
        sum += r.score * r.count;
        byScore[r.score] = (byScore[r.score] ?? 0) + r.count;
      }
      return {
        total,
        average: total > 0 ? Math.round((sum / total) * 100) / 100 : null,
        byScore,
        from: from.toISOString(),
        to: to.toISOString(),
      };
    },
  );
}
