// Publish a completed benchmark run as a shareable bundle (ADR-0017; evidence-spec §5, §6).
//
// A published bundle holds ONLY: the run manifest, every per-repetition evidence.json (layout
// preserved, <scenario>/<rep>/evidence.json), the three renders from report() (report.md,
// report.json, report.sarif) and an index.md. Raw transcripts (claude-stream.jsonl, hook logs,
// detector logs) are never copied: §5 stores them verbatim for local audit, which is exactly
// why they must not leave the machine.
//
// Redaction gate (§5): before ANY file is written, every byte that would be published is
// scanned. A non-loopback URL (http(s), ws(s), ssh, git) that is not exactly a scenario source
// URL of the published corpus (or on an explicit --allow-host host), a scheme-less public host,
// an email address, a git remote, a credential shape (the fixture inertness patterns,
// src/fixtures/fixture.ts: prefixed keys, Bearer, JWT, PEM private key), the operator's username,
// or an absolute path under a home directory fails the publish, and nothing is written
// (ADR-0017 block-4 amendment "Gate patterns", "Allow-URL"). The gate itself never rewrites (no
// `~` substitution): the maintainer must see and fix the leak.
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
// Unconditional (ADR-0017 "Harness canary tokens"): the random per-run token/marker/command/
// package values the detectors mint (src/detectors/*.ts: detector_hits[].matched.token / .marker
// / .command / .package) are not findings. Each distinct value is replaced everywhere in the
// bundle by a stable <canary-token-N> (one N per distinct value within the run), including where a
// token is embedded in a URL, an argv entry or a request path. Values no detector hit recorded
// are harvested too: any `aab-canary-<hex>` substring, and the token/marker/command/package values
// of the kept scenarios' <kind>.canary.json detector metadata (read, never published; a malformed
// one fails closed). Integrity digests (scenario_version,
// task_sha256, settings_digest, input_digest, corpus_digest) live at other keys and are kept, as
// are scenario source URLs and ids. Applied with the MCP-name rewrite, before --redact-home and
// the gate.
//
// Opt-in (--withhold <id>, ADR-0017 "Withholding a scenario", ADR-0014 disclosure policy): the
// named scenario is dropped from the published manifest.results, totals are recomputed from the
// rest, its evidence is not copied, and every render plus index.md comes from the reduced
// manifest; index.md lists the withheld ids. Applied first, before the MCP-name rewrite,
// --redact-home and the gate. An unknown id fails the publish.
//
// Opt-in (--exclude <id>, ADR-0017 "Excluding a scenario", ADR-0014 amendment): same file and
// totals handling as --withhold, for an operator-declared non-measurement (e.g. a fixture defect
// fixed after the run). index.md carries EXCLUDED_NOTE instead of WITHHELD_NOTE, and the
// published manifest records the ids in a top-level `excluded` array. An id may not be both
// withheld and excluded; an unknown id fails the publish.
//
// Block B12 (ADR-0017 amendment 2026-11-05, evidence-spec s5): two more unconditional gate kinds.
// `env_value` compares the bundle against the values of the variables forwarded to the agent
// (the non-basic `observation.env_forwarded` names looked up in the publishing shell, plus the
// `env` blocks of the harness settings files in the run dir) in their raw, JSON-escaped,
// percent-encoded and base64/base64url spellings, and names only the variable. `credential`
// recognises a credential by its context (assignment, JSON member, --password-family flag,
// MySQL-family glued -p / sshpass -p, URL userinfo password, 40+ character hex/base64 blob in a
// URL query/path or in detector_hits[].matched.requested/argv/args). The address rules cover
// private IPv6, `user@<ipv4>:` remotes and single-label `host:port`. A run dir without evidence
// files is refused unless --allow-no-evidence; fewer files than planned repetitions is a warning.
//
// Structure: planPublish() / scanForLeaks() / renderIndex() are pure (data in, data out);
// readRunDir() (lstat, never follows a symlink) and writeBundle() (atomic: <out>.partial, then
// rename) are the only I/O; cmdPublish() in src/cli.ts glues them.

import { SERVED_MODEL_WARNING_PREFIX } from '../adapters/adapter.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EvidenceRecord, RunManifest } from '../runner/types.js';
import { extractHost, findSecretShapes } from '../fixtures/fixture.js';
import { ENV_VALUE_EXEMPT, isBasicEnvName } from '../adapters/childEnv.js';
import type { Scenario } from '../scenario/types.js';
import { corpusDigest } from '../scenario/digest.js';
import { report, buildScore, type EvidenceLookup } from './index.js';
import type { SurfaceLookup } from './guidance.js';
import { REPOSITORY_URL } from './sarif.js';
import { REPORT_REPOSITORY_URLS } from './guidance.js';
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
  /** Detector metadata files (rel = <scenario>/<rep>/<kind>.canary.json). Never published: read
   *  only so every per-run canary value the detectors minted is known to the redaction, including
   *  values that appear in a transcript although no detector hit recorded them (ADR-0017 "Harness
   *  canary tokens"). Optional: absent = harvest from the bundle alone. */
  canaryMeta?: BundleFile[];
  /** The `env` values of the harness settings files of the kept repetitions
   *  (`<scenario>/<rep>/claude-settings.json`, ADR-0017 block B12 "Operator values"). Never
   *  published: read only so a value the operator handed the agent through its settings is
   *  known to the `env_value` check. `rel` names the file so a withheld/excluded scenario's
   *  values are dropped with it. Optional: absent = the publishing shell is the only source. */
  settingsEnv?: SettingsEnvEntry[];
}

/** One operator-declared environment value harvested from a harness settings file. */
export interface SettingsEnvEntry {
  rel: string; // <scenario>/<rep>/<file>
  name: string;
  value: string;
}

export interface PublishPolicy {
  /** Extra hosts the maintainer deliberately allows (--allow-host): any URL, scheme-less
   *  host reference or email address on such a host passes the gate. */
  allowHosts?: string[];
  /** The scenario corpus the run used (or a superset of it). Its source.* URLs, for the
   *  published scenarios of the run's corpus, are the only non-loopback URLs the gate passes
   *  without --allow-host (ADR-0017 "Allow-URL"); with --withhold/--exclude it is also what the
   *  published corpus_digest is recomputed from, after it is verified against the run's
   *  original digest (ADR-0017 "Corpus block of a reduced bundle"). */
  corpus?: Scenario[];
  /** The publishing user's home directory; any absolute path under it fails the gate. */
  homeDir?: string;
  /** --redact-home: replace every occurrence of `homeDir` in the published copies with
   *  HOME_PLACEHOLDER before the gate runs. Requires `homeDir`. */
  redactHome?: boolean;
  /** --withhold: scenario ids kept out of the published copy (ADR-0014). Each must be a
   *  manifest result id; duplicates count once. */
  withhold?: string[];
  /** --exclude: scenario ids left out because their result is not a measurement (operator
   *  declaration, never a disclosure hold). Same rules as `withhold`; an id in both fails. */
  exclude?: string[];
  /** ADR-0021: scenario id -> attack surface for report.md's plain-language layers. */
  surfaceOf?: SurfaceLookup;
  /** The publishing process environment (a copy of process.env, or a test's map), ADR-0017
   *  block B12 "Operator values": the value of every non-basic, non-exempt name in the union of
   *  `observation.env_forwarded` is looked for in the bundle (`env_value`). Absent = the
   *  settings files are the only source. */
  operatorEnv?: Readonly<Record<string, string | undefined>>;
  /** --allow-no-evidence: publish a run dir that holds no evidence file (report-only copy, e.g.
   *  the shipped demo). Without it such a run is refused (block B12 "Evidence count"). */
  allowNoEvidence?: boolean;
  /** How the run dir is named in messages (the path the operator typed). */
  runDir?: string;
}

/** The fixed index.md text for a withheld scenario. */
export const WITHHELD_NOTE = 'withheld pending coordinated disclosure (ADR-0014)';

/** The fixed index.md text for an excluded scenario (--exclude). */
export const EXCLUDED_NOTE = 'excluded by the operator: result is not a measurement (see the bundle notes)';

/** The literal that replaces the operator home directory under --redact-home. */
export const HOME_PLACEHOLDER = '<HOME>';

/** The literal that replaces the operator home directory's dash-encoded project slug (the home
 *  path with every separator replaced by `-`, as in `~/.claude/projects/-home-u-work`). */
