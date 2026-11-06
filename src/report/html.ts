// ADR-0021 amendment (UB-6): a self-contained single-file HTML report for readers outside the
// terminal. It is the Markdown report (same data, same order) converted by a narrow converter
// for the constructs renderMarkdown emits, plus the OWASP Agentic table (UB-1). Every byte that
// comes from the manifest is HTML-escaped; links are emitted only for http(s) URLs; there are no
// external assets and the Content-Security-Policy forbids scripts and remote loads.

import type { AsiRow } from './frameworks.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const VERDICTS = ['vulnerable', 'degraded', 'inconclusive', 'resisted'] as const;

/** Inline Markdown: `code`, **bold**, [text](http-url), bare http(s) URLs. Everything escaped. */
export function inlineHtml(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.length >= 2 && part.startsWith('`') && part.endsWith('`') ? `<code>${esc(part.slice(1, -1))}</code>` : inlineText(part)))
    .join('');
}

function inlineText(text: string): string {
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*(.+?)\*\*|(https?:\/\/[^\s|<>]*[^\s|<>.,;:)])/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined && m[2] !== undefined) out += `<a href="${esc(m[2])}">${esc(m[1])}</a>`;
    else if (m[3] !== undefined) out += `<strong>${inlineText(m[3])}</strong>`;
    else if (m[4] !== undefined) out += `<a href="${esc(m[4])}">${esc(m[4])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function verdictClass(cell: string): string {
  const v = VERDICTS.find((x) => cell.startsWith(x));
  return v ? ` class="v-${v}"` : '';
}

/** The Markdown report as an HTML body fragment. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${inlineHtml(h[2])}</h${n}>`);
      i += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const block: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) block.push(lines[i++].replace(/^> ?/, ''));
      const paras = block.join('\n').split(/\n\s*\n/).map((p) => `<p>${p.split('\n').map(inlineHtml).join('<br>\n')}</p>`);
      out.push(`<blockquote>${paras.join('\n')}</blockquote>`);
      continue;
    }
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s|:-]+\|$/.test(lines[i + 1].trim())) {
      const head = cells(line);
      i += 2;
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        body.push(`<tr>${cells(lines[i]).map((c) => `<td${verdictClass(c)}>${inlineHtml(c)}</td>`).join('')}</tr>`);
        i += 1;
      }
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>\n${body.join('\n')}\n</tbody></table>`);
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) items.push(`<li>${inlineHtml(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('\n')}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3} |>|\||[-*] )/.test(lines[i])) para.push(lines[i++]);
    const text = para.join('\n');
    const em = /^_([\s\S]*)_$/.exec(text);
    out.push(em ? `<p class="note"><em>${inlineHtml(em[1])}</em></p>` : `<p>${para.map(inlineHtml).join('\n')}</p>`);
  }
  return out.join('\n');
}

/** The UB-1 table as HTML; empty when no row. */
export function asiTableHtml(rows: AsiRow[]): string {
  if (rows.length === 0) return '';
  const tr = rows
    .map(
      (r) =>
        `<tr${r.vulnerable > 0 ? ' class="v-vulnerable"' : ''}><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${r.measured}</td><td>${r.vulnerable}</td><td>${r.resisted + r.degraded}</td><td>${r.inconclusive}</td></tr>`,
    )
    .join('\n');
  return `<h2>By OWASP Agentic Top 10</h2>\n<table><thead><tr><th>id</th><th>category</th><th>measured</th><th>vulnerable</th><th>resisted</th><th>inconclusive</th></tr></thead><tbody>\n${tr}\n</tbody></table>`;
}

const STYLE = `body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;color:#1b1f24;background:#fff}
h1{font-size:1.6rem}h2{font-size:1.25rem;margin-top:2rem;border-bottom:1px solid #d0d7de}h3{font-size:1.05rem}
table{border-collapse:collapse;width:100%;font-size:.9rem;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.3rem .5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#f6f8fa}code{font:.85em ui-monospace,monospace;background:#f6f8fa;padding:.1em .3em;border-radius:3px;overflow-wrap:anywhere}
blockquote{margin:1rem 0;padding:.5rem 1rem;border-left:4px solid #8c959f;background:#f6f8fa}
.v-vulnerable{background:#ffebe9;color:#82071e;font-weight:600}.v-resisted{color:#116329}.v-degraded,.v-inconclusive{background:#fff8c5;color:#4d2d00}
.note{color:#57606a;font-size:.9rem}footer{margin-top:3rem;color:#57606a;font-size:.85rem}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th,code,blockquote{background:#161b22}th,td{border-color:#30363d}
.v-vulnerable{background:#4c1d1d;color:#ffdcd7}.v-resisted{color:#7ee787}.v-degraded,.v-inconclusive{background:#3b2e00;color:#f8e3a1}a{color:#58a6ff}}`;

/** A complete, self-contained HTML document from the Markdown report and the ASI rows. The ASI
 *  table goes before the first second-level section after the headline. */
export function renderHtml(markdown: string, asiRows: AsiRow[], title: string, footer: string): string {
  const body = markdownToHtml(markdown);
  const asi = asiTableHtml(asiRows);
  const at = body.indexOf('\n<h2>');
  const merged = asi === '' ? body : at === -1 ? `${body}\n${asi}` : `${body.slice(0, at)}\n${asi}${body.slice(at)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${merged}
<footer>${inlineHtml(footer)}</footer>
</body>
</html>
`;
}
