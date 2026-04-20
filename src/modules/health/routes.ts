import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { HealthResponse } from '@blossom/shared-types';

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/health', async (): Promise<HealthResponse> => {
    const checks: HealthResponse['checks'] = { db: 'down', redis: 'down' };

    try {
      await app.db.execute(sql`SELECT 1`);
      checks.db = 'ok';
    } catch (err) {
      app.log.error({ err }, 'health: db check failed');
    }

    try {
      const pong = await app.redis.ping();
      if (pong === 'PONG') checks.redis = 'ok';
    } catch (err) {
      app.log.error({ err }, 'health: redis check failed');
    }

    const allOk = checks.db === 'ok' && checks.redis === 'ok';

    return {
      status: allOk ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '0.0.1',
      uptime: Math.round((Date.now() - startedAt) / 1000),
      checks,
    };
  });
}