export const HOME_SLUG_PLACEHOLDER = '<HOME-SLUG>';

/** Gate finding kinds (ADR-0017 "Gate patterns", evidence-spec s5). */
export type LeakKind =
  | 'url' // http(s):// URL that is not loopback, intrinsic, a source URL or an allowed host
  | 'ws_url' // ws(s):// URL, same rule minus the source-URL exception
  | 'ssh_url' // ssh:// / git:// / git+ssh:// URL
  | 'git_ssh' // scp-style git remote: user@host:path
  | 'host' // scheme-less host:port or host/path with a public TLD
  | 'email' // an email address
  | 'token' // prefixed API key / access token (sk-, ghp_, AKIA, xox*, AIza, glpat-, ...)
  | 'bearer' // Bearer credential
  | 'jwt' // JSON Web Token
  | 'private_key' // PEM private-key header
  | 'credential' // a credential recognised by context (assignment, flag, URL userinfo, encoded blob)
  | 'env_value' // the value of a variable forwarded to the agent (named, never shown)
  | 'home_path'
  | 'home_user';

export interface Leak {
  file: string; // bundle-relative path
  kind: LeakKind;
  /** Safe-to-print detail: the host for a URL / host / email / git remote, the pattern family
   *  for a token (never the value), the path prefix for a home path. */
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
      /** Harness canary token values replaced by <canary-token-N> (always counted; 0 = none). */
      canaryTokenReplacements: number;
      /** Scenario ids withheld via --withhold (in manifest order; empty = none). */
      withheld: string[];
      /** Scenario ids excluded via --exclude (in manifest order; empty = none). */
      excluded: string[];
      /** Non-fatal notes for stderr (block B12: fewer evidence files than planned repetitions). */
      warnings: string[];
      /** Evidence files in the bundle versus planned repetitions of the published results. */
      evidenceFound: number;
      evidenceExpected: number;
    }
  | { ok: false; benchmarkRunId?: string; error?: string; next?: string; leaks: Leak[] };

/** URLs the tool itself emits (SARIF $schema and driver.informationUri, and the repository file
 *  URLs a Markdown report cites, ADR-0021 amendment). They are exact strings, not hosts, so
 *  allowing them does not open the whole host. */
export const SARIF_SCHEMA_URL = 'https://json.schemastore.org/sarif-2.1.0.json';
const INTRINSIC_URLS = new Set([SARIF_SCHEMA_URL, REPOSITORY_URL, ...REPORT_REPOSITORY_URLS]);

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

/** Highest N assigned per names map (kept beside the caller's map so the signature is unchanged). */
const placeholderN = new WeakMap<Map<string, string>, number>();
function lastPlaceholderN(names: Map<string, string>): number {
  const known = placeholderN.get(names);
  if (known !== undefined) return known;
  // A map filled elsewhere: derive once from its values.
  let max = 0;
  for (const v of names.values()) {
    const m = /^<user-mcp-(\d+)>$/.exec(v);
    if (m) max = Math.max(max, Number(m[1]));
  }
  placeholderN.set(names, max);
  return max;
}

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
          // mistaken for a fixture server. Placeholders are assigned with increasing N, so the
          // next candidate starts after the highest N handed out so far (O(1) per name; no Set
          // of the used values is rebuilt per name).
          let n = Math.max(names.size, lastPlaceholderN(names)) + 1;
          while (reserved.has(userMcpPlaceholder(n))) n++;
          placeholder = userMcpPlaceholder(n);
          names.set(e.name, placeholder);
          placeholderN.set(names, n);
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

// --- harness canary tokens (pure) -------------------------------------------------------

/** JSON keys whose string value, when it has a canary-token shape, is a per-run harness secret a
 *  detector minted (src/detectors/*.ts): `token` (canary_egress_http / canary_mcp_tool), `marker`
 *  (canary_file_read), `command` (canary_command, `aab-canary-<hex>`) and `package`
 *  (canary_egress_http registry mode, `aab-canary-<hex>`). Digest keys (scenario_version,
 *  task_sha256, settings_digest, input_digest, corpus_digest) are deliberately absent: those are
 *  integrity hashes that must survive. */
export const CANARY_TOKEN_KEYS: ReadonlySet<string> = new Set(['token', 'marker', 'command', 'package']);

/** The shape of a minted canary value: the `aab-canary-<hex>` family (command base and registry
 *  package name) or a bare hex run of 16+ (randomBytes(8|16).toString('hex') = 16 or 32 hex). The
 *  shape guard means a real agent value sharing one of these keys (e.g. a tool call's
 *  `input.command` of `ls`, which is not canary-shaped) is never harvested. The whole string must
 *  match, so a command line that merely contains the token is not itself taken (the token inside
 *  it is still replaced, as a substring, by replaceCanaryTokens). */
const CANARY_TOKEN_SHAPE = /^(?:aab-[a-z]+-[0-9a-f]{8,}|[0-9a-f]{16,})$/;

/** The `aab-<word>-<hex>` family as a substring (ADR-0017 "Harness canary tokens"): every value
 *  the harness mints carries the `aab-` prefix, a lowercase word naming its minter and a hex run
 *  (`aab-canary-<hex>` detector commands/packages, `aab-skill-<hex>` skill-package markers,
 *  `aab-web-<hex>` web-server markers, and any later `aab-<word>-<hex>`). The prefix is
 *  harness-only, so any occurrence anywhere (a tool-call command, a URL path) is a minted value
 *  even without a detector hit. The word is letters only, so a benchmark run id
 *  (`aab-<digits>-<hex>`) never matches. */
const CANARY_PREFIXED_RE = /aab-[a-z]+-[0-9a-f]{8,}/g;

/** Add every `aab-<word>-<hex>` substring of `text` to `tokens` (first-seen order). Pure. */
export function collectPrefixedCanaryTokens(text: string, tokens: Map<string, string>): Map<string, string> {
  for (const m of text.matchAll(CANARY_PREFIXED_RE)) {
    if (!tokens.has(m[0])) tokens.set(m[0], canaryTokenPlaceholder(tokens.size + 1));
  }
  return tokens;
}

/** The placeholder for the n-th (1-based) distinct canary token value within a run. */
export const canaryTokenPlaceholder = (n: number): string => `<canary-token-${n}>`;

/** Walk `value`, adding to `tokens` (original value -> placeholder) every canary-shaped string
 *  found at a CANARY_TOKEN_KEYS key. First-seen order fixes the numbering; `tokens` is shared
 *  across the manifest and every evidence record, so one value gets one placeholder everywhere.
 *  Pure (reads only). */
export function collectCanaryTokens(value: unknown, tokens: Map<string, string>): Map<string, string> {
  if (!value || typeof value !== 'object') return tokens;
  if (Array.isArray(value)) {
    for (const v of value) collectCanaryTokens(v, tokens);
    return tokens;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && CANARY_TOKEN_KEYS.has(key) && CANARY_TOKEN_SHAPE.test(v)) {
      if (!tokens.has(v)) tokens.set(v, canaryTokenPlaceholder(tokens.size + 1));
    } else {
      collectCanaryTokens(v, tokens);
    }
  }
  return tokens;
}

/** Replace every occurrence of each harvested canary token value in `text` with its placeholder.
 *  Longest value first, so one value can never clip another, and a placeholder (which carries no
 *  hex run and no `aab-canary-` prefix) is never itself a replacement target. Returns the new text
 *  and the number of replacements. Pure. */
export function replaceCanaryTokens(
  text: string,
  tokens: Map<string, string>,
  used?: Set<string>,
): { text: string; count: number } {
  if (tokens.size === 0) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const value of [...tokens.keys()].sort((a, b) => b.length - a.length)) {
    const placeholder = tokens.get(value) as string;
    out = out.replace(new RegExp(escapeRe(value), 'g'), () => {
      count++;
      used?.add(value);
      return placeholder;
    });
  }
  return { text: out, count };
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

// Any scheme-qualified URL: a scheme of two or more characters (so a Windows drive `C:\\` is
// not one) and two or more `/` or `\` (so `https:\\host` and `https:///host` count too). http(s),
// ws(s), ssh/git/sftp have their own kinds; every other scheme (ftp, smb, postgres, redis, ...)
// is a `url` finding. No left boundary: `xhttps://host` is still a URL finding (fail closed).
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]+:[\\/]{2,}[^\s"'<>`|\\]+/gi;
/** The scheme separator of a URL_RE match, normalised to `://` before host extraction. */
const URL_SEP_RE = /^([A-Za-z][A-Za-z0-9+.-]+):[\\/]+/;
const TRAILING_PUNCT = /[.,;:!?)\]}*_]+$/;

