import type Redis from 'ioredis';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import {
  DEFAULT_GMAIL_DAILY_SEND_CAP,
  effectiveDailySendCap,
  effectiveTimezone,
  parseGmailConfig,
} from '../channels/gmail-config';
import { nextMidnightMs } from '../channels/inbox-cap-time';
import {
  currentSendCount,
  isInboxPaused,
  reserveForInbox,
} from '../channels/inbox-send-cap';

const bodySchema = z.object({
  mailboxIds: z.array(z.string().uuid()).min(1).max(50),
  messageId: z.string().min(1).max(200),
  dailyCapOverride: z.number().int().min(1).max(10000).nullable().optional(),
});

interface Candidate {
  inboxId: string;
  timezone: string;
  effectiveCap: number;
  sent: number;
}

/**
 * Fase 5.1 — rotação de mailbox pra journeys de outbound.
 *
 * O `msg-email` node do journey builder passa N mailboxes (subset das inboxes
 * do time) e um dailyCapOverride opcional. A rota escolhe a menos carregada
 * (menor `sent/cap` ratio) que ainda tem cap disponível e reserva o slot
 * atomicamente via `reserveForInbox` (Lua Redis).
 *
 * Retornos:
 *  - `{ selectedMailboxId, remainingCap }` — reservou, o caller já pode enviar.
 *  - `{ delayed: true, resumeAt }` — todas capadas OU pausadas OU inválidas.
 *    `resumeAt` = próximo midnight local mais próximo entre as candidatas.
 *
 * Idempotência: o `messageId` é chave; se a mesma mensagem já foi reservada
 * antes, `reserveForInbox` retorna `reserved-already` e essa mailbox é
 * respondida como reservada (bug-free retry).
 *
 * Non-gmail inboxes são ignoradas (rotação só faz sentido em canal com cap
 * real por reputação — WhatsApp/Twilio têm outros mecanismos).
 */
export async function mailboxRotateRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/internal/mailbox-rotate',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { mailboxIds, messageId, dailyCapOverride } = parsed.data;

      const rows = await app.db
        .select()
        .from(schema.inboxes)
        .where(
          and(
            inArray(schema.inboxes.id, mailboxIds),
            isNull(schema.inboxes.deletedAt),
            eq(schema.inboxes.enabled, true),
            eq(schema.inboxes.channelType, 'email'),
          ),
        );

      const redis = app.redis as Redis;
      const nowMs = Date.now();
      const candidates: Candidate[] = [];
      const nextMidnights: number[] = [];

      for (const inbox of rows) {
        const cfg = parseGmailConfig(inbox.config);
        if ((cfg as { provider?: string }).provider !== 'gmail') continue;
        const cap = dailyCapOverride ?? effectiveDailySendCap(cfg) ?? DEFAULT_GMAIL_DAILY_SEND_CAP;
        const timezone = effectiveTimezone(cfg);
        nextMidnights.push(nextMidnightMs(timezone, nowMs));

        const paused = await isInboxPaused(redis, inbox.id);
        if (paused) continue;
        const sent = await currentSendCount(redis, inbox.id, timezone, nowMs);
        if (sent >= cap) continue;

        candidates.push({ inboxId: inbox.id, timezone, effectiveCap: cap, sent });
      }

      // Sort by remaining capacity ratio DESC (menos carregada primeiro).
      candidates.sort(
        (a, b) =>
          (b.effectiveCap - b.sent) / b.effectiveCap - (a.effectiveCap - a.sent) / a.effectiveCap,
      );

      for (const c of candidates) {
        const outcome = await reserveForInbox(redis, {
          inboxId: c.inboxId,
          messageId,
          cap: c.effectiveCap,
          timezone: c.timezone,
          nowMs,
        });
        if (outcome === 'ok' || outcome === 'reserved-already') {
          const sentAfter = await currentSendCount(redis, c.inboxId, c.timezone, nowMs);
          return {
            selectedMailboxId: c.inboxId,
            remainingCap: Math.max(0, c.effectiveCap - sentAfter),
          };
        }
        // 'paused' or 'over-cap' race — try next candidate.
      }

      const resumeAt =
        nextMidnights.length > 0
          ? new Date(Math.min(...nextMidnights)).toISOString()
          : new Date(nowMs + 60 * 60 * 1000).toISOString(); // fallback 1h se nenhuma inbox válida
      return reply.code(200).send({ delayed: true, resumeAt });
    },
  );
}
