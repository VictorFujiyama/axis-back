import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-20: POST /webhooks/webchat/:inboxId/attachment uploads a visitor file. Auth is
// widgetToken + visitorId (multipart fields). Validates type/size against the inbox
// config, stores it, then ingests a contact message with mediaUrl/mediaMimeType.

vi.mock('../post-ingest', () => ({
  ingestWithHooks: vi.fn(async () => ({
    contactId: 'c1',
    conversationId: 'conv1',
    messageId: 'm1',
    deduped: false,
    blocked: false,
  })),
}));

vi.mock('../../../lib/storage', () => ({
  uploadFile: vi.fn(async () => ({ url: 'https://r2.example/uploads/x.png', key: 'k' })),
  reserveWriteSlot: vi.fn(async () => ({ used: 1, limit: 100 })),
  StorageQuotaExceeded: class StorageQuotaExceeded extends Error {},
}));

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const WIDGET_TOKEN = 'wt_test';
const VISITOR_ID = `vis_${'a'.repeat(32)}`;
const ACCOUNT_ID = '33333333-4444-4555-8666-777777777777';
const BOUNDARY = '----webchatattachboundary';

function inboxRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, attachments: { enabled: true }, ...configOverrides },
    secrets: null as string | null,
    defaultBotId: null as string | null,
    enabled: true,
    deletedAt: null as Date | null,
  };
}

function multipartBody(
  fields: Record<string, string>,
  file?: { filename: string; mimetype: string; buffer: Buffer },
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

async function buildTestApp(results: unknown[]): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { webchatChannelRoutes } = await import('../webchat-webhook');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const idx = call++;
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.innerJoin = () => q;
    q.limit = () => Promise.resolve(results[idx] ?? []);
    return q;
  });

  app.decorate('db', { select } as unknown as FastifyInstance['db']);
  app.decorate('redis', {} as unknown as FastifyInstance['redis']);

  await app.register(webchatChannelRoutes);
  await app.ready();
  return app;
}

function attachReq(
  app: FastifyInstance,
  fields: Record<string, string>,
  file?: { filename: string; mimetype: string; buffer: Buffer },
) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/webchat/${INBOX_ID}/attachment`,
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(fields, file),
  });
}

const PNG = { filename: 'photo.png', mimetype: 'image/png', buffer: Buffer.alloc(2048, 1) };

describe('POST /webhooks/webchat/:inboxId/attachment (T-20)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores a valid upload and ingests a media message', async () => {
    const app = await buildTestApp([[inboxRow()], [{ id: 'identity-1' }]]);
    const { uploadFile } = await import('../../../lib/storage');
    const { ingestWithHooks } = await import('../post-ingest');
    try {
      const res = await attachReq(
        app,
        { widgetToken: WIDGET_TOKEN, visitorId: VISITOR_ID },
        PNG,
      );
      expect(res.statusCode).toBe(201);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(ingestWithHooks).toHaveBeenCalledTimes(1);
      const arg = (ingestWithHooks as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
        mediaUrl?: string;
        mediaMimeType?: string;
        contentType?: string;
      };
      expect(arg.mediaUrl).toBe('https://r2.example/uploads/x.png');
      expect(arg.mediaMimeType).toBe('image/png');
      expect(arg.contentType).toBe('image');
    } finally {
      await app.close();
    }
  });

  it('rejects a disallowed mime type', async () => {
    const app = await buildTestApp([[inboxRow()]]);
    const { uploadFile } = await import('../../../lib/storage');
    try {
      const res = await attachReq(
        app,
        { widgetToken: WIDGET_TOKEN, visitorId: VISITOR_ID },
        { filename: 'evil.svg', mimetype: 'image/svg+xml', buffer: Buffer.alloc(64) },
      );
      expect(res.statusCode).toBe(415);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects when attachments are disabled on the inbox', async () => {
    const app = await buildTestApp([[inboxRow({ attachments: { enabled: false } })]]);
    const { uploadFile } = await import('../../../lib/storage');
    try {
      const res = await attachReq(app, { widgetToken: WIDGET_TOKEN, visitorId: VISITOR_ID }, PNG);
      expect(res.statusCode).toBe(403);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an unregistered visitor', async () => {
    const app = await buildTestApp([[inboxRow()], []]);
    const { uploadFile } = await import('../../../lib/storage');
    try {
      const res = await attachReq(app, { widgetToken: WIDGET_TOKEN, visitorId: VISITOR_ID }, PNG);
      expect(res.statusCode).toBe(401);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a file larger than the inbox limit', async () => {
    const app = await buildTestApp([
      [inboxRow({ attachments: { enabled: true, maxSizeMb: 0.001 } })],
      [{ id: 'identity-1' }],
    ]);
    const { uploadFile } = await import('../../../lib/storage');
    try {
      const res = await attachReq(
        app,
        { widgetToken: WIDGET_TOKEN, visitorId: VISITOR_ID },
        { filename: 'big.png', mimetype: 'image/png', buffer: Buffer.alloc(8192, 1) },
      );
      expect(res.statusCode).toBe(413);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed visitorId before touching the inbox', async () => {
    const app = await buildTestApp([]);
    try {
      const res = await attachReq(app, { widgetToken: WIDGET_TOKEN, visitorId: 'nope' }, PNG);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
