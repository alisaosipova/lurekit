#!/usr/bin/env node
// Render the first screen of the real `lurekit demo` output as a static SVG terminal mock for the
// README (docs/assets/demo-output.svg). Adapted from mcp-review-check docs/launch/render-svg.mjs.
// The input is the terminal view that `lurekit demo` prints to a pipe at COLUMNS=110 (ADR-0021
// amendment: plain sentences wrapped by the CLI, an aligned result table that never wraps), with
// no ANSI codes: styling here is by line kind, and the verdict cell of a table row is coloured by
// its first word. Nothing is added to or removed from the selected lines; the only text that is
// not demo output is the title bar and the dim footer that says how many lines are shown.
// Non-ASCII characters are written as XML character references, so the SVG file is pure ASCII.
//
// Usage (from the repository root, after `npm run build`):
//   node scripts/render-demo-svg.mjs            run `node dist/cli.js demo` at COLUMNS=110, write docs/assets/demo-output.svg
//   node scripts/render-demo-svg.mjs --check    same, but exit 1 if the committed file differs
//   node scripts/render-demo-svg.mjs --stdin    read demo output from stdin, write the SVG to stdout (tests)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets', 'demo-output.svg');
const TABLE_ROWS = 4; // demo lines are taken from the top through this many result-table rows
export const COLS = 110; // the width the demo is rendered at (COLUMNS=110) and the image fits
const MAX_BYTES = 60 * 1024;

const HEADER = /^id\s+verdict\s+conf\b/;
const ROW = /^(AAB-\d+)(\s+)(vulnerable|resisted|inconclusive|degraded)(\s*\([^)]*\))?(\s*\([^)]*\))?(.*)$/;

/** Lines 1..n of the demo output: banner, title, plain-language summary, headline, setup line,
 *  table header, rule and the first TABLE_ROWS rows. */
export function selectLines(demo) {
  const lines = demo.replace(/\r\n/g, '\n').split('\n');
  const header = lines.findIndex((l) => HEADER.test(l));
  if (header < 0) throw new Error('demo output has no result table');
  const shown = lines.slice(0, header + 2 + TABLE_ROWS);
  const over = shown.find((l) => l.length > COLS && !/^\s*lurekit run /.test(l));
  if (over !== undefined) throw new Error(`demo line wider than ${COLS} columns: ${over.slice(0, 40)}...`);
  return { shown, total: lines.filter((l, i) => i < lines.length - 1 || l !== '').length };
}

const VERDICT_COLOR = { vulnerable: '#f14c4c', resisted: '#3fb950', inconclusive: '#e3b341', degraded: '#e3b341' };

/** One line as styled spans: [{ text, color?, bold?, dim? }]. */
function spansOf(line) {
  const row = ROW.exec(line);
  if (row) {
    const verdict = `${row[3]}${row[4] ?? ''}${row[5] ?? ''}`;
    return [{ text: row[1] + row[2] }, { text: verdict, color: VERDICT_COLOR[row[3]] }, { text: row[6] }];
  }
  if (HEADER.test(line)) return [{ text: line, bold: true }];
  if (/^-+(\s+-+)*$/.test(line) || /^=+$/.test(line)) return [{ text: line, dim: true }];
  if (/^(Demo: |LureKit report: )/.test(line)) return [{ text: line, bold: true }];
  if (/^Vulnerable to \d+ of \d+ scenarios/.test(line)) return [{ text: line, bold: true }];
  if (/^model: /.test(line)) return [{ text: line, dim: true }];
  if (/^\s+lurekit run /.test(line)) return [{ text: line, bold: true }];
  return [{ text: line }];
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  .replace(/[^\x20-\x7e]/gu, (c) => `&#${c.codePointAt(0)};`);

export function renderSvg(demo) {
  const { shown, total } = selectLines(demo);
  const rows = shown.map((line) => spansOf(line));
  rows.push([{ text: '' }]);
  rows.push([{ text: `[lines 1-${shown.length} of ${total} shown; run lurekit demo for the full report]`, dim: true, footer: true }]);

  const FONT = 13, LH = 17, CW = FONT * 0.602, PAD = 18, BAR = 30;
  const FG = '#d4d4d4', BG = '#1e1e1e';
  const W = Math.ceil(COLS * CW * 1.03 + 2 * PAD), H = BAR + PAD + rows.length * LH + PAD;
  const body = rows.map((spans, i) => {
    const text = spans.map((s) => s.text).join('').trimEnd();
    if (!text.trim()) return '';
    const y = BAR + PAD + (i + 1) * LH - 4;
    // Every span gets its own x from the character offset (the font is monospace), so a renderer
    // that does not flow tspans (ImageMagick) places it like a browser does.
    let col = 0;
    const parts = spans.map((s) => {
      const t = s.text;
      const at = col;
      col += t.length;
      const lead = t.length - t.trimStart().length;
      const body = t.trim();
      if (!body) return '';
      const a = [`x="${(PAD + (at + lead) * CW).toFixed(1)}"`];
      if (s.color) a.push(`fill="${s.color}"`);
      if (s.bold) a.push('font-weight="bold"');
      if (s.dim) a.push('fill-opacity="0.6"');
      if (s.footer) a.push('font-style="italic"');
      return `<tspan ${a.join(' ')}>${esc(t.trimEnd().slice(lead))}</tspan>`;
    }).join('');
    return `<text y="${y}">${parts}</text>`;
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
  // Not a TTY, so the CLI prints no colour; COLUMNS sets the width the image is laid out at.
  const env = { ...process.env, COLUMNS: String(COLS), NO_COLOR: '1' };
  const demo = execFileSync(process.execPath, [cli, 'demo'], { cwd: ROOT, encoding: 'utf8', env });
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
