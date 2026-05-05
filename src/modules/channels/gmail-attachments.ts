/**
 * Wrappers around the Gmail REST API surface used by the inbound sync worker
 * for attachment ingestion. The OAuth token plumbing lives in
 * `src/modules/oauth/google/tokens.ts`; callers must pass an access token they
 * have already validated/refreshed.
 */

import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { uploadFile } from '../../lib/storage.js';
import type { ParsedGmailAttachment } from './gmail-parse.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const FETCH_TIMEOUT_MS = 15_000;
/** Gmail itself caps user-visible attachments at 25 MB. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class GmailApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

export interface GmailAttachmentDeps {
  /** Override `fetch` for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface AttachmentResponseBody {
  size?: number;
  data?: string;
}

/**
 * Downloads a single attachment from Gmail and returns its decoded bytes.
 * Wraps `users.messages.attachments.get` with a 15s abort. The response is
 * `{ size, data }` where `data` is base64url-encoded — we decode it before
 * returning so callers can pipe straight into the R2 upload.
 *
 * Throws `GmailApiError` on any non-2xx response (including 5xx so the caller
 * can decide whether to retry) or when the response body is malformed.
 */
export async function downloadGmailAttachment(
  messageId: string,
  attachmentId: string,
  accessToken: string,
  deps: GmailAttachmentDeps = {},
): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(
    messageId,
  )}/attachments/${encodeURIComponent(attachmentId)}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GmailApiError(`network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new GmailApiError(
      `gmail attachments.get ${res.status}`,
      res.status,
    );
  }

  const data = (await res
    .json()
    .catch(() => ({}))) as AttachmentResponseBody;

  if (typeof data.data !== 'string') {
    throw new GmailApiError(
      'invalid attachment response from gmail',
      res.status,
    );
  }

  return Buffer.from(data.data, 'base64url');
}

/** Minimal logger shape compatible with Fastify's `app.log`. */
export interface GmailAttachmentLogger {
  warn(payload: Record<string, unknown>, msg?: string): void;
}

const noopLogger: GmailAttachmentLogger = { warn: () => undefined };

/**
 * Size-aware wrapper around `downloadGmailAttachment`. Returns `null` (and logs)
 * when the parsed attachment exceeds 25 MB so the worker can skip it without
 * burning a Gmail API call. Under the cap, delegates to the raw HTTP wrapper —
 * its errors (4xx / 5xx / network) propagate unchanged so the caller can apply
 * the same retry/permanent-fail policy as direct `downloadGmailAttachment` use.
 */
export async function downloadGmailAttachmentSafe(
  messageId: string,
  attachment: ParsedGmailAttachment,
  accessToken: string,
  deps: GmailAttachmentDeps & { logger?: GmailAttachmentLogger } = {},
): Promise<Buffer | null> {
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    const logger = deps.logger ?? noopLogger;
    logger.warn(
      { filename: attachment.filename, size: attachment.size },
      'gmail attachment skipped: > 25 MB',
    );
    return null;
  }

  return downloadGmailAttachment(
    messageId,
    attachment.attachmentId,
    accessToken,
    deps,
  );
}

export type UploadFileImpl = (
  buffer: Buffer,
  key: string,
  contentType: string,
) => Promise<{ url: string; key: string }>;

export interface UploadGmailAttachmentDeps {
  /** Override the storage backend for testing. Defaults to `lib/storage.uploadFile`. */
  uploadFileImpl?: UploadFileImpl;
}

const DEFAULT_FILENAME = 'attachment';
const DEFAULT_EXT = '.bin';

/**
 * Uploads an attachment buffer to R2 and returns its public URL. Mirrors the
 * `mirrorTwilioMedia` key convention `<accountId>/inbound/<uuid><ext>` so
 * inbound media from every channel share a single addressing scheme — easy to
 * audit, bill, or purge per-tenant.
 *
 * `filename` is used only to derive the file extension. Empty filenames fall
 * back to a sentinel ('attachment'); when no extension can be lifted, '.bin'
 * is used. `mimeType` becomes the R2 object's Content-Type header verbatim.
 */
export async function uploadGmailAttachment(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  accountId: string,
  deps: UploadGmailAttachmentDeps = {},
): Promise<string> {
  const upload = deps.uploadFileImpl ?? uploadFile;
  const safeName = filename || DEFAULT_FILENAME;
  const ext = extname(safeName).toLowerCase() || DEFAULT_EXT;
  const key = `${accountId}/inbound/${randomUUID()}${ext}`;
  const result = await upload(buffer, key, mimeType);
  return result.url;
}
