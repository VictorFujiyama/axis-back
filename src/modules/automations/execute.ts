import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign_user'), userId: z.string().uuid() }),
  z.object({ type: z.literal('assign_team'), teamId: z.string().uuid() }),
  z.object({ type: z.literal('set_status'), status: z.enum(['open', 'pending', 'resolved', 'snoozed']) }),
  z.object({ type: z.literal('add_tag'), tagId: z.string().uuid() }),
  z.object({ type: z.literal('remove_tag'), tagId: z.string().uuid() }),
  z.object({ type: z.literal('send_message'), content: z.string().min(1).max(10_000), isPrivateNote: z.boolean().default(false) }),
]);
export type Action = z.infer<typeof ActionSchema>;

export interface ExecuteContext {
  conversationId: string;
  actorUserId: string | null;
  app: FastifyInstance;
}

/** Execute a sequence of actions sequentially on a conversation.
 *  Returns list of action types that were applied (for audit/response). */
export async function runActions(
  actions: Action[],
  ctx: ExecuteContext,
): Promise<string[]> {
  const applied: string[] = [];
  for (const action of actions) {
    try {
      await runSingle(action, ctx);
      applied.push(action.type);
    } catch (err) {
      ctx.app.log.warn(
        { err, action: action.type, conversationId: ctx.conversationId },
        'automation: action failed',
      );
    }
  }
  return applied;
}

async function runSingle(action: Action, ctx: ExecuteContext): Promise<void> {
  const now = new Date();
  const { app, conversationId } = ctx;
  switch (action.type) {
    case 'assign_user': {
      await app.db
        .update(schema.conversations)
        .set({ assignedUserId: action.userId, updatedAt: now })
        .where(eq(schema.conversations.id, conversationId));
      break;
    }
    case 'assign_team': {
      await app.db
        .update(schema.conversations)
        .set({ assignedTeamId: action.teamId, updatedAt: now })
        .where(eq(schema.conversations.id, conversationId));
      break;
    }
    case 'set_status': {
      const patch: Record<string, unknown> = { status: action.status, updatedAt: now };
      if (action.status === 'resolved') {
        patch.resolvedAt = now;
        patch.resolvedBy = ctx.actorUserId;
      } else if (action.status === 'open') {
        patch.resolvedAt = null;
        patch.resolvedBy = null;
      }
      await app.db
        .update(schema.conversations)
        .set(patch)
        .where(eq(schema.conversations.id, conversationId));
      break;
    }
    case 'add_tag': {
      try {
        await app.db
          .insert(schema.conversationTags)
          .values({ conversationId, tagId: action.tagId });
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
      }
      break;
    }
    case 'remove_tag': {
      await app.db
        .delete(schema.conversationTags)
        .where(
          and(
            eq(schema.conversationTags.conversationId, conversationId),
            eq(schema.conversationTags.tagId, action.tagId),
          ),
        );
      break;
    }
    case 'send_message': {
      const [conv] = await app.db
        .select({ inboxId: schema.conversations.inboxId })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversationId))
        .limit(1);
      if (!conv) return;
      const [msg] = await app.db
        .insert(schema.messages)
        .values({
          conversationId,
          inboxId: conv.inboxId,
          senderType: 'system',
          senderId: ctx.actorUserId,
          content: action.content,
          contentType: 'text',
          isPrivateNote: action.isPrivateNote,
        })
        .returning();
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: conv.inboxId,
        conversationId,
        // Tag as automation-emitted so event-hook never re-triggers rules on
        // this event — prevents loops without needing senderType coupling.
        source: 'automation',
        message: {
          id: msg!.id,
          conversationId: msg!.conversationId,
          inboxId: msg!.inboxId,
          senderType: msg!.senderType,
          senderId: msg!.senderId,
          content: msg!.content,
          contentType: msg!.contentType,
          isPrivateNote: msg!.isPrivateNote,
          createdAt: msg!.createdAt,
        },
      } as unknown as Parameters<typeof eventBus.emitEvent>[0]);
      break;
    }
  }
}
