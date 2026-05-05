import { describe, expect, it } from 'vitest';
import { htmlToText } from '../email-utils.js';

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
