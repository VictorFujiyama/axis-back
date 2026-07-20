import { z } from 'zod';

/**
 * [crm-T-01] `lead_qualified` — kind constant + zod payload schema.
 *
 * Atlas's connector envelope (`@atlas/connectors`) keeps `kind` as an open
 * string and `metadata` as a free-form record (envelope §12.1.01 forward-
 * compat). Per-kind shapes are not enumerated in the vendored manifest schema
 * — each app owns its own kind constants + payload schemas in-tree. This file
 * is the single source of truth for `lead_qualified` (T-02 builder, T-03
 * trigger, and the Atlas-side handler all import from here).
 *
 * Payload shape (spec §A.1, Decisões D3/D4):
 *   {
 *     contact: { name?, phone?, email? },   // dedup-relevant identity hints
 *     source_ref: <conv_id>,                // mirrors envelope.source_ref.id
 *     conv_summary?: string,                // optional running summary at tag time
 *     tagged_at: ISO string (with offset),  // when the qualifying tag landed
 *     route?: 'meeting-ready' | 'nurture',  // which qualifying tag fired (fase 4)
 *   }
 *
 * Identity rule: emitting with neither phone nor email is allowed at the
 * schema level (the Atlas-side handler skips materialization per D4 — "sem
 * nenhum = lead anônimo, deixa no inbox"). The schema does NOT enforce
 * at-least-one-of so the trigger can still emit a typed envelope for replay /
 * memory ingestion (D9) and the handler is the single gate.
 */

export const LEAD_QUALIFIED_KIND = 'lead_qualified' as const;
export type LeadQualifiedKind = typeof LEAD_QUALIFIED_KIND;

export const LeadQualifiedContactSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
});
export type LeadQualifiedContact = z.infer<typeof LeadQualifiedContactSchema>;

export const LeadQualifiedPayloadSchema = z.object({
  contact: LeadQualifiedContactSchema,
  source_ref: z.string().min(1),
  conv_summary: z.string().min(1).optional(),
  tagged_at: z.string().datetime({ offset: true }),
  route: z.enum(['meeting-ready', 'nurture']).optional(),
});
export type LeadQualifiedPayload = z.infer<typeof LeadQualifiedPayloadSchema>;

export type ParseLeadQualifiedPayloadResult =
  | { ok: true; payload: LeadQualifiedPayload }
  | { ok: false; error: z.ZodError };

export function parseLeadQualifiedPayload(input: unknown): ParseLeadQualifiedPayloadResult {
  const r = LeadQualifiedPayloadSchema.safeParse(input);
  if (r.success) return { ok: true, payload: r.data };
  return { ok: false, error: r.error };
}
