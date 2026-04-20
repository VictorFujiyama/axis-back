import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import type { UserRole } from '@blossom/shared-types';

export async function userInboxIds(
  app: FastifyInstance,
  userId: string,
  accountId?: string,
): Promise<string[]> {
  const conditions = [eq(schema.inboxMembers.userId, userId)];
  if (accountId) {
    // Join inboxes to filter by account
    const rows = await app.db
      .select({ inboxId: schema.inboxMembers.inboxId })
      .from(schema.inboxMembers)
      .innerJoin(schema.inboxes, eq(schema.inboxes.id, schema.inboxMembers.inboxId))
      .where(and(eq(schema.inboxMembers.userId, userId), eq(schema.inboxes.accountId, accountId)));
    return rows.map((r) => r.inboxId);
  }
  const rows = await app.db
    .select({ inboxId: schema.inboxMembers.inboxId })
    .from(schema.inboxMembers)
    .where(eq(schema.inboxMembers.userId, userId));
  return rows.map((r) => r.inboxId);
}

/**
 * Returns true if the user can access the conversation:
 * - Admin and supervisor: verify conversation belongs to the account
 * - Agent: only if member of the conversation's inbox AND conversation belongs to account
 */
export async function canAccessConversation(
  app: FastifyInstance,
  user: { sub: string; role: UserRole; accountId: string },
  conversationId: string,
): Promise<boolean> {
  if (user.role === 'admin' || user.role === 'supervisor') {
    const [row] = await app.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.accountId, user.accountId),
        ),
      )
      .limit(1);
    return !!row;
  }
  const allowed = await userInboxIds(app, user.sub, user.accountId);
  if (allowed.length === 0) return false;
  const [row] = await app.db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.accountId, user.accountId),
        inArray(schema.conversations.inboxId, allowed),
      ),
    )
    .limit(1);
  return !!row;
}
