import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { config as appConfig } from '../../config';
import { sha256 } from '../../crypto';
import { writeAudit } from '../../lib/audit';

// Fase 3 (T-A.3 / T-A.4) — playbook versioning endpoints. `inbox_playbooks`
// holds the current content; every save appends a row to
// `inbox_playbook_versions`. Revert never rewrites history: it creates a NEW
// version carrying the old content, so the log stays linear.

const inboxIdParams = z.object({ inboxId: z.string().uuid() });

// Same content bounds as the PATCH /inboxes playbook field (D13/D14).
const versionBody = z.object({
  content: z.string().min(20).max(10000),
  note: z.string().max(500).optional(),
  // Optimistic concurrency: etag of the version the client loaded. Absent is
  // only valid when the inbox has no playbook yet (first version).
  etag: z.string().nullable().optional(),
});

const versionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  // Keyset cursor: return versions strictly below this number.
  before: z.coerce.number().int().positive().optional(),
});

const revertBody = z.object({ toVersion: z.number().int().positive() });

class HttpConflict extends Error {}
class HttpNotFound extends Error {}

function etagFor(content: string): string {
  return sha256(content).slice(0, 16);
}

function publicPlaybook(row: {
  inboxId: string;
  content: string;
  etag: string;
  version: number;
  updatedAt: Date;
}) {
  return {
    inboxId: row.inboxId,
    content: row.content,
    etag: row.etag,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export async function inboxPlaybookRoutes(app: FastifyInstance): Promise<void> {
  // Scope check shared by all three endpoints: the inbox must exist, belong to
  // the caller's account and not be soft-deleted.
  async function inboxInAccount(inboxId: string, accountId: string): Promise<boolean> {
    const [row] = await app.db
      .select({ id: schema.inboxes.id })
      .from(schema.inboxes)
      .where(
        and(
          eq(schema.inboxes.id, inboxId),
          eq(schema.inboxes.accountId, accountId),
          isNull(schema.inboxes.deletedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  app.post(
    '/api/v1/inbox-playbooks/:inboxId/version',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { inboxId } = inboxIdParams.parse(req.params);
      const parsed = versionBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const body = parsed.data;

      if (!appConfig.PLAYBOOK_IN_AXIS_ENABLED) return reply.badRequest('feature disabled');
      if (!(await inboxInAccount(inboxId, req.user.accountId))) return reply.notFound();

      const etag = etagFor(body.content);
      let newVersion = 1;
      try {
        await app.db.transaction(async (tx) => {
          // Lock the current row so concurrent saves serialize; the loser
          // re-reads post-commit state and fails the etag check below.
          const [current] = await tx
            .select()
            .from(schema.inboxPlaybooks)
            .where(eq(schema.inboxPlaybooks.inboxId, inboxId))
            .limit(1)
            .for('update');

          if (current) {
            if (body.etag == null || body.etag !== current.etag) {
              throw new HttpConflict('etag stale');
            }
            newVersion = current.version + 1;
          } else if (body.etag != null) {
            // Client thinks a playbook exists but there is none (deleted
            // meanwhile) — surface as a conflict, not a silent create.
            throw new HttpConflict('playbook no longer exists');
          }

          await tx.insert(schema.inboxPlaybookVersions).values({
            inboxId,
            version: newVersion,
            content: body.content,
            note: body.note ?? null,
            createdBy: req.user.sub,
          });

          await tx
            .insert(schema.inboxPlaybooks)
            .values({ inboxId, content: body.content, etag, version: newVersion })
            .onConflictDoUpdate({
              target: schema.inboxPlaybooks.inboxId,
              set: { content: body.content, etag, version: newVersion, updatedAt: new Date() },
            });
        });
      } catch (err) {
        if (err instanceof HttpConflict) {
          return reply.conflict('Playbook was modified by someone else. Reload and retry.');
        }
        // Unique (inbox_id, version) violation = a concurrent writer won the
        // race outside the lock path — same remedy as a stale etag.
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Playbook was modified by someone else. Reload and retry.');
        }
        throw err;
      }

      void writeAudit(
        req,
        {
          action: 'inbox_playbook.version_created',
          entityType: 'inbox',
          entityId: inboxId,
          changes: { version: newVersion, note: body.note ?? null },
        },
        { db: app.db, log: app.log },
      );

      return {
        version: newVersion,
        playbook: publicPlaybook({
          inboxId,
          content: body.content,
          etag,
          version: newVersion,
          updatedAt: new Date(),
        }),
      };
    },
  );

  app.get(
    '/api/v1/inbox-playbooks/:inboxId/versions',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { inboxId } = inboxIdParams.parse(req.params);
      const parsed = versionsQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { limit, before } = parsed.data;

      if (!(await inboxInAccount(inboxId, req.user.accountId))) return reply.notFound();

      const conditions = [eq(schema.inboxPlaybookVersions.inboxId, inboxId)];
      if (before !== undefined) conditions.push(lt(schema.inboxPlaybookVersions.version, before));

      // Fetch one extra row to know whether another page exists.
      const rows = await app.db
        .select({
          id: schema.inboxPlaybookVersions.id,
          version: schema.inboxPlaybookVersions.version,
          content: schema.inboxPlaybookVersions.content,
          note: schema.inboxPlaybookVersions.note,
          createdBy: schema.inboxPlaybookVersions.createdBy,
          createdAt: schema.inboxPlaybookVersions.createdAt,
        })
        .from(schema.inboxPlaybookVersions)
        .where(and(...conditions))
        .orderBy(desc(schema.inboxPlaybookVersions.version))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? page[page.length - 1]!.version : null;
      return { versions: page, nextCursor };
    },
  );

  app.post(
    '/api/v1/inbox-playbooks/:inboxId/revert',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { inboxId } = inboxIdParams.parse(req.params);
      const parsed = revertBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { toVersion } = parsed.data;

      if (!appConfig.PLAYBOOK_IN_AXIS_ENABLED) return reply.badRequest('feature disabled');
      if (!(await inboxInAccount(inboxId, req.user.accountId))) return reply.notFound();

      let newVersion = 0;
      let revertedContent = '';
      let etag = '';
      try {
        await app.db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(schema.inboxPlaybooks)
            .where(eq(schema.inboxPlaybooks.inboxId, inboxId))
            .limit(1)
            .for('update');
          if (!current) throw new HttpNotFound('playbook not found');

          const [target] = await tx
            .select()
            .from(schema.inboxPlaybookVersions)
            .where(
              and(
                eq(schema.inboxPlaybookVersions.inboxId, inboxId),
                eq(schema.inboxPlaybookVersions.version, toVersion),
              ),
            )
            .limit(1);
          if (!target) throw new HttpNotFound('version not found');

          newVersion = current.version + 1;
          revertedContent = target.content;
          etag = etagFor(target.content);

          await tx.insert(schema.inboxPlaybookVersions).values({
            inboxId,
            version: newVersion,
            content: target.content,
            note: `Revertido da v${toVersion}`,
            createdBy: req.user.sub,
          });

          await tx
            .update(schema.inboxPlaybooks)
            .set({ content: target.content, etag, version: newVersion, updatedAt: new Date() })
            .where(eq(schema.inboxPlaybooks.inboxId, inboxId));
        });
      } catch (err) {
        if (err instanceof HttpNotFound) return reply.notFound(err.message);
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Playbook was modified by someone else. Reload and retry.');
        }
        throw err;
      }

      void writeAudit(
        req,
        {
          action: 'inbox_playbook.reverted',
          entityType: 'inbox',
          entityId: inboxId,
          changes: { toVersion, newVersion },
        },
        { db: app.db, log: app.log },
      );

      return {
        version: newVersion,
        playbook: publicPlaybook({
          inboxId,
          content: revertedContent,
          etag,
          version: newVersion,
          updatedAt: new Date(),
        }),
      };
    },
  );
}
