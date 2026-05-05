import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGmailMessage, type GmailMessage } from '../gmail-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', '..', '..', '__tests__', 'fixtures', 'gmail');

function loadFixture(name: string): GmailMessage {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8')) as GmailMessage;
}

function encode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

describe('parseGmailMessage', () => {
  describe('body extraction', () => {
    it('prefers text/plain part when both plain and html are present', () => {
      const parsed = parseGmailMessage(loadFixture('plain.json'));
      expect(parsed.content).toBe('Hello world from plain text!');
    });

    it('falls back to text/html (passed through htmlToText) when no plain part exists', () => {
      const parsed = parseGmailMessage(loadFixture('html-only.json'));
      expect(parsed.content).toBe('Hello world from HTML');
    });

    it('extracts body from a non-multipart text/plain root payload', () => {
      const raw: GmailMessage = {
        id: 'single-plain',
        payload: {
          mimeType: 'text/plain',
          body: { size: 10, data: encode('plain root') },
        },
      };
      expect(parseGmailMessage(raw).content).toBe('plain root');
    });

    it('extracts and html-strips a non-multipart text/html root payload', () => {
      const raw: GmailMessage = {
        id: 'single-html',
        payload: {
          mimeType: 'text/html',
          body: { size: 18, data: encode('<p>solo html</p>') },
        },
      };
      expect(parseGmailMessage(raw).content).toBe('solo html');
    });

    it('walks nested multipart trees to find a text/plain leaf', () => {
      const raw: GmailMessage = {
        id: 'nested',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                {
                  mimeType: 'text/plain',
                  body: { size: 6, data: encode('nested') },
                },
                {
                  mimeType: 'text/html',
                  body: { size: 19, data: encode('<p>nested-html</p>') },
                },
              ],
            },
          ],
        },
      };
      expect(parseGmailMessage(raw).content).toBe('nested');
    });

    it('returns empty content when neither plain nor html part exists', () => {
      const raw: GmailMessage = {
        id: 'empty',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [],
        },
      };
      expect(parseGmailMessage(raw).content).toBe('');
    });

    it('returns empty content when the part has no body data', () => {
      const raw: GmailMessage = {
        id: 'no-data',
        payload: {
          mimeType: 'text/plain',
          body: { size: 0 },
        },
      };
      expect(parseGmailMessage(raw).content).toBe('');
    });

    it('decodes UTF-8 (multibyte) bodies', () => {
      const raw: GmailMessage = {
        id: 'utf8',
        payload: {
          mimeType: 'text/plain',
          body: {
            size: 14,
            data: encode('Olá, açaí ☕'),
          },
        },
      };
      expect(parseGmailMessage(raw).content).toBe('Olá, açaí ☕');
    });
  });

  describe('headers (subject + threading hints)', () => {
    it('reads Subject from the top-level payload headers', () => {
      const parsed = parseGmailMessage(loadFixture('plain.json'));
      expect(parsed.subject).toBe('Hello');
    });

    it('reads Message-ID from the top-level payload headers (including angle brackets)', () => {
      const parsed = parseGmailMessage(loadFixture('plain.json'));
      expect(parsed.messageId).toBe('<msg-1@mail.gmail.com>');
    });

    it('returns empty threadHints for a message without In-Reply-To or References', () => {
      const parsed = parseGmailMessage(loadFixture('plain.json'));
      expect(parsed.threadHints).toEqual([]);
    });

    it('extracts subject + messageId + threadHints from with-references.json', () => {
      const parsed = parseGmailMessage(loadFixture('with-references.json'));
      expect(parsed.subject).toBe('Re: Hello');
      expect(parsed.messageId).toBe('<msg-3@mail.gmail.com>');
      expect(parsed.threadHints).toEqual([
        '<prev-1@mail.gmail.com>',
        '<ref-1@mail.gmail.com>',
        '<ref-2@mail.gmail.com>',
      ]);
    });

    it('matches header names case-insensitively', () => {
      const raw: GmailMessage = {
        id: 'mixed-case',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'subject', value: 'lower-case header' },
            { name: 'MESSAGE-ID', value: '<upper@example.com>' },
            { name: 'In-Reply-To', value: '<r@example.com>' },
          ],
          body: { size: 4, data: encode('body') },
        },
      };
      const parsed = parseGmailMessage(raw);
      expect(parsed.subject).toBe('lower-case header');
      expect(parsed.messageId).toBe('<upper@example.com>');
      expect(parsed.threadHints).toEqual(['<r@example.com>']);
    });

    it('returns undefined subject/messageId and empty threadHints when payload has no headers', () => {
      const raw: GmailMessage = {
        id: 'no-headers',
        payload: {
          mimeType: 'text/plain',
          body: { size: 4, data: encode('body') },
        },
      };
      const parsed = parseGmailMessage(raw);
      expect(parsed.subject).toBeUndefined();
      expect(parsed.messageId).toBeUndefined();
      expect(parsed.threadHints).toEqual([]);
    });

    it('builds threadHints from only In-Reply-To when References is absent', () => {
      const raw: GmailMessage = {
        id: 'irt-only',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'In-Reply-To', value: '<a@example.com>' }],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).threadHints).toEqual(['<a@example.com>']);
    });

    it('builds threadHints from only References (multiple ids) when In-Reply-To is absent', () => {
      const raw: GmailMessage = {
        id: 'refs-only',
        payload: {
          mimeType: 'text/plain',
          headers: [
            {
              name: 'References',
              value: '<x@example.com> <y@example.com> <z@example.com>',
            },
          ],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).threadHints).toEqual([
        '<x@example.com>',
        '<y@example.com>',
        '<z@example.com>',
      ]);
    });
  });

  describe('from + threadId metadata', () => {
    it('parses From header with display name into { name, email }', () => {
      const parsed = parseGmailMessage(loadFixture('plain.json'));
      expect(parsed.from).toEqual({ name: 'Alice', email: 'alice@example.com' });
    });

    it('parses a bare-email From header into { name: undefined, email }', () => {
      const raw: GmailMessage = {
        id: 'bare-from',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'From', value: 'sender@example.com' }],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).from).toEqual({
        name: undefined,
        email: 'sender@example.com',
      });
    });

    it('lowercases the From email but preserves the display name case', () => {
      const raw: GmailMessage = {
        id: 'mixed-case-from',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'From', value: 'Bob Smith <BOB@EXAMPLE.COM>' }],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).from).toEqual({
        name: 'Bob Smith',
        email: 'bob@example.com',
      });
    });

    it('matches the From header case-insensitively', () => {
      const raw: GmailMessage = {
        id: 'lowercase-from-header',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'from', value: 'Eve <eve@example.com>' }],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).from).toEqual({
        name: 'Eve',
        email: 'eve@example.com',
      });
    });

    it('returns from: undefined when the From header is missing', () => {
      const raw: GmailMessage = {
        id: 'no-from',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'no sender here' }],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).from).toBeUndefined();
    });

    it('returns from: undefined when the From header is malformed', () => {
      const raw: GmailMessage = {
        id: 'bad-from',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'From', value: 'not an email' }],
          body: { size: 4, data: encode('body') },
        },
      };
      expect(parseGmailMessage(raw).from).toBeUndefined();
    });

    it('exposes raw.threadId as metadata.gmailThreadId', () => {
      const parsed = parseGmailMessage(loadFixture('plain.json'));
      expect(parsed.metadata.gmailThreadId).toBe('1932abcd0001');
    });

    it('leaves metadata.gmailThreadId undefined when raw.threadId is absent', () => {
      const raw: GmailMessage = {
        id: 'no-thread',
        payload: {
          mimeType: 'text/plain',
          body: { size: 4, data: encode('body') },
        },
      };
      const parsed = parseGmailMessage(raw);
      expect(parsed.metadata.gmailThreadId).toBeUndefined();
    });
  });
});
