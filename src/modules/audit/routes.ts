import { and, desc, eq, gte, like, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const listQuery = z.object({
  actorUserId: z.string().uuid().optional(),
  // Restricted to the action grammar we use internally — also blocks LIKE wildcard chars (% _).
  action: z
    .string()
    .max(120)
    .regex(/^[a-z0-9._]+$/)
    .optional(),
  entityType: z
    .string()
    .max(60)
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  entityId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/audit-logs',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const q = listQuery.parse(req.query);
      const conditions = [eq(schema.auditLogs.accountId, req.user.accountId)];
      if (q.actorUserId) conditions.push(eq(schema.auditLogs.actorUserId, q.actorUserId));
      if (q.action) conditions.push(like(schema.auditLogs.action, `${q.action}%`));
      if (q.entityType) conditions.push(eq(schema.auditLogs.entityType, q.entityType));
      if (q.entityId) conditions.push(eq(schema.auditLogs.entityId, q.entityId));
      if (q.from) conditions.push(gte(schema.auditLogs.createdAt, q.from));
      if (q.to) conditions.push(lte(schema.auditLogs.createdAt, q.to));
      if (q.cursor) {
        const cd = new Date(q.cursor);
        if (!Number.isNaN(cd.getTime())) conditions.push(lt(schema.auditLogs.createdAt, cd));
      }

      const rows = await app.db
        .select()
        .from(schema.auditLogs)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(q.limit + 1);

      const hasMore = rows.length > q.limit;
      const items = hasMore ? rows.slice(0, q.limit) : rows;
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
      };
    },
  );

  // Aggregate: action counts in period (for an audit overview)
  app.get(
    '/api/v1/audit-logs/summary',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const q = listQuery.parse(req.query);
      const from = q.from ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const to = q.to ?? new Date();
      const rows = await app.db.execute<{ action: string; count: number }>(sql`
        SELECT action, COUNT(*)::int AS count
        FROM audit_logs
        WHERE created_at >= ${from.toISOString()}
          AND created_at <= ${to.toISOString()}
          AND account_id = ${req.user.accountId}
        GROUP BY action
        ORDER BY count DESC
        LIMIT 50
      `);
      return { items: Array.from(rows) };
    },
  );
}
