import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type DB = PostgresJsDatabase<typeof schema>;

export function createDb(url: string): { db: DB; client: postgres.Sql } {
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, client };
}
