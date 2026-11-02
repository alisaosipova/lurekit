// Publish a completed benchmark run as a shareable bundle (ADR-0017; evidence-spec §5, §6).
//
// A published bundle holds ONLY: the run manifest, every per-repetition evidence.json (layout
// preserved, <scenario>/<rep>/evidence.json), the three renders from report() (report.md,
// report.json, report.sarif) and an index.md. Raw transcripts (claude-stream.jsonl, hook logs,
// detector logs) are never copied: §5 stores them verbatim for local audit, which is exactly
// why they must not leave the machine.
//
// Redaction gate (§5): before ANY file is written, every byte that would be published is
// scanned. A non-loopback http(s) URL whose host is not a scenario source host (or an explicit
// --allow-host), a token-shaped string (the fixture inertness patterns, src/fixtures/fixture.ts),
// or an absolute path under a home directory fails the publish, and nothing is written. The gate
// itself never rewrites (no `~` substitution): the maintainer must see and fix the leak.
//
// One explicit, opt-in exception (--redact-home, ADR-0017 "Operator home redaction"): every
// occurrence of the operator's OWN home directory in the published copies is replaced by the
// literal <HOME>, the count is recorded in index.md, and the gate then runs on the redacted
// bundle as usual, so any other home-style path, token or URL still fails. The run dir is never
// modified: redaction applies to the in-memory copies only.
//
// Structure: planPublish() / scanForLeaks() / renderIndex() are pure (data in, data out);
// readRunDir() and writeBundle() are the only I/O; publishRun() glues them.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EvidenceRecord, RunManifest } from '../runner/types.js';
import { extractHost, findSecretShape } from '../fixtures/fixture.js';
import { report, buildScore, type EvidenceLookup } from './index.js';
import { REPOSITORY_URL } from './sarif.js';
import { PARTIAL_MARKER } from './markdown.js';

/** One file of the bundle: its path relative to the out dir (POSIX separators) and its text. */
export interface BundleFile {
  rel: string;
  text: string;
}

/** What publish reads from a run dir: the manifest text and each evidence file's text. */
export interface RunDirContents {
  manifestText: string;
  evidence: BundleFile[]; // rel = <scenario>/<rep>/evidence.json
}

export interface PublishPolicy {
  /** Extra hosts the maintainer deliberately allows (--allow-host). */
  allowHosts?: string[];
  /** The publishing user's home directory; any absolute path under it fails the gate. */
  homeDir?: string;
  /** --redact-home: replace every occurrence of `homeDir` in the published copies with
   *  HOME_PLACEHOLDER before the gate runs. Requires `homeDir`. */
  redactHome?: boolean;
}

/** The literal that replaces the operator home directory under --redact-home. */
export const HOME_PLACEHOLDER = '<HOME>';

export type LeakKind = 'url' | 'token' | 'home_path';

export interface Leak {
  file: string; // bundle-relative path
  kind: LeakKind;
  /** Safe-to-print detail: the host for a URL, the pattern family for a token (never the
   *  value), the path prefix for a home path. */
  detail: string;
}

export type PublishPlan =
  | { ok: true; benchmarkRunId: string; files: BundleFile[]; homeReplacements?: number }
  | { ok: false; benchmarkRunId?: string; error?: string; leaks: Leak[] };

/** URLs the tool itself emits in every render (SARIF $schema and driver.informationUri). They
 *  are exact strings, not hosts, so allowing them does not open the whole host. */
export const SARIF_SCHEMA_URL = 'https://json.schemastore.org/sarif-2.1.0.json';
const INTRINSIC_URLS = new Set([SARIF_SCHEMA_URL, REPOSITORY_URL]);

