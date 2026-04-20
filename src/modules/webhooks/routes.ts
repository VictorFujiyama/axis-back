import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { encryptJSON } from '../../crypto';

const idParams = z.object({ id: z.string().uuid() });
const ALLOWED_EVENTS = [
  'message.created',
  'conversation.created',
  'conversation.assigned',
  'conversation.resolved',
  'conversation.reopened',
  'conversation.updated',
  '*',
] as const;

const createBody = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().refine(
    (v) => v.startsWith('https://') || process.env.NODE_ENV !== 'production',
    'must use https in production',
  ),
  secret: z.string().min(16).max(200),
  events: z.array(z.enum(ALLOWED_EVENTS)).min(1),
  active: z.boolean().default(true),
});

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().url().optional(),
  secret: z.string().min(16).max(200).optional(),
  events: z.array(z.enum(ALLOWED_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});

function publicSub(s: typeof schema.webhookSubscriptions.$inferSelect) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    events: s.events,
    active: s.active,
    lastDeliveryAt: s.lastDeliveryAt,
    lastFailureAt: s.lastFailureAt,
    lastFailureReason: s.lastFailureReason,
    createdAt: s.createdAt,
  };
}

export async function webhookSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/webhook-subscriptions',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const rows = await app.db.select().from(schema.webhookSubscriptions)
        .where(eq(schema.webhookSubscriptions.accountId, req.user.accountId));
      return { items: rows.map(publicSub) };
    },
  );

  app.post(
    '/api/v1/webhook-subscriptions',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      const [row] = await app.db
        .insert(schema.webhookSubscriptions)
        .values({
          name: body.name,
          url: body.url,
          secret: encryptJSON(body.secret),
          events: body.events,
          active: body.active,
          createdBy: req.user.sub,
          accountId: req.user.accountId,
        })
        .returning();
      return reply.code(201).send(publicSub(row!));
    },
  );

  app.patch(
    '/api/v1/webhook-subscriptions/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.url !== undefined) patch.url = body.url;
      if (body.secret !== undefined) patch.secret = encryptJSON(body.secret);
      if (body.events !== undefined) patch.events = body.events;
      if (body.active !== undefined) patch.active = body.active;
      const [row] = await app.db
        .update(schema.webhookSubscriptions)
        .set(patch)
        .where(and(eq(schema.webhookSubscriptions.id, id), eq(schema.webhookSubscriptions.accountId, req.user.accountId)))
        .returning();
      if (!row) return reply.notFound();
      return publicSub(row);
    },
  );

  app.delete(
    '/api/v1/webhook-subscriptions/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.webhookSubscriptions)
        .where(and(eq(schema.webhookSubscriptions.id, id), eq(schema.webhookSubscriptions.accountId, req.user.accountId)))
        .returning({ id: schema.webhookSubscriptions.id });
      if (deleted.length === 0) return reply.notFound();
      return reply.code(204).send();
    },
  );
}
