// Claude Code adapter (evidence-spec §4). Pure plumbing: launch `claude -p` headless under
// a SetupProfile, observe the run on two layers, and return a RunObservation. It carries no
// attack content — the task string and the fixtures carry the scenario, not the adapter.
//
// Two invariants (§4.1): (1) never loosen the profile — permission_mode is passed through
// verbatim via --permission-mode and never substituted for a looser one; (2) observe, do not
// steer — the installed PreToolUse/PostToolUse hooks only append their stdin to a log and
// exit 0, never blocking a call.
//
// Observation layers merged by tool_use_id (§4.2):
//   stream  — `--output-format stream-json --verbose`; assistant.tool_use blocks + result cost;
//             error-flagged tool_result blocks and result.permission_denials -> attempts (§4.2).
//   hook    — a PreToolUse/PostToolUse hook the adapter passes in a SEPARATE settings file
//             (`--settings <runDir>/claude-settings.json`); the workdir's own project settings
//             are never read or rewritten (§4.2). The hook appends its stdin JSON to
//             <runDir>/claude-hooks.jsonl.
//
// Determinism (§4.5): given the same profile, task and recorded stream, the adapter produces
// the same RunObservation. Tests drive a stub agent binary; no live agent, network or spend.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import type {
  Adapter,
  ObservationSource,
  RunObservation,
  RunOptions,
  SetupProfile,
  ToolAttempt,
  ToolCall,
  McpServerStatus,
} from './adapter.js';
import { inputDigest, normalizeMcpServers, requireWorkdir, strictMcpConfigFor, validateSettingSources } from './adapter.js';
import type { AgentId } from '../scenario/types.js';

const STREAM_FILE = 'claude-stream.jsonl';
const HOOKS_FILE = 'claude-hooks.jsonl';
const HOOK_SCRIPT = 'aab-hook.cjs';
/** Harness-only settings file carrying the observe hook, passed with `--settings` (§4.2). It
 *  lives in the run dir, never in the workdir, so fixture-planted project settings stay intact. */
export const HOOK_SETTINGS_FILE = 'claude-settings.json';
/** File the profile's MCP config is written to for `--mcp-config` (evidence-spec §4.3). */
export const MCP_CONFIG_FILE = 'mcp.json';

/** Env var that overrides the `claude` binary path (so tests point at a stub). */
export const CLAUDE_BIN_ENV = 'AAB_CLAUDE_BIN';

/** Backoff between launch attempts (evidence-spec §4.3 "Binary resolution and launch
 *  retry"): 1 initial attempt + one retry per entry, so 4 attempts in all. */
export const LAUNCH_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

export interface ClaudeCodeAdapterOptions {
  bin?: string;      // explicit binary path; else env override; else 'claude' on PATH
  runDir?: string;   // default run dir if run() is not given one
  /** Backoff schedule for launch retries (default LAUNCH_RETRY_DELAYS_MS). Tests shorten it. */
  retryDelaysMs?: readonly number[];
  /** Sleep used between retries (default setTimeout). Tests inject a deterministic one. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HookEntry {
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  transcript_path?: string;
  aab_hook_at?: number;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly id: AgentId = 'claude-code';
  /** What to resolve: constructor arg > env override > 'claude' on PATH (fixed at construction). */
  private readonly binSpec: string;
  private readonly defaultRunDir?: string;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  /** Absolute real path resolved once per instance (§4.3); re-resolved only if it vanishes. */
  private resolvedBin?: string;
  /** First version this instance observed; later repetitions are compared to it (§4.3). */
  private baselineVersion?: string;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binSpec = opts.bin ?? process.env[CLAUDE_BIN_ENV] ?? 'claude';
    this.defaultRunDir = opts.runDir;
    this.retryDelaysMs = opts.retryDelaysMs ?? LAUNCH_RETRY_DELAYS_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(): {
    headless: boolean;
    observes: ObservationSource[];
    can_pin_version: boolean;
    can_pin_model: boolean;
  } {
    // §4.4.
    return {
      headless: true,
      observes: ['stream', 'hook'],
      can_pin_version: true,
      can_pin_model: true,
    };
  }

