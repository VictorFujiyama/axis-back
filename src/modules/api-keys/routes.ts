import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const idParams = z.object({ id: z.string().uuid() });
const createBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).default(['*']),
});

function hashSecret(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function randomKey(prefix = 'bk'): { full: string; prefix: string; secret: string } {
  const p = `${prefix}_${randomBytes(6).toString('hex')}`;
  const s = randomBytes(24).toString('base64url');
  return { full: `${p}.${s}`, prefix: p, secret: s };
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/api-keys',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const rows = await app.db
        .select({
          id: schema.apiKeys.id,
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          scopes: schema.apiKeys.scopes,
          lastUsedAt: schema.apiKeys.lastUsedAt,
          revokedAt: schema.apiKeys.revokedAt,
          createdAt: schema.apiKeys.createdAt,
        })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.accountId, req.user.accountId));
      return { items: rows };
    },
  );

  app.post(
    '/api/v1/api-keys',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      const { full, prefix, secret } = randomKey();
      const [row] = await app.db
        .insert(schema.apiKeys)
        .values({
          name: body.name,
          prefix,
          keyHash: hashSecret(secret),
          scopes: body.scopes,
          createdBy: req.user.sub,
          accountId: req.user.accountId,
        })
        .returning({
          id: schema.apiKeys.id,
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          scopes: schema.apiKeys.scopes,
          createdAt: schema.apiKeys.createdAt,
        });
      // The `key` is returned ONCE at creation — it's never re-displayed.
      return reply.code(201).send({ ...row, key: full });
    },
  );

  app.post(
    '/api/v1/api-keys/:id/revoke',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      await app.db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.accountId, req.user.accountId)));
      return reply.code(204).send();
    },
  );
}

/**
 * Middleware: authenticates a request via `Authorization: Bearer <prefix>.<secret>`
 * and decorates req.apiKey on success. Use as preHandler on public routes.
 */
export function requireApiKey(
  app: FastifyInstance,
): (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void> {
  async function failCount(ip: string): Promise<number> {
    const key = `apikey-fail:${ip}:${Math.floor(Date.now() / 1000 / 60)}`;
    try {
      const n = await app.redis.incr(key);
      if (n === 1) await app.redis.expire(key, 60);
      return n;
    } catch {
      return 0;
    }
  }

  return async (req, reply) => {
    const ip = req.ip ?? 'unknown';
    const reject = async (reason: string) => {
      const n = await failCount(ip);
      app.log.warn({ ip, reason, attempts: n, url: req.url }, 'api-key: unauthorized');
      if (n > 10) return reply.code(429).send({ error: 'Too many attempts' });
      return reply.unauthorized('Invalid API key');
    };

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return reject('missing bearer');
    const token = header.slice('Bearer '.length).trim();
    const [prefix, secret] = token.split('.');
    if (!prefix || !secret) return reject('malformed');

    const [row] = await app.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.prefix, prefix))
      .limit(1);
    if (!row || row.revokedAt) return reject(row ? 'revoked' : 'unknown prefix');

    const expected = Buffer.from(row.keyHash, 'utf8');
    const actual = Buffer.from(hashSecret(secret), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return reject('bad secret');
    }

    // Best-effort lastUsedAt update.
    void app.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.id))
      .catch(() => {/* silent */});

    (req as unknown as { apiKey: typeof row }).apiKey = row;
  };
}
