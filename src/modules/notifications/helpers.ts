import type { FastifyBaseLogger } from 'fastify';
import { inArray, or, sql } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';

const MENTION_RE = /@([a-zA-Z0-9_.-]{2,60})/g;

/** Extract @mention tokens from text. Case-insensitive match on users.email (before @)
 *  or users.name. Returns resolved userIds. */
export async function resolveMentions(
  text: string,
  db: DB,
): Promise<Array<{ userId: string; token: string; displayName: string }>> {
  const tokens = Array.from(new Set(Array.from(text.matchAll(MENTION_RE), (m) => m[1]!)));
  if (tokens.length === 0) return [];
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  const users = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(
      or(
        inArray(sql`lower(split_part(${schema.users.email}, '@', 1))`, lowerTokens),
        inArray(sql`lower(${schema.users.name})`, lowerTokens),
      )!,
    );
  const out: Array<{ userId: string; token: string; displayName: string }> = [];
  for (const u of users) {
    const localPart = u.email.split('@')[0]?.toLowerCase();
    const matched = tokens.find(
      (t) => t.toLowerCase() === localPart || t.toLowerCase() === u.name.toLowerCase(),
    );
    if (matched) out.push({ userId: u.id, token: matched, displayName: u.name });
  }
  return out;
}

export async function createMentionNotifications(
  db: DB,
  log: FastifyBaseLogger,
  input: {
    mentionedUserIds: string[];
    actorName: string;
    conversationId: string;
    messageId: string;
    preview: string;
  },
): Promise<void> {
  if (input.mentionedUserIds.length === 0) return;
  try {
    await db.insert(schema.notifications).values(
      input.mentionedUserIds.map((userId) => ({
        userId,
        type: 'mention' as const,
        title: `${input.actorName} mencionou você`,
        body: input.preview.slice(0, 200),
        data: {
          conversationId: input.conversationId,
          messageId: input.messageId,
        },
      })),
    );
  } catch (err) {
    log.error({ err }, 'notifications: failed to create mentions');
  }
}
