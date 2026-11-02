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
// modified: redaction applies to the in-memory copies only. Encoded spellings of the same home
// (ADR-0017 "Encoded home spellings": the agent runtime's project slug, `/` -> `-`, and the
// percent-encoded path) fail the gate like a plain path and, under --redact-home, become
// <HOME-SLUG> / <HOME>. A last check then fails the publish if the operator's bare username is
// still a token anywhere in the bundle.
//
// Unconditional (ADR-0017 "Operator MCP server names"): every observation `mcp_servers` entry
// whose `source` is not one the harness itself configures (`dynamic` = --mcp-config fixture
// servers, `project` = a fixture-planted .mcp.json) has its `name` replaced by a stable
// placeholder <user-mcp-N> (one N per distinct name within the published run); status and
// source are kept. These entries describe the operator's own MCP servers / connectors, which are
// never part of the measurement. Applied before --redact-home and before the gate.
//
// Opt-in (--withhold <id>, ADR-0017 "Withholding a scenario", ADR-0014 disclosure policy): the
// named scenario is dropped from the published manifest.results, totals are recomputed from the
// rest, its evidence is not copied, and every render plus index.md comes from the reduced
// manifest; index.md lists the withheld ids. Applied first, before the MCP-name rewrite,
// --redact-home and the gate. An unknown id fails the publish.
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
  /** --withhold: scenario ids kept out of the published copy (ADR-0014). Each must be a
   *  manifest result id; duplicates count once. */
  withhold?: string[];
}

/** The fixed index.md text for a withheld scenario. */
export const WITHHELD_NOTE = 'withheld pending coordinated disclosure (ADR-0014)';

/** The literal that replaces the operator home directory under --redact-home. */
export const HOME_PLACEHOLDER = '<HOME>';

/** The literal that replaces the operator home directory's dash-encoded project slug (the home
 *  path with every separator replaced by `-`, as in `~/.claude/projects/-home-u-work`). */
export const HOME_SLUG_PLACEHOLDER = '<HOME-SLUG>';

export type LeakKind = 'url' | 'token' | 'home_path' | 'home_user';

export interface Leak {
  file: string; // bundle-relative path
  kind: LeakKind;
  /** Safe-to-print detail: the host for a URL, the pattern family for a token (never the
   *  value), the path prefix for a home path. */
  detail: string;
}

export type PublishPlan =
  | {
      ok: true;
      benchmarkRunId: string;
      files: BundleFile[];
      homeReplacements?: number;
      /** Set with homeReplacements: encoded home spellings rewritten (slug / percent). */
      homeEncodedReplacements?: HomeEncodedCounts;
      /** Operator MCP server entries renamed to <user-mcp-N> (always counted; 0 = none). */
      mcpNameReplacements: number;
      /** Scenario ids withheld via --withhold (in manifest order; empty = none). */
      withheld: string[];
    }
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

// --- operator MCP server names (pure) ---------------------------------------------------

/** `mcp_servers` sources the harness itself configures; every other source (user, local,
 *  claudeai, enterprise, managed, ..., or none reported) is the operator's environment. */
export const HARNESS_MCP_SOURCES: ReadonlySet<string> = new Set(['dynamic', 'project']);

/** The placeholder for the n-th (1-based) distinct operator MCP server name. */
export const userMcpPlaceholder = (n: number): string => `<user-mcp-${n}>`;

/** Rewrite, in place, the `name` of every non-harness entry of every `mcp_servers` array found
 *  anywhere in `value`. `names` maps an original name to its placeholder and is shared across
 *  all files of one publish, so the same server gets the same placeholder everywhere. An entry
 *  with no string `source` is treated as the operator's (fail closed). Returns the number of
 *  entries rewritten. */
export function pseudonymizeMcpServers(
  value: unknown,
  names: Map<string, string>,
  reserved: ReadonlySet<string> = new Set(),
): number {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  if (Array.isArray(value)) {
    for (const v of value) count += pseudonymizeMcpServers(v, names, reserved);
    return count;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'mcp_servers' && Array.isArray(v)) {
      for (const entry of v) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== 'string') continue;
        if (typeof e.source === 'string' && HARNESS_MCP_SOURCES.has(e.source)) continue;
        let placeholder = names.get(e.name);
        if (placeholder === undefined) {
          // Never reuse a name a kept (harness) entry carries, so a placeholder cannot be
          // mistaken for a fixture server.
          const used = new Set(names.values());
          let n = names.size + 1;
          while (used.has(userMcpPlaceholder(n)) || reserved.has(userMcpPlaceholder(n))) n++;
          placeholder = userMcpPlaceholder(n);
          names.set(e.name, placeholder);
        }
        e.name = placeholder;
        count++;
      }
    } else {
      count += pseudonymizeMcpServers(v, names, reserved);
    }
  }
  return count;
}

