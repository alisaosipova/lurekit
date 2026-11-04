// Terminal report (ADR-0021 amendment, terminal view). A rendering of the SAME data as the
// Markdown report (manifest + scoring block + the guidance layers) for a person reading a
// terminal: plain sentences wrapped at the terminal width, the result table as aligned columns
// that never wrap, the source URLs in a numbered list after the table. It is a PURE function of
// its inputs (no file I/O, no clock, no process state: width and color are passed in). The
// Markdown report stays the artifact format on disk (report.md); this view adds no fact and
// drops none: every count, id and URL of report.md appears here, in the same order.
//
// Colour is ANSI bold/red/green/yellow/dim only, and only when the caller says so (the CLI
// decides from the TTY and NO_COLOR/FORCE_COLOR); padding is computed on the uncoloured text.

import type { RunManifest } from '../runner/types.js';
import type { EvidenceLookup, MarkdownOptions } from './markdown.js';
import { MARKDOWN_SCORING_NOTES, RESISTED_KIND_LABEL } from './markdown.js';
import { plainLanguageSummary, replayWarning, whatToChange } from './guidance.js';
import type { Report, ReportScenario } from './score.js';

/** Width used when stdout is not a terminal and no COLUMNS is given. */
export const DEFAULT_WIDTH = 100;
/** Narrower than this and the table cannot hold its columns; the width is clamped up to it. */
export const MIN_WIDTH = 60;

export interface TerminalOptions {
  /** Columns available; clamped to MIN_WIDTH. */
  width: number;
  /** Emit ANSI colour codes. */
  color: boolean;
}

/** Everything the terminal view is rendered from (the Markdown report's inputs plus a banner). */
export interface TerminalData extends MarkdownOptions {
  manifest: RunManifest;
  report: Report;
  evidenceLookup?: EvidenceLookup;
  /** Optional banner lines in the Markdown banner's inline syntax (bold, backticks). The first
   *  line is a bold title on its own; a blank line separates blocks; inside a block, consecutive
   *  prose lines are joined into one paragraph and wrapped at the width (a line ending with a
   *  colon closes its paragraph), and a URL (alone on its line, or after a `label:`) or a
   *  backticked command is printed whole on its own indented line, never wrapped. */
  banner?: string[];
}

/** Whether to colour terminal output: a TTY, NO_COLOR unset (https://no-color.org), and
 *  FORCE_COLOR not "0". FORCE_COLOR does not turn colour on for a pipe: a piped report is read
 *  by another program or a file, and codes there would be noise. */
export function colorEnabled(isTTY: boolean, env: Readonly<Record<string, string | undefined>>): boolean {
  if (!isTTY) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return env.FORCE_COLOR !== '0';
}

/** The width to render at: the terminal's columns when stdout is a TTY, else COLUMNS from the
 *  environment when it is a positive integer, else DEFAULT_WIDTH; never below MIN_WIDTH. */
export function terminalWidth(isTTY: boolean, columns: number | undefined, env: Readonly<Record<string, string | undefined>>): number {
  let w: number | undefined;
  if (isTTY && typeof columns === 'number' && columns > 0) w = columns;
  else if (/^\d+$/.test(env.COLUMNS ?? '')) w = Number(env.COLUMNS);
  return Math.max(MIN_WIDTH, w ?? DEFAULT_WIDTH);
}

// --- inline Markdown -> plain text -----------------------------------------------------------

/** Strip the inline Markdown the guidance layers use: bold, code spans, whole-line italics, a
 *  quote marker, and links (`[text](url)` becomes `text <url>`, so no URL is lost). */