/** Public top-level domains a scheme-less host reference must end in to be a finding (ADR-0017
 *  "Gate patterns"). Curated, not the full IANA list: TLDs that collide with common file
 *  extensions or words (md, sh, py, rs, pl, ts, app, so, zip, mov, in, me, run) are left out so
 *  `README.md/`, `run.sh:12` or `Cursor.app/Contents` are not findings. */
export const GATE_PUBLIC_TLDS: readonly string[] = [
  'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'cloud', 'xyz', 'info', 'biz', 'gov', 'edu', 'mil',
  'us', 'uk', 'de', 'ru', 'fr', 'jp', 'cn', 'eu', 'ca', 'au', 'nl', 'ch', 'se', 'es', 'it', 'br',
  'kr', 'tech', 'site', 'online', 'security', 'blog', 'page', 'link', 'tv', 'gg', 'ly',
];
const TLD_ALT = GATE_PUBLIC_TLDS.join('|');
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';

/** Scheme-less host followed by `:<port>` or `/<path>`, not preceded by a URL/path/email
 *  character (so a host inside a scheme URL, a file path or an address is not double-counted). */
const BARE_HOST_RE = new RegExp(
  `(?<![A-Za-z0-9._%+@/:\\\\-])((?:${LABEL}\\.)+(?:${TLD_ALT}))(?![A-Za-z0-9-])(?=:\\d{1,5}(?!\\d)|/[A-Za-z0-9._~%-])`,
  'gi',
);
/** Internal / reserved / special-use TLDs (RFC 2606, RFC 6761, RFC 6762, ICANN `.internal`,
 *  common private zones). A host ending in one of these is an internal name: a finding with or
 *  without a port or path (ADR-0017 "Gate patterns"). `.localhost` is loopback, not listed;
 *  `home` and `private` are left out because `user.home` / `this.private` are code, not hosts. */
export const GATE_INTERNAL_TLDS: readonly string[] = [
  'internal', 'local', 'localdomain', 'lan', 'corp', 'intranet', 'intra', 'home.arpa', 'example',
  'test', 'invalid',
];
/** A dotted host ending in an internal TLD, not part of a longer dotted name (so
 *  `settings.local.json` or `publish.test.ts` are file names, not hosts). */
const INTERNAL_HOST_RE = new RegExp(
  `(?<![A-Za-z0-9._%+@/:\\-])((?:${LABEL}\\.)+(?:${GATE_INTERNAL_TLDS.map((t) => t.replace('.', '\\.')).join('|')}))(?![A-Za-z0-9-])(?!\\.[A-Za-z0-9])`,
  'gi',
);
/** A scheme-less IPv4 literal with a port (`10.0.0.5:22`); loopback and 0.0.0.0 are filtered.
 *  Block B12: `@` and `:` are not in the lookbehind (scheme URLs are blanked from the view before
 *  this runs, so they only hid `deploy@10.0.0.5:/srv` and `::ffff:10.0.0.7`). */
const IPV4_PORT_RE = /(?<![A-Za-z0-9._%+/\\-])((?:\d{1,3}\.){3}\d{1,3}):\d{1,5}(?!\d)/g;
/** A scheme-less RFC 1918 / CGNAT / link-local IPv4 literal, with or without a port (ADR-0017
 *  "Gate patterns" block 4 amendment): an internal address is a finding on its own. Not part of
 *  a longer dotted number (`1.10.0.0.5`, `10.0.0.5.1`). */
const IPV4_PRIVATE_RE =
  /(?<![A-Za-z0-9._%+/\\-])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![0-9]|\.[0-9])/g;
/** A protocol-relative reference `//host.tld` (public or internal TLD) not preceded by a scheme,
 *  path or word character. */
const PROTO_REL_HOST_RE = new RegExp(
  `(?<![A-Za-z0-9._%+@:\\\\/-])//((?:${LABEL}\\.)+(?:${[...GATE_PUBLIC_TLDS, ...GATE_INTERNAL_TLDS].map((t) => t.replace('.', '\\.')).join('|')}))(?![A-Za-z0-9-])`,
  'gi',
);
/** scp-style git remote `user@host:path` (git@github.com:org/repo.git). */
const GIT_SSH_RE = new RegExp(`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._-]+@((?:${LABEL}\\.)+[A-Za-z]{2,}):(?=[A-Za-z0-9~._/-])`, 'g');
/** scp-style remote on an IPv4 literal, `user@<ipv4>:path` (`deploy@10.0.0.5:/srv`,
 *  `backup@10.20.30.40:/mnt`), block B12: GIT_SSH_RE needs an alphabetic TLD. Loopback and
 *  `--allow-host` hosts are skipped by the caller. */
const GIT_SSH_IPV4_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._-]+@((?:\d{1,3}\.){3}\d{1,3}):(?=[A-Za-z0-9~._/-])/g;
/** A bare IPv6 unique-local (`fc00::/7`) or link-local (`fe80::/10`) literal, with or without
 *  brackets and a port, block B12: `fd12:3456::1`, `fe80::1`, `[fd12::1]:22`. Global IPv6
 *  literals stay out (same budget as public IPv4); `::1` is loopback. Not part of a longer
 *  hex/dotted token. */
const IPV6_PRIVATE_RE = /(?<![A-Za-z0-9:.-])\[?((?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?::[0-9a-f]{0,4}){2,7})\]?(?::\d{1,5})?(?![A-Za-z0-9.-])/gi;
/** A single-label host with a port (`gitlab:8443`, `redis:6379`, `db:5432`), block B12, decided
 *  against the FP budget (zero matches over the committed bundles, demo, recordings, corpus and
 *  guides): a label of 2-63 characters starting with a letter, `:`, 2-5 digits; preceded by the
 *  start, whitespace, a quote, a backtick, `=`, `(` or `[`; followed by whitespace, a quote, a
 *  backtick, `/`, `)`, `,`, `;`, `]` or the end. So `at 12:30`, `C:123`, `retry:3`, `sha256:ab`,
 *  `"port":8080` and `file.ts:12` are not matches. `localhost` and `--allow-host` labels are
 *  skipped by the caller. */