/** Add to `out` the name of every harness-configured entry (`source` in HARNESS_MCP_SOURCES)
 *  of every `mcp_servers` array found anywhere in `value`: the names the rewrite keeps. */
export function collectHarnessMcpNames(value: unknown, out: Set<string>): Set<string> {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) collectHarnessMcpNames(v, out);
    return out;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'mcp_servers' && Array.isArray(v)) {
      for (const entry of v) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name === 'string' && typeof e.source === 'string' && HARNESS_MCP_SOURCES.has(e.source)) out.add(e.name);
      }
    } else {
      collectHarnessMcpNames(v, out);
    }
  }
  return out;
}

/** Re-serialise a rewritten JSON file in the layout of its original text (indent detected from
 *  the second line; trailing newline kept), so only the rewritten values change. */
function reserialize(original: string, value: unknown): string {
  const m = /^[{[]\r?\n([ \t]+)/.exec(original);
  const indent = m ? m[1] : 0; // no line break after the opening bracket: compact
  const eol = /\r?\n$/.exec(original)?.[0] ?? '';
  return JSON.stringify(value, null, indent) + eol;
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
  // Percent-encoded home roots (any user): `%2Fhome%2F<u>`, `%2FUsers%2F<u>`.
  out.push(/(?<![A-Za-z0-9])%2F(?:home|Users)%2F[A-Za-z0-9._-]+/i);
  // The operator's own home in encoded spellings. Detection ends at any non-alphanumeric, which
  // is wider than redaction's terminator set, so whatever redaction leaves still fails.
  for (const src of homeSlugSources(homeDir)) out.push(new RegExp(`${src}${NOT_BEFORE_ALNUM}`));
  for (const v of homePercentVariants(homeDir)) out.push(new RegExp(`${percentRe(v)}${NOT_BEFORE_ALNUM}`));
  return out;
}

const NOT_AFTER_ALNUM = '(?<![A-Za-z0-9])';
const NOT_BEFORE_ALNUM = '(?![A-Za-z0-9])';

/** The dash-encoded project-slug spellings of `homeDir`, without the leading `-`: every `/` or
 *  `\` replaced by `-` (the stated rule), and every non-alphanumeric replaced by `-` (what the
 *  agent runtime does, e.g. `/home/a.b` -> `-home-a-b`). Root-ish homes yield nothing. */
function homeSlugCores(homeDir: string | undefined): string[] {
  const home = homeDir?.replace(/[\\/]+$/, '');
  if (!home || home.length <= 1) return [];
  const cores = new Set<string>();
  for (const slug of [home.replace(/[\\/]/g, '-'), home.replace(/[^A-Za-z0-9]/g, '-')]) {
    const core = slug.replace(/^-+/, '');
    if (/[A-Za-z0-9]/.test(core)) cores.add(core);
  }
  return [...cores].sort((a, b) => b.length - a.length); // longest first in the alternation
}

/** Regex sources (left boundary + slug, no right boundary) for the operator home's slugs. For a
 *  multi-segment home (`/home/u`) the leading `-` is optional. For a single-segment home
 *  (`/root`) the core is a bare word, so the leading `-` is required and must not follow another
 *  `-`: otherwise ordinary text (`running as root`, `--root`) would match. */
function homeSlugSources(homeDir: string | undefined): string[] {
  const home = homeDir?.replace(/[\\/]+$/, '') ?? '';
  const multi = home.split(/[\\/]+/).filter((s) => s.length > 0).length > 1;
  return homeSlugCores(homeDir).map((core) =>
    multi ? `${NOT_AFTER_ALNUM}-?${escapeRe(core)}` : `(?<![A-Za-z0-9-])-${escapeRe(core)}`,
  );
}

/** The percent-encoded spellings of `homeDir`: encodeURIComponent of its raw and forward-slash
 *  forms (`/home/u` -> `%2Fhome%2Fu`). */
function homePercentVariants(homeDir: string | undefined): string[] {
  const home = homeDir?.replace(/[\\/]+$/, '');
  if (!home || home.length <= 1) return [];
  const out = new Set<string>();
  for (const v of [home, home.replace(/\\/g, '/')]) {
    const enc = encodeURIComponent(v);
    if (enc !== v) out.add(enc);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Regex source for a percent-encoded string, matching each `%XX` escape in either hex case. */
function percentRe(enc: string): string {
  return enc
    .split(/(%[0-9A-F]{2})/)
    .map((part) =>
      /^%[0-9A-F]{2}$/.test(part)
        ? `%[${part[1]}${part[1].toLowerCase()}][${part[2]}${part[2].toLowerCase()}]`
        : escapeRe(part),
    )
    .join('');
}

/** The operator's bare username: the last path segment of `homeDir` (empty for a root-ish home
 *  or a segment with no alphanumeric). */
export function homeUsername(homeDir: string | undefined): string {
  const home = homeDir?.replace(/[\\/]+$/, '') ?? '';
  if (home.length <= 1) return '';
  const seg = home.split(/[\\/]/).pop() ?? '';
  return /[A-Za-z0-9]/.test(seg) ? seg : '';
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

export interface HomeEncodedCounts {
  slug: number;
  percent: number;
}

/** Replace the operator home directory's encoded spellings (ADR-0017 "Encoded home spellings"):
 *  the dash-encoded project slug (`-home-u`, leading `-` optional) with HOME_SLUG_PLACEHOLDER, and
 *  the percent-encoded path (`%2Fhome%2Fu`, either hex case) with HOME_PLACEHOLDER. A slug counts
 *  only when not preceded by an alphanumeric and followed by `-`, a separator, whitespace, a
 *  quote, `<>|` or the end; a percent spelling only when followed by `%`, a separator,
 *  whitespace, a quote, `<>|&?#` or the end. Anything else is left as is and fails the gate
 *  (fail closed). Pure. */
export function redactHomeEncoded(text: string, homeDir: string): { text: string; counts: HomeEncodedCounts } {
  const counts: HomeEncodedCounts = { slug: 0, percent: 0 };
  let out = text;
  const pct = homePercentVariants(homeDir);
  if (pct.length > 0) {
    const re = new RegExp(`(?:${pct.map(percentRe).join('|')})(?=%|[\\\\/\\s"'\`<>|&?#]|$)`, 'g');
    out = out.replace(re, () => {
      counts.percent++;
      return HOME_PLACEHOLDER;
    });
  }
  const slugs = homeSlugSources(homeDir);
  if (slugs.length > 0) {
    const re = new RegExp(`(?:${slugs.join('|')})(?=[-\\\\/\\s"'\`<>|]|$)`, 'g');
    out = out.replace(re, () => {
      counts.slug++;
      return HOME_SLUG_PLACEHOLDER;
    });
  }
  return { text: out, counts };
}

/** Final check under --redact-home: one leak per file in which the operator's bare username
 *  (homeUsername()) still appears as a token bounded by non-alphanumerics (or the text ends).
 *  The finding names the file, never the value. Pure. */
export function findUsernameTokens(files: BundleFile[], homeDir: string | undefined): Leak[] {
  const user = homeUsername(homeDir);
  if (!user) return [];
  const re = new RegExp(`${NOT_AFTER_ALNUM}${escapeRe(user)}${NOT_BEFORE_ALNUM}`);
  const leaks: Leak[] = [];
  for (const f of files) {
    if (scanViews(f.text).some((v) => re.test(v))) {
      leaks.push({ file: f.rel, kind: 'home_user', detail: 'operator username still present after --redact-home (value redacted)' });
    }
  }
  return leaks;
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
    // Home paths, plain or encoded: fail, never rewrite to `~`.
    home: for (const view of views) {
      for (const re of homeRes) {
        const m = re.exec(view);
        if (m) {
          const what = m[0].includes('%')
            ? 'percent-encoded home path'
            : /[\\/]/.test(m[0])
              ? 'absolute home path'
              : 'home directory slug';
          leaks.push({ file: f.rel, kind: 'home_path', detail: `${what} "${m[0]}"` });
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
  /** Set with homeReplacements: encoded home spellings replaced (slug -> <HOME-SLUG>,
   *  percent-encoded -> <HOME>). */
  homeEncodedReplacements?: HomeEncodedCounts;
  /** Operator MCP server entries renamed to <user-mcp-N>; the note is shown when > 0. */
  mcpNameReplacements?: number;
  /** Distinct operator MCP server names behind those replacements. */
  mcpDistinctNames?: number;
  /** Scenario ids withheld via --withhold; a `## Withheld` section is shown when non-empty. */
  withheld?: string[];
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
  const mcpNotes = (notes.mcpNameReplacements ?? 0) > 0;
  if (notes.homeReplacements !== undefined || mcpNotes) {
    out.push('## Redaction', '');
    if (notes.homeReplacements !== undefined) {
      out.push(`- redaction applied: home directory -> ${HOME_PLACEHOLDER} (${notes.homeReplacements} replacements)`);
      const enc = notes.homeEncodedReplacements ?? { slug: 0, percent: 0 };
      out.push(
        `- redaction applied: encoded home directory: project slug -> ${HOME_SLUG_PLACEHOLDER} ` +
          `(${enc.slug} replacements), percent-encoded -> ${HOME_PLACEHOLDER} (${enc.percent} replacements)`,
      );
    }
    if (mcpNotes) {
      out.push(
        `- redaction applied: operator MCP server names (mcp_servers entries whose source is not ` +
          `${[...HARNESS_MCP_SOURCES].join('/')}) -> <user-mcp-N> ` +
          `(${notes.mcpNameReplacements} replacements, ${notes.mcpDistinctNames ?? 0} distinct names)`,
      );
    }
    out.push('');
  }
  const withheld = notes.withheld ?? [];
  if (withheld.length > 0) {
    out.push('## Withheld', '');
    out.push(`${withheld.length} scenario(s) withheld from this bundle; the headline and tables cover the published scenarios only.`, '');
    for (const w of withheld) out.push(`- ${cell(w)}: ${WITHHELD_NOTE}`);
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

const VERDICTS: ReadonlySet<string> = new Set(['resisted', 'vulnerable', 'degraded', 'inconclusive']);

/** Manifest totals over `results`, by the runner's rule (writeManifest): one per verdict, spend
 *  summed and rounded to 6 decimals. Used when --withhold reduces the published results. */
export function recomputeTotals(results: RunManifest['results']): RunManifest['totals'] {
  const totals = { resisted: 0, vulnerable: 0, degraded: 0, inconclusive: 0, spend_usd: 0 };
  for (const r of results) {
    if (VERDICTS.has(r.verdict)) totals[r.verdict] += 1;
    totals.spend_usd = Math.round((totals.spend_usd + (typeof r.spend_usd === 'number' ? r.spend_usd : 0)) * 1e6) / 1e6;
  }
  return totals;
}

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

  // --withhold (ADR-0017 "Withholding a scenario"): applied first, so everything below sees
  // only the reduced manifest and the kept evidence. Withheld evidence is never parsed.
  const withholdSet = new Set(policy.withhold ?? []);
  const resultIds = new Set(manifest.results.map((r) => r.scenario_id));
  const unknown = [...withholdSet].filter((w) => !resultIds.has(w));
  if (unknown.length > 0) {
    return {
      ok: false,
      benchmarkRunId: id,
      error: `--withhold: unknown scenario id(s) ${unknown.map((u) => JSON.stringify(u)).join(', ')} (not in manifest results)`,
      leaks: [],
    };
  }
  const withheld = manifest.results.map((r) => r.scenario_id).filter((s) => withholdSet.has(s));
  if (withheld.length > 0) {
    manifest.results = manifest.results.filter((r) => !withholdSet.has(r.scenario_id));
    manifest.totals = recomputeTotals(manifest.results);
  }
  const keptEvidence = contents.evidence.filter((f) => !withholdSet.has(f.rel.split('/')[0]));

  // Operator MCP server names (unconditional): rewrite the parsed manifest and records, and
  // re-serialise only the files that changed, so every other file stays a byte copy. The
  // renders below are built from the rewritten objects. Manifest first, then evidence in
  // order, so placeholder numbering is deterministic. Everything is parsed first so the names
  // of kept (harness) entries anywhere in the run are reserved before any placeholder is
  // assigned.
  const parsed: { rel: string; text: string; rec: EvidenceRecord }[] = [];
  for (const f of keptEvidence) {
    try {
      parsed.push({ rel: f.rel, text: f.text, rec: JSON.parse(f.text) as EvidenceRecord });
    } catch (err) {
      return { ok: false, benchmarkRunId: id, error: `${f.rel} is not valid JSON: ${(err as Error).message}`, leaks: [] };
    }
  }
  const reserved = collectHarnessMcpNames(manifest, new Set());
  for (const p of parsed) collectHarnessMcpNames(p.rec, reserved);
  const mcpNames = new Map<string, string>();
  let mcpNameReplacements = pseudonymizeMcpServers(manifest, mcpNames, reserved);
  const manifestText =
    mcpNameReplacements > 0 || withheld.length > 0 ? reserialize(contents.manifestText, manifest) : contents.manifestText;

  const records = new Map<string, EvidenceRecord>();
  const evidenceFiles: BundleFile[] = [];
  for (const { rel, text, rec } of parsed) {
    const n = pseudonymizeMcpServers(rec, mcpNames, reserved);
    mcpNameReplacements += n;
    records.set(rel.replace(/\/evidence\.json$/, ''), rec);
    evidenceFiles.push({ rel, text: n > 0 ? reserialize(text, rec) : text });
  }
  const lookup = lookupFromRecords(manifest, records);
  const evidenceRels = keptEvidence.map((f) => f.rel);
  const mcpNotes: IndexNotes = { mcpNameReplacements, mcpDistinctNames: mcpNames.size, withheld };

  let files: BundleFile[] = [
    { rel: 'manifest.json', text: manifestText },
    ...evidenceFiles,
    { rel: 'report.md', text: report(manifest, { format: 'markdown', evidenceLookup: lookup }) },
    { rel: 'report.json', text: report(manifest, { format: 'json' }) },
    { rel: 'report.sarif', text: report(manifest, { format: 'sarif' }) },
  ];

  // --redact-home: rewrite the in-memory copies only (contents.* are fresh objects per file, the
  // run dir is never touched). index.md is rendered last so its note can carry the total count;
  // the note itself contains no home path, so redacting the noted index counts the same as the
  // un-noted one.
  let homeReplacements: number | undefined;
  let homeEncodedReplacements: HomeEncodedCounts | undefined;
  if (policy.redactHome) {
    const home = policy.homeDir;
    if (homeVariants(home).length === 0) {
      return { ok: false, benchmarkRunId: id, error: '--redact-home needs a usable home directory', leaks: [] };
    }
    // Plain spellings first, then the encoded ones (ADR-0017 "Encoded home spellings").
    const redactAll = (text: string): { text: string; count: number; enc: HomeEncodedCounts } => {
      const plain = redactHomeDir(text, home as string);
      const encoded = redactHomeEncoded(plain.text, home as string);
      return { text: encoded.text, count: plain.count, enc: encoded.counts };
    };
    let total = 0;
    const enc: HomeEncodedCounts = { slug: 0, percent: 0 };
    const add = (r: { count: number; enc: HomeEncodedCounts }): void => {
      total += r.count;
      enc.slug += r.enc.slug;
      enc.percent += r.enc.percent;
    };
    files = files.map((f) => {
      const r = redactAll(f.text);
      add(r);
      return { rel: f.rel, text: r.text };
    });
    add(redactAll(renderIndex(manifest, evidenceRels, mcpNotes)));
    homeReplacements = total;
    homeEncodedReplacements = enc;
    const index = redactAll(renderIndex(manifest, evidenceRels, { ...mcpNotes, homeReplacements, homeEncodedReplacements }));
    files.push({ rel: 'index.md', text: index.text });
  } else {
    files.push({ rel: 'index.md', text: renderIndex(manifest, evidenceRels, mcpNotes) });
  }

  const allowed = new Set<string>();
  for (const r of manifest.results) {
    if (typeof r.source === 'string' && /^https?:\/\//i.test(r.source)) allowed.add(extractHost(r.source));
  }
  for (const h of policy.allowHosts ?? []) allowed.add(extractHost(h));

  // The gate always runs, and after redaction: a foreign home path, a token or a URL still fails.
  // Under --redact-home, a final check: the operator's bare username must not survive anywhere.
  const leaks = scanForLeaks(files, allowed, policy.homeDir);
  if (policy.redactHome) leaks.push(...findUsernameTokens(files, policy.homeDir));
  if (leaks.length > 0) return { ok: false, benchmarkRunId: id, leaks };
  return homeReplacements === undefined
    ? { ok: true, benchmarkRunId: id, files, mcpNameReplacements, withheld }
    : { ok: true, benchmarkRunId: id, files, homeReplacements, homeEncodedReplacements, mcpNameReplacements, withheld };
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
