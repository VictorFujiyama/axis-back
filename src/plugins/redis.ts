import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { config } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  await redis.connect();
  app.decorate('redis', redis);

  app.addHook('onClose', async () => {
    await redis.quit();
  });
}

export default fp(plugin, { name: 'redis' });
