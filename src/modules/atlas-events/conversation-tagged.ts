import { z } from 'zod';

/**
 * [6.4-T-11] `conversation_tagged` — kind constant + zod payload schema.
 *
 * The generic sibling of `lead_qualified` (D20): where `lead_qualified` fires
 * ONLY for the `qualified` tag and carries CRM-shaped identity, this kind fires
 * for EVERY tag and carries the tag name, so Atlas-side journey triggers
 * (Task 6.4) can match on arbitrary tags (`vip`, `hot-lead`, `disqualified`).
 * For the `qualified` tag both fire in PARALLEL — `lead_qualified` stays for the
 * CRM handler's backwards-compat, `conversation_tagged` feeds journeys.
 *
 * Like `lead-qualified.ts`, this file is the single source of truth for the
 * kind constant + payload shape (the builder in `build-connector-event.ts` and
 * the Atlas-side trigger matcher both import from here). The connector envelope
 * keeps `kind` open and `metadata` free-form (spec §12.1.01), so the typed
 * payload is parked under `metadata.conversation_tagged`.
 *
 * Payload shape (spec §5.B.1):
 *   {
 *     tagName: string,                      // the applied tag's name (any)
 *     conversationId: string,               // mirrors envelope.source_ref.id
 *     contactId: string | null,             // the conversation's contact, if any
 *     taggedAt: ISO string (with offset),   // when the tag landed
 *     actor?: { kind, id } | null,          // who applied it, when known
 *   }
 *
 * `actor` is optional/nullable: the `conversation.tagged` realtime event does
 * not carry the tagging actor yet, so the builder emits `null` until the bus
 * event grows an actor field. `contactId` is nullable because an unassigned /
 * anonymous conversation can still be tagged.
 */

export const CONVERSATION_TAGGED_KIND = 'conversation_tagged' as const;
export type ConversationTaggedKind = typeof CONVERSATION_TAGGED_KIND;

export const ConversationTaggedActorSchema = z.object({
  kind: z.enum(['contact', 'user', 'bot', 'system']),
  id: z.string().min(1),
});
export type ConversationTaggedActor = z.infer<typeof ConversationTaggedActorSchema>;

export const ConversationTaggedPayloadSchema = z.object({
  tagName: z.string().min(1),
  conversationId: z.string().min(1),
  contactId: z.string().min(1).nullable(),
  taggedAt: z.string().datetime({ offset: true }),
  actor: ConversationTaggedActorSchema.nullable().optional(),
});
export type ConversationTaggedPayload = z.infer<typeof ConversationTaggedPayloadSchema>;

export type ParseConversationTaggedPayloadResult =
  | { ok: true; payload: ConversationTaggedPayload }
  | { ok: false; error: z.ZodError };

export function parseConversationTaggedPayload(
  input: unknown,
): ParseConversationTaggedPayloadResult {
  const r = ConversationTaggedPayloadSchema.safeParse(input);
  if (r.success) return { ok: true, payload: r.data };
  return { ok: false, error: r.error };
}
