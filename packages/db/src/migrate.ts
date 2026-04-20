import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const url =
  process.env.DATABASE_URL ?? 'postgresql://blossom:blossom_dev@localhost:5434/blossom';

async function run() {
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  console.log('[migrate] applying migrations...');
  await migrate(db, { migrationsFolder: './migrations' });
  console.log('[migrate] done');
  await client.end();
}

run().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
