import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@blossom/db';
import { config } from '../config';
import { hashPassword } from '../modules/auth/password';

async function main(): Promise<void> {
  const rawEmail = process.env.ADMIN_EMAIL ?? process.argv[2];
  const name = process.env.ADMIN_NAME ?? process.argv[3] ?? 'Admin';
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');

  if (!rawEmail) {
    console.error('Uso: pnpm seed:admin <email> [name]');
    console.error('Ou: ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm seed:admin');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();

  const { db, client } = createDb(config.DATABASE_URL);

  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existing) {
    console.log(`⚠️  Usuário ${email} já existe (id=${existing.id}).`);
    await client.end();
    return;
  }

  const hash = await hashPassword(password);
  const [user] = await db
    .insert(schema.users)
    .values({ email, name, passwordHash: hash, role: 'admin' })
    .returning();

  console.log('');
  console.log('✅ Usuário admin criado!');
  console.log('');
  console.log(`   ID:    ${user!.id}`);
  console.log(`   Email: ${email}`);
  console.log(`   Senha: ${password}`);
  console.log(`   Role:  admin`);
  console.log('');
  console.log('Login via:');
  console.log(`   curl -X POST http://localhost:${config.PORT}/api/v1/auth/login \\`);
  console.log(`     -H 'Content-Type: application/json' \\`);
  console.log(`     -d '{"email":"${email}","password":"${password}"}'`);
  console.log('');

  await client.end();
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
