import { z } from 'zod';

/**
 * [marketing-T-09] `message.failed` — kind constant + zod payload schema.
 *
 * Atlas's marketing readiness round (spec D11) needs axis-back to tell Atlas
 * when an outbound send permanently fails, so the Atlas-side connector handler
 * (D12) can drop the contact into `suppression_list` (reason `bounce`/`complaint`).
 *
 * Mirrors `lead-qualified.ts` / `conversation-tagged.ts`: this file is the single
 * source of truth for the kind constant + payload shape. The builder
 * (`buildMessageFailedEnvelope` in `build-connector-event.ts`) parks this typed
 * payload under `metadata.message_failed` because the connector envelope keeps
 * `kind` open and `metadata` free-form (spec §12.1.01) — there is no first-class
 * payload slot. The Atlas-side handler reads it from there.
 *
 * Payload shape (spec §2 D11, D12, D13):
 *   {
 *     messageId: string,                    // the failed message's id
 *     conversationId: string,               // its conversation (Atlas resolves contact from it)
 *     channel: string,                      // 'email' | 'whatsapp' | 'telegram' | 'instagram' | 'messenger'
 *     failureReason: string,                // human-readable reason (feeds D12 bounce/complaint heuristic)
 *     failedAt: ISO string (with offset),   // when the failure was marked (== envelope occurred_at)
 *     sentByJourneyRunId?: string,          // present when the send originated from an Atlas journey (D13)
 *   }
 *
 * `sentByJourneyRunId` is optional: a normal (non-journey) send carries none, so
 * the Atlas handler skips the `journey_run_events` delivery_status update (D13).
 */

export const MESSAGE_FAILED_KIND = 'message.failed' as const;
export type MessageFailedKind = typeof MESSAGE_FAILED_KIND;

export const MessageFailedPayloadSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  channel: z.string().min(1),
  failureReason: z.string().min(1),
  failedAt: z.string().datetime({ offset: true }),
  sentByJourneyRunId: z.string().min(1).optional(),
});
export type MessageFailedPayload = z.infer<typeof MessageFailedPayloadSchema>;

export type ParseMessageFailedPayloadResult =
  | { ok: true; payload: MessageFailedPayload }
  | { ok: false; error: z.ZodError };

export function parseMessageFailedPayload(input: unknown): ParseMessageFailedPayloadResult {
  const r = MessageFailedPayloadSchema.safeParse(input);
  if (r.success) return { ok: true, payload: r.data };
  return { ok: false, error: r.error };
}