  /** The cached absolute real path when it is still launchable; otherwise resolve again from
   *  the spec (PATH lookup or explicit path, then realpath). A changed path is warned about. */
  private currentBin(warnings: string[]): LaunchAttempt<string> {
    if (this.resolvedBin !== undefined && launchable(this.resolvedBin)) {
      return { ok: true, value: this.resolvedBin };
    }
    const found = resolveAgentBinary(this.binSpec);
    if (!found) {
      return { ok: false, retryable: true, reason: `agent binary "${this.binSpec}" not found or not executable` };
    }
    if (this.resolvedBin !== undefined && this.resolvedBin !== found) {
      warnings.push(`agent binary path changed during the run: ${this.resolvedBin} -> ${found}`);
    }
    this.resolvedBin = found;
    return { ok: true, value: found };
  }

  async run(
    profile: SetupProfile,
    task: string,
    signal: AbortSignal,
    options: RunOptions = {},
  ): Promise<RunObservation> {
    const runDir = options.runDir ?? this.defaultRunDir;
    if (!runDir) {
      throw new Error('ClaudeCodeAdapter.run: a runDir is required (pass options.runDir or construct with { runDir })');
    }
    const workdir = requireWorkdir(profile, 'ClaudeCodeAdapter.run');
    // §4.3 hardening knob: reject an invalid setting_sources before anything is spawned.
    const settingSources =
      profile.setting_sources !== undefined ? validateSettingSources(profile.setting_sources) : undefined;
    const usedBare = options.bare === true; // §4.3: default NOT used.
    await mkdir(runDir, { recursive: true });
    // The spawn cwd must exist; creating the (normally runner-provisioned) dir writes nothing in it.
    await mkdir(workdir, { recursive: true });

    const warnings: string[] = [];
    const retry = { delaysMs: this.retryDelaysMs, sleep: this.sleep, signal, warnings };

    // Binary resolution + version probe (§4.3/§4.4), retried with backoff: an agent that
    // auto-updates replaces its binary in place, leaving a short window where it is absent
    // (ENOENT) or not yet executable (EACCES). Exhausting the retries throws (adapter error).
    const probed = await retryLaunch('version probe', retry, () => {
      const b = this.currentBin(warnings);
      if (!b.ok) return b;
      const p = probeVersion(b.value);
      if (!p.ok) return p;
      return { ok: true, value: { bin: b.value, version: p.value } };
    });
    let bin = probed.bin;
    const agentVersionReported = probed.version;
    if (agentVersionReported && !versionMatches(profile.agent_version, agentVersionReported)) {
      warnings.push(
        `agent version mismatch: profile pins ${profile.agent_version}, binary reports ${agentVersionReported}`,
      );
    } else if (!agentVersionReported) {
      warnings.push('could not read agent version from `--version`');
    }
    // Version drift (§4.3): compare with the first version this adapter instance observed.
    if (agentVersionReported) {
      if (this.baselineVersion === undefined) {
        this.baselineVersion = agentVersionReported;
      } else if (semverOf(this.baselineVersion) !== semverOf(agentVersionReported)) {
        warnings.push(
          `agent updated during the run: first observed ${this.baselineVersion}, this repetition reports ${agentVersionReported} (${bin})`,
        );
      }
    }

    // Observation hook (§4.2): written to a harness-only settings file in the run dir and
    // passed with `--settings <file>` ("load additional settings from"; confirmed in
    // `claude --help`, NOTES). The workdir's .claude/settings.json is never touched, so a
    // fixture-planted project hook (AAB-002, AAB-032) stays byte-for-byte as planted.
    const hooksJsonlPath = path.join(runDir, HOOKS_FILE);
    const hookScriptPath = path.join(runDir, HOOK_SCRIPT);
    await writeFile(hookScriptPath, hookScriptSource(hooksJsonlPath), 'utf8');
    const hookSettingsPath = path.join(runDir, HOOK_SETTINGS_FILE);
    await writeFile(hookSettingsPath, JSON.stringify(observeHookSettings(hookScriptPath), null, 2), 'utf8');

    // Build headless argv (§4.2/§4.3). permission_mode passed verbatim; never loosened.
    const argv = ['-p', task, '--output-format', 'stream-json', '--verbose', '--model', profile.model];
    if (profile.permission_mode !== undefined) {
      // §4.1 invariant 1: pass the profile's mode through as-is. Only ever reach for the
      // --dangerously-skip-permissions flag when the profile's mode literally asks for it.
      if (profile.permission_mode === 'dangerously-skip-permissions') {
        argv.push('--dangerously-skip-permissions');
      } else {
        argv.push('--permission-mode', profile.permission_mode);
      }
    }
    if (usedBare) argv.push('--bare');
    argv.push('--settings', hookSettingsPath);
    // §4.3: `--setting-sources <csv>` only when the profile narrows it; absent => no flag, the
    // agent's default sources apply (no default change).
    if (settingSources !== undefined) argv.push('--setting-sources', settingSources.join(','));

    // MCP isolation (§4.3): `--strict-mcp-config` ("Only use MCP servers from --mcp-config,
    // ignoring all other MCP configurations") on EVERY run, so the operator's own user-scope
    // servers never load into a benchmark run — with no profile MCP config that means no MCP
    // server loads at all. Dropped only for an operator opt-out (strict_mcp_config:false) or a
    // declared run requirement (requires.project_mcp_autoload: the scenario measures whether a
    // project .mcp.json auto-loads, which strict mode would suppress). The runner records the
    // resulting isolation marker from agent_flags.
    const strict = strictMcpConfigFor(profile, options.requires);
    if (strict) {
      argv.push('--strict-mcp-config');
      // Strict isolation also ignores a project .mcp.json; say so rather than hide it.
      if (existsSync(path.join(workdir, '.mcp.json'))) {
        warnings.push(
          '--strict-mcp-config is on: the workdir .mcp.json is ignored (no run requirement declared project_mcp_autoload)',
        );
      }
    }
    // The profile's MCP config under test: <runDir>/mcp.json via `--mcp-config <file>`.
    // Appended last: `--mcp-config` is variadic, so nothing positional may follow its value.
    if (profile.mcp !== undefined && profile.mcp !== null) {
      const mcpPath = path.join(runDir, MCP_CONFIG_FILE);
      await writeFile(mcpPath, JSON.stringify(profile.mcp, null, 2), 'utf8');
      argv.push('--mcp-config', mcpPath);
    }
    const agentFlags = flagNames(argv);

    const env = { ...process.env, ...(profile.env ?? {}) };

    const startedAt = Date.now();
    const perfStart = performance.now();

    const state = newStreamState();
    const stdoutChunks: Buffer[] = [];
    let lineBuffer = '';

    const handleLine = (line: string): void => {
      parseStreamLine(line, performance.now() - perfStart, state);
    };

    // Spawn (§4.3), retried on ENOENT/EACCES with the same backoff. A failed spawn emits no
    // output, so a retry cannot duplicate stream events.
    const child = await retryLaunch('spawn', retry, async () => {
      const b = this.currentBin(warnings);
      if (!b.ok) return b;
      bin = b.value;
      const { cmd, args } = commandFor(bin, argv);
      const c = spawn(cmd, args, { cwd: workdir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const err = await spawnOutcome(c);
      if (!err) return { ok: true, value: c };
      const reason = `failed to spawn agent binary "${bin}": ${err.code ?? err.message}`;
      return { ok: false, retryable: isRetryableLaunchError(err), reason };
    });

    const onAbort = (): void => {
      // Honour the AbortSignal: kill the child (observe, never hang).
      child.kill('SIGKILL');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const exitCode: number = await new Promise<number>((resolve) => {
      child.stdout.on('data', (buf: Buffer) => {
        stdoutChunks.push(buf);
        lineBuffer += buf.toString('utf8');
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, idx);
          lineBuffer = lineBuffer.slice(idx + 1);
          handleLine(line);
        }
      });
      // Drain stderr so the pipe never blocks; contents are not evidence.
      child.stderr.on('data', () => {});
      child.on('error', (err) => {
        warnings.push(`agent process error (${bin}): ${err.message}`);
        resolve(-1);
      });
      child.on('close', (code, sig) => {
        if (lineBuffer.length > 0) handleLine(lineBuffer);
        if (code !== null) resolve(code);
        else if (sig) resolve(128 + (signalNumber(sig) ?? 0));
        else resolve(-1);
      });
    });

    signal.removeEventListener('abort', onAbort);

    const endedAt = Date.now();

    // Persist stdout verbatim (raw_events_path).
    const rawPath = path.join(runDir, STREAM_FILE);
    await writeFile(rawPath, Buffer.concat(stdoutChunks));

    // Read the hook log and merge stream + hook by tool_use_id (shared with replay, ADR-0015).
    const hookEntries = await readJsonl<HookEntry>(hooksJsonlPath);
    return assembleObservation(state, hookEntries, {
      rawEventsPath: rawPath,
      exitCode,
      startedAt,
      endedAt,
      usedBare,
      agentVersionReported,
      agentBinaryPath: bin,
      warnings,
      agentFlags,
    });
  }
}

// --- shared pure parse/merge step (evidence-spec §4.2/§4.5, ADR-0015) --------------------
// The live adapter and the replay adapter both go through these functions, so a replayed
// recording exercises exactly the code that parses a live run.

/** Accumulated state from parsing the stream-json output line by line. */
export interface StreamState {
  calls: ToolCall[];
  effectiveModel?: string;
  effectivePermissionMode?: string;
  mcpServers?: McpServerStatus[];
  costUsd?: number;
  /** §4.2 "Attempts": entries of the result event's `permission_denials` (last result wins). */
  permissionDenials?: Array<{ id?: string; name?: string; input?: unknown; at: number }>;
  /** §4.2 "Attempts": `tool_result` blocks flagged `is_error: true`, in stream order. */
  toolErrors: Array<{ id?: string; at: number }>;
}

export function newStreamState(): StreamState {
  return { calls: [], toolErrors: [] };
}

/** Parse one stream-json line into `state`. `at` is the ms offset recorded on tool calls.
 *  Non-JSON and blank lines are ignored (the raw file keeps them verbatim). */
export function parseStreamLine(line: string, at: number, state: StreamState): void {
  const text = line.trim();
  if (!text) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return; // not JSON — keep raw in the file, skip for parsing
  }
  const type = evt.type;
  if (type === 'system' && evt.subtype === 'init') {
    state.effectiveModel = typeof evt.model === 'string' ? evt.model : state.effectiveModel;
    // system/init uses permissionMode (camelCase); accept snake_case defensively.
    const pm = (evt.permissionMode ?? evt.permission_mode) as unknown;
    if (typeof pm === 'string') state.effectivePermissionMode = pm;
    // Record the init list as name/status/source (§4.3); a later init without a list does not
    // erase an earlier one.
    const servers = normalizeMcpServers(evt.mcp_servers);
    if (servers) state.mcpServers = servers;
  } else if (type === 'assistant') {
    const msg = evt.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block.type === 'tool_use') {
        state.calls.push({
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : 'unknown',
          input: block.input,
          at,
          source: 'stream',
          sources: ['stream'],
        });
      }
    }
  } else if (type === 'user') {
    // Tool results come back on user messages; an error-flagged one is a failed/denied attempt.
    const msg = evt.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block.type === 'tool_result' && block.is_error === true) {
        state.toolErrors.push({
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          at,
        });
      }
    }
  } else if (type === 'result') {
    if (typeof evt.total_cost_usd === 'number') state.costUsd = evt.total_cost_usd;
    // `permission_denials`: [{ tool_name, tool_use_id, tool_input }] — the tool uses the
    // permission gate refused during the run (§4.2 "Attempts").
    if (Array.isArray(evt.permission_denials)) {
      const denials: NonNullable<StreamState['permissionDenials']> = [];
      for (const d of evt.permission_denials as unknown[]) {
        if (!d || typeof d !== 'object') continue;
        const r = d as Record<string, unknown>;
        denials.push({
          id: typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined,
          name: typeof r.tool_name === 'string' ? r.tool_name : undefined,
          input: r.tool_input,
          at,
        });
      }
      state.permissionDenials = denials;
    }
  }
}

