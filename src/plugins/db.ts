import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createDb, type DB } from '@blossom/db';
import type postgres from 'postgres';
import { config } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    pg: postgres.Sql;
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const { db, client } = createDb(config.DATABASE_URL);
  app.decorate('db', db);
  app.decorate('pg', client);

  app.addHook('onClose', async () => {
    await client.end({ timeout: 5 });
  });
}

export default fp(plugin, { name: 'db' });
