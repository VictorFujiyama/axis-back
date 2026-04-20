import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { publicContact } from '../contacts/routes.js';

const idParams = z.object({ id: z.string().uuid() });
const flagBody = z.object({ note: z.string().max(500).optional() });

export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  // List blocked contacts.
  app.get(
    '/api/v1/blocklist',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async () => {
      const rows = await app.db
        .select({
          id: schema.contacts.id,
          name: schema.contacts.name,
          email: schema.contacts.email,
          phone: schema.contacts.phone,
          updatedAt: schema.contacts.updatedAt,
        })
        .from(schema.contacts)
        .where(and(isNotNull(schema.contacts.blocked), isNull(schema.contacts.deletedAt)));
      return { items: rows };
    },
  );

  app.post(
    '/api/v1/contacts/:id/block',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .update(schema.contacts)
        .set({ blocked: 'blocked', updatedAt: new Date() })
        .where(and(eq(schema.contacts.id, id), isNull(schema.contacts.deletedAt)))
        .returning();
      if (!row) return reply.notFound();
      return publicContact(row);
    },
  );

  app.post(
    '/api/v1/contacts/:id/unblock',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .update(schema.contacts)
        .set({ blocked: null, updatedAt: new Date() })
        .where(and(eq(schema.contacts.id, id), isNull(schema.contacts.deletedAt)))
        .returning();
      if (!row) return reply.notFound();
      return publicContact(row);
    },
  );

  // Flag for supervisor review — stores in contact.customFields.flags (append).
  app.post(
    '/api/v1/contacts/:id/flag',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = flagBody.parse(req.body);
      const [c] = await app.db
        .select({ customFields: schema.contacts.customFields })
        .from(schema.contacts)
        .where(eq(schema.contacts.id, id))
        .limit(1);
      if (!c) return reply.notFound();
      const cf = (c.customFields as Record<string, unknown>) ?? {};
      const flags = Array.isArray(cf.flags) ? cf.flags : [];
      flags.push({
        note: body.note ?? '',
        by: req.user.sub,
        at: new Date().toISOString(),
      });
      await app.db
        .update(schema.contacts)
        .set({ customFields: { ...cf, flags }, updatedAt: new Date() })
        .where(eq(schema.contacts.id, id));
      return reply.code(204).send();
    },
  );
}

/**
 * Rate-limit check for incoming messages per contact. Uses Redis INCR with window.
 * Returns true if under limit, false if over. Default: 30 msgs / 60s.
 */
export async function contactRateOk(
  app: FastifyInstance,
  contactId: string,
  limit = 30,
  windowSec = 60,
): Promise<boolean> {
  const key = `contact-rate:${contactId}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await app.redis.incr(key);
  if (n === 1) await app.redis.expire(key, windowSec);
  return n <= limit;
}
