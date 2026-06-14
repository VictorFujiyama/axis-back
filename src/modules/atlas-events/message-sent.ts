import { z } from 'zod';

export const MESSAGE_SENT_KIND = 'message.sent' as const;
export type MessageSentKind = typeof MESSAGE_SENT_KIND;

export const MessageSentPayloadSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  channel: z.string().min(1),
  channelMsgId: z.string().min(1).optional(),
  deliveredAt: z.string().datetime({ offset: true }),
  sentByJourneyRunId: z.string().min(1).optional(),
  sentByNodeRunId: z.string().min(1).optional(),
});
export type MessageSentPayload = z.infer<typeof MessageSentPayloadSchema>;

export type ParseMessageSentPayloadResult =
  | { ok: true; payload: MessageSentPayload }
  | { ok: false; error: z.ZodError };

export function parseMessageSentPayload(input: unknown): ParseMessageSentPayloadResult {
  const r = MessageSentPayloadSchema.safeParse(input);
  if (r.success) return { ok: true, payload: r.data };
  return { ok: false, error: r.error };
}
