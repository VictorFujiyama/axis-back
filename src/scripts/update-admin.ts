import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@blossom/db';
import { config } from '../config';
import { hashPassword } from '../modules/auth/password';

/**
 * One-off utility to change an existing admin's email + password.
 *   pnpm tsx src/scripts/update-admin.ts <oldEmail> <newEmail> <newPassword>
 */
async function main(): Promise<void> {
  const [oldEmail, newEmail, newPassword] = process.argv.slice(2);
  if (!oldEmail || !newEmail || !newPassword) {
    console.error('Uso: tsx src/scripts/update-admin.ts <oldEmail> <newEmail> <newPassword>');
    process.exit(1);
  }

  const { db, client } = createDb(config.DATABASE_URL);
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, oldEmail.toLowerCase()))
    .limit(1);
  if (!existing) {
    console.error(`Usuário ${oldEmail} não encontrado.`);
    await client.end();
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(schema.users)
    .set({ email: newEmail.toLowerCase(), passwordHash })
    .where(eq(schema.users.id, existing.id));

  console.log(`✅ Atualizado: ${oldEmail} → ${newEmail}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
