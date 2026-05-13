import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';

/**
 * MCP write-tools provision a dedicated `atlas-bot-<account_id>` user per
 * Axis account (T-019). Inserted messages from `messaging.send_message` use
 * `senderType='bot', senderId=<this-id>`, giving a clear audit trail in the
 * Axis UI (every Atlas-originated action shows up as a single bot user).
 *
 * Design (L-409 + spec D.3):
 *   - Lazy creation on first MCP write call for an account.
 *   - `is_atlas_bot=true` is the runtime gate that distinguishes bots from
 *     real humans on auth and assignment-routing paths (column added T-018).
 *   - `password_hash` is required by the schema but never used: we burn 32
 *     random bytes per row so the column is well-formed.
 *   - Membership: `account_users.role='agent'` (valid enum value — `'member'`
 *     does not exist) + `auto_offline=false` to prevent presence churn on
 *     the bot row.
 *   - Idempotent under concurrent calls: ON CONFLICT DO NOTHING on the unique
 *     `users.email` constraint plus the `(account_id, user_id)` constraint on
 *     `account_users` lets two simultaneous callers both succeed without
 *     duplicating rows.
 */

export interface AtlasBotUser {
  id: string;
  email: string;
  name: string;
}

const ATLAS_BOT_NAME = 'Atlas Assistant';

export function buildAtlasBotEmail(accountId: string): string {
  return `atlas-bot+${accountId}@atlas.internal`;
}

export async function getOrCreateAtlasBotUser(
  db: DB,
  accountId: string,
): Promise<AtlasBotUser> {
  const existing = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.users)
    .innerJoin(schema.accountUsers, eq(schema.accountUsers.userId, schema.users.id))
    .where(
      and(
        eq(schema.users.isAtlasBot, true),
        eq(schema.accountUsers.accountId, accountId),
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0];

  const email = buildAtlasBotEmail(accountId);
  // Never used for login — `is_atlas_bot=true` gates the auth path. Random
  // bytes are cheaper than rejecting the column's NOT NULL.
  const passwordHash = randomBytes(32).toString('hex');

  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.users)
      .values({
        email,
        name: ATLAS_BOT_NAME,
        passwordHash,
        isAtlasBot: true,
      })
      .onConflictDoNothing({ target: schema.users.email })
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      });

    let user: AtlasBotUser;
    if (inserted[0]) {
      user = inserted[0];
    } else {
      const [row] = await tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
        })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (!row) {
        throw new Error(`atlas-bot user row missing after ON CONFLICT (${email})`);
      }
      user = row;
    }

    await tx
      .insert(schema.accountUsers)
      .values({
        accountId,
        userId: user.id,
        role: 'agent',
        autoOffline: false,
      })
      .onConflictDoNothing({
        target: [schema.accountUsers.accountId, schema.accountUsers.userId],
      });

    return user;
  });
}