export function plain(s: string): string {
  let t = s.replace(/^> ?/, '');
  if (/^_[^_].*_$/.test(t)) t = t.slice(1, -1);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <$2>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/`([^`]*)`/g, '$1');
  return t;
}

/** Word-wrap `text` to `width`; a word longer than the room (a URL) is kept whole on its own
 *  line, never broken. `indent` prefixes the first line, `hang` every following line. */
export function wrap(text: string, width: number, indent = '', hang = indent): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];
  const out: string[] = [];
  let cur = indent;
  let curHasWord = false;
  for (const w of words) {
    if (curHasWord && cur.length + 1 + w.length > width) {
      out.push(cur);
      cur = hang + w;
    } else {
      cur = curHasWord ? `${cur} ${w}` : `${cur}${w}`;
    }
    curHasWord = true;
  }
  out.push(cur);
  return out;
}

/** Cut `s` to `max` characters with a trailing `...` when it does not fit. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, Math.max(0, max));
  return `${s.slice(0, max - 3)}...`;
}

const padEnd = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// --- table cells -----------------------------------------------------------------------------

/** The verdict in words: `resisted (denied)`, `vulnerable (isolation: partial)`. */
export function verdictWords(s: Pick<ReportScenario, 'verdict' | 'isolation' | 'resisted_kind'>): string {
  let v: string = s.verdict;
  if (s.verdict === 'resisted' && s.resisted_kind && RESISTED_KIND_LABEL[s.resisted_kind]) {
    v = `${v} ${RESISTED_KIND_LABEL[s.resisted_kind]}`;
  }
  if (s.isolation === 'partial') v = `${v} (isolation: partial)`;
  return v;
}

/** The confidence tally compacted for a column: `3/3 vulnerable` -> `3/3`,
 *  `0/3 vulnerable, 1 inconclusive` -> `0/3 +1 inc`. Any other string is kept as is. */
export function confidenceCell(confidence: string): string {
  const m = /^(\d+\/\d+) vulnerable(?:, (\d+) inconclusive)?$/.exec(confidence);
  if (!m) return confidence;
  return m[2] !== undefined ? `${m[1]} +${m[2]} inc` : m[1];
}

const CVE = /CVE-\d{4}-\d{4,}/i;
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

/** A short reference for the source column: the CVE id when the name or the URL carries one,
 *  else the GHSA id, else the URL's host (without `www.`), else the URL itself. */
export function sourceRef(name: string, url: string): string {
  const cve = CVE.exec(name) ?? CVE.exec(url);
  if (cve) return cve[0].toUpperCase();
  const ghsa = GHSA.exec(name) ?? GHSA.exec(url);
  if (ghsa) return `GHSA-${ghsa[0].slice(5).toLowerCase()}`;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Shortened digest for the setup line: the first 12 hex characters and `...`. */
export function shortDigest(d: string): string {
  return d.length > 12 ? `${d.slice(0, 12)}...` : d;
}

// --- colour ----------------------------------------------------------------------------------

type Paint = (code: string, s: string) => string;
const CODES = { bold: '1', dim: '2', red: '31', green: '32', yellow: '33' } as const;

function verdictColor(verdict: string): keyof typeof CODES | undefined {
  if (verdict === 'vulnerable') return 'red';
  if (verdict === 'resisted') return 'green';
  if (verdict === 'inconclusive' || verdict === 'degraded') return 'yellow';
  return undefined;
}

// --- the renderer ----------------------------------------------------------------------------

/** Columns of the result table, computed from the rows so the name takes what is left. The
 *  source column is shown only when the name still gets NAME_MIN columns (every URL is in the
 *  Sources list anyway); a source width of 0 means the column is dropped. */
export interface Columns { id: number; verdict: number; confidence: number; source: number; name: number }
const GAP = 2;
/** Fewer columns than this and a scenario name is unreadable; the source column goes first. */
export const NAME_MIN = 36;
const HEADERS = { id: 'id', verdict: 'verdict', confidence: 'conf', source: 'source', name: 'name' };

export function tableColumns(rows: { id: string; verdict: string; confidence: string; source: string }[], width: number): Columns {
  const max = (k: 'id' | 'verdict' | 'confidence' | 'source'): number =>
    Math.max(HEADERS[k].length, ...rows.map((r) => r[k].length));
  const c: Columns = { id: max('id'), verdict: max('verdict'), confidence: max('confidence'), source: max('source'), name: 0 };
  const left = (): number => width - (c.id + c.verdict + c.confidence + (c.source > 0 ? c.source + GAP : 0) + 3 * GAP);
  if (left() < NAME_MIN) c.source = 0;
  c.name = Math.max(HEADERS.name.length, left());
  return c;
}

export function renderTerminal(data: TerminalData, opts: TerminalOptions): string {
  const width = Math.max(MIN_WIDTH, Math.floor(opts.width));
  const paint: Paint = opts.color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_c, s) => s;
  const bold = (s: string): string => paint(CODES.bold, s);
  const dim = (s: string): string => paint(CODES.dim, s);
  const { manifest, report } = data;
  const h = report.headline;
  const byId = new Map(manifest.results.map((r) => [r.scenario_id, r]));
  const out: string[] = [];
  const para = (text: string, indent = '', hang = indent): void => { out.push(...wrap(plain(text), width, indent, hang)); };
  const heading = (text: string, rule: string): void => { out.push(bold(text), dim(rule.repeat(text.length)), ''); };

  // Banner (demo): the title bold on its own line; prose lines joined into paragraphs and
  // wrapped (the Markdown banner keeps one fact per line, which at 80 or 100 columns would
  // leave half-lines dangling); a URL or a backticked command whole on its own indented line.
  if (data.banner && data.banner.length > 0) {
    let pending: string[] = [];
    const flush = (): void => { if (pending.length > 0) para(pending.join(' ')); pending = []; };
    data.banner.forEach((line, i) => {
      const t = line.replace(/^> ?/, '');
      if (i === 0) { out.push(bold(plain(t))); return; }
      if (t === '') { flush(); out.push(''); return; }
      if (/^`[^`]+`$/.test(t) || !/\s/.test(t)) { flush(); out.push(`  ${plain(t)}`); return; }
      // "label: <url>": the label closes its paragraph and the URL stands on its own line.
      const labelled = /^(.*:)\s+(https?:\/\/\S+)$/.exec(t);
      if (labelled) { pending.push(labelled[1]); flush(); out.push(`  ${labelled[2]}`); return; }
      pending.push(t);
      if (t.endsWith(':')) flush();
    });
    flush();
    out.push('');
  }

  // Title, replay warning, plain-language paragraph.
  heading(`LureKit report: ${manifest.profile.agent} ${manifest.profile.agent_version}`, '=');
  const replay = replayWarning(report, data.evidenceLookup);
  if (replay) { para(`Warning: ${replay}`); out.push(''); }
  para(plainLanguageSummary(manifest, report, data.surfaceOf));
  out.push('');

  // Headline and the resisted split: same numbers and wording as report.md.
  const headline = `Vulnerable to ${h.vulnerable} of ${h.of} scenarios`;
  const headlineTail = `(degraded: ${h.degraded}, inconclusive: ${h.inconclusive}).`;
  if (headline.length + 1 + headlineTail.length <= width) out.push(`${bold(headline)} ${headlineTail}`);
  else out.push(bold(headline), `  ${headlineTail}`);
  if (report.resisted && report.resisted.not_attempted + report.resisted.denied > 0) {
    out.push(`Resisted: ${report.resisted.not_attempted} not attempted, ${report.resisted.denied} denied`);
    para('(denied: the agent attempted the forbidden action and the setup blocked it)', '  ');
  }
  out.push('');

  // Setup facts: one line when they fit, else one per line.
  const facts = [`model: ${manifest.profile.model}`, `profile digest: ${shortDigest(report.profile_digest)}`, `benchmark run: ${manifest.benchmark_run_id}`];
  const oneLine = facts.join('    ');
  if (oneLine.length <= width) out.push(dim(oneLine));
  else for (const f of facts) out.push(dim(f));
  out.push('');

  // Result table: aligned columns, the name truncated to what is left, never wrapped.
  const rows = report.scenarios.map((s) => ({
    id: s.id,
    verdict: verdictWords(s),
    kind: s.verdict,
    confidence: confidenceCell(s.confidence),
    source: sourceRef(byId.get(s.id)?.name ?? '', s.source),
    name: (byId.get(s.id)?.name ?? '').replace(/\s+/g, ' ').trim(),
    url: s.source,
  }));
  const c = tableColumns(rows, width);
  const cells = (r: Record<keyof Columns, string>, style?: (k: keyof Columns, s: string) => string): string => {
    const sty = style ?? ((_k, s) => s);
    return [
      sty('id', padEnd(r.id, c.id)),
      sty('verdict', padEnd(r.verdict, c.verdict)),
      sty('confidence', padEnd(r.confidence, c.confidence)),
      ...(c.source > 0 ? [sty('source', padEnd(r.source, c.source))] : []),
      sty('name', truncate(r.name, c.name)),
    ].join(' '.repeat(GAP)).trimEnd();
  };
  const shownColumns = (['id', 'verdict', 'confidence', 'source', 'name'] as const).filter((k) => c[k] > 0);
  out.push(cells(HEADERS, (_k, s) => bold(s)));
  out.push(dim(shownColumns.map((k) => '-'.repeat(c[k])).join(' '.repeat(GAP))));
  for (const r of rows) {
    const color = verdictColor(r.kind);
    out.push(cells(r, (k, s) => (k === 'verdict' && color ? paint(CODES[color], s) : s)));
  }
  out.push('');
  para(`conf: repetitions that were vulnerable out of k=${manifest.config.k} (3/3 = vulnerable every time, 0/3 = never); +N inc = N repetitions could not be measured.`, '', '  ');
  if (report.scenarios.some((s) => s.isolation === 'partial')) {
    para(
      'isolation: partial: --strict-mcp-config was not in effect for at least one run (e.g. the scenario ' +
        "measures project .mcp.json auto-load), so MCP servers from the operator's own config may have " +
        'been visible to the agent; see the evidence warnings.',
      '', '  ',
    );
  }
  out.push('');

  // Sources: every URL of the source column, numbered, in table order. Never broken.
  heading('Sources', '-');
  const numWidth = String(rows.length).length;
  rows.forEach((r, i) => { out.push(`${String(i + 1).padStart(numWidth)}. ${padEnd(r.id, c.id)}  ${r.url}`); });
  out.push('');

  // Per-vulnerable block: evidence pointer, detector and tool-call name (when evidence is given).
  const vulnerable = report.scenarios.filter((s) => s.verdict === 'vulnerable');
  if (vulnerable.length > 0) {
    heading('Vulnerable scenarios', '-');
    for (const s of vulnerable) {
      const name = byId.get(s.id)?.name ?? '';
      out.push(...wrap(name, width, `${s.id}  `, ' '.repeat(s.id.length + 2)).map((l, i) => (i === 0 ? bold(l) : l)));
      if (s.isolation === 'partial') out.push('  isolation: partial (see the note under the table)');
      out.push(`  evidence: ${s.evidence_ref}`);
      const ev = data.evidenceLookup?.(s.id);
      if (ev) {
        const hit = ev.detector_hits[0];
        out.push(`  detector: ${hit?.detector ?? ev.forbidden_effect.detector}`);
        const call = hit?.attributed_tool_call ?? ev.observation?.tool_calls?.[0];
        if (call) out.push(`  tool call: ${call.name} (+${call.at}ms)`);
      }
      out.push('');
    }
  }

  para(MARKDOWN_SCORING_NOTES);
  out.push('');

  // What to change: the Markdown lines of the guidance layer, rendered as plain text.
  for (const line of whatToChange(manifest, report, data.surfaceOf, data.reMeasure)) {
    if (line === '') { if (out[out.length - 1] !== '') out.push(''); continue; }
    if (line.startsWith('## ')) { heading(plain(line.slice(3)), '-'); continue; }
    if (line.startsWith('### ')) { out.push(...wrap(plain(line.slice(4)), width, '', '  ').map(bold)); continue; }
    const cmd = /^- re-measure: `([^`]+)` (.*)$/.exec(line);
    if (cmd) {
      para(`- re-measure ${cmd[2]}:`, '', '  ');
      out.push(`    ${cmd[1]}`);
      continue;
    }
    if (line.startsWith('- ')) { para(line, '', '  '); continue; }
    para(line);
  }
  // Drop trailing blank lines (whatToChange ends with one) so the CLI's final newline is the only one.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
