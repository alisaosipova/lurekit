// Cursor CLI adapter (ADR-0016; facts: NOTES-verified-facts.md § Cursor CLI; invariants:
// evidence-spec §4.1). Pure plumbing: launch `agent -p` headless under a SetupProfile, capture
// its NDJSON stream verbatim, and return a RunObservation. It carries no attack content.
//
// Invariants (§4.1): (1) never loosen the profile — every permission-relevant flag (--mode,
// --force, --sandbox, --trust, --approve-mcps) is emitted only when the profile's
// permission_mode literally names it; the adapter adds none on its own; (2) observe, do not
// steer — the adapter installs nothing into the workdir (no hooks, no config).
//
// Observation layer: `stream` only. Whether hooks fire under `-p` is UNVERIFIED (NOTES), so the
// `hook` layer is not declared until a recorded run proves it (ADR-0016 §Decision 5).
//
// Determinism (§4.5): the parse step is the exported pure `observeCursorRun`; tests drive an
// offline stub binary (test/fixtures/agents/stub-cursor.mjs). No live agent, network or spend.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  Adapter,
  ObservationSource,
  RunObservation,
  RunOptions,
  SetupProfile,
  ToolCall,
  McpServerStatus,
} from './adapter.js';
import { normalizeMcpServers } from './adapter.js';
import type { AgentId } from '../scenario/types.js';

export const CURSOR_STREAM_FILE = 'cursor-stream.jsonl';
export const CURSOR_STDERR_FILE = 'cursor-stderr.log';
export const CURSOR_ARGV_FILE = 'cursor-argv.json';

/** Env var that overrides the `agent` binary path (so tests point at a stub). */
export const CURSOR_BIN_ENV = 'AAB_CURSOR_BIN';

export interface CursorCliAdapterOptions {
  bin?: string;    // explicit binary path; else env override; else 'agent' on PATH
  runDir?: string; // default run dir if run() is not given one
  /** Pass `--disable-auto-update`. Default false: the flag is documented only in the January
   *  2026 changelog and is absent from the current parameters page (UNVERIFIED, NOTES). Turn it
   *  on only after confirming it in the live `agent --help`. */
  disableAutoUpdate?: boolean;
}

/** The Cursor-specific permission flags a profile may name (ADR-0016 §Decision 1). */
export interface CursorPermissionFlags {
  mode?: 'plan' | 'ask';
  force?: boolean;
  sandbox?: 'enabled' | 'disabled';
  trust?: boolean;
  approveMcps?: boolean;
}

/** Parse `profile.permission_mode` for Cursor. Grammar: tokens separated by commas and/or
 *  whitespace; each token maps to exactly one flag:
 *    plan | ask | mode=plan | mode=ask   -> --mode <v>
 *    force                               -> --force
 *    sandbox=enabled | sandbox=disabled  -> --sandbox <v>
 *    trust                               -> --trust
 *    approve-mcps                        -> --approve-mcps
 *  An unknown or conflicting token throws: silently dropping it could run the agent looser
 *  than the profile intends (§4.1 invariant 1). */
export function parseCursorPermissionMode(mode: string | undefined): CursorPermissionFlags {
  const out: CursorPermissionFlags = {};
  if (mode === undefined) return out;
  const tokens = mode.split(/[\s,]+/).filter((t) => t.length > 0);
  const setMode = (v: 'plan' | 'ask'): void => {
    if (out.mode !== undefined && out.mode !== v) throw new Error(`cursor-cli: conflicting modes "${out.mode}" and "${v}" in permission_mode`);
    out.mode = v;
  };
  for (const t of tokens) {
    if (t === 'plan' || t === 'mode=plan') setMode('plan');
    else if (t === 'ask' || t === 'mode=ask') setMode('ask');
    else if (t === 'force') out.force = true;
    else if (t === 'sandbox=enabled' || t === 'sandbox=disabled') {
      const v = t.slice('sandbox='.length) as 'enabled' | 'disabled';
      if (out.sandbox !== undefined && out.sandbox !== v) throw new Error('cursor-cli: conflicting sandbox values in permission_mode');
      out.sandbox = v;
    } else if (t === 'trust') out.trust = true;
    else if (t === 'approve-mcps') out.approveMcps = true;
    else {
      throw new Error(
        `cursor-cli: unknown permission_mode token "${t}" (allowed: plan, ask, mode=plan|ask, force, sandbox=enabled|disabled, trust, approve-mcps)`,
      );
    }
  }
  return out;
}

