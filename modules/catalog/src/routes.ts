/// <reference path="./fastify-augment.d.ts" />
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { createProductBody, idParams, listQuery, updateProductBody } from './schemas';

const BASE = '/api/v1/modules/catalog';

export function registerCatalogRoutes(app: FastifyInstance): void {
  app.get(
    `${BASE}/products`,
    { preHandler: app.requireAuth },
    async (req) => {
      const q = listQuery.parse(req.query ?? {});
      const conditions = [eq(schema.moduleCatalogProducts.accountId, req.user.accountId)];

      if (q.archived !== 'true') {
        conditions.push(isNull(schema.moduleCatalogProducts.archivedAt));
      }
      if (q.search) {
        const term = `%${q.search}%`;
        conditions.push(
          or(
            ilike(schema.moduleCatalogProducts.name, term),
            ilike(schema.moduleCatalogProducts.brand, term),
            ilike(schema.moduleCatalogProducts.category, term),
          )!,
        );
      }

      // Defensive cap; pagination can come later if needed.
      const rows = await app.db
        .select()
        .from(schema.moduleCatalogProducts)
        .where(and(...conditions))
        .orderBy(desc(schema.moduleCatalogProducts.createdAt))
        .limit(500);

      return { items: rows };
    },
  );

  app.post(
    `${BASE}/products`,
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = createProductBody.parse(req.body);
      const [product] = await app.db
        .insert(schema.moduleCatalogProducts)
        .values({
          accountId: req.user.accountId,
          name: body.name,
          brand: body.brand ?? null,
          category: body.category ?? null,
          price: body.price.toFixed(2),
          description: body.description ?? null,
          imageUrl: body.imageUrl ?? null,
        })
        .returning();
      return reply.code(201).send(product);
    },
  );

  app.patch(
    `${BASE}/products/:id`,
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateProductBody.parse(req.body);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.brand !== undefined) patch.brand = body.brand;
      if (body.category !== undefined) patch.category = body.category;
      if (body.price !== undefined) patch.price = body.price.toFixed(2);
      if (body.description !== undefined) patch.description = body.description;
      if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl;

      const [product] = await app.db
        .update(schema.moduleCatalogProducts)
        .set(patch)
        .where(
          and(
            eq(schema.moduleCatalogProducts.id, id),
            eq(schema.moduleCatalogProducts.accountId, req.user.accountId),
          ),
        )
        .returning();

      if (!product) return reply.notFound();
      return product;
    },
  );

  app.delete(
    `${BASE}/products/:id`,
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.moduleCatalogProducts)
        .where(
          and(
            eq(schema.moduleCatalogProducts.id, id),
            eq(schema.moduleCatalogProducts.accountId, req.user.accountId),
          ),
        )
        .returning({ id: schema.moduleCatalogProducts.id });
      if (deleted.length === 0) return reply.notFound();
      return reply.code(204).send();
    },
  );
}
