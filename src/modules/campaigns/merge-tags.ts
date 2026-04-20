/** Render merge tags for campaign messages. Mirrors canned's renderMergeTags. */
export interface CampaignMergeCtx {
  contact?: { name?: string | null; email?: string | null; phone?: string | null };
}

export function renderCampaignTemplate(template: string, ctx: CampaignMergeCtx): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, token: string) => {
    switch (token) {
      case 'contato.nome': return ctx.contact?.name ?? match;
      case 'contato.email': return ctx.contact?.email ?? match;
      case 'contato.telefone': return ctx.contact?.phone ?? match;
      default: return match;
    }
  });
}
