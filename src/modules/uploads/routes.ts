import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const UPLOADS_DIR = join(import.meta.dirname, '..', '..', '..', 'uploads');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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
  // Ensure uploads directory exists.
  await mkdir(UPLOADS_DIR, { recursive: true });

  // Multipart parser for file uploads.
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1,
      },
    });
  }

  // Serve uploaded files as static assets with security headers.
  await app.register(fastifyStatic, {
    root: UPLOADS_DIR,
    prefix: '/uploads/',
    decorateReply: false,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Content-Disposition', 'inline');
    },
  });

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

      // Validate extension.
      const originalName = uploaded.filename;
      const ext = extname(originalName).toLowerCase();
      if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        return reply.badRequest(
          `File type "${ext || 'unknown'}" is not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
        );
      }

      // Read file into buffer (respects multipart fileSize limit).
      let buf: Buffer;
      try {
        buf = await uploaded.toBuffer();
      } catch {
        return reply.code(413).send({ error: 'File exceeds the 10 MB size limit' });
      }

      // Double-check size (belt-and-suspenders — multipart limits should catch it).
      if (buf.length > MAX_FILE_SIZE) {
        return reply.code(413).send({ error: 'File exceeds the 10 MB size limit' });
      }

      // Generate unique filename.
      const uniqueName = `${randomUUID()}${ext}`;
      const destPath = join(UPLOADS_DIR, uniqueName);

      // Write to disk.
      const ws = createWriteStream(destPath);
      await new Promise<void>((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
        ws.end(buf);
      });

      return {
        url: `/uploads/${uniqueName}`,
        mimeType: uploaded.mimetype,
        originalName,
      };
    },
  );
}
