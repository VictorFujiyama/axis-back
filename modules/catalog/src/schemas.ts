import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

const optionalUrl = z
  .string()
  .max(2048)
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional()
  .refine((v) => {
    if (v == null) return true;
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Imagem deve ser uma URL http(s):// válida');

export const createProductBody = z.object({
  name: z
    .string()
    .min(1, 'Nome obrigatório')
    .max(120)
    .transform((v) => v.trim()),
  brand: optionalText(60),
  category: optionalText(60),
  price: z.number().nonnegative().max(99999999.99),
  description: optionalText(2000),
  imageUrl: optionalUrl,
});

export const updateProductBody = createProductBody.partial();

export const idParams = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  search: z.string().max(120).optional(),
  archived: z.enum(['true', 'false']).optional(),
});
