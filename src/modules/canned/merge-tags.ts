/**
 * Render merge tags in canned response content.
 *
 * Supported tokens:
 *   {{contato.nome}}, {{contato.email}}, {{contato.telefone}}
 *   {{agente.nome}}, {{agente.email}}
 *   {{conversa.id}}
 *
 * Unknown tokens are left in place (visible to the agent as signal that the
 * data isn't available) rather than silently replaced with empty — safer UX.
 */

export interface MergeContext {
  contact?: { name?: string | null; email?: string | null; phone?: string | null };
  agent?: { name?: string | null; email?: string | null };
  conversation?: { id?: string };
}

export function renderMergeTags(template: string, ctx: MergeContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, token: string) => {
    switch (token) {
      case 'contato.nome':
        return ctx.contact?.name ?? match;
      case 'contato.email':
        return ctx.contact?.email ?? match;
      case 'contato.telefone':
        return ctx.contact?.phone ?? match;
      case 'agente.nome':
        return ctx.agent?.name ?? match;
      case 'agente.email':
        return ctx.agent?.email ?? match;
      case 'conversa.id':
        return ctx.conversation?.id ?? match;
      default:
        return match;
    }
  });
}
