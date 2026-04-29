import { mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import {
  uploadFile,
  isGcsEnabled,
  reserveWriteSlot,
  StorageQuotaExceeded,
} from '../../lib/storage';

const LOCAL_UPLOADS_DIR = join(import.meta.dirname, '..', '..', '..', 'uploads');

// Defensive cap on per-file size. Smaller than the prior 10 MB to keep the
// total storage footprint well inside R2's 10 GB free tier. Override via env.
const MAX_FILE_SIZE = (Number(process.env.STORAGE_MAX_FILE_SIZE_MB) || 2) * 1024 * 1024;
const MAX_FILE_SIZE_LABEL = `${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB`;

const ALLOWED_EXTENSIONS = new Set([
  // Images (SVG excluded — can contain scripts)
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt',
  // Audio
  '.mp3', '.ogg', '.wav', '.m4a',
  // Video
  '.mp4', '.webm',
]);

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Multipart parser for file uploads.
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1,
      },
    });
  }
  app.log.info(
    { maxFileSize: MAX_FILE_SIZE_LABEL, monthlyWriteLimit: process.env.STORAGE_MONTHLY_WRITE_LIMIT ?? '500000 (default)' },
    'uploads: storage limits',
  );

  // Local filesystem fallback: only when GCS is not configured.
  // Production must set GCS_BUCKET_NAME — see lib/storage.ts.
  if (!isGcsEnabled()) {
    await mkdir(LOCAL_UPLOADS_DIR, { recursive: true });
    await app.register(fastifyStatic, {
      root: LOCAL_UPLOADS_DIR,
      prefix: '/uploads/',
      decorateReply: false,
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        res.setHeader('Content-Disposition', 'inline');
      },
    });
  }

  // ====== POST /api/v1/upload ======

  app.post(
    '/api/v1/upload',
    { onRequest: app.requireAuth },
    async (req, reply) => {
      const r = req as unknown as {
        file?: () => Promise<{
          file: NodeJS.ReadableStream;
          filename: string;
          mimetype: string;
          toBuffer: () => Promise<Buffer>;
        } | undefined>;
      };

      if (typeof r.file !== 'function') {
        return reply.badRequest('multipart/form-data required');
      }

      const uploaded = await r.file();
      if (!uploaded) {
        return reply.badRequest('Missing file field');
      }

      const originalName = uploaded.filename;
      const ext = extname(originalName).toLowerCase();
      if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        return reply.badRequest(
          `File type "${ext || 'unknown'}" is not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
        );
      }

      let buf: Buffer;
      try {
        buf = await uploaded.toBuffer();
      } catch {
        return reply
          .code(413)
          .send({ error: `File exceeds the ${MAX_FILE_SIZE_LABEL} size limit` });
      }

      if (buf.length > MAX_FILE_SIZE) {
        return reply
          .code(413)
          .send({ error: `File exceeds the ${MAX_FILE_SIZE_LABEL} size limit` });
      }

      // Defensive monthly write budget — refuse before hitting paid tier.
      try {
        await reserveWriteSlot(app.redis);
      } catch (err) {
        if (err instanceof StorageQuotaExceeded) {
          app.log.warn({ used: err.used, limit: err.limit }, 'storage: monthly write budget exhausted');
          return reply.code(503).send({
            error:
              'Limite mensal de uploads atingido para esta instância. Tente novamente no próximo mês ou contate o admin.',
          });
        }
        throw err;
      }

      // Path includes accountId so each tenant's files are isolated and
      // easy to audit/purge (LGPD right-to-erasure). UUID keeps URL unguessable.
      const key = `${req.user.accountId}/${randomUUID()}${ext}`;
      const result = await uploadFile(buf, key, uploaded.mimetype);

      return {
        url: result.url,
        mimeType: uploaded.mimetype,
        originalName,
      };
    },
  );
}
