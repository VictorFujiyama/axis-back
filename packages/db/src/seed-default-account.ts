import postgres from 'postgres';

const url =
  process.env.DATABASE_URL ?? 'postgresql://blossom:blossom_dev@localhost:5434/blossom';

const DEFAULT_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

async function run() {
  const sql = postgres(url, { max: 1 });

  console.log('[seed] Creating default account...');
  await sql`
    INSERT INTO accounts (id, name, locale, status)
    VALUES (${DEFAULT_ACCOUNT_ID}, 'Default Account', 'pt-BR', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  console.log('[seed] Backfilling account_id on all tables...');
  const tables = [
    'inboxes', 'contacts', 'conversations', 'messages', 'tags', 'teams',
    'canned_responses', 'bots', 'custom_field_defs', 'automation_rules',
    'macros', 'campaigns', 'webhook_subscriptions', 'api_keys',
    'audit_logs', 'notifications', 'custom_actions',
  ];

  for (const table of tables) {
    const result = await sql.unsafe(
      `UPDATE ${table} SET account_id = '${DEFAULT_ACCOUNT_ID}' WHERE account_id IS NULL`,
    );
    console.log(`  ${table}: ${result.count} rows updated`);
  }

  console.log('[seed] Creating account_users from existing users...');
  await sql`
    INSERT INTO account_users (account_id, user_id, role)
    SELECT ${DEFAULT_ACCOUNT_ID}, id, role
    FROM users
    WHERE deleted_at IS NULL
    ON CONFLICT (account_id, user_id) DO NOTHING
  `;

  const [{ count }] = await sql`SELECT COUNT(*) as count FROM account_users`;
  console.log(`  account_users: ${count} rows`);

  console.log('[seed] Done!');
  await sql.end();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
