import { describe, expect, it } from 'vitest';
import { htmlToText, parseRfc5322Address } from '../email-utils.js';

describe('htmlToText', () => {
  it('returns plain text input unchanged (modulo trim)', () => {
    expect(htmlToText('hello world')).toBe('hello world');
  });

  it('strips simple tags', () => {
    expect(htmlToText('<div>hello <span>world</span></div>')).toBe('hello world');
  });

  it('decodes the supported HTML entities', () => {
    expect(htmlToText('a&nbsp;b&amp;c&lt;d&gt;e&quot;f&#39;g')).toBe(
      'a b&c<d>e"f\'g',
    );
  });

  it('drops <style> and <script> blocks entirely', () => {
    const html = '<style>p { color: red }</style>before<script>alert(1)</script>after';
    expect(htmlToText(html)).toBe('beforeafter');
  });

  it('converts <br> to a newline', () => {
    expect(htmlToText('line one<br>line two<br/>line three<br />line four')).toBe(
      'line one\nline two\nline three\nline four',
    );
  });

  it('converts </p> to a paragraph break', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
  });

  it('collapses 3+ newlines down to a paragraph break', () => {
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(htmlToText('  <p>hi</p>  ')).toBe('hi');
  });
});

describe('parseRfc5322Address', () => {
  it('parses quoted display name with embedded comma', () => {
    expect(parseRfc5322Address('"Doe, John" <john@example.com>')).toEqual({
      name: 'Doe, John',
      email: 'john@example.com',
    });
  });

  it('parses unquoted display name with angle-bracketed email', () => {
    expect(parseRfc5322Address('John Doe <john@example.com>')).toEqual({
      name: 'John Doe',
      email: 'john@example.com',
    });
  });

  it('returns name=undefined when angle form has no display part', () => {
    expect(parseRfc5322Address('<a@b.com>')).toEqual({
      name: undefined,
      email: 'a@b.com',
    });
  });

  it('parses bare email (no angle brackets) as { name: undefined, email }', () => {
    expect(parseRfc5322Address('a@b.com')).toEqual({
      name: undefined,
      email: 'a@b.com',
    });
  });

  it('lowercases the email portion', () => {
    expect(parseRfc5322Address('Bob <BOB@EXAMPLE.COM>')).toEqual({
      name: 'Bob',
      email: 'bob@example.com',
    });
    expect(parseRfc5322Address('JOHN@EXAMPLE.COM')).toEqual({
      name: undefined,
      email: 'john@example.com',
    });
  });

  it('strips outer whitespace around the whole input', () => {
    expect(parseRfc5322Address('  John <a@b>  ')).toEqual({
      name: 'John',
      email: 'a@b',
    });
  });

  it('returns null for non-email strings', () => {
    expect(parseRfc5322Address('not an email')).toBeNull();
  });

  it('returns null for empty string and whitespace-only input', () => {
    expect(parseRfc5322Address('')).toBeNull();
    expect(parseRfc5322Address('   ')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(parseRfc5322Address(null)).toBeNull();
    expect(parseRfc5322Address(undefined)).toBeNull();
    expect(parseRfc5322Address(42)).toBeNull();
    expect(parseRfc5322Address({ email: 'a@b' })).toBeNull();
  });

  it('returns null when the angle-bracket form contains a malformed email', () => {
    expect(parseRfc5322Address('John <not-an-email>')).toBeNull();
  });
});
