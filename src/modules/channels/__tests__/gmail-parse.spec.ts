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
});
