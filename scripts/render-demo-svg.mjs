#!/usr/bin/env node
// Render the first lines of the real `lurekit demo` output as a static SVG terminal mock for the
// README (docs/assets/demo-output.svg). Adapted from mcp-review-check docs/launch/render-svg.mjs:
// the input here is the Markdown that `lurekit demo` prints (no ANSI codes), so styling is by
// line kind, and long lines are word-wrapped instead of widening the image. Nothing is added to
// or removed from the selected lines; the only text that is not demo output is the title bar and
// the dim footer that says how many lines are shown. Non-ASCII characters are written as XML
// character references, so the SVG file is pure ASCII.
//
// Usage (from the repository root, after `npm run build`):
//   node scripts/render-demo-svg.mjs            run `node dist/cli.js demo`, write docs/assets/demo-output.svg
//   node scripts/render-demo-svg.mjs --check    same, but exit 1 if the committed file differs
//   node scripts/render-demo-svg.mjs --stdin    read demo output from stdin, write the SVG to stdout (tests)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets', 'demo-output.svg');
const TABLE_ROWS = 4; // demo lines are taken from the top through this many result-table rows
const COLS = 110; // wrap width in characters
const MAX_BYTES = 60 * 1024;

/** Lines 1..n of the demo output: banner, title, plain-language summary, headline, profile
 *  bullets, table header, separator and the first TABLE_ROWS rows. */
export function selectLines(demo) {
  const lines = demo.replace(/\r\n/g, '\n').split('\n');
  const sep = lines.findIndex((l) => /^\|---/.test(l));
  if (sep < 0) throw new Error('demo output has no result table');
  return { shown: lines.slice(0, sep + 1 + TABLE_ROWS), total: lines.filter((l, i) => i < lines.length - 1 || l !== '').length };
}

/** Word-wrap one line to COLS; continuation lines are indented by two spaces. A word longer than
 *  the width (a URL) is broken hard. */
function wrap(line) {
  if (line.length <= COLS) return [line];
  const out = [];
  let cur = '';
  for (const word of line.split(' ')) {
    let w = word;
    const room = () => COLS - (out.length > 0 ? 2 : 0);
    while (w.length > room()) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(w.slice(0, room()));
      w = w.slice(room());
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= room()) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.map((l, i) => (i === 0 ? l : '  ' + l));
}

function styleOf(line) {
  if (/^\|---/.test(line)) return { dim: true };
  if (/^\| AAB-\d+ .*\| vulnerable/.test(line)) return { color: '#f14c4c' };
  if (/^\| AAB-\d+ /.test(line)) return {};
  if (/^\| id /.test(line)) return { bold: true };
  if (/^(> )?\*\*|^#/.test(line)) return { bold: true };
  if (/^- /.test(line)) return { dim: true };
  return {};
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  .replace(/[^\x20-\x7e]/gu, (c) => `&#${c.codePointAt(0)};`);

export function renderSvg(demo) {
  const { shown, total } = selectLines(demo);
  const rows = [];
  for (const line of shown) {
    const st = styleOf(line);
    // The plain-language and banner paragraphs are long; their wrapped rows keep the line's style.
    for (const part of wrap(line)) rows.push({ text: part, st });
  }
  rows.push({ text: '', st: {} });
  rows.push({ text: `[lines 1-${shown.length} of ${total} shown; run lurekit demo for the full report]`, st: { dim: true, footer: true } });

  const FONT = 13, LH = 17, CW = FONT * 0.602, PAD = 18, BAR = 30;
  const FG = '#d4d4d4', BG = '#1e1e1e';
  const W = Math.ceil(COLS * CW * 1.03 + 2 * PAD), H = BAR + PAD + rows.length * LH + PAD;
  const body = rows.map((r, i) => {
    const text = r.text.trimEnd();
    if (!text.trim()) return '';
    const lead = text.length - text.trimStart().length;
    const a = [`x="${(PAD + lead * CW).toFixed(1)}"`, `y="${BAR + PAD + (i + 1) * LH - 4}"`];
    if (r.st.color) a.push(`fill="${r.st.color}"`);
    if (r.st.bold) a.push('font-weight="bold"');
    if (r.st.dim) a.push('fill-opacity="0.6"');
    if (r.st.footer) a.push('font-style="italic"');
    return `<text ${a.join(' ')}>${esc(text.trimStart())}</text>`;
  }).filter(Boolean).join('\n');
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";
  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="lurekit demo output: a published Claude Code 2.1.317 run, vulnerable to 4 of 21 scenarios, all through settings_hooks_file">
<title>lurekit demo: the first ${shown.length} lines of the real output (generated by scripts/render-demo-svg.mjs)</title>
<rect width="${W}" height="${H}" rx="8" fill="${BG}"/>
<rect width="${W}" height="${BAR}" rx="8" fill="#2d2d2d"/><rect y="${BAR - 8}" width="${W}" height="8" fill="#2d2d2d"/>
<circle cx="18" cy="15" r="6" fill="#ff5f56"/><circle cx="38" cy="15" r="6" fill="#ffbd2e"/><circle cx="58" cy="15" r="6" fill="#27c93f"/>
<text x="${W / 2}" y="19" text-anchor="middle" fill="#9a9a9a" font-family="${mono}" font-size="12">$ lurekit demo</text>
<g font-family="${mono}" font-size="${FONT}" fill="${FG}" xml:space="preserve">
${body}
</g>
</svg>
`;
}

function check(svg) {
  if (/[^\x00-\x7f]/.test(svg)) throw new Error('SVG is not pure ASCII');
  if (Buffer.byteLength(svg) >= MAX_BYTES) throw new Error(`SVG is ${Buffer.byteLength(svg)} bytes, limit ${MAX_BYTES}`);
  return svg;
}

const mode = process.argv[2];
if (mode === '--stdin') {
  process.stdout.write(check(renderSvg(readFileSync(0, 'utf8'))));
} else if (mode === undefined || mode === '--check') {
  const cli = path.join(ROOT, 'dist', 'cli.js');
  if (!existsSync(cli)) { console.error('dist/cli.js not found: run npm run build first'); process.exit(2); }
  const demo = execFileSync(process.execPath, [cli, 'demo'], { cwd: ROOT, encoding: 'utf8' });
  const svg = check(renderSvg(demo));
  if (mode === '--check') {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== svg) { console.error('docs/assets/demo-output.svg is stale: run npm run build && npm run assets:demo'); process.exit(1); }
    console.log('docs/assets/demo-output.svg is current');
  } else {
    writeFileSync(OUT, svg);
    console.log(`docs/assets/demo-output.svg: ${Buffer.byteLength(svg)} bytes`);
  }
} else {
  console.error('usage: render-demo-svg.mjs [--check|--stdin]');
  process.exit(2);
}
