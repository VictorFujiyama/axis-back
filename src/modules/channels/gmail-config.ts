import { z } from 'zod';

export const GmailConfigSchema = z
  .object({
    provider: z.literal('gmail'),
    gmailEmail: z.string().email().optional(),
    gmailHistoryId: z.string().nullable().optional(),
    needsReauth: z.boolean().optional(),
    fromName: z.string().min(1).max(120).optional(),
  })
  .passthrough();

export type GmailConfig = z.infer<typeof GmailConfigSchema>;

export function parseGmailConfig(raw: unknown): GmailConfig | Record<string, never> {
  return GmailConfigSchema.safeParse(raw).data ?? {};
}
