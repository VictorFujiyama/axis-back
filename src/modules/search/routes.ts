import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { userInboxIds } from '../conversations/access';

const searchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : ['messages', 'contacts', 'conversations'])),
});

// Raw-SQL handles to the generated tsvector columns (not modeled in Drizzle schema
// because generated columns aren't inserted/selected via ORM in this codebase).
const msgSearchVector = sql.raw('messages.search_vector');
const contactSearchVector = sql.raw('contacts.search_vector');

/**
 * Global search across messages, contacts, and conversations.
 * Uses Postgres GIN tsvectors (see migrations/0006_search_vectors.sql).
 * Scope: restricted to rows not soft-deleted. Role-level scoping (agent sees only
 * assigned) is deferred — all authenticated users can search; tune later if needed.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/search',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = searchQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.badRequest(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const query = parsed.data;
      const tsquery = sql`websearch_to_tsquery('simple', ${query.q})`;
      const out: Record<string, unknown> = {};

      // For agents, restrict message/conversation results to inboxes they belong to.
      // Admin/supervisor see everything.
      const needsInboxFilter = req.user.role === 'agent';
      const allowedInboxIds = needsInboxFilter
        ? await userInboxIds(app, req.user.sub, req.user.accountId)
        : null;
      if (needsInboxFilter && allowedInboxIds!.length === 0) {
        return { messages: [], contacts: [], conversations: [] };
      }

      if (query.kinds.includes('messages')) {
        const conditions = [
          sql`${msgSearchVector} @@ ${tsquery}`,
          eq(schema.messages.accountId, req.user.accountId),
          // Recency cutoff: messages older than 180 days rarely relevant and
          // scanning them scales poorly once the table grows.
          gte(
            schema.messages.createdAt,
            new Date(Date.now() - 180 * 24 * 3600 * 1000),
          ),
        ];
        if (needsInboxFilter) {
          conditions.push(inArray(schema.messages.inboxId, allowedInboxIds!));
        }
        const rows = await app.db
          .select({
            id: schema.messages.id,
            conversationId: schema.messages.conversationId,
            inboxId: schema.messages.inboxId,
            content: schema.messages.content,
            createdAt: schema.messages.createdAt,
            rank: sql<number>`ts_rank(${msgSearchVector}, ${tsquery})`.as('rank'),
          })
          .from(schema.messages)
          .where(and(...conditions))
          .orderBy(desc(sql`rank`), desc(schema.messages.createdAt))
          .limit(query.limit);
        out.messages = rows;
      }

      if (query.kinds.includes('contacts')) {
        const rows = await app.db
          .select({
            id: schema.contacts.id,
            name: schema.contacts.name,
            email: schema.contacts.email,
            phone: schema.contacts.phone,
            createdAt: schema.contacts.createdAt,
            rank: sql<number>`ts_rank(${contactSearchVector}, ${tsquery})`.as('rank'),
          })
          .from(schema.contacts)
          .where(
            and(
              sql`${contactSearchVector} @@ ${tsquery}`,
              eq(schema.contacts.accountId, req.user.accountId),
              isNull(schema.contacts.deletedAt),
            ),
          )
          .orderBy(desc(sql`rank`), desc(schema.contacts.createdAt))
          .limit(query.limit);
        out.contacts = rows;
      }

      if (query.kinds.includes('conversations')) {
        // Conversations are searched via their contact (name/email/phone).
        const conditions = [
          sql`${contactSearchVector} @@ ${tsquery}`,
          eq(schema.conversations.accountId, req.user.accountId),
          isNull(schema.conversations.deletedAt),
        ];
        if (needsInboxFilter) {
          conditions.push(inArray(schema.conversations.inboxId, allowedInboxIds!));
        }
        const rows = await app.db
          .select({
            id: schema.conversations.id,
            contactId: schema.conversations.contactId,
            inboxId: schema.conversations.inboxId,
            status: schema.conversations.status,
            contactName: schema.contacts.name,
            contactEmail: schema.contacts.email,
            createdAt: schema.conversations.createdAt,
            rank: sql<number>`ts_rank(${contactSearchVector}, ${tsquery})`.as('rank'),
          })
          .from(schema.conversations)
          .innerJoin(
            schema.contacts,
            eq(schema.contacts.id, schema.conversations.contactId),
          )
          .where(and(...conditions))
          .orderBy(desc(sql`rank`), desc(schema.conversations.createdAt))
          .limit(query.limit);
        out.conversations = rows;
      }

      return out;
    },
  );
}
