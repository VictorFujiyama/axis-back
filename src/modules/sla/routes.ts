import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { computeSla, type SlaConfig } from './compute';

const periodQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  inboxId: z.string().uuid().optional(),
});

/**
 * Dashboard: SLA compliance per inbox over a period.
 * Returns counts of {ok, warning, breached} for first-response and resolution.
 */
export async function slaRoutes(app: FastifyInstance): Promise<void> {
  // Batch SLA lookup — used by the inbox list to render the colored indicator.
  // Body shape: { ids: string[] } (POST instead of GET to avoid huge query strings).
  app.post(
    '/api/v1/sla/batch',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
      const convs = await app.db
        .select({
          id: schema.conversations.id,
          inboxId: schema.conversations.inboxId,
          status: schema.conversations.status,
          createdAt: schema.conversations.createdAt,
          firstResponseAt: schema.conversations.firstResponseAt,
          resolvedAt: schema.conversations.resolvedAt,
        })
        .from(schema.conversations)
        .where(and(sql`${schema.conversations.id} = ANY(${body.ids})`, eq(schema.conversations.accountId, req.user.accountId)));
      if (convs.length === 0) return {};
      const inboxIds = Array.from(new Set(convs.map((c) => c.inboxId)));
      const inboxes = await app.db
        .select({ id: schema.inboxes.id, config: schema.inboxes.config })
        .from(schema.inboxes)
        .where(sql`${schema.inboxes.id} = ANY(${inboxIds})`);
      const cfgByInbox = new Map<string, SlaConfig | undefined>();
      for (const i of inboxes) {
        cfgByInbox.set(i.id, (i.config as { sla?: SlaConfig } | null)?.sla);
      }
      const out: Record<string, ReturnType<typeof computeSla>> = {};
      const now = new Date();
      for (const c of convs) {
        out[c.id] = computeSla(c, cfgByInbox.get(c.inboxId), now);
      }
      return out;
    },
  );

  // Per-conversation SLA snapshot.
  app.get(
    '/api/v1/conversations/:id/sla',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const [conv] = await app.db
        .select({
          id: schema.conversations.id,
          inboxId: schema.conversations.inboxId,
          status: schema.conversations.status,
          createdAt: schema.conversations.createdAt,
          firstResponseAt: schema.conversations.firstResponseAt,
          resolvedAt: schema.conversations.resolvedAt,
        })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, req.user.accountId)))
        .limit(1);
      if (!conv) return reply.notFound();
      const [inbox] = await app.db
        .select({ config: schema.inboxes.config })
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, conv.inboxId))
        .limit(1);
      const cfg = (inbox?.config as { sla?: SlaConfig } | null)?.sla;
      return computeSla(conv, cfg);
    },
  );

  app.get(
    '/api/v1/analytics/sla',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const q = periodQuery.parse(req.query);
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const to = q.to ? new Date(q.to) : new Date();

      const conds = [
        sql`${schema.conversations.createdAt} >= ${from}`,
        sql`${schema.conversations.createdAt} <= ${to}`,
        isNull(schema.conversations.deletedAt),
        eq(schema.conversations.accountId, req.user.accountId),
      ];
      if (q.inboxId) conds.push(eq(schema.conversations.inboxId, q.inboxId));

      const convs = await app.db
        .select({
          id: schema.conversations.id,
          inboxId: schema.conversations.inboxId,
          status: schema.conversations.status,
          createdAt: schema.conversations.createdAt,
          firstResponseAt: schema.conversations.firstResponseAt,
          resolvedAt: schema.conversations.resolvedAt,
        })
        .from(schema.conversations)
        .where(and(...conds));

      // Load inbox SLA configs in one query.
      const inboxCfg = new Map<string, SlaConfig | undefined>();
      if (convs.length > 0) {
        const inboxIds = Array.from(new Set(convs.map((c) => c.inboxId)));
        const inboxes = await app.db
          .select({ id: schema.inboxes.id, config: schema.inboxes.config })
          .from(schema.inboxes);
        for (const i of inboxes) {
          if (!inboxIds.includes(i.id)) continue;
          const cfg = (i.config as { sla?: SlaConfig } | null)?.sla;
          inboxCfg.set(i.id, cfg);
        }
      }

      const summary: Record<string, Record<string, number>> = {};
      const now = new Date();
      for (const c of convs) {
        const r = computeSla(c, inboxCfg.get(c.inboxId), now);
        if (!r.status) continue;
        const key = c.inboxId;
        summary[key] ??= { ok: 0, warning: 0, breached: 0 };
        summary[key][r.status]!++;
      }
      return { inboxes: summary, from: from.toISOString(), to: to.toISOString() };
    },
  );
}
