import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeFetch } from '../../lib/safe-fetch';

const query = z.object({ url: z.string().url() });
const TTL_SECONDS = 24 * 3600;

interface Preview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** Extract an HTML meta value given a regex pattern. Case-insensitive, non-greedy. */
function extractMeta(html: string, pattern: RegExp): string | null {
  const m = pattern.exec(html);
  return m?.[1]?.trim() ?? null;
}

function parseOpenGraph(html: string, fallbackUrl: string): Preview {
  const og = (p: string) =>
    new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)`, 'i');
  const name = (p: string) =>
    new RegExp(`<meta[^>]+name=["']${p}["'][^>]+content=["']([^"']+)`, 'i');
  return {
    url: fallbackUrl,
    title:
      extractMeta(html, og('title')) ??
      extractMeta(html, /<title[^>]*>([^<]+)<\/title>/i),
    description:
      extractMeta(html, og('description')) ??
      extractMeta(html, name('description')),
    image: extractMeta(html, og('image')),
    siteName: extractMeta(html, og('site_name')),
  };
}

/**
 * Fetch Open Graph preview for a URL. SSRF-protected via safeFetch; cached in
 * Redis 24h. Never blocks the composer (client handles slow responses).
 */
export async function linkPreviewRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/link-preview',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) return reply.badRequest('invalid url');
      const { url } = parsed.data;
      const cacheKey = `link-preview:${url}`;
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {/* fallthrough */}
      }
      try {
        const res = await safeFetch(url, {
          method: 'GET',
          headers: { Accept: 'text/html,*/*;q=0.8' },
        });
        if (!res.ok) return reply.notFound();
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('text/html')) return reply.badRequest('not html');
        // Limit body size to 512KB — OG tags live in <head>.
        const reader = res.body?.getReader();
        if (!reader) return reply.notFound();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < 512 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
        await reader.cancel().catch(() => {/* ignore */});
        const html = new TextDecoder().decode(
          new Uint8Array(chunks.reduce<number[]>((a, c) => a.concat(Array.from(c)), [])),
        );
        const preview = parseOpenGraph(html, url);
        await app.redis.set(cacheKey, JSON.stringify(preview), 'EX', TTL_SECONDS);
        return preview;
      } catch (err) {
        app.log.warn({ err, url }, 'link-preview: fetch failed');
        return reply.notFound();
      }
    },
  );
}