/** Derive the attempts list (§4.2 "Attempts") from the parsed stream and the merged tool calls.
 *  Every permission denial is one `permission_gate` attempt; every error-flagged tool_result
 *  whose tool_use_id is not already a denial is one `tool_error` attempt. Name/input come from
 *  the denial itself, else from the tool call with the same id. Only a digest of the input is
 *  kept; the raw events are not modified. */
export function attemptsFrom(state: StreamState, calls: ToolCall[]): ToolAttempt[] {
  const byId = new Map<string, ToolCall>();
  for (const c of calls) if (c.id && !byId.has(c.id)) byId.set(c.id, c);
  const out: ToolAttempt[] = [];
  const deniedIds = new Set<string>();
  for (const d of state.permissionDenials ?? []) {
    const call = d.id ? byId.get(d.id) : undefined;
    const input = d.input !== undefined ? d.input : call?.input;
    if (d.id) deniedIds.add(d.id);
    out.push({
      ...(d.id ? { tool_use_id: d.id } : {}),
      name: d.name ?? call?.name ?? 'unknown',
      input_digest: inputDigest(input),
      denied_by: 'permission_gate',
      at: call?.at ?? d.at,
    });
  }
  const errorIds = new Set<string>();
  for (const e of state.toolErrors) {
    if (e.id && (deniedIds.has(e.id) || errorIds.has(e.id))) continue;
    if (e.id) errorIds.add(e.id);
    const call = e.id ? byId.get(e.id) : undefined;
    out.push({
      ...(e.id ? { tool_use_id: e.id } : {}),
      name: call?.name ?? 'unknown',
      input_digest: inputDigest(call?.input),
      denied_by: 'tool_error',
      at: call?.at ?? e.at,
    });
  }
  return out;
}

