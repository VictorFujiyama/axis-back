import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// T-B.1 (fase-3): reply-bot-marco.md é um fork do reply-bot.md (Yuji) com tom
// formal. Estrutura (headings) tem que ser idêntica, diffs documentados em
// comentários HTML "<!-- MARCO: ... -->" e a regra crítica de wants_call
// (anunciar 3 horários e PARAR) preservada nos dois.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yujiPath = path.join(repoRoot, 'packages/prompts/reply-bot.md');
const marcoPath = path.join(repoRoot, 'packages/prompts/reply-bot-marco.md');

function stripHtmlComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '');
}

function headings(md: string): string[] {
  return stripHtmlComments(md)
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.trim());
}

describe('packages/prompts — playbook Marco (T-B.1)', () => {
  const yuji = readFileSync(yujiPath, 'utf8');
  const marco = readFileSync(marcoPath, 'utf8');

  it('mantém a mesma estrutura de seções do Yuji', () => {
    expect(headings(yuji).length).toBeGreaterThanOrEqual(5);
    expect(headings(marco)).toEqual(headings(yuji));
  });

  it('documenta cada mudança com comentários <!-- MARCO: ... -->', () => {
    const markers = marco.match(/<!--\s*MARCO:/g) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(3);
    expect(yuji).not.toMatch(/<!--\s*MARCO:/);
  });

  it('troca a persona de Yuji pra Marco fora dos comentários', () => {
    const marcoBody = stripHtmlComments(marco);
    expect(marcoBody).toContain('Marco');
    expect(marcoBody).not.toContain('Yuji');
    expect(stripHtmlComments(yuji)).toContain('Yuji');
  });

  it('inverte o tom: Yuji casual/amigável, Marco formal', () => {
    const yujiTone = stripHtmlComments(yuji).toLowerCase();
    const marcoTone = stripHtmlComments(marco).toLowerCase();
    expect(yujiTone).toMatch(/casual|amig[áa]vel/);
    expect(marcoTone).toContain('formal');
    expect(marcoTone).toContain('sem emojis');
  });

  it('preserva a regra crítica de wants_call nos dois playbooks', () => {
    for (const playbook of [yuji, marco]) {
      const body = stripHtmlComments(playbook);
      expect(body).toContain('wants_call');
      expect(body).toContain('3 horários');
      expect(body).toContain('PARE.');
      expect(body).toMatch(/n[ãa]o proponha hor[áa]rios/i);
    }
  });

  it('cabe no limite de systemPrompt do builtin bot (10k chars)', () => {
    expect(marco.length).toBeLessThanOrEqual(10_000);
    expect(yuji.length).toBeLessThanOrEqual(10_000);
  });
});
