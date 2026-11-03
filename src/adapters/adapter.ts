// Agent adapter interface. One implementation per agent (brief §3.1).
// The adapter launches the agent headless under a given SetupProfile, injects the
// task, and returns the observable record. It never approves trust prompts and never
// relaxes the profile; the profile IS the variable under test.

import { createHash } from 'node:crypto';

import type { AgentId } from '../scenario/types.js';
import { findSecretShape } from '../fixtures/fixture.js';

export interface SetupProfile {
  agent: AgentId;
  agent_version: string;      // pinned, e.g. "@anthropic-ai/claude-code@2.1.309"
  model: string;              // pinned full model id
  // The provisioned (possibly poisoned) working directory. Optional on the CALLER's profile:
  // the runner gives every repetition its own fresh dir under the run dir (ADR-0002,
  // evidence-spec §2.1) and an explicit value is only the BASE for those per-run dirs. The
  // profile handed to fixtures/adapters always carries the per-run path.
  workdir?: string;
  env?: Record<string, string>;
  // Config under test, copied verbatim into the workdir / home by the runner:
  settings?: unknown;         // settings file(s)
  hooks?: unknown;            // hooks config
  mcp?: unknown;              // MCP server config
  skills?: string[];          // skill directories
  permission_mode?: string;   // agent-specific; recorded, never overridden to be looser
  // Benchmark isolation from the operator's own MCP servers (evidence-spec §4.3). The Claude Code
  // adapter passes `--strict-mcp-config` on EVERY run (with `--mcp-config <runDir>/mcp.json` when
  // `mcp` is set), so only the run's own servers load. `false` is an operator opt-out; a fixture
  // cannot set it (mergeProfilePatch). The only other way to drop strict is a declared run
  // requirement (RunRequirements.project_mcp_autoload). Resolved by strictMcpConfigFor().
  strict_mcp_config?: boolean;
  // Hardening knob (evidence-spec §4.3): which Claude Code setting sources load. When set, the
  // Claude Code adapter passes `--setting-sources <csv>` ("Comma-separated list of setting
  // sources to load (user, project, local)", `claude --help` 2.1.316, NOTES); when absent no flag
  // is passed and the agent's own default applies. Values: SETTING_SOURCES only, non-empty, no
  // duplicates (validateSettingSources). Never set by default; only the operator narrows it.
  setting_sources?: string[];
}

/** The setting sources `claude --help` (2.1.316) lists for `--setting-sources` (NOTES). */
export const SETTING_SOURCES: readonly string[] = ['user', 'project', 'local'];

/** Validate a `setting_sources` list (evidence-spec §4.3): a non-empty array of distinct values
 *  from SETTING_SOURCES. Throws on anything else, so an invalid value is rejected before any
 *  agent process is spawned. Returns the list unchanged. */
export function validateSettingSources(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`setting_sources must be a non-empty list of: ${SETTING_SOURCES.join(', ')}`);
  }
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string' || !SETTING_SOURCES.includes(v)) {
      throw new Error(`setting_sources: unknown source ${JSON.stringify(v)} (allowed: ${SETTING_SOURCES.join(', ')})`);
    }
    if (seen.has(v)) throw new Error(`setting_sources: duplicate source "${v}"`);
    seen.add(v);
  }
  return value as string[];
}

/** Parse a `--setting-sources` CSV (e.g. "user,project") into a validated list. Whitespace
 *  around entries is trimmed; empty entries are rejected. */
export function parseSettingSourcesCsv(csv: string | undefined): string[] {
  if (csv === undefined || csv.trim() === '') {
    throw new Error(`--setting-sources expects a comma-separated list of: ${SETTING_SOURCES.join(', ')}`);
  }
  return validateSettingSources(csv.split(',').map((s) => s.trim()));
}

/** The per-run workdir an adapter runs in. Throws when the profile carries none: an adapter
 *  never invents a working directory (and never falls back to os.tmpdir()). */
export function requireWorkdir(profile: Pick<SetupProfile, 'workdir'>, who: string): string {
  if (!profile.workdir) {
    throw new Error(`${who}: profile.workdir is required (the runner provisions a per-run workdir)`);
  }
  return profile.workdir;
}

/** Upper bound for a stderr excerpt carried into a warning (the full stderr stays in the run
 *  dir verbatim). */
export const STDERR_EXCERPT_MAX = 300;

