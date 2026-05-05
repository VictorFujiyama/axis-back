import { describe, expect, it, vi } from 'vitest';
import {
  downloadGmailAttachment,
  downloadGmailAttachmentSafe,
  GmailApiError,
  uploadGmailAttachment,
} from '../gmail-attachments.js';
import type { ParsedGmailAttachment } from '../gmail-parse.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('downloadGmailAttachment', () => {
  it('returns the decoded buffer (base64url → bytes) on happy path', async () => {
    const payload = Buffer.from('PDF binary content here', 'utf-8');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        size: payload.length,
        data: payload.toString('base64url'),
      }),
    );
    const buf = await downloadGmailAttachment('msg-1', 'att-1', 'access-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(payload)).toBe(true);
  });

  it('hits the correct gmail API url and authenticates with bearer token', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ size: 1, data: 'YQ' });
    });
    await downloadGmailAttachment('msg-abc', 'att-xyz', 'ya29.access', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedUrl).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-abc/attachments/att-xyz',
    );
    expect(capturedInit?.method ?? 'GET').toBe('GET');
    expect(
      (capturedInit!.headers as Record<string, string>).Authorization,
    ).toBe('Bearer ya29.access');
  });

  it('url-encodes path components so unusual ids do not break the URL', async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return jsonResponse({ size: 1, data: 'YQ' });
    });
    await downloadGmailAttachment('msg/with slash', 'att+with=eq', 'tok', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedUrl).toContain('messages/msg%2Fwith%20slash');
    expect(capturedUrl).toContain('attachments/att%2Bwith%3Deq');
  });

  it('throws GmailApiError carrying status on 4xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Not Found', code: 404 } }, 404),
    );
    const err = await downloadGmailAttachment('m', 'a', 't', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(404);
  });

  it('throws GmailApiError on 5xx responses too', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const err = await downloadGmailAttachment('m', 'a', 't', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(503);
  });

  it('throws GmailApiError when 200 response is missing the data field', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ size: 0 }));
    await expect(
      downloadGmailAttachment('m', 'a', 't', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(GmailApiError);
  });

  it('configures an AbortSignal on the fetch call (15s timeout)', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      return jsonResponse({ size: 1, data: 'YQ' });
    });
    await downloadGmailAttachment('m', 'a', 't', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it('wraps network/abort errors in GmailApiError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = await downloadGmailAttachment('m', 'a', 't', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as Error).message).toContain('network error');
  });

  it('decodes base64url unpadded form (gmail emits unpadded)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ size: 2, data: 'Zm8' }));
    const buf = await downloadGmailAttachment('m', 'a', 't', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(buf.toString('utf-8')).toBe('fo');
  });
});

const MEGABYTE = 1024 * 1024;

function makeAttachment(
  overrides: Partial<ParsedGmailAttachment> = {},
): ParsedGmailAttachment {
  return {
    partId: '1',
    attachmentId: 'att-1',
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    ...overrides,
  };
}

describe('downloadGmailAttachmentSafe', () => {
  it('returns null and logs a warning when size exceeds 25 MB', async () => {
    const fetchImpl = vi.fn();
    const warn = vi.fn();
    const attachment = makeAttachment({
      filename: 'huge.zip',
      size: 26 * MEGABYTE,
    });
    const result = await downloadGmailAttachmentSafe(
      'msg-1',
      attachment,
      'access-token',
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: { warn },
      },
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { filename: 'huge.zip', size: 26 * MEGABYTE },
      expect.any(String),
    );
  });

  it('skip threshold is exactly 25 MB (size === cap allowed, cap+1 skipped)', async () => {
    const fetchImplOk = vi.fn(async () =>
      jsonResponse({ size: 25 * MEGABYTE, data: 'YQ' }),
    );
    const fetchImplSkip = vi.fn();

    const okResult = await downloadGmailAttachmentSafe(
      'msg-1',
      makeAttachment({ size: 25 * MEGABYTE }),
      'tok',
      { fetchImpl: fetchImplOk as unknown as typeof fetch },
    );
    expect(okResult).toBeInstanceOf(Buffer);
    expect(fetchImplOk).toHaveBeenCalledTimes(1);

    const skipResult = await downloadGmailAttachmentSafe(
      'msg-1',
      makeAttachment({ size: 25 * MEGABYTE + 1 }),
      'tok',
      { fetchImpl: fetchImplSkip as unknown as typeof fetch },
    );
    expect(skipResult).toBeNull();
    expect(fetchImplSkip).not.toHaveBeenCalled();
  });

  it('delegates to downloadGmailAttachment when under cap', async () => {
    const payload = Buffer.from('inline body bytes', 'utf-8');
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return jsonResponse({
        size: payload.length,
        data: payload.toString('base64url'),
      });
    });
    const result = await downloadGmailAttachmentSafe(
      'msg-42',
      makeAttachment({ attachmentId: 'att-42', size: 1024 }),
      'ya29.access',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).not.toBeNull();
    expect((result as Buffer).equals(payload)).toBe(true);
    expect(capturedUrl).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-42/attachments/att-42',
    );
    expect(capturedAuth).toBe('Bearer ya29.access');
  });

  it('does not throw when no logger is provided and size is over the cap', async () => {
    const fetchImpl = vi.fn();
    const result = await downloadGmailAttachmentSafe(
      'msg-1',
      makeAttachment({ size: 50 * MEGABYTE }),
      'tok',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates GmailApiError from the underlying download (under-cap 4xx still throws)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 404 } }, 404),
    );
    await expect(
      downloadGmailAttachmentSafe(
        'msg-1',
        makeAttachment({ size: 1024 }),
        'tok',
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(GmailApiError);
  });
});

