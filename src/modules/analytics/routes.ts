import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

const periodQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    inboxId: z.string().uuid().optional(),
  })
  .refine(
    (v) => !v.from || !v.to || (v.from <= v.to && v.to.getTime() - v.from.getTime() <= MAX_RANGE_MS),
    { message: 'invalid range (from > to or > 366d)' },
  );

function defaultPeriod(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

/** Pass dates as ISO strings — drizzle/postgres-js doesn't auto-serialize Date in raw sql templates. */
function iso(d: Date): string {
  return d.toISOString();
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Neutralize Excel/Sheets formula injection: prefix dangerous leading chars with a single-quote.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\n');
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Overview KPIs for the period:
   * - messages received/sent
   * - conversations created/resolved
   * - average first-response time (seconds)
   */
  app.get(
    '/api/v1/analytics/overview',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const q = periodQuery.parse(req.query);
      const period = q.from && q.to ? { from: q.from, to: q.to } : defaultPeriod();

      const accountFilter = sql`AND m.account_id = ${req.user.accountId}`;
      const accountFilterConv = sql`AND c.account_id = ${req.user.accountId}`;
      const inboxFilter = q.inboxId
        ? sql`AND m.inbox_id = ${q.inboxId}`
        : sql``;
      const inboxFilterConv = q.inboxId
        ? sql`AND c.inbox_id = ${q.inboxId}`
        : sql``;

      const [messages] = await app.db.execute<{
        received: number;
        sent: number;
      }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE m.sender_type = 'contact')::int AS received,
          COUNT(*) FILTER (WHERE m.sender_type IN ('user','bot')) ::int AS sent
        FROM messages m
        WHERE m.created_at >= ${iso(period.from)}
          AND m.created_at <= ${iso(period.to)}
          AND m.is_private_note = false
          ${accountFilter}
          ${inboxFilter}
      `);

      const [conversations] = await app.db.execute<{
        created: number;
        resolved: number;
      }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE c.created_at >= ${iso(period.from)} AND c.created_at <= ${iso(period.to)})::int AS created,
          COUNT(*) FILTER (WHERE c.resolved_at >= ${iso(period.from)} AND c.resolved_at <= ${iso(period.to)})::int AS resolved
        FROM conversations c
        WHERE c.deleted_at IS NULL
          ${accountFilterConv}
          ${inboxFilterConv}
      `);

      const [firstResp] = await app.db.execute<{ avg_seconds: number | null }>(sql`
        SELECT
          AVG(EXTRACT(EPOCH FROM (c.first_response_at - c.created_at)))::float AS avg_seconds
        FROM conversations c
        WHERE c.first_response_at IS NOT NULL
          AND c.created_at >= ${iso(period.from)}
          AND c.created_at <= ${iso(period.to)}
          AND c.deleted_at IS NULL
          ${accountFilterConv}
          ${inboxFilterConv}
      `);

      return {
        period: { from: period.from.toISOString(), to: period.to.toISOString() },
        messages: {
          received: messages?.received ?? 0,
          sent: messages?.sent ?? 0,
          total: (messages?.received ?? 0) + (messages?.sent ?? 0),
        },
        conversations: {
          created: conversations?.created ?? 0,
          resolved: conversations?.resolved ?? 0,
        },
        firstResponseAvgSeconds: firstResp?.avg_seconds ?? null,
      };
    },
  );

  /** Daily message volume (received vs sent), one row per UTC day. */
  app.get(
    '/api/v1/analytics/by-day',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const q = periodQuery.parse(req.query);
      const period = q.from && q.to ? { from: q.from, to: q.to } : defaultPeriod();
      const inboxFilter = q.inboxId ? sql`AND inbox_id = ${q.inboxId}` : sql``;

      const rows = await app.db.execute<{
        day: string;
        received: number;
        sent: number;
      }>(sql`
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE sender_type = 'contact')::int AS received,
          COUNT(*) FILTER (WHERE sender_type IN ('user','bot'))::int AS sent
        FROM messages
        WHERE created_at >= ${iso(period.from)}
          AND created_at <= ${iso(period.to)}
          AND is_private_note = false
          AND account_id = ${req.user.accountId}
          ${inboxFilter}
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      return { items: Array.from(rows) };
    },
  );

  /** Per-agent counts: messages sent + conversations resolved. */
  app.get(
    '/api/v1/analytics/by-agent',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const q = periodQuery.parse(req.query);
      const period = q.from && q.to ? { from: q.from, to: q.to } : defaultPeriod();

      const rows = await app.db.execute<{
        userId: string;
        userName: string;
        messages: number;
        resolved: number;
      }>(sql`
        WITH msgs AS (
          SELECT sender_id AS user_id, COUNT(*)::int AS cnt
          FROM messages
          WHERE sender_type = 'user'
            AND created_at >= ${iso(period.from)}
            AND created_at <= ${iso(period.to)}
            AND is_private_note = false
            AND account_id = ${req.user.accountId}
          GROUP BY sender_id
        ),
        convs AS (
          SELECT resolved_by AS user_id, COUNT(*)::int AS cnt
          FROM conversations
          WHERE resolved_by IS NOT NULL
            AND resolved_at >= ${iso(period.from)}
            AND resolved_at <= ${iso(period.to)}
            AND account_id = ${req.user.accountId}
          GROUP BY resolved_by
        )
        SELECT
          u.id AS "userId",
          u.name AS "userName",
          COALESCE(m.cnt, 0) AS messages,
          COALESCE(c.cnt, 0) AS resolved
        FROM users u
        INNER JOIN account_users au ON au.user_id = u.id AND au.account_id = ${req.user.accountId}
        LEFT JOIN msgs m ON m.user_id = u.id
        LEFT JOIN convs c ON c.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND (m.cnt > 0 OR c.cnt > 0)
        ORDER BY messages DESC
        LIMIT 50
      `);

      return { items: Array.from(rows) };
    },
  );

  /** Per-channel counts: messages received + conversations created. */
  app.get(
    '/api/v1/analytics/by-inbox',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const q = periodQuery.parse(req.query);
      const period = q.from && q.to ? { from: q.from, to: q.to } : defaultPeriod();

      const rows = await app.db.execute<{
        inboxId: string;
        inboxName: string;
        channelType: string;
        messages: number;
        conversations: number;
      }>(sql`
        WITH msgs AS (
          SELECT inbox_id, COUNT(*)::int AS cnt
          FROM messages
          WHERE created_at >= ${iso(period.from)}
            AND created_at <= ${iso(period.to)}
            AND is_private_note = false
            AND account_id = ${req.user.accountId}
          GROUP BY inbox_id
        ),
        convs AS (
          SELECT inbox_id, COUNT(*)::int AS cnt
          FROM conversations
          WHERE created_at >= ${iso(period.from)}
            AND created_at <= ${iso(period.to)}
            AND deleted_at IS NULL
            AND account_id = ${req.user.accountId}
          GROUP BY inbox_id
        )
        SELECT
          i.id AS "inboxId",
          i.name AS "inboxName",
          i.channel_type::text AS "channelType",
          COALESCE(m.cnt, 0) AS messages,
          COALESCE(c.cnt, 0) AS conversations
        FROM inboxes i
        LEFT JOIN msgs m ON m.inbox_id = i.id
        LEFT JOIN convs c ON c.inbox_id = i.id
        WHERE i.deleted_at IS NULL
          AND i.account_id = ${req.user.accountId}
        ORDER BY messages DESC
      `);

      return { items: Array.from(rows) };
    },
  );

  /** CSV export of overview + by-agent + by-inbox in one file. */
  app.get(
    '/api/v1/analytics/export',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const q = periodQuery.parse(req.query);
      const period = q.from && q.to ? { from: q.from, to: q.to } : defaultPeriod();

      // Reuse the same SQL by inlining (small data set, single export).
      const byAgent = await app.db.execute<{
        userId: string;
        userName: string;
        messages: number;
        resolved: number;
      }>(sql`
        WITH msgs AS (
          SELECT sender_id AS user_id, COUNT(*)::int AS cnt
          FROM messages
          WHERE sender_type = 'user' AND created_at >= ${iso(period.from)} AND created_at <= ${iso(period.to)}
            AND is_private_note = false
            AND account_id = ${req.user.accountId}
          GROUP BY sender_id
        ),
        convs AS (
          SELECT resolved_by AS user_id, COUNT(*)::int AS cnt
          FROM conversations
          WHERE resolved_by IS NOT NULL AND resolved_at >= ${iso(period.from)} AND resolved_at <= ${iso(period.to)}
            AND account_id = ${req.user.accountId}
          GROUP BY resolved_by
        )
        SELECT u.id AS "userId", u.name AS "userName",
          COALESCE(m.cnt,0) AS messages, COALESCE(c.cnt,0) AS resolved
        FROM users u
        INNER JOIN account_users au ON au.user_id = u.id AND au.account_id = ${req.user.accountId}
        LEFT JOIN msgs m ON m.user_id = u.id
        LEFT JOIN convs c ON c.user_id = u.id
        WHERE u.deleted_at IS NULL AND (m.cnt > 0 OR c.cnt > 0)
        ORDER BY messages DESC
      `);

      const byInbox = await app.db.execute<{
        inboxId: string;
        inboxName: string;
        channelType: string;
        messages: number;
        conversations: number;
      }>(sql`
        WITH msgs AS (
          SELECT inbox_id, COUNT(*)::int AS cnt FROM messages
          WHERE created_at >= ${iso(period.from)} AND created_at <= ${iso(period.to)} AND is_private_note=false
            AND account_id = ${req.user.accountId}
          GROUP BY inbox_id
        ),
        convs AS (
          SELECT inbox_id, COUNT(*)::int AS cnt FROM conversations
          WHERE created_at >= ${iso(period.from)} AND created_at <= ${iso(period.to)} AND deleted_at IS NULL
            AND account_id = ${req.user.accountId}
          GROUP BY inbox_id
        )
        SELECT i.id AS "inboxId", i.name AS "inboxName", i.channel_type::text AS "channelType",
          COALESCE(m.cnt,0) AS messages, COALESCE(c.cnt,0) AS conversations
        FROM inboxes i
        LEFT JOIN msgs m ON m.inbox_id = i.id
        LEFT JOIN convs c ON c.inbox_id = i.id
        WHERE i.deleted_at IS NULL
          AND i.account_id = ${req.user.accountId}
        ORDER BY messages DESC
      `);

      // BOM so Excel (Windows pt-BR) reads UTF-8 correctly.
      const out =
        '\uFEFF' +
        [
          '# Blossom Inbox — analytics export',
          `# from,${period.from.toISOString()}`,
          `# to,${period.to.toISOString()}`,
          '',
          '## by-agent',
          rowsToCsv(['userId', 'userName', 'messages', 'resolved'], Array.from(byAgent)),
          '',
          '## by-inbox',
          rowsToCsv(
            ['inboxId', 'inboxName', 'channelType', 'messages', 'conversations'],
            Array.from(byInbox),
          ),
        ].join('\n');

      const filename = `blossom-analytics-${period.from.toISOString().slice(0, 10)}_${period.to
        .toISOString()
        .slice(0, 10)}.csv`;
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return out;
    },
  );

  // expose schema indirectly to silence unused-export warning
  void schema;
}
