import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { QUEUE_NAMES, type CampaignRunnerJob } from '../../queue';

const idParams = z.object({ id: z.string().uuid() });

const createBody = z.object({
  name: z.string().min(1).max(120),
  inboxId: z.string().uuid(),
  tagIds: z.array(z.string().uuid()).min(1),
  template: z.string().min(1).max(4_000),
  templateId: z.string().max(120).optional(),
  scheduledFor: z.coerce.date().optional(),
});

const updateBody = createBody.partial().omit({ inboxId: true });

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/campaigns',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.accountId, req.user.accountId))
        .orderBy(desc(schema.campaigns.createdAt));
      return { items: rows };
    },
  );

  app.get(
    '/api/v1/campaigns/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .select()
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)))
        .limit(1);
      if (!row) return reply.notFound();
      // Aggregate recipient statuses
      const buckets = await app.db
        .select({
          status: schema.campaignRecipients.status,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, id))
        .groupBy(schema.campaignRecipients.status);
      const report: Record<string, number> = {};
      for (const b of buckets) report[b.status] = b.count;
      return { ...row, report };
    },
  );

  app.post(
    '/api/v1/campaigns',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = createBody.parse(req.body);

      // Validate inbox exists
      const [inbox] = await app.db
        .select({ id: schema.inboxes.id, channelType: schema.inboxes.channelType })
        .from(schema.inboxes)
        .where(
          and(eq(schema.inboxes.id, body.inboxId), isNull(schema.inboxes.deletedAt)),
        )
        .limit(1);
      if (!inbox) return reply.badRequest('inbox not found');

      // WhatsApp channel requires templateId (approved Meta template).
      if (inbox.channelType === 'whatsapp' && !body.templateId) {
        return reply.badRequest(
          'campaign em WhatsApp requer templateId (template aprovado pela Meta)',
        );
      }

      const status = body.scheduledFor ? 'scheduled' : 'draft';
      const [row] = await app.db
        .insert(schema.campaigns)
        .values({
          name: body.name,
          inboxId: body.inboxId,
          tagIds: body.tagIds,
          template: body.template,
          templateId: body.templateId,
          scheduledFor: body.scheduledFor,
          status,
          createdBy: req.user.sub,
          accountId: req.user.accountId,
        })
        .returning();
      return reply.code(201).send(row);
    },
  );

  app.patch(
    '/api/v1/campaigns/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const [existing] = await app.db
        .select({ status: schema.campaigns.status })
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)))
        .limit(1);
      if (!existing) return reply.notFound();
      if (existing.status === 'running' || existing.status === 'completed') {
        return reply.badRequest(`Campanha ${existing.status} não pode ser editada`);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.tagIds !== undefined) patch.tagIds = body.tagIds;
      if (body.template !== undefined) patch.template = body.template;
      if (body.templateId !== undefined) patch.templateId = body.templateId;
      if (body.scheduledFor !== undefined) {
        patch.scheduledFor = body.scheduledFor;
        patch.status = body.scheduledFor ? 'scheduled' : 'draft';
      }
      const [row] = await app.db
        .update(schema.campaigns)
        .set(patch)
        .where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)))
        .returning();
      return row;
    },
  );

  app.delete(
    '/api/v1/campaigns/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .select({ status: schema.campaigns.status })
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)))
        .limit(1);
      if (!row) return reply.notFound();
      if (row.status === 'running') {
        return reply.badRequest('Cancele a campanha antes de deletar');
      }
      await app.db.delete(schema.campaigns).where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)));
      return reply.code(204).send();
    },
  );

  // Preview: count recipients that match the segmentation.
  app.post(
    '/api/v1/campaigns/preview',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const body = z
        .object({ inboxId: z.string().uuid(), tagIds: z.array(z.string().uuid()).min(1) })
        .parse(req.body);
      const [inbox] = await app.db
        .select({ channelType: schema.inboxes.channelType })
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, body.inboxId))
        .limit(1);
      if (!inbox) return { count: 0 };
      const countRows = await app.db
        .select({ count: sql<number>`count(distinct ${schema.contacts.id})::int` })
        .from(schema.contacts)
        .innerJoin(schema.contactTags, eq(schema.contactTags.contactId, schema.contacts.id))
        .innerJoin(
          schema.contactIdentities,
          eq(schema.contactIdentities.contactId, schema.contacts.id),
        )
        .where(
          and(
            inArray(schema.contactTags.tagId, body.tagIds),
            eq(schema.contactIdentities.channel, inbox.channelType),
            isNull(schema.contacts.blocked),
            isNull(schema.contacts.deletedAt),
          ),
        );
      return { count: countRows[0]?.count ?? 0 };
    },
  );

  app.post(
    '/api/v1/campaigns/:id/start',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .select()
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)))
        .limit(1);
      if (!row) return reply.notFound();
      if (row.status === 'running' || row.status === 'completed') {
        return reply.badRequest(`Campanha já ${row.status}`);
      }
      const delay =
        row.scheduledFor && row.scheduledFor.getTime() > Date.now()
          ? row.scheduledFor.getTime() - Date.now()
          : 0;
      await app.queues
        .getQueue<CampaignRunnerJob>(QUEUE_NAMES.CAMPAIGN_RUNNER)
        .add('run', { campaignId: id }, { jobId: `runner-${id}`, delay });
      await app.db
        .update(schema.campaigns)
        .set({ status: delay > 0 ? 'scheduled' : 'running', updatedAt: new Date() })
        .where(eq(schema.campaigns.id, id));
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/campaigns/:id/cancel',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      await app.db
        .update(schema.campaigns)
        .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, req.user.accountId)));
      return reply.code(204).send();
    },
  );
}
