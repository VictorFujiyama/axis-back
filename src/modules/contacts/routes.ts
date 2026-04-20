import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { writeAudit } from '../../lib/audit';

const channelTypes = [
  'whatsapp',
  'email',
  'instagram',
  'messenger',
  'telegram',
  'webchat',
  'sms',
  'api',
] as const;

const createBody = z.object({
  name: z.string().min(1).max(120).nullish(),
  email: z
    .string()
    .email()
    .transform((v) => v.trim().toLowerCase())
    .nullish(),
  phone: z.string().min(5).max(30).nullish(),
  avatarUrl: z.string().url().nullish(),
  customFields: z.record(z.unknown()).default({}),
  identities: z
    .array(
      z.object({
        channel: z.enum(channelTypes),
        identifier: z.string().min(1),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
  tagIds: z.array(z.string().uuid()).optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(120).nullish(),
  email: z
    .string()
    .email()
    .transform((v) => v.trim().toLowerCase())
    .nullish(),
  phone: z.string().min(5).max(30).nullish(),
  avatarUrl: z.string().url().nullish(),
  customFields: z.record(z.unknown()).optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const filterOperators = ['equals', 'contains', 'not_equals'] as const;
const filterAttributes = ['name', 'email', 'phone', 'city', 'country', 'company'] as const;
const sortFields = ['lastActivity', 'name', 'createdAt'] as const;

const filterSchema = z.array(
  z.object({
    attribute: z.enum(filterAttributes),
    operator: z.enum(filterOperators),
    value: z.string().min(1),
  }),
);

const listQuery = z.object({
  q: z.string().optional(),
  tagId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  filters: z.string().optional(),
  sort: z.enum(sortFields).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

const tagsBody = z.object({ tagIds: z.array(z.string().uuid()).min(1) });

const noteBody = z.object({ body: z.string().min(1).max(10_000) });
const notePatchBody = z.object({ body: z.string().min(1).max(10_000) });
const noteParams = z.object({ id: z.string().uuid(), noteId: z.string().uuid() });

const mergeBody = z.object({ targetId: z.string().uuid() });

type ContactRow = typeof schema.contacts.$inferSelect;

export function publicContact(row: ContactRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatarUrl,
    customFields: row.customFields,
    blocked: row.blocked,
    lastActivityAt: row.lastActivityAt ?? row.updatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Build SQL condition for a single filter entry. `city`/`country`/`company`
 * are stored inside `custom_fields` jsonb.
 */
function filterToSql(
  f: z.infer<typeof filterSchema>[number],
): ReturnType<typeof sql> | null {
  const val = f.value;
  if (f.attribute === 'city' || f.attribute === 'country' || f.attribute === 'company') {
    const path = sql.raw(`custom_fields->>'${f.attribute}'`);
    if (f.operator === 'equals') return sql`lower(${path}) = lower(${val})`;
    if (f.operator === 'not_equals') return sql`lower(coalesce(${path}, '')) <> lower(${val})`;
    return sql`lower(coalesce(${path}, '')) like ${`%${val.toLowerCase()}%`}`;
  }
  const col =
    f.attribute === 'name'
      ? schema.contacts.name
      : f.attribute === 'email'
        ? schema.contacts.email
        : schema.contacts.phone;
  if (f.operator === 'equals') return sql`lower(${col}) = lower(${val})`;
  if (f.operator === 'not_equals') return sql`lower(coalesce(${col}, '')) <> lower(${val})`;
  return sql`lower(coalesce(${col}, '')) like ${`%${val.toLowerCase()}%`}`;
}

function reqActor(req: FastifyRequest): { id: string; role: string } | null {
  const u = (req as { user?: { sub?: string; role?: string } }).user;
  if (!u?.sub || !u.role) return null;
  return { id: u.sub, role: u.role };
}

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  // Multipart parser for CSV upload (contact import).
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB — enough for ~100k rows
        files: 1,
      },
    });
  }

  app.get('/api/v1/contacts', { preHandler: app.requireAuth }, async (req, reply) => {
    const query = listQuery.parse(req.query);
    const conditions = [isNull(schema.contacts.deletedAt), eq(schema.contacts.accountId, req.user.accountId)];

    if (query.q) {
      const like = `%${query.q.toLowerCase()}%`;
      conditions.push(
        or(
          sql`lower(${schema.contacts.name}) like ${like}`,
          sql`lower(${schema.contacts.email}) like ${like}`,
          sql`${schema.contacts.phone} like ${like}`,
        )!,
      );
    }

    if (query.filters) {
      let parsed: z.infer<typeof filterSchema>;
      try {
        parsed = filterSchema.parse(JSON.parse(query.filters));
      } catch {
        return reply.badRequest('filters must be a JSON array of {attribute, operator, value}');
      }
      for (const f of parsed) {
        const c = filterToSql(f);
        if (c) conditions.push(c);
      }
    }

    if (query.tagId) {
      const taggedIds = await app.db
        .select({ id: schema.contactTags.contactId })
        .from(schema.contactTags)
        .where(eq(schema.contactTags.tagId, query.tagId));
      if (taggedIds.length === 0) return { items: [], nextCursor: null };
      conditions.push(
        inArray(
          schema.contacts.id,
          taggedIds.map((r) => r.id),
        ),
      );
    }

    // Cursor pagination only for default sort (createdAt desc). For other
    // sorts, fall back to offset (kept simple and good enough for ~10k rows).
    const useCursor = query.sort === 'createdAt' && !query.offset;
    if (useCursor && query.cursor) {
      const cursorDate = new Date(query.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(
          query.order === 'asc'
            ? gt(schema.contacts.createdAt, cursorDate)
            : lt(schema.contacts.createdAt, cursorDate),
        );
      }
    }

    const sortCol =
      query.sort === 'name'
        ? schema.contacts.name
        : query.sort === 'lastActivity'
          ? schema.contacts.lastActivityAt
          : schema.contacts.createdAt;
    // Nulls go to the end when sorting by lastActivity.
    const orderExpr =
      query.sort === 'lastActivity'
        ? query.order === 'asc'
          ? sql`${sortCol} asc nulls last`
          : sql`${sortCol} desc nulls last`
        : query.order === 'asc'
          ? asc(sortCol)
          : desc(sortCol);

    const baseQuery = app.db
      .select()
      .from(schema.contacts)
      .where(and(...conditions))
      .orderBy(orderExpr)
      .limit(query.limit + 1);

    const rows = useCursor
      ? await baseQuery
      : await baseQuery.offset(query.offset ?? 0);

    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(publicContact);
    const last = items[items.length - 1];
    const nextCursor =
      useCursor && hasMore && last ? last.createdAt.toISOString() : null;
    return { items, nextCursor };
  });

  app.get(
    '/api/v1/contacts/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [contact] = await app.db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .limit(1);
      if (!contact) return reply.notFound();

      const identities = await app.db
        .select()
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, id))
        .orderBy(asc(schema.contactIdentities.createdAt));

      const tags = await app.db
        .select({
          id: schema.tags.id,
          name: schema.tags.name,
          color: schema.tags.color,
        })
        .from(schema.contactTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId))
        .where(eq(schema.contactTags.contactId, id));

      return { ...publicContact(contact), identities, tags };
    },
  );

  app.post(
    '/api/v1/contacts',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      const result = await app.db.transaction(async (tx) => {
        const [contact] = await tx
          .insert(schema.contacts)
          .values({
            name: body.name,
            email: body.email,
            phone: body.phone,
            avatarUrl: body.avatarUrl,
            customFields: body.customFields,
            accountId: req.user.accountId,
          })
          .returning();
        if (!contact) throw new Error('Insert failed');

        if (body.identities?.length) {
          await tx.insert(schema.contactIdentities).values(
            body.identities.map((i) => ({
              contactId: contact.id,
              channel: i.channel,
              identifier: i.identifier,
              metadata: i.metadata ?? {},
            })),
          );
        }

        if (body.tagIds?.length) {
          await tx.insert(schema.contactTags).values(
            body.tagIds.map((tagId) => ({ contactId: contact.id, tagId })),
          );
        }

        return contact;
      });

      return reply.code(201).send(publicContact(result));
    },
  );

  app.patch(
    '/api/v1/contacts/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.email !== undefined) patch.email = body.email;
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.avatarUrl !== undefined) patch.avatarUrl = body.avatarUrl;
      if (body.customFields !== undefined) patch.customFields = body.customFields;

      const [contact] = await app.db
        .update(schema.contacts)
        .set(patch)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .returning();
      if (!contact) return reply.notFound();
      return publicContact(contact);
    },
  );

  app.delete(
    '/api/v1/contacts/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [contact] = await app.db
        .update(schema.contacts)
        .set({ deletedAt: new Date() })
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .returning();
      if (!contact) return reply.notFound();
      return reply.code(204).send();
    },
  );

  // Tag management
  app.post(
    '/api/v1/contacts/:id/tags',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = tagsBody.parse(req.body);
      try {
        await app.db
          .insert(schema.contactTags)
          .values(body.tagIds.map((tagId) => ({ contactId: id, tagId })))
          .onConflictDoNothing();
      } catch (err) {
        if ((err as { code?: string }).code === '23503') {
          return reply.badRequest('contactId ou tagId inválido');
        }
        throw err;
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/contacts/:id/tags/:tagId',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), tagId: z.string().uuid() })
        .parse(req.params);
      await app.db
        .delete(schema.contactTags)
        .where(
          and(
            eq(schema.contactTags.contactId, params.id),
            eq(schema.contactTags.tagId, params.tagId),
          ),
        );
      return reply.code(204).send();
    },
  );

  // ====== Notes ======

  app.get(
    '/api/v1/contacts/:id/notes',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [contact] = await app.db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .limit(1);
      if (!contact) return reply.notFound();

      const rows = await app.db
        .select({
          id: schema.contactNotes.id,
          contactId: schema.contactNotes.contactId,
          body: schema.contactNotes.body,
          createdAt: schema.contactNotes.createdAt,
          updatedAt: schema.contactNotes.updatedAt,
          authorId: schema.contactNotes.authorId,
          authorName: schema.users.name,
          authorEmail: schema.users.email,
        })
        .from(schema.contactNotes)
        .leftJoin(schema.users, eq(schema.users.id, schema.contactNotes.authorId))
        .where(eq(schema.contactNotes.contactId, id))
        .orderBy(desc(schema.contactNotes.createdAt));

      return {
        items: rows.map((r) => ({
          id: r.id,
          contactId: r.contactId,
          body: r.body,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          author: r.authorId
            ? { id: r.authorId, name: r.authorName, email: r.authorEmail }
            : null,
        })),
      };
    },
  );

  app.post(
    '/api/v1/contacts/:id/notes',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = noteBody.parse(req.body);
      const actor = reqActor(req);
      if (!actor) return reply.unauthorized();

      const [contact] = await app.db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .limit(1);
      if (!contact) return reply.notFound();

      const [note] = await app.db
        .insert(schema.contactNotes)
        .values({ contactId: id, authorId: actor.id, body: body.body })
        .returning();
      if (!note) throw new Error('Insert failed');

      await writeAudit(
        req,
        {
          action: 'contact.note.created',
          entityType: 'contact',
          entityId: id,
          changes: { noteId: note.id },
        },
        { db: app.db, log: app.log },
      );

      return reply.code(201).send({
        id: note.id,
        contactId: note.contactId,
        body: note.body,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        author: { id: actor.id, name: null, email: null },
      });
    },
  );

  app.patch(
    '/api/v1/contacts/:id/notes/:noteId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const params = noteParams.parse(req.params);
      const body = notePatchBody.parse(req.body);
      const actor = reqActor(req);
      if (!actor) return reply.unauthorized();

      const [existing] = await app.db
        .select()
        .from(schema.contactNotes)
        .where(
          and(
            eq(schema.contactNotes.id, params.noteId),
            eq(schema.contactNotes.contactId, params.id),
          ),
        )
        .limit(1);
      if (!existing) return reply.notFound();

      if (existing.authorId !== actor.id && actor.role !== 'admin') {
        return reply.forbidden('Only author or admin can edit this note');
      }

      const [note] = await app.db
        .update(schema.contactNotes)
        .set({ body: body.body, updatedAt: new Date() })
        .where(eq(schema.contactNotes.id, params.noteId))
        .returning();
      if (!note) return reply.notFound();
      return {
        id: note.id,
        contactId: note.contactId,
        body: note.body,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
    },
  );

  app.delete(
    '/api/v1/contacts/:id/notes/:noteId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const params = noteParams.parse(req.params);
      const actor = reqActor(req);
      if (!actor) return reply.unauthorized();

      const [existing] = await app.db
        .select()
        .from(schema.contactNotes)
        .where(
          and(
            eq(schema.contactNotes.id, params.noteId),
            eq(schema.contactNotes.contactId, params.id),
          ),
        )
        .limit(1);
      if (!existing) return reply.notFound();

      if (existing.authorId !== actor.id && actor.role !== 'admin') {
        return reply.forbidden('Only author or admin can delete this note');
      }

      await app.db
        .delete(schema.contactNotes)
        .where(eq(schema.contactNotes.id, params.noteId));

      await writeAudit(
        req,
        {
          action: 'contact.note.deleted',
          entityType: 'contact',
          entityId: params.id,
          changes: { noteId: params.noteId },
        },
        { db: app.db, log: app.log },
      );

      return reply.code(204).send();
    },
  );

  // ====== History (previous conversations) ======

  app.get(
    '/api/v1/contacts/:id/conversations',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [contact] = await app.db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .limit(1);
      if (!contact) return reply.notFound();

      const conversations = await app.db
        .select({
          id: schema.conversations.id,
          inboxId: schema.conversations.inboxId,
          inboxName: schema.inboxes.name,
          channelType: schema.inboxes.channelType,
          status: schema.conversations.status,
          priority: schema.conversations.priority,
          lastMessageAt: schema.conversations.lastMessageAt,
          updatedAt: schema.conversations.updatedAt,
          createdAt: schema.conversations.createdAt,
          assignedUserId: schema.conversations.assignedUserId,
          assignedUserName: schema.users.name,
          assignedUserEmail: schema.users.email,
        })
        .from(schema.conversations)
        .leftJoin(schema.inboxes, eq(schema.inboxes.id, schema.conversations.inboxId))
        .leftJoin(schema.users, eq(schema.users.id, schema.conversations.assignedUserId))
        .where(
          and(
            eq(schema.conversations.contactId, id),
            isNull(schema.conversations.deletedAt),
          ),
        )
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(50);

      if (conversations.length === 0) return { items: [] };

      const convIds = conversations.map((c) => c.id);

      // Last message per conversation (preview + timestamp).
      const lastMessages = await app.db.execute<{
        conversation_id: string;
        content: string | null;
        content_type: string;
        created_at: Date;
      }>(sql`
        select distinct on (conversation_id)
          conversation_id, content, content_type, created_at
        from messages
        where conversation_id in (${sql.join(
          convIds.map((c) => sql`${c}`),
          sql`, `,
        )})
        order by conversation_id, created_at desc
      `);

      // Unread = inbound messages with read_at IS NULL.
      const unreadRows = await app.db.execute<{ conversation_id: string; cnt: string }>(sql`
        select conversation_id, count(*)::text as cnt
        from messages
        where conversation_id in (${sql.join(
          convIds.map((c) => sql`${c}`),
          sql`, `,
        )})
          and sender_type = 'contact'
          and read_at is null
        group by conversation_id
      `);

      const lastByConv = new Map<string, { content: string | null; contentType: string; createdAt: Date }>();
      for (const row of lastMessages as unknown as Array<{
        conversation_id: string;
        content: string | null;
        content_type: string;
        created_at: Date;
      }>) {
        lastByConv.set(row.conversation_id, {
          content: row.content,
          contentType: row.content_type,
          createdAt: row.created_at,
        });
      }
      const unreadByConv = new Map<string, number>();
      for (const row of unreadRows as unknown as Array<{
        conversation_id: string;
        cnt: string;
      }>) {
        unreadByConv.set(row.conversation_id, Number(row.cnt));
      }

      return {
        items: conversations.map((c) => {
          const last = lastByConv.get(c.id);
          return {
            id: c.id,
            inboxId: c.inboxId,
            inboxName: c.inboxName,
            channelType: c.channelType,
            status: c.status,
            priority: c.priority,
            lastMessagePreview: last?.content ?? null,
            lastMessageContentType: last?.contentType ?? null,
            lastMessageAt: last?.createdAt ?? c.lastMessageAt,
            unreadCount: unreadByConv.get(c.id) ?? 0,
            assignee: c.assignedUserId
              ? { id: c.assignedUserId, name: c.assignedUserName, email: c.assignedUserEmail }
              : null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          };
        }),
      };
    },
  );

  // ====== Merge ======

  app.post(
    '/api/v1/contacts/:id/merge',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const { targetId } = mergeBody.parse(req.body);

      if (id === targetId) return reply.badRequest('Cannot merge a contact into itself');

      const [primary] = await app.db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .limit(1);
      if (!primary) return reply.notFound('Primary contact not found');

      const [target] = await app.db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, targetId), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
        .limit(1);
      if (!target) return reply.notFound('Target contact not found');

      await app.db.transaction(async (tx) => {
        // Lock both contact rows to avoid concurrent writes during merge.
        await tx.execute(
          sql`SELECT id FROM contacts WHERE id IN (${id}, ${targetId}) FOR UPDATE`,
        );

        // Reassign identities (unique on channel+identifier — cascade-delete dupes).
        // If primary already has same (channel, identifier), drop target's to avoid unique violation.
        await tx.execute(sql`
          delete from contact_identities ci
          where ci.contact_id = ${targetId}
            and exists (
              select 1 from contact_identities cj
              where cj.contact_id = ${id}
                and cj.channel = ci.channel
                and cj.identifier = ci.identifier
            )
        `);
        await tx
          .update(schema.contactIdentities)
          .set({ contactId: id })
          .where(eq(schema.contactIdentities.contactId, targetId));

        // Tags — onConflictDoNothing pattern via INSERT ... SELECT.
        await tx.execute(sql`
          insert into contact_tags (contact_id, tag_id)
          select ${id}, tag_id from contact_tags where contact_id = ${targetId}
          on conflict do nothing
        `);
        await tx
          .delete(schema.contactTags)
          .where(eq(schema.contactTags.contactId, targetId));

        // Conversations.
        await tx
          .update(schema.conversations)
          .set({ contactId: id })
          .where(eq(schema.conversations.contactId, targetId));

        // Notes.
        await tx
          .update(schema.contactNotes)
          .set({ contactId: id })
          .where(eq(schema.contactNotes.contactId, targetId));

        // Merge customFields — primary wins on conflict.
        const mergedCustom: Record<string, unknown> = {
          ...((target.customFields as Record<string, unknown>) ?? {}),
          ...((primary.customFields as Record<string, unknown>) ?? {}),
        };

        // Backfill nullable fields on primary from target (primary wins when set).
        const primaryPatch: Record<string, unknown> = {
          customFields: mergedCustom,
          updatedAt: new Date(),
        };
        if (!primary.name && target.name) primaryPatch.name = target.name;
        if (!primary.email && target.email) primaryPatch.email = target.email;
        if (!primary.phone && target.phone) primaryPatch.phone = target.phone;
        if (!primary.avatarUrl && target.avatarUrl) primaryPatch.avatarUrl = target.avatarUrl;

        await tx
          .update(schema.contacts)
          .set(primaryPatch)
          .where(eq(schema.contacts.id, id));

        // Soft-delete target.
        await tx
          .update(schema.contacts)
          .set({ deletedAt: new Date() })
          .where(eq(schema.contacts.id, targetId));
      });

      await writeAudit(
        req,
        {
          action: 'contact.merged',
          entityType: 'contact',
          entityId: id,
          changes: {
            targetId,
            targetEmail: target.email,
            targetPhone: target.phone,
          },
        },
        { db: app.db, log: app.log },
      );

      const [merged] = await app.db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, id))
        .limit(1);
      return publicContact(merged!);
    },
  );

  // Block/unblock live in `modules/moderation/routes.ts` (with /api/v1/blocklist).

  // ====== CSV Import ======

  app.post(
    '/api/v1/contacts/import',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      // `@fastify/multipart` decorates req with .file(); if missing, reject.
      const r = req as unknown as {
        file?: () => Promise<{
          file: NodeJS.ReadableStream;
          filename: string;
          mimetype: string;
          toBuffer: () => Promise<Buffer>;
        } | undefined>;
        isMultipart?: () => boolean;
      };
      if (typeof r.file !== 'function') {
        return reply.badRequest('multipart/form-data required');
      }
      const uploaded = await r.file();
      if (!uploaded) return reply.badRequest('missing file field');

      const buf = await uploaded.toBuffer();
      const text = buf.toString('utf8');
      const parsed = parseCsv(text);
      if (!parsed.headers.length) {
        return reply.badRequest('CSV header row is empty');
      }

      const imported: string[] = [];
      const errors: Array<{ row: number; error: string }> = [];
      let skipped = 0;

      // Process rows outside a giant transaction — per-row insert so one bad row
      // doesn't undo the batch. Dedup by email/phone seen in DB.
      for (let i = 0; i < parsed.rows.length; i++) {
        const row = parsed.rows[i]!;
        const rowNum = i + 2; // +1 for 0-index, +1 for header
        const name = row.name?.trim() || null;
        const email = row.email?.trim().toLowerCase() || null;
        const phone = row.phone?.trim() || null;
        const city = row.city?.trim() || undefined;
        const country = row.country?.trim() || undefined;
        const company = row.company?.trim() || undefined;

        if (!email && !phone) {
          skipped++;
          continue;
        }

        try {
          // Dedup check (skip if exists by email or phone).
          const dupeConds = [];
          if (email) dupeConds.push(eq(schema.contacts.email, email));
          if (phone) dupeConds.push(eq(schema.contacts.phone, phone));
          if (dupeConds.length > 0) {
            const [existing] = await app.db
              .select({ id: schema.contacts.id })
              .from(schema.contacts)
              .where(and(or(...dupeConds), eq(schema.contacts.accountId, req.user.accountId), isNull(schema.contacts.deletedAt)))
              .limit(1);
            if (existing) {
              skipped++;
              continue;
            }
          }

          const customFields: Record<string, unknown> = {};
          if (city) customFields.city = city;
          if (country) customFields.country = country;
          if (company) customFields.company = company;

          const [inserted] = await app.db
            .insert(schema.contacts)
            .values({ name, email, phone, customFields, accountId: req.user.accountId })
            .returning({ id: schema.contacts.id });
          if (inserted) imported.push(inserted.id);
        } catch (err) {
          errors.push({
            row: rowNum,
            error: err instanceof Error ? err.message : 'unknown error',
          });
        }
      }

      await writeAudit(
        req,
        {
          action: 'contact.imported',
          entityType: 'contact',
          entityId: null,
          changes: {
            imported: imported.length,
            skipped,
            errors: errors.length,
            filename: uploaded.filename,
          },
        },
        { db: app.db, log: app.log },
      );

      return { imported: imported.length, skipped, errors };
    },
  );

  // ====== LGPD ======

  /**
   * Export all data we hold about a contact (LGPD art. 9º — direito de acesso).
   * Includes contact, identities, tags, conversations, and messages.
   * Audited.
   */
  app.get(
    '/api/v1/contacts/:id/export',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [contact] = await app.db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId)))
        .limit(1);
      if (!contact) return reply.notFound();

      const identities = await app.db
        .select()
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, id));

      const tags = await app.db
        .select({
          id: schema.tags.id,
          name: schema.tags.name,
          color: schema.tags.color,
        })
        .from(schema.contactTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId))
        .where(eq(schema.contactTags.contactId, id));

      const conversations = await app.db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.contactId, id));

      const conversationIds = conversations.map((c) => c.id);
      const messages = conversationIds.length
        ? await app.db
            .select()
            .from(schema.messages)
            .where(inArray(schema.messages.conversationId, conversationIds))
        : [];

      // Compliance (LGPD art. 37): await — record the export request before responding.
      await writeAudit(
        req,
        {
          action: 'lgpd.export',
          entityType: 'contact',
          entityId: id,
          changes: { conversations: conversations.length, messages: messages.length },
        },
        { db: app.db, log: app.log },
      );

      const filename = `contact-${id}-export-${new Date().toISOString().slice(0, 10)}.json`;
      reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return {
        exportedAt: new Date().toISOString(),
        contact,
        identities,
        tags,
        conversations,
        messages,
      };
    },
  );

  /**
   * Hard-delete a contact and ALL related data (LGPD art. 18 V — direito de eliminação).
   * Cascades: contact_identities, contact_tags, conversations (and via FK cascade messages,
   * conversation_tags). Requires header `X-Confirm: purge` to avoid accidental calls.
   * Audited (audit row references actor, not the deleted contact, since the contact ID
   * will no longer exist).
   */
  app.post(
    '/api/v1/contacts/:id/purge',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (req.headers['x-confirm'] !== 'purge') {
        return reply.badRequest('missing X-Confirm: purge header');
      }
      const [contact] = await app.db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, req.user.accountId)))
        .limit(1);
      if (!contact) return reply.notFound();

      const convIds = await app.db.transaction(async (tx) => {
        // Lock the contact row to prevent concurrent webhook inserts during purge.
        await tx.execute(sql`SELECT id FROM contacts WHERE id = ${id} FOR UPDATE`);

        // Re-read conversations INSIDE the tx (race-safe).
        const conversations = await tx
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(eq(schema.conversations.contactId, id));
        const cIds = conversations.map((c) => c.id);

        if (cIds.length) {
          // action_logs.conversation_id has on-delete:set null but the row contains PII payload.
          // Wipe action_logs for these conversations BEFORE the conversations are deleted.
          await tx
            .delete(schema.actionLogs)
            .where(inArray(schema.actionLogs.conversationId, cIds));
          await tx
            .delete(schema.messages)
            .where(inArray(schema.messages.conversationId, cIds));
          await tx
            .delete(schema.conversationTags)
            .where(inArray(schema.conversationTags.conversationId, cIds));
          await tx
            .delete(schema.conversations)
            .where(inArray(schema.conversations.id, cIds));
        }
        // Action logs that reference the contact directly (without conversation).
        await tx
          .delete(schema.actionLogs)
          .where(eq(schema.actionLogs.contactId, id));
        await tx
          .delete(schema.contactIdentities)
          .where(eq(schema.contactIdentities.contactId, id));
        await tx
          .delete(schema.contactTags)
          .where(eq(schema.contactTags.contactId, id));
        await tx
          .delete(schema.contactNotes)
          .where(eq(schema.contactNotes.contactId, id));
        await tx.delete(schema.contacts).where(eq(schema.contacts.id, id));
        return cIds;
      });

      // Audit row records the actor and the *previously held* identifiers — useful for
      // proof of compliance with deletion requests.
      await writeAudit(
        req,
        {
          action: 'lgpd.purge',
          entityType: 'contact',
          entityId: id,
          changes: {
            email: contact.email,
            phone: contact.phone,
            conversations: convIds.length,
          },
        },
        { db: app.db, log: app.log },
      );

      return reply.code(204).send();
    },
  );
}

// ====== CSV parser (minimal, RFC 4180-ish) ======
// Handles quoted fields, escaped double-quotes, CRLF or LF. Not streaming —
// full file in memory is OK for the 10 MB limit set on multipart.
function parseCsv(text: string): {
  headers: string[];
  rows: Array<Record<string, string>>;
} {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Strip BOM.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush last field/row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const objRows = rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => {
      const obj: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]!] = r[j] ?? '';
      }
      return obj;
    });
  return { headers, rows: objRows };
}