const SINGLE_LABEL_PORT_RE = /(?<![^\s"'`=(\[])([A-Za-z][A-Za-z0-9-]{1,62}):(\d{2,5})(?=[\s"'`/),;\]]|$)/g;
/** An email address: local part, `@`, a dotted domain ending in an alphabetic TLD. A git remote
 *  (`@host:path`) is reported by GIT_SSH_RE instead. */
const EMAIL_RE = new RegExp(
  `(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:${LABEL}\\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])(?!:[A-Za-z0-9~._/-])`,
  'g',
);

// --- credential shapes (block B12; gate-only, separate from the fixture inertness list) ---------

/** A value that is a placeholder, not a credential (ADR-0017 block B12 "Credential shapes"):
 *  starts with `$`, `<`, `*`, `{`, `%`, `xxx`, `...` or one of the words REDACTED, CHANGEME,
 *  EXAMPLE, PLACEHOLDER (any case). */
export function isPlaceholderValue(value: string): boolean {
  return /^(?:[$<*{%]|xxx|\.\.\.|redacted|changeme|example|placeholder)/i.test(value);
}

/** The credential-bearing name family of the assignment and JSON-member shapes. */
const CRED_NAME = '(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)';

/** One context shape: the regex (global), which capture group holds the value (placeholder
 *  check) and how the finding is worded from the match (never the value). */
interface CredentialShape {
  name: string;
  re: RegExp;
  value: number;
  detail: (m: RegExpMatchArray) => string;
}

/** The credential shapes the gate recognises by context rather than by token prefix (ADR-0017
 *  block B12 "Credential shapes"; evidence-spec s5). Kept apart from the fixture inertness
 *  `SECRET_PATTERNS` (src/fixtures/fixture.ts): these are assignment/flag/URL contexts, and lure
 *  prose such as `TOKEN=` followed by a canary must stay acceptable in a fixture (the canary
 *  rewrite turns such a value into `<canary-token-N>` before the gate anyway). Scanned per line
 *  and over the joined view; the detail names the shape, never the value. The values exclude
 *  whitespace, quotes and backslashes (a JSON escape ends a value). */
export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
  {
    // 1. NAME=value: an upper-case name of the family, bounded by non-word characters, `=`, and
    //    an 8+ character value (optionally quoted). `export`/`set`/`env` prefixes need nothing.
    name: 'assignment',
    re: new RegExp(`(?<![A-Za-z0-9_])([A-Z0-9_]*${CRED_NAME}[A-Z0-9_]*)=["']?([^\\s"'\\\\]{8,})`, 'g'),
    value: 2,
    detail: (m) => `credential assignment ${m[1]}=... (value redacted)`,
  },
  {
    // 2. "NAME": "value", the same family case-insensitively, so a settings `env` block or a
    //    .env file the agent printed is caught in its JSON spelling (raw or escaped quotes).
    name: 'json_member',
    re: new RegExp(`\\\\?"([A-Za-z0-9_-]*${CRED_NAME}[A-Za-z0-9_-]*)\\\\?"\\s*:\\s*\\\\?"([^\\s"\\\\]{8,})\\\\?"`, 'gi'),
    value: 2,
    detail: (m) => `credential JSON member "${m[1]}" (value redacted)`,
  },
  {
    // 3. --password-family flag followed by `=` or whitespace and a 4+ character value; not
    //    preceded by a word character or `-` (`canary-token rewrite` is prose). A value that
    //    starts with `-` is the next flag, not a value.
    name: 'flag',
    re: /(?<![A-Za-z0-9_-])(--(?:password|passwd|secret|token|api-?key|access-?key))(?:=|\s+)["']?(?!-)([^\s"'\\]{4,})/gi,
    value: 2,
    detail: (m) => `credential flag ${m[1].toLowerCase()} (value redacted)`,
  },
  {
    // 4a. MySQL-family glued -p<value> on the same command segment (no `|`, `;`, `&` or line
    //     break between the command word and the flag). A bare `-p ` (`claude -p <task>`,
    //     `mkdir -p`) is not a match.
    name: 'mysql_p',
    re: /\b(mysql|mysqladmin|mysqldump|mysqlsh|mariadb|mariadb-dump)\b[^\n|;&]*?\s-p([^\s"'\\]{2,})/g,
    value: 2,
    detail: (m) => `credential glued -p<value> after ${m[1]} (value redacted)`,
  },
  {
    // 4b. sshpass -p <value> (glued or spaced).
    name: 'sshpass_p',
    re: /\bsshpass\b[^\n|;&]*?\s-p\s*["']?([^\s"'\\]{2,})/g,
    value: 1,
    detail: () => 'credential sshpass -p (value redacted)',
  },
  {
    // 5. scheme://user:password@host with a non-empty password, on every host (loopback and
    //    allowed hosts included: the host rules skip loopback, this one does not).
    name: 'url_userinfo',
    re: /[A-Za-z][A-Za-z0-9+.-]+:\/\/([^\s/:@"'<>`\\]*):([^\s/@"'<>`\\]+)@(\[[^\]\s]+\]|[^\s/:?#"'<>`\\]+)/g,
    value: 2,
    detail: (m) => `credential in URL userinfo on host "${m[3].toLowerCase()}"`,
  },
];

/** A 40+ character hex run, or a 40+ character base64/base64url run (optional `=` padding) that
 *  carries an upper-case letter, a lower-case letter and a digit and no `--` (Markdown anchors
 *  and slugs do not qualify). Block B12 "Encoded blob". */
export function hasEncodedBlob(text: string): boolean {
  if (/[0-9a-f]{40,}/i.test(text)) return true;
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{40,}=*/g)) {
    const run = m[0];
    if (run.includes('--')) continue;
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}

/** Whether a URL (comparison form) carries an encoded blob in its query string or in a path
 *  segment (the fragment is not looked at). */
function urlHasEncodedBlob(url: string): boolean {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^#]*)/.exec(url);
  if (!m) return false;
  const q = m[1].indexOf('?');
  const pathPart = q === -1 ? m[1] : m[1].slice(0, q);
  const query = q === -1 ? '' : m[1].slice(q + 1);
  if (pathPart.split('/').some((seg) => hasEncodedBlob(seg))) return true;
  return query.length > 0 && hasEncodedBlob(query);
}

/** A scheme-less query string: `?` followed by query characters up to whitespace, a quote,
 *  `<>`, a backtick or a backslash (a JSON escape ends it). */
const SCHEMELESS_QUERY_RE = /\?([^\s"'<>`\\?#]+)/g;

/** Detector-owned `matched` keys read structurally from each evidence record for the encoded
 *  blob rule (b): `requested` (canary_egress_http), `argv` (canary_command), `args`
 *  (canary_mcp_tool). Digest keys live elsewhere and are never reached. */
const BLOB_MATCHED_KEYS: readonly string[] = ['requested', 'argv', 'args'];

/** Every string found (recursively) under `value`. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) stringsOf(v, out);
  return out;
}

/** The `matched.<key>` names of an evidence record's detector hits whose strings carry an
 *  encoded blob (rule b), in first-seen order. `text` must be an evidence record; anything that
 *  is not valid JSON yields nothing (the gate's text rules still apply to it). */
export function blobMatchedKeys(text: string): string[] {
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return [];
  }
  const hits = (rec as { detector_hits?: unknown })?.detector_hits;
  if (!Array.isArray(hits)) return [];
  const out: string[] = [];
  for (const h of hits) {
    const matched = (h as { matched?: unknown })?.matched;
    if (!matched || typeof matched !== 'object') continue;
    for (const key of BLOB_MATCHED_KEYS) {
      if (out.includes(key)) continue;
      if (stringsOf((matched as Record<string, unknown>)[key]).some(hasEncodedBlob)) out.push(key);
    }
  }
  return out;
}

// --- operator values (block B12, pure) ------------------------------------------------------

/** The shortest operator value the `env_value` check looks for (ADR-0017 block B12): shorter
 *  values collide with ordinary words. */
export const ENV_VALUE_MIN_LEN = 8;

/** The spellings an operator value can take in published text: raw, JSON-escaped, percent-encoded
 *  (encodeURIComponent), base64 and base64url, each with and without padding. Distinct values
 *  only. */
export function envValueSpellings(value: string): string[] {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const b64url = Buffer.from(value, 'utf8').toString('base64url');
  return [
    ...new Set([
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      b64,
      b64.replace(/=+$/, ''),
      b64url,
      `${b64url}${'='.repeat((4 - (b64url.length % 4)) % 4)}`,
    ]),
  ];
}

/** One `env_value` leak per file and name whose value (any spelling, any scan view) is a
 *  substring of the file. Values shorter than ENV_VALUE_MIN_LEN and values in `skip` (the
 *  published model and agent version) are not looked for. The finding names the variable, never
 *  the value. Pure. */
export function findOperatorValues(
  files: BundleFile[],
  values: ReadonlyArray<{ name: string; value: string }>,
  skip: ReadonlySet<string> = new Set(),
): Leak[] {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const candidates = values.filter((v) => v.value.length >= ENV_VALUE_MIN_LEN && !skip.has(v.value));
  if (candidates.length === 0) return leaks;
  for (const f of files) {
    const views = scanViews(f.text);
    for (const { name, value } of candidates) {
      const key = `${f.rel}\u0000${name}`;
      if (seen.has(key)) continue;
      const spellings = envValueSpellings(value);
      if (views.some((v) => spellings.some((sp) => v.includes(sp)))) {
        seen.add(key);
        leaks.push({ file: f.rel, kind: 'env_value', detail: `value of environment variable ${name} present (value redacted)` });
      }
    }
  }
  return leaks;
}

/** What the gate lets through besides loopback and the tool's intrinsic URLs. */
export interface GateAllow {
  /** Exact http(s) URLs (compared without the fragment): the run's scenario source URLs. */
  urls?: ReadonlySet<string>;
  /** Hosts the operator allowed explicitly (--allow-host): any URL, host, email or remote on
   *  such a host passes. */
  hosts?: ReadonlySet<string>;
}

/** A URL in its gate comparison form: fragment dropped, scheme and host lowercased. */
export function normalizeGateUrl(url: string): string {
  const noFrag = url.split('#')[0];
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/.exec(noFrag);
  return m ? m[1].toLowerCase() + m[2].toLowerCase() + m[3] : noFrag;
}

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

/** The shortest operator username the gate checks without --redact-home (ADR-0017 "Operator
 *  username"): shorter names (`u`, `op`, `dev`) collide with ordinary words too often. Under
 *  --redact-home the check runs for any length, as before. */
export const USERNAME_MIN_LEN = 4;

/** One leak per file in which the operator's bare username (homeUsername()) still appears as a
 *  token bounded by non-alphanumerics (or the text ends). Runs on every publish when the
 *  username is at least `minLen` characters (0 = any length, used under --redact-home). The
 *  finding names the file, never the value. Pure. */
export function findUsernameTokens(files: BundleFile[], homeDir: string | undefined, minLen = 0): Leak[] {
  const user = homeUsername(homeDir);
  if (!user || user.length < minLen) return [];
  const re = new RegExp(`${NOT_AFTER_ALNUM}${escapeRe(user)}${NOT_BEFORE_ALNUM}`);
  const leaks: Leak[] = [];
  for (const f of files) {
    if (scanViews(f.text).some((v) => re.test(v))) {
      leaks.push({ file: f.rel, kind: 'home_user', detail: 'operator username present (value redacted)' });
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
  // A further view with the remaining JSON escapes decoded (`\/` -> `/`, `\u0040` -> `@`), so an
  // escaped spelling of a URL, address or path is seen in its plain form.
  const decoded = unescaped.replace(/\\\\|\\\/|\\u([0-9A-Fa-f]{4})/g, (m, hex: string | undefined) =>
    m === '\\\\' ? m : m === '\\/' ? '/' : String.fromCharCode(parseInt(hex as string, 16)),
  );
  return [...new Set([text, unescaped, decoded])];
}

/** Percent-decoded copies of the scan views (once and twice, so `%252F` is seen as `/`), for the
 *  home-path patterns only: `C%3A%5CUsers%5Cu` or a double-encoded `/home/u` still fails.
 *  Malformed escapes are left as is. */
function percentDecodedViews(views: string[]): string[] {
  const dec = (t: string): string => t.replace(/%[0-9A-Fa-f]{2}/g, (e) => String.fromCharCode(parseInt(e.slice(1), 16)));
  const out = new Set<string>();
  for (const v of views) {
    if (!v.includes('%')) continue;
    const once = dec(v);
    if (once !== v) out.add(once);
    const twice = dec(once);
    if (twice !== once) out.add(twice);
  }
  return [...out];
}

/** Scan bundle files for s5 leaks. Pure; returns every leak found (empty = clean). `allow` is a
 *  GateAllow, or (back-compat) a plain Set of explicitly allowed hosts. */
export function scanForLeaks(files: BundleFile[], allow: ReadonlySet<string> | GateAllow, homeDir?: string): Leak[] {
  const gate: GateAllow = allow instanceof Set ? { hosts: allow } : (allow as GateAllow);
  const allowedHosts = gate.hosts ?? new Set<string>();
  const allowedUrls = new Set([...(gate.urls ?? [])].map(normalizeGateUrl));
  const hostOk = (host: string): boolean => isLoopbackHost(host) || allowedHosts.has(host);
  const leaks: Leak[] = [];
  const homeRes = homePathPatterns(homeDir);
  for (const f of files) {
    const views = scanViews(f.text);
    // One finding per (kind, host) per file; the detail names the host, never a path or value.
    const seen = new Set<string>();
    const report = (kind: LeakKind, host: string, detail: string): void => {
      const key = `${kind}\u0000${host}`;
      if (seen.has(key)) return;
      seen.add(key);
      leaks.push({ file: f.rel, kind, detail });
    };
    for (const view of views) {
      // Scheme URLs: loopback, an intrinsic tool URL, an exact scenario source URL (http(s)
      // only), or an explicitly allowed host.
      for (const m of view.matchAll(URL_RE)) {
        let raw = m[0].replace(TRAILING_PUNCT, '');
        // A known scheme glued to a preceding word (`xhttps://`, `\nhttps://` read raw) is judged
        // as that scheme, exactly as before the generic-scheme widening.
        const known = /(?:git\+ssh|https?|wss?|ssh|sftp|scp|git)$/i.exec(raw.slice(0, raw.indexOf(':')));
        if (known) raw = raw.slice(known.index);
        const url = raw.replace(URL_SEP_RE, '$1://');
        if (INTRINSIC_URLS.has(url)) continue;
        const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
        // `file:///abs/path` has no host: the home-path patterns below judge the path.
        if (scheme === 'file' && /^file:[\\/]{3}/i.test(raw)) continue;
        const host = extractHost(url);
        // Block B12 "Encoded blob" (a): a 40+ character blob in the query or a path segment of
        // any URL, loopback included, except the exact source URLs and the intrinsic URLs.
        if (!allowedUrls.has(normalizeGateUrl(url)) && urlHasEncodedBlob(url)) {
          report('credential', 'blob:url', 'encoded blob in URL query or path');
        }
        if (hostOk(host)) continue;
        if (scheme === 'http' || scheme === 'https') {
          if (allowedUrls.has(normalizeGateUrl(url))) continue;
          report('url', host, `non-allowlisted host "${host}" (not a scenario source URL)`);
        } else if (scheme === 'ws' || scheme === 'wss') {
          report('ws_url', host, `${scheme}:// URL on non-allowlisted host "${host}"`);
        } else if (scheme === 'ssh' || scheme === 'git' || scheme === 'git+ssh' || scheme === 'sftp' || scheme === 'scp') {
          report('ssh_url', host, `${scheme}:// URL on non-allowlisted host "${host}"`);
        } else {
          report('url', host, `${scheme}:// URL on non-allowlisted host "${host}"`);
        }
      }
      // A view without the scheme URLs, so their hosts and userinfo are not seen again below.
      const rest = view.replace(URL_RE, ' ');
      // Block B12 "Encoded blob" (a), scheme-less spelling: a `?query` string outside any scheme
      // URL (`/c/tok?k=<blob>` in a tool-call input) carrying a blob.
      for (const m of rest.matchAll(SCHEMELESS_QUERY_RE)) {
        if (hasEncodedBlob(m[1])) report('credential', 'blob:query', 'encoded blob in URL query or path');
      }
      for (const m of rest.matchAll(GIT_SSH_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('git_ssh', host, `scp-style git remote on host "${host}"`);
      }
      for (const m of rest.matchAll(EMAIL_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('email', host, `email address at "${host}" (value redacted)`);
      }
      for (const m of rest.matchAll(BARE_HOST_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('host', host, `scheme-less host reference "${host}"`);
      }
      for (const m of rest.matchAll(INTERNAL_HOST_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('host', host, `internal host name "${host}"`);
      }
      for (const m of rest.matchAll(PROTO_REL_HOST_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('host', host, `protocol-relative host reference "${host}"`);
      }
      for (const m of rest.matchAll(IPV4_PRIVATE_RE)) {
        const host = m[1];
        if (!hostOk(host)) report('host', host, `private IP address "${host}"`);
      }
      for (const m of rest.matchAll(IPV4_PORT_RE)) {
        const host = m[1];
        if (!hostOk(host) && host !== '0.0.0.0') report('host', host, `scheme-less IP address with port "${host}"`);
      }
      // Block B12 "Address gaps".
      for (const m of rest.matchAll(GIT_SSH_IPV4_RE)) {
        const host = m[1];
        if (!hostOk(host)) report('git_ssh', host, `scp-style remote on host "${host}"`);
      }
      for (const m of rest.matchAll(IPV6_PRIVATE_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('host', host, `private IPv6 address "${host}"`);
      }
      for (const m of rest.matchAll(SINGLE_LABEL_PORT_RE)) {
        const host = m[1].toLowerCase();
        if (!hostOk(host)) report('host', host, `single-label host with port "${host}"`);
      }
    }
    // Credential shapes: one list, owned by the fixture inertness contract. Scan per line so a
    // file naming several families reports each; the value is never echoed.
    const families = new Map<string, LeakKind>();
    for (const view of views) {
      for (const line of view.split(/\r?\n/)) {
        for (const { name, kind } of findSecretShapes(line)) families.set(name, kind);
      }
      // A credential split across lines (raw or JSON-escaped line breaks, plus the indentation
      // that follows): the joined text is scanned too.
      const joined = view.replace(/(?:\\r|\\n|\r|\n)+[ \t]*/g, '');
      if (joined !== view) {
        for (const { name, kind } of findSecretShapes(joined)) families.set(name, kind);
      }
    }
    for (const [name, kind] of families) {
      leaks.push({ file: f.rel, kind, detail: `${name} (value redacted)` });
    }
    // Credential shapes by context (block B12): per line and over the joined view, like the
    // token families; placeholders are not findings; the detail never carries the value.
    const shapes = new Set<string>();
    const scanShapes = (text: string): void => {
      for (const shape of CREDENTIAL_SHAPES) {
        for (const m of text.matchAll(shape.re)) {
          if (!isPlaceholderValue(m[shape.value])) shapes.add(shape.detail(m));
        }
      }
    };
    for (const view of views) {
      for (const line of view.split(/\r?\n/)) scanShapes(line);
      const joined = view.replace(/(?:\\r|\\n|\r|\n)+[ \t]*/g, '');
      if (joined !== view) scanShapes(joined);
    }
    for (const detail of shapes) leaks.push({ file: f.rel, kind: 'credential', detail });
    // Encoded blob (b): read structurally from the detector-owned fields of an evidence record.
    if (/(?:^|\/)evidence\.json$/.test(f.rel)) {
      for (const key of blobMatchedKeys(f.text)) {
        leaks.push({ file: f.rel, kind: 'credential', detail: `encoded blob in detector field matched.${key}` });
      }
    }
    // Home paths, plain or encoded: fail, never rewrite to `~`.
    home: for (const view of [...views, ...percentDecodedViews(views)]) {
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
  /** Harness canary token values replaced by <canary-token-N>; the note is shown when > 0. */
  canaryTokenReplacements?: number;
  /** Distinct canary token values behind those replacements. */
  canaryDistinctTokens?: number;
  /** Scenario ids withheld via --withhold; a `## Withheld` section is shown when non-empty. */
  withheld?: string[];
  /** Scenario ids excluded via --exclude; an `## Excluded` section is shown when non-empty. */
  excluded?: string[];
  /** Set under --allow-no-evidence when the bundle holds no evidence file: the planned
   *  repetitions of the published results. An `## Evidence` section says so (block B12). */
  noEvidenceExpected?: number;
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
  out.push(`# LureKit run ${cell(manifest.benchmark_run_id)}`, '');
  out.push(
    `**Vulnerable to ${h.vulnerable} of ${h.of} scenarios** ` +
      `(degraded: ${h.degraded}, inconclusive: ${h.inconclusive}).`,
    '',
  );
  out.push('## Run', '');
  out.push(`- tool: LureKit ${cell(manifest.tool_version)}`);
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
  if (notes.noEvidenceExpected !== undefined) {
    out.push('## Evidence', '');
    out.push(
      `no evidence files published (--allow-no-evidence): 0 of ${notes.noEvidenceExpected} planned ` +
        'repetition(s); the evidence lines in report.md cite files that are not in this bundle',
      '',
    );
  }
  const mcpNotes = (notes.mcpNameReplacements ?? 0) > 0;
  const canaryNotes = (notes.canaryTokenReplacements ?? 0) > 0;
  if (notes.homeReplacements !== undefined || mcpNotes || canaryNotes) {
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
    if (canaryNotes) {
      out.push(
        `- redaction applied: harness canary tokens (per-run detector token/marker/command/package ` +
          `values) -> <canary-token-N> ` +
          `(${notes.canaryTokenReplacements} replacements, ${notes.canaryDistinctTokens ?? 0} distinct tokens)`,
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
  const excluded = notes.excluded ?? [];
  if (excluded.length > 0) {
    out.push('## Excluded', '');
    out.push(`${excluded.length} scenario(s) excluded from this bundle; the headline and tables cover the published scenarios only.`, '');
    for (const x of excluded) out.push(`- ${cell(x)}: ${EXCLUDED_NOTE}`);
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
 *  summed and rounded to 6 decimals. Used when --withhold/--exclude reduce the published results. */
export function recomputeTotals(results: RunManifest['results']): RunManifest['totals'] {
  const totals = { resisted: 0, vulnerable: 0, degraded: 0, inconclusive: 0, spend_usd: 0 };
  for (const r of results) {
    if (VERDICTS.has(r.verdict)) totals[r.verdict] += 1;
    totals.spend_usd = Math.round((totals.spend_usd + (typeof r.spend_usd === 'number' ? r.spend_usd : 0)) * 1e6) / 1e6;
  }
  return totals;
}

/** Every http(s) URL under a scenario's `source` block (primary_url, secondary_urls, and any
 *  other URL-valued field the block carries). */
export function scenarioSourceUrls(scenario: Pick<Scenario, 'source'>): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(scenario.source);
  return out;
}

/** The gate allow-list for a (published) manifest (ADR-0017 "Allow-URL"): the exact source URLs
 *  of the manifest's published results and of every scenario of `corpus` whose id is in the
 *  manifest's corpus.scenario_ids, plus the hosts named by --allow-host. A source URL opens only
 *  itself, never its host: another URL on github.com fails unless the operator allows the host. */
export function gateAllowFor(
  manifest: Pick<RunManifest, 'results' | 'corpus'>,
  corpus: Scenario[] | undefined,
  allowHosts: string[] | undefined,
): GateAllow {
  const urls = new Set<string>();
  for (const r of manifest.results) {
    if (typeof r.source === 'string' && /^https?:\/\//i.test(r.source)) urls.add(normalizeGateUrl(r.source));
  }
  const ids = new Set(Array.isArray(manifest.corpus?.scenario_ids) ? manifest.corpus.scenario_ids : []);
  for (const sc of corpus ?? []) {
    if (!ids.has(sc.id)) continue;
    for (const u of scenarioSourceUrls(sc)) urls.add(normalizeGateUrl(u));
  }
  const hosts = new Set<string>();
  for (const h of allowHosts ?? []) hosts.add(extractHost(h));
  return { urls, hosts };
}

/** The corpus block of a reduced bundle (ADR-0017 "Corpus block of a reduced bundle",
 *  evidence-spec s2.3): `scenario_ids` without the withheld/excluded ids, `scenario_count` to
 *  match, `corpus_digest` recomputed over the published scenarios with the runner's algorithm,
 *  and the run's original digest kept as `corpus_digest_full`. The recomputation needs the
 *  scenario files: `corpus` must reproduce the original digest over the original ids first, so
 *  the published digest is exactly the one a run over the reduced corpus would record. Fails
 *  closed (error) when it cannot. Unchanged when no dropped id is in the corpus. Pure. */
export function reduceCorpusBlock(
  block: RunManifest['corpus'],
  drop: ReadonlySet<string>,
  corpus: Scenario[] | undefined,
): { corpus: RunManifest['corpus'] } | { error: string } {
  const ids = block.scenario_ids;
  const kept = ids.filter((x) => !drop.has(x));
  if (kept.length === ids.length) return { corpus: block };
  const byId = new Map((corpus ?? []).map((sc) => [sc.id, sc]));
  const missing = ids.filter((x) => !byId.has(x));
  const next =
    'pass --scenarios <the scenario directory the run used> so the published corpus_digest can be recomputed';
  if (missing.length > 0) {
    return {
      error: `cannot recompute corpus_digest over the published scenarios: ${missing.length} corpus scenario(s) not found in the scenario corpus (first: ${missing[0]}); ${next}`,
    };
  }
  if (corpusDigest(ids.map((x) => byId.get(x) as Scenario)) !== block.corpus_digest) {
    return {
      error: `cannot recompute corpus_digest over the published scenarios: the scenario corpus does not reproduce the run's corpus_digest (the scenario files changed since the run); ${next}`,
    };
  }
  return {
    corpus: {
      scenario_count: kept.length,
      scenario_ids: kept,
      corpus_digest: corpusDigest(kept.map((x) => byId.get(x) as Scenario)),
      corpus_digest_full: block.corpus_digest,
    },
  };
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
  if (manifest.partial) {
    // ADR-0024 B13a: a provisional manifest of a run that did not finish is never a bundle.
    return {
      ok: false,
      benchmarkRunId: id,
      error: `run ${id} is partial (${manifest.partial.completed_scenarios} of ${manifest.partial.planned_scenarios} scenarios completed); a bundle must hold a finished measurement`,
      leaks: [],
    };
  }
  for (const r of manifest.results) {
    if (typeof r.scenario_id !== 'string' || !SAFE_SEGMENT.test(r.scenario_id)) {
      return { ok: false, benchmarkRunId: id, error: `unsafe scenario id in manifest: ${JSON.stringify(r.scenario_id)}`, leaks: [] };
    }
  }

  // --withhold / --exclude (ADR-0017 "Withholding a scenario", "Excluding a scenario"): applied
  // first, so everything below sees only the reduced manifest and the kept evidence. Dropped
  // evidence is never parsed. Both lists share one file/totals path; only the notes differ.
  const withholdSet = new Set(policy.withhold ?? []);
  const excludeSet = new Set(policy.exclude ?? []);
  const resultIds = new Set(manifest.results.map((r) => r.scenario_id));
  for (const [flag, set] of [['--withhold', withholdSet], ['--exclude', excludeSet]] as const) {
    const unknown = [...set].filter((w) => !resultIds.has(w));
    if (unknown.length > 0) {
      return {
        ok: false,
        benchmarkRunId: id,
        error: `${flag}: unknown scenario id(s) ${unknown.map((u) => JSON.stringify(u)).join(', ')} (not in manifest results)`,
        leaks: [],
      };
    }
  }
  const both = [...excludeSet].filter((x) => withholdSet.has(x));
  if (both.length > 0) {
    return {
      ok: false,
      benchmarkRunId: id,
      error: `scenario id(s) ${both.map((u) => JSON.stringify(u)).join(', ')} given to both --withhold and --exclude (pick one)`,
      leaks: [],
    };
  }
  const dropSet = new Set([...withholdSet, ...excludeSet]);
  const withheld = manifest.results.map((r) => r.scenario_id).filter((s) => withholdSet.has(s));
  const excluded = manifest.results.map((r) => r.scenario_id).filter((s) => excludeSet.has(s));
  if (withheld.length > 0 || excluded.length > 0) {
    manifest.results = manifest.results.filter((r) => !dropSet.has(r.scenario_id));
    manifest.totals = recomputeTotals(manifest.results);
  }
  if (excluded.length > 0) manifest.excluded = excluded;
  if (dropSet.size > 0 && manifest.corpus && Array.isArray(manifest.corpus.scenario_ids)) {
    const reduced = reduceCorpusBlock(manifest.corpus, dropSet, policy.corpus);
    if ('error' in reduced) return { ok: false, benchmarkRunId: id, error: reduced.error, leaks: [] };
    manifest.corpus = reduced.corpus;
  }
  const keptEvidence = contents.evidence.filter((f) => !dropSet.has(f.rel.split('/')[0]));

  // Evidence count (ADR-0017 block B12 "Evidence count"): the kept evidence files against the
  // planned repetitions of the published results. None at all is refused unless the operator
  // asked for a report-only copy (--allow-no-evidence); fewer than planned is a warning.
  const evidenceExpected = manifest.results.reduce((n, r) => n + (typeof r.runs === 'number' && r.runs > 0 ? r.runs : 0), 0);
  const evidenceFound = keptEvidence.length;
  const warnings: string[] = [];
  const runLabel = policy.runDir ?? '<runDir>';
  if (evidenceFound === 0 && !policy.allowNoEvidence) {
    return {
      ok: false,
      benchmarkRunId: id,
      error: `no evidence files under ${runLabel} (0 of ${evidenceExpected} planned repetitions); a bundle without evidence cannot be audited`,
      next: `lurekit publish ${runLabel} --allow-no-evidence   (report-only copy, e.g. the shipped demo)`,
      leaks: [],
    };
  }
  if (evidenceFound > 0 && evidenceFound < evidenceExpected) {
    warnings.push(
      `publish: ${evidenceFound} evidence file(s) for ${evidenceExpected} planned repetition(s); report.md cites evidence files that are not in the bundle`,
    );
  }

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
    mcpNameReplacements > 0 || withheld.length > 0 || excluded.length > 0 ? reserialize(contents.manifestText, manifest) : contents.manifestText;

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

  let files: BundleFile[] = [
    { rel: 'manifest.json', text: manifestText },
    ...evidenceFiles,
    { rel: 'report.md', text: report(manifest, { format: 'markdown', evidenceLookup: lookup, surfaceOf: policy.surfaceOf }) },
    { rel: 'report.json', text: report(manifest, { format: 'json' }) },
    { rel: 'report.sarif', text: report(manifest, { format: 'sarif' }) },
  ];

  // Harness canary tokens (unconditional, ADR-0017 "Harness canary tokens"): harvest every
  // distinct per-run token/marker/command/package value the detectors minted from the parsed
  // objects (manifest first, then evidence in bundle order, so the numbering is deterministic),
  // then replace each value everywhere in the bundle with <canary-token-N> — including where a
  // token is embedded in a URL, an argv entry or a request path. Done here with the MCP-name
  // rewrite, before --redact-home and the gate. index.md (built below) is passed through the same
  // replacement so a token can never ride along there either. Source run dir is never touched.
  // Values a detector minted but no hit recorded (the agent only named the canary in a tool
  // call) are covered twice: by the `aab-canary-<hex>` substring shape, and by the kept
  // scenarios' detector metadata files (read here, never published). A malformed metadata file
  // fails closed, since its values could otherwise ship unredacted.
  const canaryTokens = new Map<string, string>();
  collectCanaryTokens(manifest, canaryTokens);
  collectPrefixedCanaryTokens(manifestText, canaryTokens);
  for (const p of parsed) {
    collectCanaryTokens(p.rec, canaryTokens);
    collectPrefixedCanaryTokens(p.text, canaryTokens);
  }
  for (const f of contents.canaryMeta ?? []) {
    if (dropSet.has(f.rel.split('/')[0])) continue;
    try {
      collectCanaryTokens(JSON.parse(f.text), canaryTokens);
    } catch (err) {
      return { ok: false, benchmarkRunId: id, error: `${f.rel} is not valid JSON: ${(err as Error).message}`, leaks: [] };
    }
  }
  let canaryTokenReplacements = 0;
  const canaryUsed = new Set<string>();
  if (canaryTokens.size > 0) {
    files = files.map((f) => {
      const r = replaceCanaryTokens(f.text, canaryTokens, canaryUsed);
      canaryTokenReplacements += r.count;
      return { rel: f.rel, text: r.text };
    });
  }
  const redactCanary = (text: string): string =>
    canaryTokens.size > 0 ? replaceCanaryTokens(text, canaryTokens).text : text;
  const mcpNotes: IndexNotes = {
    mcpNameReplacements,
    mcpDistinctNames: mcpNames.size,
    withheld,
    excluded,
    canaryTokenReplacements,
    canaryDistinctTokens: canaryUsed.size,
    ...(evidenceFound === 0 ? { noEvidenceExpected: evidenceExpected } : {}),
  };

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
    const index = redactAll(redactCanary(renderIndex(manifest, evidenceRels, { ...mcpNotes, homeReplacements, homeEncodedReplacements })));
    files.push({ rel: 'index.md', text: index.text });
  } else {
    files.push({ rel: 'index.md', text: redactCanary(renderIndex(manifest, evidenceRels, mcpNotes)) });
  }

  // The gate always runs, and after redaction: a foreign home path, a token or a URL still fails.
  // The operator's bare username must not survive anywhere: checked on every publish when it is
  // at least USERNAME_MIN_LEN characters, and for any length under --redact-home.
  const leaks = scanForLeaks(files, gateAllowFor(manifest, policy.corpus, policy.allowHosts), policy.homeDir);
  leaks.push(...findUsernameTokens(files, policy.homeDir, policy.redactHome ? 0 : USERNAME_MIN_LEN));
  // Operator values (ADR-0017 block B12 "Operator values"): the publishing shell's value of every
  // non-basic, non-exempt name the published records forwarded to the agent, plus every `env`
  // value of the kept repetitions' harness settings files. The published model and agent version
  // are facts by design; shorter values than ENV_VALUE_MIN_LEN are skipped inside the check.
  const forwarded = new Set<string>();
  for (const p of parsed) {
    for (const n of p.rec.observation?.env_forwarded ?? []) if (typeof n === 'string') forwarded.add(n);
  }
  const exempt = new Set(ENV_VALUE_EXEMPT.map((n) => n.toUpperCase()));
  const operatorValues: { name: string; value: string }[] = [];
  const seenValue = new Set<string>();
  const addValue = (name: string, value: string): void => {
    const key = `${name}\u0000${value}`;
    if (seenValue.has(key)) return;
    seenValue.add(key);
    operatorValues.push({ name, value });
  };
  for (const name of [...forwarded].sort()) {
    if (isBasicEnvName(name) || exempt.has(name.toUpperCase())) continue;
    const value = policy.operatorEnv?.[name];
    if (typeof value === 'string') addValue(name, value);
  }
  for (const e of contents.settingsEnv ?? []) {
    if (dropSet.has(e.rel.split('/')[0])) continue;
    if (typeof e.name === 'string' && typeof e.value === 'string') addValue(e.name, e.value);
  }
  const publishedFacts = new Set(
    [manifest.profile?.model, manifest.profile?.agent_version].filter((v): v is string => typeof v === 'string'),
  );
  leaks.push(...findOperatorValues(files, operatorValues, publishedFacts));
  if (leaks.length > 0) return { ok: false, benchmarkRunId: id, leaks };
  const counts = { warnings, evidenceFound, evidenceExpected };
  return homeReplacements === undefined
    ? { ok: true, benchmarkRunId: id, files, mcpNameReplacements, canaryTokenReplacements, withheld, excluded, ...counts }
    : { ok: true, benchmarkRunId: id, files, homeReplacements, homeEncodedReplacements, mcpNameReplacements, canaryTokenReplacements, withheld, excluded, ...counts };
}

/** Human-readable failure text for a rejected plan. */
export function formatPlanFailure(plan: Extract<PublishPlan, { ok: false }>): string {
  if (plan.error) return `publish: ${plan.error}; nothing written\n${plan.next ? `next: ${plan.next}\n` : ''}`;
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

/** lstat-based kind of a path: 'missing', 'symlink', 'dir', 'file' or 'other'. Never follows a
 *  link. */
function entryKind(p: string): 'missing' | 'symlink' | 'dir' | 'file' | 'other' {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

/** The harness settings files whose top-level `env` object the operator-value check reads
 *  (ADR-0017 block B12 "Operator values"): the Claude Code adapter's per-repetition settings
 *  (src/adapters/claudeCode.ts HOOK_SETTINGS_FILE). Never published. */
export const SETTINGS_ENV_FILES: readonly string[] = ['claude-settings.json'];

/** Read manifest.json and every <scenario>/<rep>/evidence.json for the manifest's scenarios.
 *  Nothing else under the run dir is read (raw transcripts stay local), except the detector
 *  canary metadata and the harness settings files' `env` blocks (both never published; the
 *  settings files of the scenarios in `opts.skipScenarios`, the --withhold/--exclude ids, are
 *  not read, and one that is not valid JSON throws so the publish fails closed). Symlinks are
 *  never followed (ADR-0017 "Run-dir reading"): a symlinked scenario dir, repetition dir,
 *  evidence, canary metadata or settings file is skipped and named in `warnings`, so a link
 *  planted in the run dir cannot pull an outside file into the bundle. A symlinked
 *  manifest.json is an error. */
export function readRunDir(runDir: string, opts: { skipScenarios?: Iterable<string> } = {}): RunDirContents & { warnings: string[] } {
  const warnings: string[] = [];
  const skipScenarios = new Set(opts.skipScenarios ?? []);
  const settingsEnv: SettingsEnvEntry[] = [];
  const mpath = path.join(runDir, 'manifest.json');
  if (entryKind(mpath) === 'symlink') {
    throw new Error(`publish: ${mpath} is a symlink; refusing to follow it`);
  }
  const manifestText = readFileSync(mpath, 'utf8');
  const evidence: BundleFile[] = [];
  const canaryMeta: BundleFile[] = [];
  let ids: string[] = [];
  try {
    const m = JSON.parse(manifestText) as RunManifest;
    ids = Array.isArray(m.results) ? m.results.map((r) => r.scenario_id) : [];
  } catch {
    return { manifestText, evidence, warnings }; // planPublish reports the parse error
  }
  const skip = (rel: string): void => {
    warnings.push(`publish: skipped symlink ${rel} (symlinks in a run dir are never followed)`);
  };
  for (const id of ids) {
    if (typeof id !== 'string' || !SAFE_SEGMENT.test(id)) continue; // planPublish rejects it
    const sdir = path.join(runDir, id);
    const skind = entryKind(sdir);
    if (skind === 'symlink') skip(id);
    if (skind !== 'dir') continue;
    const reps: number[] = [];
    for (const d of readdirSync(sdir, { withFileTypes: true })) {
      if (!/^\d+$/.test(d.name)) continue;
      if (d.isSymbolicLink()) skip(`${id}/${d.name}`);
      else if (d.isDirectory()) reps.push(Number(d.name));
    }
    reps.sort((a, b) => a - b);
    for (const rep of reps) {
      const rdir = path.join(sdir, String(rep));
      const p = path.join(rdir, 'evidence.json');
      const ekind = entryKind(p);
      if (ekind === 'symlink') skip(`${id}/${rep}/evidence.json`);
      else if (ekind === 'file') {
        const text = readFileSync(p, 'utf8');
        // ADR-0028 D2: a run answered by another model than the one named is not a result for it.
        if (text.includes(`"${SERVED_MODEL_WARNING_PREFIX}`)) {
          throw new Error(`publish: ${id}/${rep}/evidence.json records a served model that differs from the requested one (ADR-0028 D2); a substituted model is not publishable`);
        }
        evidence.push({ rel: `${id}/${rep}/evidence.json`, text });
      }
      for (const d of readdirSync(rdir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!d.name.endsWith('.canary.json')) continue;
        if (d.isSymbolicLink()) skip(`${id}/${rep}/${d.name}`);
        else if (d.isFile()) canaryMeta.push({ rel: `${id}/${rep}/${d.name}`, text: readFileSync(path.join(rdir, d.name), 'utf8') });
      }
      if (skipScenarios.has(id)) continue;
      for (const name of SETTINGS_ENV_FILES) {
        const rel = `${id}/${rep}/${name}`;
        const kind = entryKind(path.join(rdir, name));
        if (kind === 'symlink') skip(rel);
        if (kind !== 'file') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(path.join(rdir, name), 'utf8'));
        } catch (err) {
          throw new Error(`publish: ${rel} is not valid JSON: ${(err as Error).message}`);
        }
        const env = (parsed as { env?: unknown } | null)?.env;
        if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
        for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
          if (typeof v === 'string') settingsEnv.push({ rel, name: k, value: v });
        }
      }
    }
  }
  return { manifestText, evidence, canaryMeta, settingsEnv, warnings };
}

/** ADR-0022 amendment: publish's default output directory, inside the run directory it
 *  publishes (<results>/<benchmark_run_id>/bundle for a run under --results) instead of
 *  reports/<id> in the cwd. Keyed on the run directory, not --results, so publishing a run
 *  that lives elsewhere never creates a results tree in the cwd. */
export function defaultBundleDir(runDir: string): string {
  return path.join(runDir, 'bundle');
}

/** Write a gated bundle atomically (ADR-0017 "Atomic bundle"): every file goes to the sibling
 *  `<outDir>.partial` first, which is then renamed to `outDir`. On any failure the partial dir is
 *  removed, so a failed publish never leaves a half-written bundle behind. Refuses a non-empty
 *  out dir so stale, unscanned files cannot ride along, and a pre-existing `<outDir>.partial`
 *  (never deleted: it is not ours). An existing empty out dir is replaced. */
export function writeBundle(outDir: string, files: BundleFile[]): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`publish: output directory ${outDir} is not empty`);
  }
  const partial = `${outDir.replace(/[\\/]+$/, '')}.partial`;
  if (existsSync(partial)) {
    throw new Error(`publish: staging directory ${partial} already exists (remove it after checking it is not needed)`);
  }
  mkdirSync(path.dirname(partial), { recursive: true });
  mkdirSync(partial);
  try {
    for (const f of files) {
      const dest = path.join(partial, ...f.rel.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, f.text, 'utf8');
    }
    if (existsSync(outDir)) rmdirSync(outDir); // empty (checked above); rmdir never removes content
    renameSync(partial, outDir);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
}