/** Build the headless argv (ADR-0016 §Decision 1). Pure; exported for tests. */
export function buildCursorArgv(
  profile: Pick<SetupProfile, 'model' | 'workdir' | 'permission_mode'>,
  task: string,
  opts: { disableAutoUpdate?: boolean } = {},
): string[] {
  const flags = parseCursorPermissionMode(profile.permission_mode);
  // `-p, --print` is a boolean flag and the prompt is positional (NOTES § Cursor CLI), so a task
  // starting with '-' would be parsed as an option (e.g. "--force") and could loosen the run
  // (§4.1 invariant 1). Whether `--` ends option parsing is UNVERIFIED, so refuse instead.
  if (task.startsWith('-')) {
    throw new Error('cursor-cli: task text must not start with "-" (it would be parsed as a CLI option)');
  }
  const argv = ['-p', task, '--output-format', 'stream-json', '--workspace', profile.workdir, '--model', profile.model];
  if (flags.mode) argv.push('--mode', flags.mode);
  if (flags.sandbox) argv.push('--sandbox', flags.sandbox);
  if (flags.force) argv.push('--force');
  if (flags.trust) argv.push('--trust');
  if (flags.approveMcps) argv.push('--approve-mcps');
  if (opts.disableAutoUpdate) argv.push('--disable-auto-update');
  return argv;
}

export class CursorCliAdapter implements Adapter {
  readonly id: AgentId = 'cursor-cli';
  private readonly binOverride?: string;
  private readonly defaultRunDir?: string;
  private readonly disableAutoUpdate: boolean;

  constructor(opts: CursorCliAdapterOptions = {}) {
    this.binOverride = opts.bin;
    this.defaultRunDir = opts.runDir;
    this.disableAutoUpdate = opts.disableAutoUpdate === true;
  }

  capabilities(): {
    headless: boolean;
    observes: ObservationSource[];
    can_pin_version: boolean;
    can_pin_model: boolean;
  } {
    // ADR-0016 §Decision 2: no versioned install and auto-update on by default -> no version
    // pin; hooks under -p unverified -> stream only.
    return { headless: true, observes: ['stream'], can_pin_version: false, can_pin_model: true };
  }

  /** Resolve the binary: constructor arg > env override > 'agent' on PATH. */
  private bin(): string {
    return this.binOverride ?? process.env[CURSOR_BIN_ENV] ?? 'agent';
  }

