import { describe, expect, it, vi } from 'vitest';
import {
  downloadGmailAttachment,
  GmailApiError,
} from '../gmail-attachments.js';

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
