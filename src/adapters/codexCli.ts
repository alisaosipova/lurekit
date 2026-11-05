// Codex CLI adapter (ADR-0018; facts: NOTES-verified-facts.md § Codex CLI; invariants:
// evidence-spec §4.1). Pure plumbing: launch `codex exec --json` headless under a SetupProfile,
// capture its JSONL stream verbatim, and return a RunObservation. It carries no attack content.
//
// Invariants (§4.1): (1) never loosen the profile — every permission-relevant flag (--sandbox,
// --approve-for-me, --dangerously-bypass-approvals-and-sandbox,
// --skip-git-repo-check, --dangerously-bypass-hook-trust) is emitted only when the profile's
// permission_mode literally names it; the adapter adds none on its own, so `codex exec` keeps its
// documented read-only sandbox default; (2) observe, do not steer — the adapter installs nothing
// into the workdir. It only points CODEX_HOME at a run-scoped directory under runDir (isolation).
//
// Observation layer: `stream` only. Whether hooks fire under `codex exec` is UNVERIFIED (NOTES),
// so the `hook` layer is not declared until a recorded run proves it (ADR-0018 §Decision 6).
//
// Determinism (§4.5): the parse step is the exported pure `observeCodexRun`; tests drive an
// offline stub binary (test/fixtures/agents/stub-codex.mjs). No live agent, network or spend.

import { mkdir, stat } from 'node:fs/promises';
import { safeWriteFile } from '../runner/safeWrite.js';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { Adapter,
  AdapterCapabilities, ObservationSource, RunObservation, RunOptions, SetupProfile, ToolCall } from './adapter.js';
import { requireWorkdir, stderrExcerpt } from './adapter.js';
import { agentChildEnv, argvRecord, CappedStderr, envNames } from './childEnv.js';
import { createLineSplitter, killTree, probeVersionCapped, reapGroup, spawnAgent, waitExit } from './childProcess.js';
import type { AgentId } from '../scenario/types.js';

export const CODEX_STREAM_FILE = 'codex-stream.jsonl';
export const CODEX_STDERR_FILE = 'codex-stderr.log';
export const CODEX_ARGV_FILE = 'codex-argv.json';
/** Run-scoped CODEX_HOME directory name under runDir (ADR-0018 §Decision 4). */
export const CODEX_HOME_DIR = 'codex-home';

/** Env var that overrides the `codex` binary path (so tests point at a stub). */
export const CODEX_BIN_ENV = 'AAB_CODEX_BIN';

export interface CodexCliAdapterOptions {
  bin?: string;    // explicit binary path; else env override; else 'codex' on PATH
  runDir?: string; // default run dir if run() is not given one
  /** Point CODEX_HOME at `<runDir>/codex-home` (default true). `false` inherits the operator's
   *  CODEX_HOME (or ~/.codex) and is recorded as a warning: user config, hook trust records and
   *  history then leak into the run. A CODEX_HOME in profile.env always wins (also warned). */
  isolateCodexHome?: boolean;
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The Codex-specific permission flags a profile may name (ADR-0018 §Decision 1). */
export interface CodexPermissionFlags {
  sandbox?: CodexSandbox;
  approveForMe?: boolean;
  bypassApprovalsAndSandbox?: boolean;
  skipGitRepoCheck?: boolean;
  bypassHookTrust?: boolean;
}

const SANDBOX_VALUES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];
/** `codex exec` subcommands (exec/src/cli.rs `Command`): a task equal to one of these would be
 *  parsed as the subcommand, not as the prompt. */
const EXEC_SUBCOMMANDS: readonly string[] = ['resume', 'fork', 'review'];

/** Parse `profile.permission_mode` for Codex. Grammar: tokens separated by commas and/or
 *  whitespace; each token maps to exactly one flag:
 *    sandbox=read-only|workspace-write|danger-full-access  -> --sandbox <v>
 *    approve-for-me                                        -> --approve-for-me
 *    dangerously-bypass-approvals-and-sandbox | yolo       -> --dangerously-bypass-approvals-and-sandbox
 *    skip-git-repo-check                                   -> --skip-git-repo-check
 *    bypass-hook-trust                                     -> --dangerously-bypass-hook-trust
 *  An unknown or conflicting token throws: silently dropping it could run the agent looser
 *  than the profile intends (§4.1 invariant 1). `--approve-for-me` conflicts with `--sandbox`
 *  and `--yolo` (NOTES); the bypass flag together with sandbox is ambiguous and also rejected.
 *  There is no `approval=` token: `--ask-for-approval` is a TUI-only option that `codex exec`
 *  does not accept (NOTES; exec/src/cli.rs vs tui/src/cli.rs), so emitting it would fail the run. */