/** Turn hook-log entries into hook-layer tool calls; also returns the first transcript_path. */
export function hookCallsFromEntries(
  entries: HookEntry[],
  startedAt: number,
): { calls: ToolCall[]; transcriptPath?: string } {
  let transcriptPath: string | undefined;
  const calls: ToolCall[] = [];
  for (const entry of entries) {
    if (!transcriptPath && typeof entry.transcript_path === 'string') {
      transcriptPath = entry.transcript_path;
    }
    const at =
      typeof entry.aab_hook_at === 'number' ? Math.max(0, entry.aab_hook_at - startedAt) : 0;
    calls.push({
      id: typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined,
      name: typeof entry.tool_name === 'string' ? entry.tool_name : 'unknown',
      input: entry.tool_input,
      at,
      source: 'hook',
      sources: ['hook'],
    });
  }
  return { calls, transcriptPath };
}

export interface ObservationMeta {
  rawEventsPath: string;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  usedBare: boolean;
  agentVersionReported?: string;
  agentBinaryPath?: string; // §4.3: absolute real path actually spawned (live adapter only)
  warnings?: string[];
  agentFlags?: string[]; // §4.3: option names actually passed (live adapter only)
}

/** Build the RunObservation from parsed stream state and hook entries (merge by id). */
export function assembleObservation(
  state: StreamState,
  hookEntries: HookEntry[],
  meta: ObservationMeta,
): RunObservation {
  const hook = hookCallsFromEntries(hookEntries, meta.startedAt);
  const warnings = meta.warnings ?? [];
  const toolCalls = mergeById(state.calls, hook.calls);
  return {
    transcript_path: hook.transcriptPath,
    raw_events_path: meta.rawEventsPath,
    tool_calls: toolCalls,
    exit_code: meta.exitCode,
    cost_usd: state.costUsd,
    started_at: meta.startedAt,
    ended_at: meta.endedAt,
    effective_model: state.effectiveModel,
    effective_permission_mode: state.effectivePermissionMode,
    mcp_servers: state.mcpServers,
    used_bare: meta.usedBare,
    agent_version_reported: meta.agentVersionReported,
    ...(meta.agentBinaryPath !== undefined ? { agent_binary_path: meta.agentBinaryPath } : {}),
    warnings: warnings.length > 0 ? warnings : undefined,
    ...(meta.agentFlags ? { agent_flags: [...meta.agentFlags] } : {}),
    attempts: attemptsFrom(state, toolCalls),
  };
}

