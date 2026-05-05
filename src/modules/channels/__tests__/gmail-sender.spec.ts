import { describe, expect, it } from 'vitest';
import { composeMimeRfc5322 } from '../gmail-sender.js';

describe('composeMimeRfc5322', () => {
  describe('basic structure', () => {
    it('separates headers from body with a blank CRLF line', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hello',
      });
      expect(mime.endsWith('\r\n\r\nhello')).toBe(true);
    });

    it('uses CRLF line endings on every header (no bare LFs)', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hello',
      });
      const headers = mime.split('\r\n\r\n')[0]!;
      // No header line begins or ends without CRLF — every internal newline is CRLF.
      expect(headers).not.toMatch(/[^\r]\n/);
    });

    it('declares MIME-Version 1.0 and UTF-8 plain text content type', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hello',
      });
      expect(mime).toContain('MIME-Version: 1.0\r\n');
      expect(mime).toContain('Content-Type: text/plain; charset=UTF-8\r\n');
    });

    it('renders From, To, Subject with the supplied values', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com' },
        to: 'customer@acme.com',
        subject: 'Welcome',
        body: 'hi',
      });
      expect(mime).toContain('From: agent@axis.com\r\n');
      expect(mime).toContain('To: customer@acme.com\r\n');
      expect(mime).toContain('Subject: Welcome\r\n');
    });
  });

  describe('UTF-8 plain text body', () => {
    it('preserves non-ASCII characters in the body verbatim', () => {
      const body = 'Olá! Aqui está o relatório com café ☕';
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Test',
        body,
      });
      expect(mime).toContain(body);
    });

    it('preserves multi-line bodies with CR/LF intact', () => {
      const body = 'line one\nline two\n\nparagraph two';
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Test',
        body,
      });
      // Body comes after the blank-line separator, untouched.
      expect(mime.split('\r\n\r\n')[1]).toBe(body);
    });
  });

  describe('From — display name quoting', () => {
    it('wraps display name in double quotes when name is present', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com', name: 'Atendimento Acme' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Atendimento Acme" <agent@axis.com>\r\n');
    });

    it('escapes embedded double quotes via quoted-pair (\\")', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'boss@example.com', name: 'Smith "The Boss"' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Smith \\"The Boss\\"" <boss@example.com>\r\n');
    });

    it('escapes embedded backslashes via quoted-pair (\\\\)', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com', name: 'Smith\\Co' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Smith\\\\Co" <agent@axis.com>\r\n');
    });

    it('keeps RFC 5322 specials (comma, parens) inside the quoted display name', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com', name: 'Doe, John (acct)' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Doe, John (acct)" <a@b.com>\r\n');
    });

    it('emits a bare address when name is missing', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: agent@axis.com\r\n');
      expect(mime).not.toContain('From: "');
    });

    it('emits a bare address when name is an empty string', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com', name: '' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: agent@axis.com\r\n');
      expect(mime).not.toContain('From: ""');
    });
  });

  describe('Threading hints', () => {
    it('omits In-Reply-To and References when no hints provided', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).not.toMatch(/^In-Reply-To:/m);
      expect(mime).not.toMatch(/^References:/m);
    });

    it('omits both headers when threadingHints is an empty object', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: {},
      });
      expect(mime).not.toMatch(/^In-Reply-To:/m);
      expect(mime).not.toMatch(/^References:/m);
    });

    it('emits In-Reply-To when only inReplyTo is set', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: { inReplyTo: '<parent@gmail.com>' },
      });
      expect(mime).toContain('In-Reply-To: <parent@gmail.com>\r\n');
      expect(mime).not.toMatch(/^References:/m);
    });

    it('emits References when only references is set', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: { references: '<root@x> <parent@x>' },
      });
      expect(mime).toContain('References: <root@x> <parent@x>\r\n');
      expect(mime).not.toMatch(/^In-Reply-To:/m);
    });

    it('emits BOTH In-Reply-To and References when both hints provided', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: {
          inReplyTo: '<parent@gmail.com>',
          references: '<root@gmail.com> <parent@gmail.com>',
        },
      });
      expect(mime).toContain('In-Reply-To: <parent@gmail.com>\r\n');
      expect(mime).toContain(
        'References: <root@gmail.com> <parent@gmail.com>\r\n',
      );
    });
  });
});