export function parseCodexPermissionMode(mode: string | undefined): CodexPermissionFlags {
  const out: CodexPermissionFlags = {};
  if (mode === undefined) return out;
  const tokens = mode.split(/[\s,]+/).filter((t) => t.length > 0);
  for (const t of tokens) {
    if (t.startsWith('sandbox=')) {
      const v = t.slice('sandbox='.length);
      if (!SANDBOX_VALUES.includes(v)) throw new Error(`codex-cli: unknown sandbox value "${v}" in permission_mode (allowed: ${SANDBOX_VALUES.join(', ')})`);
      if (out.sandbox !== undefined && out.sandbox !== v) throw new Error('codex-cli: conflicting sandbox values in permission_mode');
      out.sandbox = v as CodexSandbox;
    } else if (t.startsWith('approval=')) {
      throw new Error('codex-cli: approval=... is not supported: codex exec has no --ask-for-approval option (it is TUI-only)');
    } else if (t === 'approve-for-me') out.approveForMe = true;
    else if (t === 'yolo' || t === 'dangerously-bypass-approvals-and-sandbox') out.bypassApprovalsAndSandbox = true;
    else if (t === 'skip-git-repo-check') out.skipGitRepoCheck = true;
    else if (t === 'bypass-hook-trust') out.bypassHookTrust = true;
    else {
      throw new Error(
        `codex-cli: unknown permission_mode token "${t}" (allowed: sandbox=<read-only|workspace-write|danger-full-access>, approve-for-me, yolo, skip-git-repo-check, bypass-hook-trust)`,
      );
    }
  }
  if (out.approveForMe && (out.sandbox !== undefined || out.bypassApprovalsAndSandbox)) {
    throw new Error('codex-cli: conflicting permission_mode: approve-for-me cannot be combined with sandbox=... or yolo');
  }
  if (out.bypassApprovalsAndSandbox && out.sandbox !== undefined) {
    throw new Error('codex-cli: conflicting permission_mode: yolo cannot be combined with sandbox=...');
  }
  return out;
}

/** Build the headless argv (ADR-0018 §Decision 1). Pure; exported for tests. */
export function buildCodexArgv(profile: Pick<SetupProfile, 'model' | 'workdir' | 'permission_mode'>, task: string): string[] {
  const flags = parseCodexPermissionMode(profile.permission_mode);
  // The prompt is positional; a task starting with '-' would be parsed as an option (e.g.
  // "--yolo") and could loosen the run, and a bare "-" reads the prompt from stdin (NOTES).
  // Refuse rather than rely on `--` handling, which no primary source documents for exec.
  if (task.startsWith('-')) {
    throw new Error('codex-cli: task text must not start with "-" (it would be parsed as a CLI option)');
  }
  if (EXEC_SUBCOMMANDS.includes(task.trim())) {
    throw new Error(`codex-cli: task text must not be an exec subcommand name (${EXEC_SUBCOMMANDS.join(', ')})`);
  }
  const argv = ['exec', '--json', '-C', requireWorkdir(profile, 'codex-cli'), '-m', profile.model];
  if (flags.sandbox) argv.push('--sandbox', flags.sandbox);
  if (flags.approveForMe) argv.push('--approve-for-me');
  if (flags.bypassApprovalsAndSandbox) argv.push('--dangerously-bypass-approvals-and-sandbox');
  if (flags.skipGitRepoCheck) argv.push('--skip-git-repo-check');
  if (flags.bypassHookTrust) argv.push('--dangerously-bypass-hook-trust');
  // evidence-spec s4.1 leading-dash guard (block 3): the verified end-of-options separator
  // (NOTES: `codex exec -- "--bogus-flag"` starts a thread) immediately before the task.
  argv.push('--', task);
  return argv;
}

/** Option names in a Codex argv, in order, values dropped (§4.3 evidence `agent_flags`). The
 *  task, workdir and model never enter evidence through this list. */
export function codexFlagNames(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // s4.1: the separator is part of what ran; everything after it is the task (a value).
      out.push(a);
      break;
    }
    if (!/^--?[A-Za-z]/.test(a)) continue;
    out.push(a);
    if (CODEX_VALUE_FLAGS.has(a)) i++;
  }
  return out;
}
const CODEX_VALUE_FLAGS = new Set(['-C', '-m', '--sandbox']);