export interface ObserveClaudeRunInput extends ObservationMeta {
  streamText: string;   // verbatim stream-json stdout
  hooksText?: string;   // verbatim hook log (JSONL); absent when no hook fired
  streamAt?: number;    // `at` stamped on every stream tool call (default 0: no clock)
}

/** The pure parse/merge step over recorded text: no I/O, no clock, no process. */
export function observeClaudeRun(input: ObserveClaudeRunInput): RunObservation {
  const state = newStreamState();
  const at = input.streamAt ?? 0;
  for (const line of input.streamText.split('\n')) parseStreamLine(line, at, state);
  const hookEntries = input.hooksText ? parseJsonlText<HookEntry>(input.hooksText) : [];
  return assembleObservation(state, hookEntries, input);
}

/** Merge stream and hook tool calls by tool_use_id into one ToolCall per id, recording every
 *  layer that saw it in `sources`. A call seen only on stream is still included (§4.2). Calls
 *  with no id are kept as-is (never collapsed together). Stream order is preserved; hook-only
 *  calls are appended. */
export function mergeById(streamCalls: ToolCall[], hookCalls: ToolCall[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  const ordered: ToolCall[] = [];

  const add = (call: ToolCall): void => {
    const id = call.id;
    if (!id) {
      ordered.push(call);
      return;
    }
    const existing = byId.get(id);
    if (!existing) {
      const copy: ToolCall = { ...call, sources: [...(call.sources ?? [call.source])] };
      byId.set(id, copy);
      ordered.push(copy);
      return;
    }
    for (const s of call.sources ?? [call.source]) {
      if (!existing.sources!.includes(s)) existing.sources!.push(s);
    }
    // Fill fields the earlier sighting lacked (hook input/name is equally authoritative).
    if (existing.input === undefined && call.input !== undefined) existing.input = call.input;
    if (existing.name === 'unknown' && call.name !== 'unknown') existing.name = call.name;
  };

  for (const c of streamCalls) add(c);
  for (const c of hookCalls) add(c);

  // Normalise `source` to the strongest-ordered layer actually seen (back-compat field).
  const priority: ObservationSource[] = ['stream', 'hook', 'proxy'];
  for (const call of ordered) {
    const seen = call.sources ?? [call.source];
    call.source = priority.find((p) => seen.includes(p)) ?? call.source;
  }
  return ordered;
}

/** The harness-only settings body passed with `--settings` (§4.2): one observe-only group for
 *  PreToolUse and PostToolUse. The command quotes node and the script path so spaces survive
 *  the shell; fs_diff recognises exactly this group shape (§1.2c). */
export function observeHookSettings(hookScriptPath: string): { hooks: Record<string, unknown[]> } {
  const command = `"${process.execPath}" "${hookScriptPath}"`;
  const observe = { matcher: '*', hooks: [{ type: 'command', command }] };
  return { hooks: { PreToolUse: [observe], PostToolUse: [observe] } };
}

/** Option names in an argv, in order, values dropped (§4.3 evidence `agent_flags`). The task
 *  string and file paths never enter evidence through this list. */
export function flagNames(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!/^--?[A-Za-z]/.test(a)) continue;
    out.push(a);
    if (VALUE_FLAGS.has(a)) i++; // skip the value (task text, model id, paths)
  }
  return out;
}
/** Options the adapter emits that take exactly one value (`--mcp-config` is variadic but the
 *  adapter passes one file). */