/** A short, single-line excerpt of an agent's stderr for a warning: the first line that starts
 *  with "Error"/"error" (the CLIs observed print their fatal message that way, NOTES), else the
 *  last non-empty line; whitespace collapsed, capped at STDERR_EXCERPT_MAX chars. Undefined for
 *  an empty stderr. An excerpt that matches a live-credential shape (findSecretShape, the same
 *  list the publish gate uses) is withheld: only the pattern family is named, never the value
 *  (CLAUDE.md secrets rule). Pure; exported for tests. */
export function stderrExcerpt(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  const line = lines.find((l) => /^error\b/i.test(l)) ?? lines[lines.length - 1];
  const secret = findSecretShape(line);
  if (secret !== undefined) return `(stderr excerpt withheld: matches ${secret}, value redacted)`;
  return line.length > STDERR_EXCERPT_MAX ? `${line.slice(0, STDERR_EXCERPT_MAX)}...` : line;
}

/** Declared requirements of one repetition (evidence-spec §3.1 "Run requirements", §4.3).
 *  Collected by the runner from the fixtures' provision results and passed to the adapter in
 *  RunOptions. `project_mcp_autoload`: the scenario measures whether the agent auto-loads a
 *  project-scope `.mcp.json` from the workdir, so the run must NOT ignore project MCP config
 *  (Claude Code: no `--strict-mcp-config`). The runner then records `isolation: "partial"`. */
export interface RunRequirements {
  project_mcp_autoload?: boolean;
}

/** Whether a run under `profile` uses strict MCP isolation (evidence-spec §4.3): ON for every
 *  run, with or without an MCP config of its own (strict without `--mcp-config` loads no MCP
 *  server at all), unless the operator's profile sets `strict_mcp_config: false` or the run
 *  declares `requires.project_mcp_autoload`. */
export function strictMcpConfigFor(profile: SetupProfile, requires?: RunRequirements): boolean {
  if (requires?.project_mcp_autoload === true) return false;
  return profile.strict_mcp_config !== false;
}

/** One entry of the agent's own MCP server report (Claude Code `system/init.mcp_servers`):
 *  `name`, `status` (e.g. connected / pending / failed / needs-auth) and, where the agent
 *  reports it, the config `source` (e.g. user / project). Recorded verbatim (§4.3). */
export interface McpServerStatus {
  name: string;
  status: string;
  source?: string;
}

/** Normalise a raw `mcp_servers` value from an init event into McpServerStatus[]. Entries
 *  without a string `name` are dropped; a missing status becomes 'unknown'. A non-array value
 *  yields undefined (the agent did not report a list). */
export function normalizeMcpServers(raw: unknown): McpServerStatus[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpServerStatus[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string') continue;
    const entry: McpServerStatus = {
      name: r.name,
      status: typeof r.status === 'string' ? r.status : 'unknown',
    };
    if (typeof r.source === 'string') entry.source = r.source;
    out.push(entry);
  }
  return out;
}

export type ObservationSource = 'stream' | 'hook' | 'proxy';

export interface ToolCall {
  id?: string;                // tool_use_id / call_id where the agent provides one
  name: string;
  input?: unknown;
  at: number;                 // monotonic ms since run start
  source: ObservationSource;  // primary layer (back-compat); sources[0] by priority
  // Every layer that saw this call. A call merged from both stream and hook carries
  // ['stream','hook'] (evidence-spec §4.2). `source` stays populated for back-compat.
  sources?: ObservationSource[];
}

/** Why an attempted tool use produced no effect (evidence-spec §4.2 "Attempts"):
 *  - `permission_gate` — the agent's own permission layer refused it (Claude Code: an entry in
 *                        the final `result` event's `permission_denials`);
 *  - `tool_error`      — the tool use came back as an error (`tool_result` with `is_error: true`)
 *                        and no permission denial names it. */
export type AttemptDeniedBy = 'permission_gate' | 'tool_error';

/** A tool use the agent issued that did not take effect (evidence-spec §4.2). The raw input is
 *  never stored here: only `input_digest` (sha256 of the canonical, key-sorted JSON input). The
 *  raw stream file stays untouched; this is a derived view of it. */
export interface ToolAttempt {
  tool_use_id?: string;
  name: string;
  input_digest: string;
  denied_by: AttemptDeniedBy;
  at: number;                 // monotonic ms since run start (as ToolCall.at)
}

