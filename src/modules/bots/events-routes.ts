/**
 * Extra bot endpoints: event log, webhook test, aggregate stats.
 */
import { randomUUID } from 'node:crypto';
import { and, avg, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { signPayload } from './dispatcher-fn';
import { safeFetch } from './safe-fetch';

const idParams = z.object({ id: z.string().uuid() });

export async function botEventsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/v1/bots/:id/events ── log de dispatches ──────────────
  app.get(
    '/api/v1/bots/:id/events',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const query = z
        .object({
          limit: z.coerce.number().min(1).max(100).default(50),
          offset: z.coerce.number().min(0).default(0),
          status: z.enum(['success', 'failed', 'timeout']).optional(),
        })
        .parse(req.query);

      // Verify bot belongs to this account
      const [bot] = await app.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!bot) return reply.notFound();

      const conditions = [eq(schema.botEvents.botId, id)];
      if (query.status) conditions.push(eq(schema.botEvents.status, query.status));

      const rows = await app.db
        .select()
        .from(schema.botEvents)
        .where(and(...conditions))
        .orderBy(desc(schema.botEvents.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return { items: rows };
    },
  );

  // ── POST /api/v1/bots/:id/test ── fire a test webhook ─────────────
  app.post(
    '/api/v1/bots/:id/test',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [bot] = await app.db
        .select()
        .from(schema.bots)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!bot) return reply.notFound();
      if (!bot.webhookUrl) return reply.badRequest('Bot has no webhook URL (built-in bot)');

      const testPayload = {
        eventId: randomUUID(),
        event: 'bot.test',
        timestamp: new Date().toISOString(),
        conversation: {
          id: '00000000-0000-0000-0000-000000000000',
          inboxId: bot.inboxId,
          status: 'pending',
          priority: 'medium',
        },
        contact: {
          id: '00000000-0000-0000-0000-000000000000',
          name: 'Test Contact',
          email: null,
          phone: null,
        },
        message: {
          id: '00000000-0000-0000-0000-000000000000',
          content: 'Hello, this is a test message from Blossom Inbox.',
          contentType: 'text',
          senderType: 'contact',
          createdAt: new Date().toISOString(),
        },
        history: [],
      };

      const body = JSON.stringify(testPayload);
      let secret: string;
      try {
        secret = decryptJSON<string>(bot.secret);
      } catch {
        return reply.internalServerError('Bot secret misconfigured');
      }
      const signature = signPayload(body, secret);

      const start = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);

      try {
        const res = await safeFetch(bot.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Blossom-Signature': signature,
            'X-Blossom-Event': 'bot.test',
            'X-Blossom-Event-Id': testPayload.eventId,
            'User-Agent': 'BlossomInbox/0.1 bot-dispatcher',
          },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const resBody = await res.text().catch(() => '');
        return {
          success: res.ok,
          httpStatus: res.status,
          latencyMs: Date.now() - start,
          response: resBody.slice(0, 1000),
        };
      } catch (err) {
        clearTimeout(timer);
        const error = err instanceof Error ? err.message : 'Unknown error';
        return {
          success: false,
          httpStatus: null,
          latencyMs: Date.now() - start,
          error,
        };
      }
    },
  );

  // ── GET /api/v1/bots/:id/stats ── aggregate metrics ───────────────
  app.get(
    '/api/v1/bots/:id/stats',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const query = z
        .object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        })
        .parse(req.query);

      // Verify bot belongs to this account
      const [bot] = await app.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!bot) return reply.notFound();

      const conditions = [eq(schema.botEvents.botId, id)];
      if (query.from) conditions.push(gte(schema.botEvents.createdAt, query.from));
      if (query.to) conditions.push(lte(schema.botEvents.createdAt, query.to));

      const [stats] = await app.db
        .select({
          total: count(),
          success: count(sql`CASE WHEN ${schema.botEvents.status} = 'success' THEN 1 END`),
          failed: count(sql`CASE WHEN ${schema.botEvents.status} = 'failed' THEN 1 END`),
          timeout: count(sql`CASE WHEN ${schema.botEvents.status} = 'timeout' THEN 1 END`),
          avgLatencyMs: avg(schema.botEvents.latencyMs),
        })
        .from(schema.botEvents)
        .where(and(...conditions));

      return stats ?? { total: 0, success: 0, failed: 0, timeout: 0, avgLatencyMs: null };
    },
  );
}