const VALUE_FLAGS = new Set(['-p', '--output-format', '--model', '--permission-mode', '--settings', '--setting-sources', '--mcp-config']);

/** The hook script: reads stdin, appends the payload (plus a receive timestamp) to the run
 *  dir's hook log, and ALWAYS exits 0 — observation, never a block (§4.1 invariant 2). */
function hookScriptSource(hooksJsonlPath: string): string {
  return `#!/usr/bin/env node
'use strict';
// LureKit observation hook (evidence-spec §4.2). Appends the PreToolUse/PostToolUse
// stdin JSON to the run dir's hook log and exits 0. It never blocks a tool call.
const fs = require('node:fs');
const OUT = ${JSON.stringify(hooksJsonlPath)};
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const text = data.trim();
    let line;
    if (text) {
      try {
        const obj = JSON.parse(text);
        obj.aab_hook_at = Date.now();
        line = JSON.stringify(obj);
      } catch (_e) {
        line = text; // not JSON — append verbatim
      }
      fs.appendFileSync(OUT, line + '\\n');
    }
  } catch (_e) { /* swallow: the hook must never fail the call */ }
  process.exit(0);
});
`;
}

/** Parse a newline-delimited JSON file, tolerating a missing file and skipping blank/corrupt
 *  lines. Inlined (not imported from detectors) so the adapter has no dependency on them. */