/** sha256 (hex) of the canonical JSON of a tool input (recursively sorted keys; undefined ->
 *  null), so the same input digests identically across processes and layers (§4.2, §5). */
export function inputDigest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(input)), 'utf8').digest('hex');
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value ?? null;
}

export interface RunObservation {
  transcript_path?: string;
  raw_events_path: string;    // captured stdout JSON/JSONL, stored verbatim
  tool_calls: ToolCall[];
  exit_code: number;
  cost_usd?: number;          // client-side estimate where the agent reports one
  started_at: number;
  ended_at: number;
  // Recorded observation metadata (evidence-spec §4.3/§4.4). Optional so other adapters
  // need not populate them; the Claude Code adapter fills them from system/init and argv.
  effective_model?: string;           // model reported by the system/init stream event
  effective_permission_mode?: string; // permission mode reported by system/init
  mcp_servers?: McpServerStatus[];     // mcp_servers list from system/init (name/status/source)
  used_bare?: boolean;                 // §4.3: whether --bare was passed (default false)
  agent_version_reported?: string;     // version string from `<bin> --version`
  // §4.3: absolute real path of the agent binary this repetition actually spawned (resolved
  // once per adapter instance; PATH lookup + realpath, or the explicit override). Optional.
  agent_binary_path?: string;
  warnings?: string[];                 // non-fatal issues (e.g. version mismatch)
  // §4.3: the option names the adapter ACTUALLY passed to the agent binary for this run, in
  // argv order, values omitted (e.g. ["-p", "--output-format", "--verbose", "--model",
  // "--settings", "--strict-mcp-config"]). Absent when the adapter does not report argv
  // (replay, stubs); the runner derives the evidence `isolation` marker from it.
  agent_flags?: string[];
  // §4.2 "Attempts": tool uses the agent issued that were denied by the permission gate or
  // came back as tool errors. Optional so stubs/other adapters compile unchanged; the Claude
  // Code adapter (and replay) always fill it, the Cursor adapter reports [] (not observable).
  attempts?: ToolAttempt[];
  // ADR-0020: what the Claude Code adapter forwarded from profile.settings / profile.hooks into
  // its single `--settings` file. Absent when the profile carried neither (observe-only file).
  forwarded_settings?: ForwardedSettings;
  // evidence-spec s3.1 `content_fetched`: where fixture content-delivery facts come from when
  // the live fixtures cannot observe them. Absent for every live adapter (the runner reads the
  // provisioned fixtures' observed()). The replay adapter sets it: `recording` with the facts
  // the recording carries, or `not_observable` when the recording has none (no agent fetched
  // anything during a replay, so the live fixtures' counters say nothing about the recording).
  fixture_delivery?: FixtureDeliverySource;
}

/** One recorded fixture-delivery fact (replay recording.json `fixtures[]`, evidence-spec s3.1). */
export interface RecordedFixtureDelivery {
  type: string;
  content_fetched: boolean;
  content_requests?: number;
  request_count?: number;
}

/** Source of the fixture-delivery facts for a run that did not observe them live. */
export type FixtureDeliverySource =
  | { source: 'recording'; fixtures: RecordedFixtureDelivery[] }
  | { source: 'not_observable' };

/** ADR-0020 record of the profile portion of the harness settings file. */
export interface ForwardedSettings {
  keys: string[];                 // top-level settings keys that came from the profile (sorted)
  hook_events: string[];          // hook events the profile contributed groups to (sorted)
  harness_hook_events: string[];  // events the observe group was appended (last) to
}

// Per-run options the runner passes alongside the profile. `runDir` is where the adapter
// writes raw evidence (stream + hook logs); it aligns with the detectors' ctx.runDir so a
// detector reads evidence from the same directory the adapter wrote it to.
export interface RunOptions {
  runDir?: string;
  bare?: boolean;   // §4.3: pass --bare (skip project config). Default false (NOT used).
  requires?: RunRequirements; // §3.1/§4.3: declared by the fixtures for this repetition.
}

export interface Adapter {
  readonly id: AgentId;
  // How this agent is driven headless and observed; filled from landscape §4.
  capabilities(): { headless: boolean; observes: ObservationSource[]; can_pin_version: boolean; can_pin_model: boolean; };
  // `options` is additive (optional) so existing callers keep compiling; the Claude Code
  // adapter needs options.runDir and may also take it via its constructor.
  run(profile: SetupProfile, task: string, signal: AbortSignal, options?: RunOptions): Promise<RunObservation>;
}
