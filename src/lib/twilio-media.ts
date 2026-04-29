import { randomUUID } from 'node:crypto';
import { uploadFile } from './storage';

/**
 * Twilio media URLs (api.twilio.com/.../Media/...) require Basic Auth and
 * Twilio rotates the underlying CDN-signed URL after roughly 1h, which means
 * the browser cannot render them directly and they expire even server-side.
 *
 * Solution: mirror the media bytes into our own storage (R2) on inbound,
 * persist the public R2 URL on the message, and serve from there.
 */

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
};

function extFor(mime: string | undefined, fallbackUrl: string): string {
  if (mime) {
    const ext = MIME_EXT[mime.toLowerCase().split(';')[0]?.trim() ?? ''];
    if (ext) return ext;
  }
  // Try to lift an extension from the URL path
  try {
    const path = new URL(fallbackUrl).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
    if (m) return `.${m[1]!.toLowerCase()}`;
  } catch {
    /* ignore */
  }
  return '.bin';
}

/**
 * Downloads a Twilio-hosted media URL using the inbox's Account SID + Auth
 * Token, uploads it to our storage backend (R2 in prod, local FS in dev),
 * and returns the public URL we should persist on the inbound message.
 */
export async function mirrorTwilioMedia(params: {
  twilioUrl: string;
  mimeType: string | undefined;
  accountId: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
}): Promise<string> {
  const { twilioUrl, mimeType, accountId, twilioAccountSid, twilioAuthToken } = params;
  const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');

  const res = await fetch(twilioUrl, {
    headers: { Authorization: `Basic ${auth}` },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Twilio media fetch ${res.status}: ${twilioUrl}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const resolvedMime = mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream';
  const key = `${accountId}/inbound/${randomUUID()}${extFor(mimeType, twilioUrl)}`;
  const uploaded = await uploadFile(buf, key, resolvedMime);
  return uploaded.url;
}