  async run(
    profile: SetupProfile,
    task: string,
    signal: AbortSignal,
    options: RunOptions = {},
  ): Promise<RunObservation> {
    const runDir = options.runDir ?? this.defaultRunDir;
    if (!runDir) {
      throw new Error('CursorCliAdapter.run: a runDir is required (pass options.runDir or construct with { runDir })');
    }
    // Validate the permission tokens before anything is spawned.
    const argv = buildCursorArgv(profile, task, { disableAutoUpdate: this.disableAutoUpdate });
    await mkdir(runDir, { recursive: true });
    await mkdir(profile.workdir, { recursive: true });

    const warnings: string[] = [];
    const bin = this.bin();
    const env = { ...process.env, ...(profile.env ?? {}) };

    if (options.bare === true) {
      warnings.push('--bare is a Claude Code option; cursor-cli has no equivalent and it was not applied');
    }
    if (!this.disableAutoUpdate) {
      warnings.push('auto-update not disabled: --disable-auto-update is unverified on the current CLI (NOTES § Cursor CLI); version drift is checked before/after');
    }
    if (await hasClaudeSettingsHooks(profile.workdir)) {
      // NOTES § Cursor CLI: "Claude Code settings.json hooks are read and merged" (changelog).
      warnings.push('workdir has .claude/settings.json hooks; Cursor CLI reads and merges Claude Code hooks, so they may execute under this run');
    }

    const versionBefore = probeVersion(bin, env);
    if (!versionBefore) {
      warnings.push('could not read agent version from `--version`');
    } else if (profile.agent_version !== 'unpinned' && !versionMatches(profile.agent_version, versionBefore)) {
      warnings.push(`agent version mismatch: profile names ${profile.agent_version}, binary reports ${versionBefore} (cursor-cli cannot pin a version)`);
    }

    await writeFile(path.join(runDir, CURSOR_ARGV_FILE), JSON.stringify([bin, ...argv]), 'utf8');

    const startedAt = Date.now();
    const perfStart = performance.now();
    const state = newCursorStreamState();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let lineBuffer = '';
    // Decode across chunk boundaries so a multi-byte UTF-8 char split between chunks is not
    // mangled in the parsed view (the raw file is written from the Buffers, verbatim).
    const decoder = new StringDecoder('utf8');
    const handleLine = (line: string): void => {
      parseCursorStreamLine(line, performance.now() - perfStart, state);
    };

    const { cmd, args } = command(bin, argv);
    const child = spawn(cmd, args, {
      cwd: profile.workdir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const exitCode: number = await new Promise<number>((resolve) => {
      child.stdout.on('data', (buf: Buffer) => {
        stdoutChunks.push(buf);
        lineBuffer += decoder.write(buf);
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, idx);
          lineBuffer = lineBuffer.slice(idx + 1);
          handleLine(line);
        }
      });
      // stderr is kept verbatim: on failure Cursor writes its error there (NOTES).
      child.stderr.on('data', (buf: Buffer) => stderrChunks.push(buf));
      child.on('error', () => {
        warnings.push(`failed to spawn agent binary "${bin}"`);
        resolve(-1);
      });
      child.on('close', (code, sig) => {
        lineBuffer += decoder.end();
        if (lineBuffer.length > 0) handleLine(lineBuffer);
        if (code !== null) resolve(code);
        else if (sig) resolve(128 + (signalNumber(sig) ?? 0));
        else resolve(-1);
      });
    });
    signal.removeEventListener('abort', onAbort);
    const endedAt = Date.now();

    const rawPath = path.join(runDir, CURSOR_STREAM_FILE);
    await writeFile(rawPath, Buffer.concat(stdoutChunks));
    await writeFile(path.join(runDir, CURSOR_STDERR_FILE), Buffer.concat(stderrChunks));

    const versionAfter = probeVersion(bin, env);
    if (versionBefore && versionAfter && versionAfter !== versionBefore) {
      warnings.push(`agent version drifted during the run: ${versionBefore} -> ${versionAfter} (auto-update)`);
    }

    return assembleCursorObservation(state, {
      requestedModel: profile.model,
      rawEventsPath: rawPath,
      exitCode,
      startedAt,
      endedAt,
      agentVersionReported: versionBefore,
      warnings,
    });
  }
}

// --- pure parse step (evidence-spec §4.5) ------------------------------------------------

export interface CursorStreamState {
  calls: ToolCall[];
  byCallId: Map<string, ToolCall>;
  effectiveModel?: string;
  effectivePermissionMode?: string;
  mcpServers?: McpServerStatus[];
  sessionId?: string;
  sawResult: boolean;
  resultIsError?: boolean;
}

export function newCursorStreamState(): CursorStreamState {
  return { calls: [], byCallId: new Map(), sawResult: false };
}

/** Name and input of a `tool_call` payload. Documented shapes (NOTES): `<x>ToolCall` objects
 *  with `args` (readToolCall, writeToolCall), and a generic `function` {name, arguments}.
 *  Any other shape keeps the whole payload as input under name 'unknown' (never dropped). */
export function describeCursorToolCall(tc: unknown): { name: string; input: unknown } {
  if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const obj = tc as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    if (fn && typeof fn === 'object' && typeof fn.name === 'string') {
      return { name: fn.name, input: fn.arguments };
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key.endsWith('ToolCall') && value && typeof value === 'object') {
        return { name: key, input: (value as Record<string, unknown>).args };
      }
    }
  }
  return { name: 'unknown', input: tc };
}

/** Parse one stream-json line into `state`. Non-JSON/blank lines and unknown event types or
 *  fields are ignored for parsing (the raw file keeps them verbatim). */
