const { mdToPdf } = require('md-to-pdf');
const path = require('path');

(async () => {
  const input = path.join(__dirname, '..', 'docs', 'PLANO-TECNICO.md');
  const output = path.join(__dirname, '..', 'docs', 'PLANO-TECNICO.pdf');

  const css = `
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; line-height: 1.55; color: #222; max-width: 900px; margin: 0 auto; padding: 2em; }
    h1 { color: #4a2e6a; border-bottom: 3px solid #7b3fa9; padding-bottom: .3em; page-break-before: auto; font-size: 2.2em; }
    h2 { color: #5a3680; border-bottom: 1px solid #ccc; padding-bottom: .3em; margin-top: 2em; page-break-before: avoid; font-size: 1.6em; }
    h3 { color: #333; margin-top: 1.5em; font-size: 1.25em; }
    h4 { color: #444; font-size: 1.08em; }
    code { background: #f4f4f4; padding: .15em .35em; border-radius: 3px; font-size: .9em; font-family: 'SF Mono','Consolas',monospace; }
    pre { background: #fafafa; border: 1px solid #eaeaea; border-radius: 6px; padding: 1em; overflow-x: auto; page-break-inside: avoid; font-size: .82em; line-height: 1.45; }
    pre code { background: transparent; padding: 0; font-size: inherit; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; page-break-inside: avoid; font-size: .92em; }
    th, td { border: 1px solid #ddd; padding: .5em .75em; text-align: left; }
    th { background: #f5f2fa; color: #4a2e6a; }
    blockquote { border-left: 4px solid #7b3fa9; padding: .1em 1em; color: #555; background: #faf7fd; margin: 1em 0; }
    a { color: #7b3fa9; }
    hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
    ul, ol { padding-left: 1.8em; }
    li { margin: .2em 0; }
    @page { size: A4; margin: 2cm 1.8cm; }
  `;

  await mdToPdf(
    { path: input },
    {
      dest: output,
      css,
      pdf_options: {
        format: 'A4',
        margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div style="font-size:8pt; width:100%; text-align:right; padding-right:1cm; color:#888;">Blossom Inbox — Plano Técnico</div>',
        footerTemplate: '<div style="font-size:8pt; width:100%; text-align:center; color:#888;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      },
      launch_options: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    }
  );
  console.log('PDF gerado em', output);
})().catch((err) => { console.error(err); process.exit(1); });
