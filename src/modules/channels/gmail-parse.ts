import { htmlToText } from './email-utils.js';

export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

export interface ParsedGmailMessage {
  content: string;
}

function findFirstPart(
  part: GmailMessagePart | undefined,
  mimeType: string,
): GmailMessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  if (part.parts) {
    for (const child of part.parts) {
      const found = findFirstPart(child, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

function decodeBase64url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

/**
 * Extracts the displayable body of a Gmail `users.messages.get?format=full`
 * response. Prefers a `text/plain` part anywhere in the MIME tree; falls back
 * to the first `text/html` part rendered through `htmlToText`. Returns an
 * empty string when neither is present.
 */
export function parseGmailMessage(raw: GmailMessage): ParsedGmailMessage {
  const root = raw.payload;

  const plain = findFirstPart(root, 'text/plain');
  if (plain?.body?.data) {
    return { content: decodeBase64url(plain.body.data) };
  }

  const html = findFirstPart(root, 'text/html');
  if (html?.body?.data) {
    return { content: htmlToText(decodeBase64url(html.body.data)) };
  }

  return { content: '' };
}