export function parseCursorStreamLine(line: string, at: number, state: CursorStreamState): void {
  const text = line.trim();
  if (!text) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!evt || typeof evt !== 'object') return;
  const type = evt.type;
  if (type === 'system' && evt.subtype === 'init') {
    if (typeof evt.model === 'string') state.effectiveModel = evt.model;
    if (typeof evt.permissionMode === 'string') state.effectivePermissionMode = evt.permissionMode;
    if (typeof evt.session_id === 'string') state.sessionId = evt.session_id;
    if ('mcp_servers' in evt) {
      const servers = normalizeMcpServers(evt.mcp_servers); // "may be added" (NOTES)
      if (servers) state.mcpServers = servers;
    }
  } else if (type === 'tool_call') {
    const { name, input } = describeCursorToolCall(evt.tool_call);
    const callId = typeof evt.call_id === 'string' ? evt.call_id : undefined;
    const existing = callId ? state.byCallId.get(callId) : undefined;
    if (existing) {
      // started/completed correlate by call_id: one ToolCall, first sighting's time.
      if (existing.name === 'unknown' && name !== 'unknown') existing.name = name;
      if (existing.input === undefined && input !== undefined) existing.input = input;
      return;
    }
    const call: ToolCall = { id: callId, name, input, at, source: 'stream', sources: ['stream'] };
    state.calls.push(call);
    if (callId) state.byCallId.set(callId, call);
  } else if (type === 'result') {
    state.sawResult = true;
    if (typeof evt.is_error === 'boolean') state.resultIsError = evt.is_error;
    // No cost or token fields are documented (NOTES): cost_usd stays undefined.
  }
}

export interface CursorObservationMeta {
  requestedModel: string;
  rawEventsPath: string;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  agentVersionReported?: string;
  warnings?: string[];
}

export function assembleCursorObservation(state: CursorStreamState, meta: CursorObservationMeta): RunObservation {
  const warnings = [...(meta.warnings ?? [])];
  if (state.effectiveModel === undefined) {
    warnings.push('no system/init model reported; model pin applied on input only');
  } else if (state.effectiveModel !== meta.requestedModel) {
    warnings.push(
      `system/init reports model "${state.effectiveModel}" for requested id "${meta.requestedModel}" (Cursor reports a display name; exact echo unverified)`,
    );
  }
  if (meta.exitCode === 0 && !state.sawResult) warnings.push('stream ended without a result event');
  if (state.resultIsError === true) warnings.push('result event reports is_error=true');
  return {
    raw_events_path: meta.rawEventsPath,
    tool_calls: state.calls,
    exit_code: meta.exitCode,
    cost_usd: undefined,
    started_at: meta.startedAt,
    ended_at: meta.endedAt,
    effective_model: state.effectiveModel,
    effective_permission_mode: state.effectivePermissionMode,
    mcp_servers: state.mcpServers,
    agent_version_reported: meta.agentVersionReported,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export interface ObserveCursorRunInput extends CursorObservationMeta {
  streamText: string;
  streamAt?: number;
}

/** The pure parse step over recorded text: no I/O, no clock, no process (for a future replay). */
export function observeCursorRun(input: ObserveCursorRunInput): RunObservation {
  const state = newCursorStreamState();
  const at = input.streamAt ?? 0;
  for (const line of input.streamText.split('\n')) parseCursorStreamLine(line, at, state);
  return assembleCursorObservation(state, input);
}

// --- helpers --------------------------------------------------------------------------------

function command(bin: string, argv: string[]): { cmd: string; args: string[] } {
  const isNodeScript = /\.(mjs|cjs|js)$/i.test(bin);
  return isNodeScript ? { cmd: process.execPath, args: [bin, ...argv] } : { cmd: bin, args: argv };
}

/** Upper bound for `--version`: a probe that blocks (e.g. on an update) must not hang the run,
 *  which the abort signal cannot interrupt while spawnSync is blocking. */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

function probeVersion(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const { cmd, args } = command(bin, ['--version']);
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env, timeout: VERSION_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return undefined;
    const out = res.stdout.trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function hasClaudeSettingsHooks(workdir: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(workdir, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as { hooks?: unknown };
    return !!settings.hooks && typeof settings.hooks === 'object' && Object.keys(settings.hooks).length > 0;
  } catch {
    return false;
  }
}

function versionMatches(pinned: string, reported: string): boolean {
  const a = pinned.match(/\d+\.\d+\.\d+/)?.[0];
  const b = reported.match(/\d+\.\d+\.\d+/)?.[0];
  return a !== undefined && a === b;
}

function signalNumber(sig: NodeJS.Signals): number | undefined {
  const n = (osConstants.signals as Record<string, number>)[sig];
  return typeof n === 'number' ? n : undefined;
}
