import { describe, expect, it } from 'vitest';
import { resolveEmailFraming } from '../email-sender';

/**
 * Journey outbound é primeiro contato, resposta manual é continuação — e o
 * e-mail precisa sair diferente em cada caso. Antes da correção, TODO envio
 * saía como `Re: <inbox>` com In-Reply-To da última mensagem recebida: um
 * disparo de campanha aparecia aninhado numa thread antiga (a journey
 * reaproveita conversas abertas) e o assunto escrito pela IA era descartado.
 */
describe('resolveEmailFraming', () => {
  const INBOX = 'Yuji 182';

  it('journey usa o assunto do Atlas e não threada', () => {
    const r = resolveEmailFraming(
      { source: 'atlas-journey', subject: 'Uma oportunidade para a Montosa' },
      INBOX,
    );
    expect(r.subject).toBe('Uma oportunidade para a Montosa');
    expect(r.useReplyThreading).toBe(false);
  });

  it('resposta manual mantém "Re: <inbox>" e threada', () => {
    const r = resolveEmailFraming({ source: 'manual' }, INBOX);
    expect(r.subject).toBe(`Re: ${INBOX}`);
    expect(r.useReplyThreading).toBe(true);
  });

  it('metadata ausente é tratado como manual', () => {
    for (const meta of [null, undefined, {}]) {
      const r = resolveEmailFraming(meta, INBOX);
      expect(r.subject).toBe(`Re: ${INBOX}`);
      expect(r.useReplyThreading).toBe(true);
    }
  });

  it('journey sem assunto cai no fallback, mas segue sem threading', () => {
    // Journey antiga (ou nó sem assunto): melhor um assunto genérico do que
    // um e-mail sem assunto — mas continua não sendo resposta de ninguém.
    for (const subject of [undefined, '', '   ', 42]) {
      const r = resolveEmailFraming({ source: 'atlas-journey', subject }, INBOX);
      expect(r.subject).toBe(`Re: ${INBOX}`);
      expect(r.useReplyThreading).toBe(false);
    }
  });

  it('assunto do Atlas é trimado', () => {
    const r = resolveEmailFraming(
      { source: 'atlas-journey', subject: '  Parceria estratégica  ' },
      INBOX,
    );
    expect(r.subject).toBe('Parceria estratégica');
  });

  it('source desconhecido não é tratado como journey', () => {
    const r = resolveEmailFraming({ source: 'outro', subject: 'X' }, INBOX);
    expect(r.subject).toBe(`Re: ${INBOX}`);
    expect(r.useReplyThreading).toBe(true);
  });
});