async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return parseJsonlText<T>(raw);
}

/** Parse newline-delimited JSON text, skipping blank/corrupt lines. */
export function parseJsonlText<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text) as T);
    } catch {
      // corrupt line — skip
    }
  }
  return out;
}

/** True when the version the binary reports is consistent with the profile's pinned version.
 *  Compares the dotted semver found in each string; a profile like
 *  "@anthropic-ai/claude-code@2.1.309" matches a report of "2.1.309 (Claude Code)". */
function versionMatches(pinned: string, reported: string): boolean {
  const a = semverOf(pinned);
  const b = semverOf(reported);
  if (!a || !b) return false;
  return a === b;
}

function semverOf(s: string): string | undefined {
  const m = s.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : undefined;
}

/** Map a signal name to its number for a 128+n exit-code convention. */
function signalNumber(sig: NodeJS.Signals): number | undefined {
  const n = (osConstants.signals as Record<string, number>)[sig];
  return typeof n === 'number' ? n : undefined;
}

// --- binary resolution and launch retry (evidence-spec §4.3) -----------------------------

/** One launch attempt's result. A retryable failure (binary absent / not executable, i.e. an
 *  ENOENT/EACCES window while an auto-update replaces it) is retried with backoff. */
export type LaunchAttempt<T> = { ok: true; value: T } | { ok: false; retryable: boolean; reason: string };

export interface RetryContext {
  delaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Each retry is recorded here: `launch retry <n>/<max> (<label>) in <ms>ms: <reason>`. */
  warnings: string[];
}