export class CodexCliAdapter implements Adapter {
  readonly id: AgentId = 'codex-cli';
  private readonly binOverride?: string;
  private readonly defaultRunDir?: string;
  private readonly isolateCodexHome: boolean;

  constructor(opts: CodexCliAdapterOptions = {}) {
    this.binOverride = opts.bin;
    this.defaultRunDir = opts.runDir;
    this.isolateCodexHome = opts.isolateCodexHome !== false;
  }

  capabilities(): AdapterCapabilities {
    // ADR-0018 §Decision 2: the adapter installs nothing and background self-update is
    // UNVERIFIED -> no version pin; hooks under exec unverified -> stream only; -m pins input.
    // s4.4 block 8: this adapter writes no MCP config for the agent -> delivers_mcp_config: false.
    return { headless: true, observes: ['stream'], can_pin_version: false, can_pin_model: true, delivers_mcp_config: false };
  }

  /** Resolve the binary: constructor arg > env override > 'codex' on PATH. */
  private bin(): string {
    return this.binOverride ?? process.env[CODEX_BIN_ENV] ?? 'codex';
  }

  async run(profile: SetupProfile, task: string, signal: AbortSignal, options: RunOptions = {}): Promise<RunObservation> {
    const runDir = options.runDir ?? this.defaultRunDir;
    if (!runDir) {
      throw new Error('CodexCliAdapter.run: a runDir is required (pass options.runDir or construct with { runDir })');
    }
    // Validate the permission tokens and the task before anything is spawned.
    const argv = buildCodexArgv(profile, task);
    const flags = parseCodexPermissionMode(profile.permission_mode);
    await mkdir(runDir, { recursive: true });
    const workdir = requireWorkdir(profile, 'CodexCliAdapter.run');
    await mkdir(workdir, { recursive: true });

    const warnings: string[] = [];
    const bin = this.bin();
    // ADR-0008 amendment: an allow-listed env, never the whole operator environment.
    const env: NodeJS.ProcessEnv = agentChildEnv('codex-cli', profile.env);
    if (profile.env?.CODEX_HOME !== undefined) {
      warnings.push('profile.env sets CODEX_HOME; the run uses that home, not a run-scoped one');
    } else if (this.isolateCodexHome) {
      const home = path.join(runDir, CODEX_HOME_DIR);
      await mkdir(home, { recursive: true });
      env.CODEX_HOME = home;
      if (!env.CODEX_API_KEY) {
        // Names only, never values (CLAUDE.md secrets rule).
        warnings.push('CODEX_API_KEY is not set and CODEX_HOME is run-scoped, so saved CLI auth is not visible to this run');
      }
    } else {
      warnings.push('CODEX_HOME is not run-scoped (isolateCodexHome: false); user config, hook trust and history may leak into the run');
    }

    if (options.bare === true) {
      warnings.push('--bare is a Claude Code option; codex-cli has no equivalent and it was not applied');
    }
    if (!(await exists(path.join(workdir, '.git')))) {
      const ancestor = await ancestorGitRoot(workdir);
      if (ancestor !== undefined) {
        // Observed 2026-11-03 (codex-cli 0.166.0): exec in a .git-less workdir nested in a repo
        // passes the git check, because the git root is found upward (NOTES, Codex CLI section).
        warnings.push(
          `workdir has no .git entry but an ancestor is a git repository (${ancestor}); codex exec treats that as the project root, so the git check passes and project-root discovery (AGENTS.md, .codex/) may start above the workdir`,
        );
      } else if (!flags.skipGitRepoCheck && !flags.bypassApprovalsAndSandbox) {
        warnings.push('workdir has no .git entry; codex exec exits 1 outside a git repository unless skip-git-repo-check is requested');
      }
    }
    if (await exists(path.join(workdir, '.codex'))) {
      warnings.push('workdir has a project .codex/ layer; Codex loads it only for a trusted project and exec behaviour for a project with no trust entry is UNVERIFIED');
    }
    if (flags.bypassHookTrust) {
      warnings.push('--dangerously-bypass-hook-trust also un-gates hooks planted in the workdir .codex/, which changes what is measured');
    }

    const versionBefore = probeVersion(bin, env);
    if (!versionBefore) {
      warnings.push('could not read agent version from `--version`');
    } else if (profile.agent_version !== 'unpinned' && !versionMatches(profile.agent_version, versionBefore)) {
      warnings.push(`agent version mismatch: profile names ${profile.agent_version}, binary reports ${versionBefore}`);
    }

    // ADR-0025 D1/D2: the argv record is written symlink-safe and declared immutable; the
    // run-scoped home is agent-owned; the stream and stderr files are declared outputs.
    await safeWriteFile(runDir, CODEX_ARGV_FILE, JSON.stringify(argvRecord(bin, argv, task)));
    if (options.artefacts) {
      await options.artefacts.register({ path: CODEX_ARGV_FILE, kind: 'immutable' });
      await options.artefacts.register({ path: CODEX_HOME_DIR, kind: 'agent' });
      await options.artefacts.register({ path: CODEX_STREAM_FILE, kind: 'output' });
      await options.artefacts.register({ path: CODEX_STDERR_FILE, kind: 'output' });
    }

    const startedAt = Date.now();
    const perfStart = performance.now();
    const state = newCodexStreamState();
    const stdoutChunks: Buffer[] = [];
    const stderrCap = new CappedStderr();
    const splitter = createLineSplitter((line) => handleLine(line), (msg) => warnings.push(msg));
    const decoder = new StringDecoder('utf8');
    const handleLine = (line: string): void => {
      parseCodexStreamLine(line, performance.now() - perfStart, state);
    };

    const { cmd, args } = command(bin, argv);
    // ADR-0024 D5: own process group (POSIX), tracked, killed as a tree on abort.
    const child = spawnAgent(cmd, args, { cwd: workdir, env });
    const onAbort = (): void => {
      // SIGTERM to the whole tree first (the final event can still be flushed), then SIGKILL.
      void killTree(child);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    child.stdout!.on('data', (buf: Buffer) => {
      stdoutChunks.push(buf);
      splitter.push(decoder.write(buf)); // ENGINE-07: bounded, scans only new text
    });
    // stderr is kept verbatim up to STDERR_FILE_MAX: exec writes progress and errors there (NOTES).
    child.stderr!.on('data', (buf: Buffer) => stderrCap.push(buf));
    // Resolves on `exit`, then waits for `close` at most STDIO_DRAIN_MS (ADR-0024 D5): a
    // grandchild holding the stdout pipe cannot keep this adapter from returning.
    const exit = await waitExit(child);
    reapGroup(child); // B10 VERDICT-12: nothing the agent started outlives the repetition
    if (exit.error) warnings.push(`failed to spawn agent binary "${bin}"`);
    if (exit.drainTimedOut) warnings.push('agent stdio did not close after exit (a child process of the agent may still hold it); output read so far is kept');
    splitter.push(decoder.end());
    splitter.end();
    const exitCode: number = exit.exitCode;
    signal.removeEventListener('abort', onAbort);
    const endedAt = Date.now();

    const rawPath = path.join(runDir, CODEX_STREAM_FILE);
    const written = await safeWriteFile(runDir, rawPath, Buffer.concat(stdoutChunks));
    // ADR-0025 D2: a symlink planted at the stream name was unlinked, never written through;
    // the manifest records it as a planted output (a finding, so the run is never resisted).
    if (written.replacedSymlink) options.artefacts?.report({ path: CODEX_STREAM_FILE, kind: 'output', what: 'planted' });
    const stderrBuf = stderrCap.head();
    await safeWriteFile(runDir, CODEX_STDERR_FILE, stderrCap.fileContent());

    const versionAfter = probeVersion(bin, env);
    if (versionBefore && versionAfter && versionAfter !== versionBefore) {
      warnings.push(`agent version drifted during the run: ${versionBefore} -> ${versionAfter}`);
    }

    const observation = assembleCodexObservation(state, {
      rawEventsPath: rawPath,
      exitCode,
      startedAt,
      endedAt,
      agentVersionReported: versionBefore,
      agentFlags: codexFlagNames(argv),
      stderr: stderrBuf.toString('utf8'),
      warnings,
    });
    observation.env_forwarded = envNames(env);
    return observation;
  }
}

// --- pure parse step (evidence-spec §4.5) ------------------------------------------------

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CodexStreamState {
  calls: ToolCall[];
  byItemId: Map<string, ToolCall>;
  threadId?: string;
  usage: CodexUsage;
  sawTurnCompleted: boolean;
  /** s4.1 "Assistant text" (block 3): `item.text` of every completed `agent_message` item. */
  assistantText?: string[];
  failures: string[]; // turn.failed / error event / error item messages, verbatim
  /** `error` events of the form "Reconnecting... N/M (...)": counted, not listed one by one
   *  (an unauthenticated run emits nine of them, observed 2026-11-03; the raw file keeps all). */
  retries: number;
  lastRetry?: string;
}

export function newCodexStreamState(): CodexStreamState {
  return {
    calls: [],
    byItemId: new Map(),
    usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    sawTurnCompleted: false,
    failures: [],
    retries: 0,
  };
}

/** Item types that are not tool calls (NOTES § Codex CLI "Items"). */
const NON_TOOL_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

/** Name and input of a tool-call item, or undefined for a documented non-tool item. Typed:
 *  `command_execution` {command}, `file_change` {changes}, `mcp_tool_call` (name = tool,
 *  input {server, tool, arguments}), `web_search` {query}. Any other type (e.g. the source-only
 *  `collab_tool_call`) keeps the whole item as input under name 'unknown' (never dropped). */
export function describeCodexItem(item: Record<string, unknown>): { name: string; input: unknown } | undefined {
  const type = item.type;
  if (typeof type === 'string' && NON_TOOL_ITEM_TYPES.has(type)) return undefined;
  if (type === 'command_execution') return { name: 'command_execution', input: { command: item.command } };
  if (type === 'file_change') return { name: 'file_change', input: { changes: item.changes } };
  if (type === 'mcp_tool_call') {
    return {
      name: typeof item.tool === 'string' ? item.tool : 'mcp_tool_call',
      input: { server: item.server, tool: item.tool, arguments: item.arguments },
    };
  }
  if (type === 'web_search') return { name: 'web_search', input: { query: item.query } };
  return { name: 'unknown', input: item };
}

/** Parse one `--json` line into `state`. Non-JSON/blank lines and unknown event types or
 *  fields are ignored for parsing (the raw file keeps them verbatim). */
export function parseCodexStreamLine(line: string, at: number, state: CodexStreamState): void {
  const text = line.trim();
  if (!text) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return;
  const type = evt.type;
  if (type === 'thread.started') {
    if (typeof evt.thread_id === 'string') state.threadId = evt.thread_id;
  } else if (type === 'turn.completed') {
    state.sawTurnCompleted = true;
    const u = evt.usage as Record<string, unknown> | undefined;
    if (u && typeof u === 'object') {
      for (const k of Object.keys(state.usage) as Array<keyof CodexUsage>) {
        if (typeof u[k] === 'number') state.usage[k] += u[k];
      }
    }
  } else if (type === 'turn.failed') {
    const err = evt.error as Record<string, unknown> | undefined;
    state.failures.push(`turn.failed: ${typeof err?.message === 'string' ? err.message : 'no message'}`);
  } else if (type === 'error') {
    const message = typeof evt.message === 'string' ? evt.message : 'no message';
    if (CODEX_RETRY_RE.test(message)) {
      state.retries += 1;
      state.lastRetry = message;
    } else {
      state.failures.push(`error event: ${message}`);
    }
  } else if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = evt.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (item.type === 'error' && type === 'item.completed') {
      state.failures.push(`error item: ${typeof item.message === 'string' ? item.message : 'no message'}`);
    }
    if (item.type === 'agent_message' && type === 'item.completed') {
      state.assistantText ??= [];
      if (typeof item.text === 'string') state.assistantText.push(item.text);
    }
    const desc = describeCodexItem(item);
    if (!desc) return;
    const id = typeof item.id === 'string' ? item.id : undefined;
    const existing = id ? state.byItemId.get(id) : undefined;
    if (existing) {
      // started/updated/completed correlate by item.id: one ToolCall, first sighting's time,
      // latest input (fields may only be filled in by a later event).
      existing.name = desc.name;
      existing.input = desc.input;
      return;
    }
    const call: ToolCall = { id, name: desc.name, input: desc.input, at, source: 'stream', sources: ['stream'] };
    state.calls.push(call);
    if (id) state.byItemId.set(id, call);
  }
}

