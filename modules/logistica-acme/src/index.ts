import { z } from 'zod';
import { defineModule } from '@blossom/sdk';

interface DispatchEntry {
  id: string;
  orderId: string;
  carrier: string;
  status: 'pending' | 'dispatched' | 'failed';
  note?: string;
  createdAt: string;
}

const store: DispatchEntry[] = [];

const createBody = z.object({
  orderId: z.string().min(1).max(120),
  carrier: z.string().min(1).max(60),
  status: z.enum(['pending', 'dispatched', 'failed']).default('pending'),
  note: z.string().max(500).optional(),
});

export default defineModule({
  key: 'logistica-acme',
  name: 'Logística ACME',
  description: 'Despachos e erros de logística da ACME (módulo de exemplo).',
  tabs: [
    { href: '/modules/logistica-acme', label: 'Logística ACME', icon: 'Truck' },
  ],
  registerBackend: (app, ctx) => {
    app.get(
      '/api/v1/modules/logistica-acme/dispatches',
      { preHandler: app.requireAuth },
      async () => ({ items: [...store].reverse() }),
    );

    app.post(
      '/api/v1/modules/logistica-acme/dispatches',
      { preHandler: app.requireAuth },
      async (req, reply) => {
        const parsed = createBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
        }
        const body = parsed.data;
        const entry: DispatchEntry = {
          id: crypto.randomUUID(),
          orderId: body.orderId,
          carrier: body.carrier,
          status: body.status,
          note: body.note,
          createdAt: new Date().toISOString(),
        };
        store.push(entry);
        ctx.log.info(
          { module: 'logistica-acme', entryId: entry.id, status: entry.status },
          'dispatch recorded',
        );
        return reply.code(201).send(entry);
      },
    );
  },
});
