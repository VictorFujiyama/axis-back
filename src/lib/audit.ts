import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { schema, type DB } from '@blossom/db';

/**
 * Redacts a URL for safe storage in audit logs: keeps only the origin so we can
 * prove "where it pointed" without leaking tokens that may be in path/query/userinfo.
 */
export function redactUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[invalid-url]';
  }
}

export interface AuditEvent {
  action: string;
  entityType?: string;
  entityId?: string | null;
  changes?: Record<string, unknown>;
  /** Override the actor inferred from req.user — used in flows like login where
   * the user object isn't on the request yet. */
  actor?: { id: string | null; email: string | null };
}

interface AuditDeps {
  db: DB;
  log: FastifyBaseLogger;
}

/**
 * Persist an audit event. Fire-and-forget: failures are logged but do not throw,
 * to avoid blocking the user-facing operation. For LGPD-grade audit, switch to
 * a synchronous insert in critical paths (already so where we await this).
 */
export async function writeAudit(
  req: FastifyRequest,
  event: AuditEvent,
  deps: AuditDeps,
): Promise<void> {
  try {
    const user = (req as { user?: { sub?: string; email?: string } }).user;
    await deps.db.insert(schema.auditLogs).values({
      actorUserId: event.actor?.id ?? user?.sub ?? null,
      actorEmail: event.actor?.email ?? user?.email ?? null,
      action: event.action,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      changes: event.changes ?? {},
      ip: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
  } catch (err) {
    deps.log.error(
      {
        err,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        actorId: event.actor?.id ?? (req as { user?: { sub?: string } }).user?.sub,
      },
      'audit: failed to write',
    );
  }
}