/** A transient-retry `error` event (observed 2026-11-03, codex-cli 0.166.0): the message starts
 *  "Reconnecting... <n>/<max> (". */
export const CODEX_RETRY_RE = /^Reconnecting\.\.\. \d+\/\d+ \(/;
/** The model API rejected the request for missing/invalid credentials (observed 2026-11-03:
 *  "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"). */
export const CODEX_AUTH_ERROR_RE = /\b401 Unauthorized\b/;

export interface CodexObservationMeta {
  rawEventsPath: string;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  agentVersionReported?: string;
  agentFlags?: string[];
  /** The run's stderr text; on a non-zero exit with no failure in the stream, an excerpt of it
   *  becomes a warning (e.g. "Error finding codex home: ..." before any JSON is printed). */
  stderr?: string;
  warnings?: string[];
}

export function assembleCodexObservation(state: CodexStreamState, meta: CodexObservationMeta): RunObservation {
  const warnings = [...(meta.warnings ?? [])];
  // NOTES: the --json stream carries no model field; the pin is applied on input (-m) only.
  warnings.push('codex --json stream reports no model; effective_model is unreported (pin applied on input only)');
  if (state.retries > 0) {
    warnings.push(`error event: ${state.retries} reconnect attempt(s) reported ("Reconnecting... n/max"), last: ${state.lastRetry ?? 'no message'}`);
  }
  for (const f of state.failures) warnings.push(f);
  if ([...state.failures, state.lastRetry ?? ''].some((f) => CODEX_AUTH_ERROR_RE.test(f))) {
    // Names only, never values (CLAUDE.md secrets rule).
    warnings.push('agent authentication failed: the model API answered 401 Unauthorized (no usable CODEX_API_KEY or saved auth in CODEX_HOME for this run)');
  }
  if (meta.exitCode !== 0 && state.failures.length === 0 && state.retries === 0) {
    const excerpt = meta.stderr !== undefined ? stderrExcerpt(meta.stderr) : undefined;
    warnings.push(excerpt !== undefined ? `agent exited ${meta.exitCode}; stderr: ${excerpt}` : `agent exited ${meta.exitCode} with no error in the stream`);
  }
  if (meta.exitCode === 0 && !state.sawTurnCompleted && state.failures.length === 0) {
    warnings.push('stream ended without a turn.completed event');
  }
  return {
    raw_events_path: meta.rawEventsPath,
    tool_calls: state.calls,
    exit_code: meta.exitCode,
    cost_usd: undefined, // no USD cost field in the stream (NOTES); tokens stay in the raw file
    started_at: meta.startedAt,
    ended_at: meta.endedAt,
    effective_model: undefined,
    agent_version_reported: meta.agentVersionReported,
    warnings,
    ...(meta.agentFlags ? { agent_flags: [...meta.agentFlags] } : {}),
    ...(state.assistantText ? { assistant_text: [...state.assistantText] } : {}),
    // §4.2 "Attempts": left empty on purpose. No permission-denial record is verified in the
    // Codex stream (a failed command_execution is not a gate denial), so the harness reports
    // none rather than guess (ADR-0018 §Decision 7).
    attempts: [],
  };
}

export interface ObserveCodexRunInput extends CodexObservationMeta {
  streamText: string;
  streamAt?: number;
}

/** The pure parse step over recorded text: no I/O, no clock, no process (for a future replay). */
export function observeCodexRun(input: ObserveCodexRunInput): RunObservation {
  const state = newCodexStreamState();
  const at = input.streamAt ?? 0;
  for (const line of input.streamText.split('\n')) parseCodexStreamLine(line, at, state);
  return assembleCodexObservation(state, input);
}

// --- helpers --------------------------------------------------------------------------------

function command(bin: string, argv: string[]): { cmd: string; args: string[] } {
  const isNodeScript = /\.(mjs|cjs|js)$/i.test(bin);
  return isNodeScript ? { cmd: process.execPath, args: [bin, ...argv] } : { cmd: bin, args: argv };
}

function probeVersion(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const { cmd, args } = command(bin, ['--version']);
  try {
    // ADR-0024 D5: capped (VERSION_PROBE_TIMEOUT_MS, SIGKILL on expiry) so a blocking probe cannot hang the run.
    const res = probeVersionCapped(cmd, args, env);
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return undefined;
    const out = res.stdout.trim();
    return out.length > 0 ? out : undefined; // recorded raw: the output format is UNVERIFIED
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The nearest ancestor of `dir` (exclusive) holding a `.git` entry, or undefined. */
async function ancestorGitRoot(dir: string): Promise<string | undefined> {
  let cur = path.dirname(path.resolve(dir));
  for (;;) {
    if (await exists(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

function versionMatches(pinned: string, reported: string): boolean {
  const a = pinned.match(/\d+\.\d+\.\d+/)?.[0];
  const b = reported.match(/\d+\.\d+\.\d+/)?.[0];
  return a !== undefined && a === b;
}

