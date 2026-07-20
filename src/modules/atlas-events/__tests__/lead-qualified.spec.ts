import { describe, expect, it } from 'vitest';

import { LeadQualifiedPayloadSchema } from '../lead-qualified';

// Fase 4 (qualifier 3 rotas): `route` espelha o schema Atlas-side
// (apps/worker/src/queues/handlers/crm-lead-qualified.ts) — cópias deliberadas,
// shapes em lockstep.

const base = {
  contact: { phone: '+5511900000000' },
  source_ref: 'conv_1',
  tagged_at: '2026-07-20T12:00:00-03:00',
};

describe('LeadQualifiedPayloadSchema route', () => {
  it('aceita route=meeting-ready', () => {
    const r = LeadQualifiedPayloadSchema.safeParse({ ...base, route: 'meeting-ready' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.route).toBe('meeting-ready');
  });

  it('aceita route=nurture', () => {
    const r = LeadQualifiedPayloadSchema.safeParse({ ...base, route: 'nurture' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.route).toBe('nurture');
  });

  it('aceita ausência de route (backward compat)', () => {
    const r = LeadQualifiedPayloadSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.route).toBeUndefined();
  });

  it('rejeita route inválido', () => {
    const r = LeadQualifiedPayloadSchema.safeParse({ ...base, route: 'bogus' });
    expect(r.success).toBe(false);
  });
});