describe('uploadGmailAttachment', () => {
  it('uploads via R2 and returns the public URL', async () => {
    const uploadFileImpl = vi.fn(async () => ({
      url: 'https://cdn.example.com/uploads/acc-1/inbound/abc.pdf',
      key: 'acc-1/inbound/abc.pdf',
    }));
    const url = await uploadGmailAttachment(
      Buffer.from('hi'),
      'invoice.pdf',
      'application/pdf',
      'acc-1',
      { uploadFileImpl },
    );
    expect(url).toBe('https://cdn.example.com/uploads/acc-1/inbound/abc.pdf');
    expect(uploadFileImpl).toHaveBeenCalledTimes(1);
  });

  it('builds key as <accountId>/inbound/<uuid><ext> (mirrors mirrorTwilioMedia convention)', async () => {
    let capturedKey: string | undefined;
    const uploadFileImpl = vi.fn(
      async (_buf: Buffer, key: string, _mime: string) => {
        capturedKey = key;
        return { url: 'u', key };
      },
    );
    await uploadGmailAttachment(
      Buffer.from('x'),
      'invoice.pdf',
      'application/pdf',
      'acc-9',
      { uploadFileImpl },
    );
    expect(capturedKey).toMatch(
      /^acc-9\/inbound\/[0-9a-f-]{36}\.pdf$/i,
    );
  });

  it('lowercases the extension derived from filename', async () => {
    let capturedKey: string | undefined;
    const uploadFileImpl = vi.fn(
      async (_buf: Buffer, key: string, _mime: string) => {
        capturedKey = key;
        return { url: 'u', key };
      },
    );
    await uploadGmailAttachment(
      Buffer.from('x'),
      'PHOTO.JPG',
      'image/jpeg',
      'acc-1',
      { uploadFileImpl },
    );
    expect(capturedKey).toMatch(/\.jpg$/);
  });

  it('falls back to .bin when filename has no extension', async () => {
    let capturedKey: string | undefined;
    const uploadFileImpl = vi.fn(
      async (_buf: Buffer, key: string, _mime: string) => {
        capturedKey = key;
        return { url: 'u', key };
      },
    );
    await uploadGmailAttachment(
      Buffer.from('x'),
      'README',
      'text/plain',
      'acc-1',
      { uploadFileImpl },
    );
    expect(capturedKey).toMatch(/\.bin$/);
  });

  it('coerces empty filename to a default and emits .bin extension', async () => {
    let capturedKey: string | undefined;
    const uploadFileImpl = vi.fn(
      async (_buf: Buffer, key: string, _mime: string) => {
        capturedKey = key;
        return { url: 'u', key };
      },
    );
    await uploadGmailAttachment(
      Buffer.from('x'),
      '',
      'application/octet-stream',
      'acc-1',
      { uploadFileImpl },
    );
    expect(capturedKey).toMatch(/\.bin$/);
  });

  it('passes mimeType verbatim as ContentType to the R2 client', async () => {
    let capturedMime: string | undefined;
    const uploadFileImpl = vi.fn(
      async (_buf: Buffer, _key: string, mime: string) => {
        capturedMime = mime;
        return { url: 'u', key: 'k' };
      },
    );
    await uploadGmailAttachment(
      Buffer.from('x'),
      'note.txt',
      'text/plain; charset=utf-8',
      'acc-1',
      { uploadFileImpl },
    );
    expect(capturedMime).toBe('text/plain; charset=utf-8');
  });

  it('passes the buffer through to the R2 client unchanged', async () => {
    const buffer = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    let capturedBuf: Buffer | undefined;
    const uploadFileImpl = vi.fn(
      async (buf: Buffer, _key: string, _mime: string) => {
        capturedBuf = buf;
        return { url: 'u', key: 'k' };
      },
    );
    await uploadGmailAttachment(
      buffer,
      'binary.bin',
      'application/octet-stream',
      'acc-1',
      { uploadFileImpl },
    );
    expect(capturedBuf).toBe(buffer);
  });

  it('emits unique keys across uploads (UUID is regenerated per call)', async () => {
    const keys: string[] = [];
    const uploadFileImpl = vi.fn(
      async (_buf: Buffer, key: string, _mime: string) => {
        keys.push(key);
        return { url: 'u', key };
      },
    );
    for (let i = 0; i < 3; i++) {
      await uploadGmailAttachment(
        Buffer.from('x'),
        'doc.pdf',
        'application/pdf',
        'acc-1',
        { uploadFileImpl },
      );
    }
    expect(new Set(keys).size).toBe(3);
  });
});