/** Ids that become path segments must be plain (no separators, no traversal). */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --- evidence selection (shared with the CLI's report path) ----------------------------

/** Pick the evidence record the Markdown excerpt shows: the first `vulnerable` repetition,
 *  else repetition 0. `read(rep)` resolves one repetition (from disk or from memory). */
export function selectEvidence(
  reps: number,
  read: (rep: number) => EvidenceRecord | undefined,
): EvidenceRecord | undefined {
  for (let rep = 0; rep < Math.max(1, reps); rep++) {
    const ev = read(rep);
    if (ev && ev.outcome === 'vulnerable') return ev;
  }
  return read(0);
}

/** An EvidenceLookup over already-parsed records keyed by `<scenario>/<rep>`. */
export function lookupFromRecords(
  manifest: RunManifest,
  records: Map<string, EvidenceRecord>,
): EvidenceLookup {
  const runsById = new Map(manifest.results.map((r) => [r.scenario_id, r.runs]));
  return (scenarioId) =>
    selectEvidence(runsById.get(scenarioId) ?? 1, (rep) => records.get(`${scenarioId}/${rep}`));
}

// --- redaction gate (pure) --------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'<>`|\\]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}*_]+$/;

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Absolute-path-under-a-home patterns: the injected home dir plus the conventional home
 *  roots on Linux, macOS and Windows (raw and JSON-escaped backslashes). */
function homePathPatterns(homeDir: string | undefined): RegExp[] {
  const out: RegExp[] = [
    /(?<![\w.~-])\/home\/[^/\s"'`<>|]+/,
    /(?<![\w.~-])\/Users\/[^/\s"'`<>|]+/,
    /(?<![\w.~-])\/root(?=[/\s"'`]|$)/,
    /\b[A-Za-z]:(?:\\|\\\\|\/)Users(?:\\|\\\\|\/)[^\\/\s"'`<>|]+/i,
  ];
  for (const v of homeVariants(homeDir)) out.push(new RegExp(`${escapeRe(v)}(?=[\\\\/\\s"'\`]|$)`));
  return out;
}

/** The spellings of `homeDir` as they can appear in published text: as is, with JSON-escaped
 *  backslashes, and with forward slashes. Trailing separators are dropped; a root-ish value
 *  (`/`, empty) yields nothing. */
function homeVariants(homeDir: string | undefined): string[] {
  const home = homeDir?.replace(/[\\/]+$/, '');
  if (!home || home.length <= 1) return [];
  const variants = new Set([home, home.replace(/\\/g, '\\\\'), home.replace(/\\/g, '/')]);
  return [...variants].sort((a, b) => b.length - a.length); // longest first in the alternation
}

/** Replace every occurrence of the operator home dir with HOME_PLACEHOLDER. An occurrence counts
 *  only when it is followed by a separator, whitespace, a quote, `<>|` or the end: exactly the
 *  characters that end a home segment in homePathPatterns(). So `/home/kali` never eats the
 *  prefix of a sibling (`/home/kali2`, `/home/kali@old`, `/home/kali+bak`, `/home/kaliü`); that
 *  path stays and fails the gate. Anything else after the home (`)`, `,`, `:`) is left as is and
 *  fails the gate too: fail closed. Pure. */
export function redactHomeDir(text: string, homeDir: string): { text: string; count: number } {
  const variants = homeVariants(homeDir);
  if (variants.length === 0) return { text, count: 0 };
  const re = new RegExp(`(?:${variants.map(escapeRe).join('|')})(?=[\\\\/\\s"'\`<>|]|$)`, 'g');
  let count = 0;
  const out = text.replace(re, () => {
    count++;
    return HOME_PLACEHOLDER;
  });
  return { text: out, count };
}

/** The texts the gate scans for one file: the bytes as written, plus (when different) a view
 *  where JSON string escapes for whitespace (`\n`, `\t`, ...) become a space. Without it a
 *  value right after an escaped newline (`"ls\n/home/u"`, `"x\nghp_..."`) sits next to a word
 *  character, so the `\b` / lookbehind anchors of the patterns never match. An escaped
 *  backslash (`\\`) is consumed first and kept, so Windows paths still match. Scan-only:
 *  nothing published is rewritten. */
function scanViews(text: string): string[] {
  const unescaped = text.replace(/\\\\|\\[nrtbf]/g, (m) => (m === '\\\\' ? m : ' '));
  return unescaped === text ? [text] : [text, unescaped];
}

/** Scan bundle files for §5 leaks. Pure; returns every leak found (empty = clean). */
export function scanForLeaks(files: BundleFile[], allowedHosts: Set<string>, homeDir?: string): Leak[] {
  const leaks: Leak[] = [];
  const homeRes = homePathPatterns(homeDir);
  for (const f of files) {
    const views = scanViews(f.text);
    // URLs: loopback, an intrinsic tool URL, or an allowlisted host.
    const seenHosts = new Set<string>();
    for (const view of views) {
      for (const m of view.matchAll(URL_RE)) {
        const url = m[0].replace(TRAILING_PUNCT, '');
        if (INTRINSIC_URLS.has(url)) continue;
        const host = extractHost(url);
        if (isLoopbackHost(host) || allowedHosts.has(host) || seenHosts.has(host)) continue;
        seenHosts.add(host);
        leaks.push({ file: f.rel, kind: 'url', detail: `non-allowlisted host "${host}"` });
      }
    }
    // Token shapes: one list, owned by the fixture inertness contract. Scan per line so a
    // report naming several families reports each; the value is never echoed.
    const families = new Set<string>();
    for (const view of views) {
      for (const line of view.split(/\r?\n/)) {
        const name = findSecretShape(line);
        if (name !== undefined) families.add(name);
      }
    }
    for (const name of families) {
      leaks.push({ file: f.rel, kind: 'token', detail: `${name} (value redacted)` });
    }
    // Home paths: fail, never rewrite to `~`.
    home: for (const view of views) {
      for (const re of homeRes) {
        const m = re.exec(view);
        if (m) {
          leaks.push({ file: f.rel, kind: 'home_path', detail: `absolute home path "${m[0]}"` });
          break home;
        }
      }
    }
  }
  return leaks;
}

// --- index.md (pure) --------------------------------------------------------------------

const EOL = /\r\n?|\n/g;
const cell = (s: string): string =>
  String(s).replace(EOL, ' ').replace(/[\p{Cc}]/gu, ' ').replace(/\|/g, '\\|');

/** Optional notes renderIndex records about how the bundle was produced. */
export interface IndexNotes {
  /** Set when --redact-home ran: the number of home-dir occurrences replaced in the bundle. */
  homeReplacements?: number;
}

export function renderIndex(manifest: RunManifest, evidenceRels: string[], notes: IndexNotes = {}): string {
  const score = buildScore(manifest);
  const h = score.headline;
  const p = manifest.profile;
  const byScenario = new Map<string, string[]>();
  for (const rel of evidenceRels) {
    const id = rel.split('/')[0];
    byScenario.set(id, [...(byScenario.get(id) ?? []), rel]);
  }
  const out: string[] = [];
  out.push(`# agent-attack-bench run ${cell(manifest.benchmark_run_id)}`, '');
  out.push(
    `**Vulnerable to ${h.vulnerable} of ${h.of} scenarios** ` +
      `(degraded: ${h.degraded}, inconclusive: ${h.inconclusive}).`,
    '',
  );
  out.push('## Run', '');
  out.push(`- tool: agent-attack-bench ${cell(manifest.tool_version)}`);
  out.push(`- created: ${cell(manifest.created_at)}`);
  out.push(`- mode: ${cell(manifest.mode)}, k=${manifest.config.k}, vulnerable_if=${cell(manifest.config.vulnerable_if)}, isolation=${cell(manifest.config.isolation)}`);
  out.push(`- corpus: ${manifest.corpus.scenario_count} scenario(s), digest \`${cell(manifest.corpus.corpus_digest)}\``);
  out.push(`- spend: $${manifest.totals.spend_usd}`);
  out.push('');
  out.push('## Profile', '');
  out.push(`- agent: ${cell(p.agent)} ${cell(p.agent_version)}`);
  out.push(`- model: ${cell(p.model)}`);
  out.push(`- permission mode: ${cell(p.permission_mode ?? 'default')}${p.used_bare ? ' (bare)' : ''}`);
  out.push(`- mcp: \`${cell(p.mcp)}\`, hooks: \`${cell(p.hooks)}\`, skills: ${p.skills.length ? p.skills.map(cell).join(', ') : 'none'}`);
  out.push(`- settings digest: \`${cell(p.settings_digest)}\``);
  out.push(`- profile digest: \`${cell(score.profile_digest)}\``);
  out.push('');
  out.push('## Scenarios', '');
  out.push('| id | name | verdict | confidence | source | evidence |');
  out.push('|---|---|---|---|---|---|');
  for (const r of manifest.results) {
    const ev = (byScenario.get(r.scenario_id) ?? []).map((rel) => `[${cell(rel.split('/')[1])}](${rel})`).join(' ');
    out.push(
      `| ${cell(r.scenario_id)} | ${cell(r.name)} | ${cell(r.isolation === 'partial' ? `${r.verdict} ${PARTIAL_MARKER}` : r.verdict)} | ${cell(r.confidence)} | ${cell(r.source)} | ${ev || '-'} |`,
    );
  }
  out.push('');
  out.push('## Files', '');
  out.push('- [manifest.json](manifest.json) — run manifest (evidence-spec §2.3)');
  out.push('- [report.md](report.md), [report.json](report.json), [report.sarif](report.sarif) — renders (evidence-spec §6)');
  for (const rel of evidenceRels) out.push(`- [${rel}](${rel})`);
  out.push('');
  if (notes.homeReplacements !== undefined) {
    out.push('## Redaction', '');
    out.push(`- redaction applied: home directory -> ${HOME_PLACEHOLDER} (${notes.homeReplacements} replacements)`);
    out.push('');
  }
  out.push(
    '_Raw agent transcripts and hook captures are kept with the local run and are not published ' +
      '(evidence-spec §5). Agent output is stochastic: the verdict is a k-run tally, not a ' +
      'deterministic pass/fail._',
    '',
  );
  return out.join('\n');
}

// --- plan (pure) ------------------------------------------------------------------------

/** Build and gate the bundle. Pure: nothing is read or written here. */
export function planPublish(contents: RunDirContents, policy: PublishPolicy = {}): PublishPlan {
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(contents.manifestText) as RunManifest;
  } catch (err) {
    return { ok: false, error: `manifest.json is not valid JSON: ${(err as Error).message}`, leaks: [] };
  }
  const id = manifest?.benchmark_run_id;
  if (typeof id !== 'string' || !SAFE_SEGMENT.test(id) || !Array.isArray(manifest.results)) {
    return { ok: false, error: 'manifest.json has no usable benchmark_run_id/results', leaks: [] };
  }
  for (const r of manifest.results) {
    if (typeof r.scenario_id !== 'string' || !SAFE_SEGMENT.test(r.scenario_id)) {
      return { ok: false, benchmarkRunId: id, error: `unsafe scenario id in manifest: ${JSON.stringify(r.scenario_id)}`, leaks: [] };
    }
  }

  const records = new Map<string, EvidenceRecord>();
  for (const f of contents.evidence) {
    try {
      records.set(f.rel.replace(/\/evidence\.json$/, ''), JSON.parse(f.text) as EvidenceRecord);
    } catch (err) {
      return { ok: false, benchmarkRunId: id, error: `${f.rel} is not valid JSON: ${(err as Error).message}`, leaks: [] };
    }
  }
  const lookup = lookupFromRecords(manifest, records);
  const evidenceRels = contents.evidence.map((f) => f.rel);

  let files: BundleFile[] = [
    { rel: 'manifest.json', text: contents.manifestText },
    ...contents.evidence,
    { rel: 'report.md', text: report(manifest, { format: 'markdown', evidenceLookup: lookup }) },
    { rel: 'report.json', text: report(manifest, { format: 'json' }) },
    { rel: 'report.sarif', text: report(manifest, { format: 'sarif' }) },
  ];

  // --redact-home: rewrite the in-memory copies only (contents.* are fresh objects per file, the
  // run dir is never touched). index.md is rendered last so its note can carry the total count;
  // the note itself contains no home path, so redacting the noted index counts the same as the
  // un-noted one.
  let homeReplacements: number | undefined;
  if (policy.redactHome) {
    const home = policy.homeDir;
    if (homeVariants(home).length === 0) {
      return { ok: false, benchmarkRunId: id, error: '--redact-home needs a usable home directory', leaks: [] };
    }
    let total = 0;
    files = files.map((f) => {
      const r = redactHomeDir(f.text, home as string);
      total += r.count;
      return { rel: f.rel, text: r.text };
    });
    total += redactHomeDir(renderIndex(manifest, evidenceRels), home as string).count;
    homeReplacements = total;
    const index = redactHomeDir(renderIndex(manifest, evidenceRels, { homeReplacements }), home as string);
    files.push({ rel: 'index.md', text: index.text });
  } else {
    files.push({ rel: 'index.md', text: renderIndex(manifest, evidenceRels) });
  }

  const allowed = new Set<string>();
  for (const r of manifest.results) {
    if (typeof r.source === 'string' && /^https?:\/\//i.test(r.source)) allowed.add(extractHost(r.source));
  }
  for (const h of policy.allowHosts ?? []) allowed.add(extractHost(h));

  // The gate always runs, and after redaction: a foreign home path, a token or a URL still fails.
  const leaks = scanForLeaks(files, allowed, policy.homeDir);
  if (leaks.length > 0) return { ok: false, benchmarkRunId: id, leaks };
  return homeReplacements === undefined
    ? { ok: true, benchmarkRunId: id, files }
    : { ok: true, benchmarkRunId: id, files, homeReplacements };
}

/** Human-readable failure text for a rejected plan. */
export function formatPlanFailure(plan: Extract<PublishPlan, { ok: false }>): string {
  if (plan.error) return `publish: ${plan.error}; nothing written\n`;
  const lines = plan.leaks.map((l) => `  ${l.file}: ${l.kind}: ${l.detail}`);
  return (
    `publish: redaction gate failed (evidence-spec §5), ${plan.leaks.length} finding(s); nothing written\n` +
    lines.join('\n') +
    '\nFix the run artefacts, or pass --allow-host <host> for a deliberate URL exception' +
    (plan.leaks.some((l) => l.kind === 'home_path')
      ? ', or --redact-home to replace your own home directory with <HOME> in the published copies'
      : '') +
    '.\n'
  );
}

// --- I/O --------------------------------------------------------------------------------

/** Read manifest.json and every <scenario>/<rep>/evidence.json for the manifest's scenarios.
 *  Nothing else under the run dir is read (raw transcripts stay local). */
export function readRunDir(runDir: string): RunDirContents {
  const manifestText = readFileSync(path.join(runDir, 'manifest.json'), 'utf8');
  const evidence: BundleFile[] = [];
  let ids: string[] = [];
  try {
    const m = JSON.parse(manifestText) as RunManifest;
    ids = Array.isArray(m.results) ? m.results.map((r) => r.scenario_id) : [];
  } catch {
    return { manifestText, evidence }; // planPublish reports the parse error
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !SAFE_SEGMENT.test(id)) continue; // planPublish rejects it
    const sdir = path.join(runDir, id);
    if (!existsSync(sdir)) continue;
    const reps = readdirSync(sdir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name))
      .sort((a, b) => a - b);
    for (const rep of reps) {
      const p = path.join(sdir, String(rep), 'evidence.json');
      if (existsSync(p)) evidence.push({ rel: `${id}/${rep}/evidence.json`, text: readFileSync(p, 'utf8') });
    }
  }
  return { manifestText, evidence };
}

/** Write a gated bundle. Refuses a non-empty out dir so stale, unscanned files cannot ride along. */
export function writeBundle(outDir: string, files: BundleFile[]): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`publish: output directory ${outDir} is not empty`);
  }
  for (const f of files) {
    const dest = path.join(outDir, ...f.rel.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.text, 'utf8');
  }
}