/** Run `attempt` up to `delaysMs.length + 1` times, sleeping `delaysMs[i]` before retry i+1.
 *  Throws once the retries are exhausted, on a non-retryable failure, or when `signal` is
 *  aborted between attempts; the message carries the attempt count and the last reason. */
export async function retryLaunch<T>(
  label: string,
  ctx: RetryContext,
  attempt: () => LaunchAttempt<T> | Promise<LaunchAttempt<T>>,
): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await attempt();
    if (r.ok) return r.value;
    if (!r.retryable || i >= ctx.delaysMs.length) {
      throw new Error(`${label} failed after ${i + 1} attempt(s): ${r.reason}`);
    }
    if (ctx.signal?.aborted) throw new Error(`${label} aborted during launch retry: ${r.reason}`);
    const delay = ctx.delaysMs[i]!;
    ctx.warnings.push(`launch retry ${i + 1}/${ctx.delaysMs.length} (${label}) in ${delay}ms: ${r.reason}`);
    await ctx.sleep(delay);
    if (ctx.signal?.aborted) throw new Error(`${label} aborted during launch retry: ${r.reason}`);
  }
}

/** ENOENT (binary absent) and EACCES (present but not executable yet) are the replace-in-place
 *  window of an updating binary; anything else is not retried. */
export function isRetryableLaunchError(err: { code?: unknown } | undefined): boolean {
  return err?.code === 'ENOENT' || err?.code === 'EACCES';
}

function isNodeScript(bin: string): boolean {
  return /\.(mjs|cjs|js)$/i.test(bin);
}

/** argv for launching `bin`: a .js/.mjs/.cjs script runs under the current node. */
function commandFor(bin: string, args: string[]): { cmd: string; args: string[] } {
  return isNodeScript(bin) ? { cmd: process.execPath, args: [bin, ...args] } : { cmd: bin, args };
}

/** Whether `file` is a regular file the adapter can launch now (readable for a node script,
 *  executable otherwise). */
function launchable(file: string): boolean {
  try {
    const mode = isNodeScript(file) || process.platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK;
    accessSync(file, mode);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve a binary spec to an absolute real path (§4.3): a spec with a path separator is
 *  taken as a path (relative to cwd); a bare name is looked up on PATH. The result is
 *  `realpathSync` of the first launchable candidate, or undefined when none is found. */
export function resolveAgentBinary(spec: string, envPath: string | undefined = process.env.PATH): string | undefined {
  const candidates: string[] = [];
  if (spec.includes('/') || spec.includes(path.sep) || path.isAbsolute(spec)) {
    candidates.push(path.resolve(spec));
  } else {
    const exts =
      process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
    for (const dir of (envPath ?? '').split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) candidates.push(path.resolve(dir, spec + ext));
    }
  }
  for (const c of candidates) {
    if (!launchable(c)) continue;
    try {
      const real = realpathSync(c);
      if (launchable(real)) return real;
    } catch {
      /* vanished between the checks: try the next candidate */
    }
  }
  return undefined;
}

/** Run `<bin> --version` synchronously. ENOENT/EACCES is a retryable failure; a binary that
 *  runs but reports nothing yields `{ ok: true, value: undefined }` (warned by the caller). */
function probeVersion(bin: string): LaunchAttempt<string | undefined> {
  const { cmd, args } = commandFor(bin, ['--version']);
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      if (isRetryableLaunchError(err)) {
        return { ok: false, retryable: true, reason: `\`--version\` probe of "${bin}" failed: ${err.code}` };
      }
      return { ok: true, value: undefined };
    }
    const out = typeof res.stdout === 'string' ? res.stdout.trim() : '';
    return { ok: true, value: out.length > 0 ? out : undefined };
  } catch {
    return { ok: true, value: undefined };
  }
}

/** Resolve once the child has either spawned (undefined) or failed to spawn (the error). */
function spawnOutcome(child: ChildProcess): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve(undefined);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      child.off('spawn', onSpawn);
      resolve(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
