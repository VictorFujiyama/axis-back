import type { FastifyInstance } from 'fastify';
import { renderMetrics } from '../../metrics';

/**
 * Public Prometheus scrape endpoint (D39, T-18-a).
 *
 * Registered like `healthRoutes` — no jwt preHandler, so it stays scrapeable.
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return renderMetrics();
  });
}
