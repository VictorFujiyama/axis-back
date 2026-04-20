import type { FastifyInstance } from 'fastify';
import { listManifests } from './loader';

export async function modulesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/modules',
    { preHandler: app.requireAuth },
    async () => ({ items: listManifests() }),
  );
}
