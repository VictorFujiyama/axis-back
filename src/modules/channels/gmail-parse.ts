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
  subject?: string;
  messageId?: string;
  threadHints: string[];
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

function getHeader(
  part: GmailMessagePart | undefined,
  name: string,
): string | undefined {
  if (!part?.headers) return undefined;
  const lower = name.toLowerCase();
  return part.headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function parseMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^>]+>/g) ?? [];
}

function extractContent(root: GmailMessagePart | undefined): string {
  const plain = findFirstPart(root, 'text/plain');
  if (plain?.body?.data) return decodeBase64url(plain.body.data);

  const html = findFirstPart(root, 'text/html');
  if (html?.body?.data) return htmlToText(decodeBase64url(html.body.data));

  return '';
}

/**
 * Extracts the displayable body, subject, and threading hints from a Gmail
 * `users.messages.get?format=full` response. Body resolution prefers a
 * `text/plain` part anywhere in the MIME tree, falling back to `text/html`
 * rendered through `htmlToText`. Threading hints concatenate the message-id
 * tokens from `In-Reply-To` and `References` headers — same shape as the
 * Postmark inbound webhook produces.
 */
export function parseGmailMessage(raw: GmailMessage): ParsedGmailMessage {
  const root = raw.payload;

  const subject = getHeader(root, 'Subject');
  const messageId = getHeader(root, 'Message-ID');
  const threadHints = [
    ...parseMessageIds(getHeader(root, 'In-Reply-To')),
    ...parseMessageIds(getHeader(root, 'References')),
  ];

  return {
    content: extractContent(root),
    subject,
    messageId,
    threadHints,
  };
}
