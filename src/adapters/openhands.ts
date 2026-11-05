// OpenHands CLI adapter (ADR-0019; facts: NOTES-verified-facts.md § OpenHands; invariants:
// evidence-spec §4.1). Pure plumbing: launch the legacy `openhands --headless --json` CLI under a
// SetupProfile, capture its stdout verbatim, read the persisted conversation events as a
// cross-check, and return a RunObservation. It carries no attack content.
//
// Invariants (§4.1): (1) never loosen the profile — headless mode forces always-approve and has no
// sandbox (NOTES), so the adapter refuses to run unless permission_mode names `always-approve`; it
// adds no approval or sandbox flag itself; (2) observe, do not steer — nothing is written into the
// workdir; HOME and the OpenHands state dirs point at a run-scoped directory under runDir.
//
// Observation layer: `stream` only (ADR-0019 §Decision 3); the on-disk event log is a
// cross-check, not an ObservationSource.
//
// Determinism (§4.5): the parse step is the exported pure `observeOpenHandsRun`; tests drive an
// offline stub binary (test/fixtures/agents/stub-openhands.mjs). No live agent, network or spend.

import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { isInside, safeWriteFile } from '../runner/safeWrite.js';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { Adapter,
  AdapterCapabilities, ObservationSource, RunObservation, RunOptions, SetupProfile, ToolCall } from './adapter.js';
import { requireWorkdir } from './adapter.js';
import { agentChildEnv, argvRecord, CappedStderr, envNames } from './childEnv.js';
import { createLineSplitter, killTree, probeVersionCapped, reapGroup, spawnAgent, waitExit } from './childProcess.js';
import type { AgentId } from '../scenario/types.js';

export const OPENHANDS_STREAM_FILE = 'openhands-stream.jsonl';
export const OPENHANDS_STDERR_FILE = 'openhands-stderr.log';
export const OPENHANDS_ARGV_FILE = 'openhands-argv.json';
export const OPENHANDS_TRANSCRIPT_FILE = 'openhands-transcript.jsonl';
/** Run-scoped HOME under runDir (ADR-0019 §Decision 5). */
export const OPENHANDS_HOME_DIR = 'openhands-home';

/** Env var that overrides the `openhands` binary path (so tests point at a stub). */
export const OPENHANDS_BIN_ENV = 'AAB_OPENHANDS_BIN';

/** The env vars the adapter isolates (ADR-0019 §Decision 5). */
const ISOLATED_VARS = ['HOME', 'OPENHANDS_PERSISTENCE_DIR', 'OPENHANDS_CONVERSATIONS_DIR'] as const;

/** Warnings every run carries (ADR-0019 §Decision 2, §Decision 5; NOTES). */
export const OPENHANDS_POSTURE_WARNINGS: readonly string[] = [
  'openhands --headless forces approval always-approve and runs tools on the host with sandbox: none; the run must sit inside the bench container/VM boundary',
  'the openhands CLI is unmaintained upstream (legacy 1.x); no new flags are expected',
  'openhands loads public skills by git clone into the run-scoped home cache (network); offline failure behaviour is UNVERIFIED',
];

export interface OpenHandsAdapterOptions {
  bin?: string;    // explicit binary path; else env override; else 'openhands' on PATH
  runDir?: string; // default run dir if run() is not given one
  /** Point HOME, OPENHANDS_PERSISTENCE_DIR and OPENHANDS_CONVERSATIONS_DIR at
   *  `<runDir>/openhands-home` (default true). `false` inherits the operator's (warned). */
  isolateHome?: boolean;
}

/** Local-model configuration (ADR-0019 "Free local-model path"): env for an Ollama server on
 *  loopback. Pair with `profile.model = "openai/<served-model-name>"`. The API key is a
 *  non-secret placeholder (docs: "any placeholder value"). Not a default anywhere; the
 *  GUI-field-to-env mapping is UNVERIFIED until a recorded run. */
export function openhandsLocalModelEnv(opts: { host?: string; port?: number; apiKey?: string } = {}): Record<string, string> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 11434;
  return { LLM_BASE_URL: `http://${host}:${port}/v1`, LLM_API_KEY: opts.apiKey ?? 'local-llm' };
}

/** Parse `profile.permission_mode` for OpenHands. Grammar: tokens separated by commas and/or
 *  whitespace. The only accepted token is `always-approve` (alias `yolo`), and it is REQUIRED:
 *  headless forces it (NOTES), so a profile that does not name it cannot be honoured and the
 *  run is refused rather than silently loosened (§4.1 invariant 1). The token adds no flag. */
export function parseOpenHandsPermissionMode(mode: string | undefined): { alwaysApprove: true } {
  const tokens = (mode ?? '').split(/[\s,]+/).filter((t) => t.length > 0);
  let ack = false;
  for (const t of tokens) {
    if (t === 'always-approve' || t === 'yolo') ack = true;
    else if (t === 'llm-approve' || t === 'confirm' || t === 'always-confirm') {
      throw new Error(`openhands: permission_mode "${t}" is not available in headless mode (headless always runs always-approve)`);
    } else {
      throw new Error(`openhands: unknown permission_mode token "${t}" (allowed: always-approve)`);
    }
  }
  if (!ack) {
    throw new Error(
      'openhands: headless mode always runs always-approve with no sandbox; the profile must state permission_mode: always-approve to run it (pass --permission-mode always-approve)',
    );
  }
  return { alwaysApprove: true };
}

/** Build the headless argv (ADR-0019 §Decision 1). Pure; exported for tests. */
export function buildOpenHandsArgv(profile: Pick<SetupProfile, 'permission_mode'>, task: string): string[] {
  parseOpenHandsPermissionMode(profile.permission_mode);
  // `-t` takes a value; argparse would read a leading '-' as an option (e.g. "--llm-approve").
  if (task.startsWith('-')) {
    throw new Error('openhands: task text must not start with "-" (it would be parsed as a CLI option)');
  }
  return ['--headless', '--json', '--override-with-envs', '-t', task];
}

/** Option names in an OpenHands argv, in order, values dropped (§4.3 `agent_flags`). */
export function openhandsFlagNames(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!/^--?[A-Za-z]/.test(a)) continue;
    out.push(a);
    if (OPENHANDS_VALUE_FLAGS.has(a)) i++;
  }
  return out;
}
const OPENHANDS_VALUE_FLAGS = new Set(['-t', '--task', '-f', '--file']);

export interface OpenHandsEnvResult {
  env: NodeJS.ProcessEnv;
  home?: string;
  persistenceDir: string;
  conversationsDir: string;
  warnings: string[];
}

/** Build the child env (ADR-0019 §Decision 4, §Decision 5). Pure; exported for tests. Never
 *  records values of secrets, only names. */
export function buildOpenHandsEnv(
  profile: Pick<SetupProfile, 'model' | 'env'>,
  workdir: string,
  runDir: string,
  opts: { isolateHome: boolean; baseEnv?: NodeJS.ProcessEnv },
): OpenHandsEnvResult {
  const base = opts.baseEnv ?? process.env;
  const penv = profile.env ?? {};
  // ADR-0008 amendment: an allow-listed env, never the whole operator environment.
  const env: NodeJS.ProcessEnv = agentChildEnv('openhands', penv, base);
  const warnings: string[] = [];

  const home = path.join(runDir, OPENHANDS_HOME_DIR);
  const isoValues: Record<(typeof ISOLATED_VARS)[number], string> = {
    HOME: home,
    OPENHANDS_PERSISTENCE_DIR: path.join(home, '.openhands'),
    OPENHANDS_CONVERSATIONS_DIR: path.join(home, '.openhands', 'conversations'),
  };
  let usedHome: string | undefined;
  if (opts.isolateHome) {
    for (const k of ISOLATED_VARS) {
      if (penv[k] !== undefined) warnings.push(`profile.env sets ${k}; the run uses that value, not a run-scoped one`);
      else env[k] = isoValues[k];
    }
    if (penv.HOME === undefined) usedHome = home;
  } else {
    warnings.push('HOME and OpenHands state dirs are not run-scoped (isolateHome: false); stored settings, hooks, skills and MCP config may leak into the run');
  }
  const persistenceDir = env.OPENHANDS_PERSISTENCE_DIR ?? path.join(env.HOME ?? '', '.openhands');
  const conversationsDir = env.OPENHANDS_CONVERSATIONS_DIR ?? path.join(persistenceDir, 'conversations');

  if (penv.OPENHANDS_WORK_DIR !== undefined && penv.OPENHANDS_WORK_DIR !== workdir) {
    warnings.push('profile.env sets OPENHANDS_WORK_DIR; overridden with the per-run workdir');
  }
  env.OPENHANDS_WORK_DIR = workdir;

  if (penv.LLM_MODEL !== undefined && penv.LLM_MODEL !== profile.model) {
    warnings.push('profile.env sets LLM_MODEL; overridden with profile.model (the pinned model)');
  }
  env.LLM_MODEL = profile.model;

  if (!env.LLM_API_KEY) {
    warnings.push('LLM_API_KEY is not set; with no stored settings --override-with-envs needs it, so the CLI will fail to start');
  }
  if (penv.LLM_BASE_URL === undefined && base.LLM_BASE_URL !== undefined) {
    warnings.push('LLM_BASE_URL is inherited from the operator environment, not set by the profile');
  }
  if (env.LLM_BASE_URL && isLocalUrl(env.LLM_BASE_URL)) {
    warnings.push('local-model base URL: mapping the documented GUI local-LLM fields to LLM_MODEL/LLM_BASE_URL/LLM_API_KEY is UNVERIFIED until a recorded run');
  }
  return { env, home: usedHome, persistenceDir, conversationsDir, warnings };
}

function isLocalUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === 'host.docker.internal';
  } catch {
    return false;
  }
}

export class OpenHandsAdapter implements Adapter {
  readonly id: AgentId = 'openhands';
  private readonly binOverride?: string;
  private readonly defaultRunDir?: string;
  private readonly isolateHome: boolean;

  constructor(opts: OpenHandsAdapterOptions = {}) {
    this.binOverride = opts.bin;
    this.defaultRunDir = opts.runDir;
    this.isolateHome = opts.isolateHome !== false;
  }

  capabilities(): AdapterCapabilities {
    // ADR-0019 §Decision 3: installs nothing, pin form and self-update UNVERIFIED -> no version
    // pin; LLM_MODEL with --override-with-envs and no settings file determines the LLM.
    // s4.4 block 8: this adapter writes no MCP config for the agent -> delivers_mcp_config: false.
    return { headless: true, observes: ['stream'], can_pin_version: false, can_pin_model: true, delivers_mcp_config: false };
  }

  /** Resolve the binary: constructor arg > env override > 'openhands' on PATH. */
  private bin(): string {
    return this.binOverride ?? process.env[OPENHANDS_BIN_ENV] ?? 'openhands';
  }

  async run(profile: SetupProfile, task: string, signal: AbortSignal, options: RunOptions = {}): Promise<RunObservation> {
    const runDir = options.runDir ?? this.defaultRunDir;
    if (!runDir) {
      throw new Error('OpenHandsAdapter.run: a runDir is required (pass options.runDir or construct with { runDir })');
    }
    // Validate the permission tokens and the task before anything is spawned or written.
    const argv = buildOpenHandsArgv(profile, task);
    const workdir = requireWorkdir(profile, 'OpenHandsAdapter.run');
    await mkdir(runDir, { recursive: true });
    await mkdir(workdir, { recursive: true });

    const built = buildOpenHandsEnv(profile, workdir, runDir, { isolateHome: this.isolateHome });
    const { env, conversationsDir, persistenceDir } = built;
    const warnings: string[] = [...built.warnings];
    if (built.home) await mkdir(built.home, { recursive: true });
    if (this.isolateHome) {
      await mkdir(persistenceDir, { recursive: true });
      await mkdir(conversationsDir, { recursive: true });
    }
    if (await exists(path.join(persistenceDir, 'agent_settings.json'))) {
      warnings.push('a stored agent_settings.json exists in the persistence dir; env overrides only partly replace it');
    }

    if (options.bare === true) {
      warnings.push('--bare is a Claude Code option; openhands has no equivalent and it was not applied');
    }
    if (await exists(path.join(workdir, '.openhands', 'hooks.json'))) {
      warnings.push('workdir has .openhands/hooks.json; OpenHands loads it without a trust gate and it replaces the user hooks file');
    }

    const bin = this.bin();
    const versionBefore = probeVersion(bin, env);
    if (!versionBefore) {
      warnings.push('could not read agent version from `--version`');
    } else if (profile.agent_version !== 'unpinned' && !versionMatches(profile.agent_version, versionBefore)) {
      warnings.push(`agent version mismatch: profile names ${profile.agent_version}, binary reports ${versionBefore}`);
    }

    // ADR-0025 D1/D2: argv record symlink-safe and immutable; the run-scoped home and the
    // persistence dirs (when inside the run dir) are agent-owned; stream, stderr and the
    // transcript are declared outputs.
    await safeWriteFile(runDir, OPENHANDS_ARGV_FILE, JSON.stringify(argvRecord(bin, argv, task)));
    if (options.artefacts) {
      await options.artefacts.register({ path: OPENHANDS_ARGV_FILE, kind: 'immutable' });
      for (const dir of [built.home, persistenceDir, conversationsDir]) {
        if (dir && isInside(runDir, dir)) await options.artefacts.register({ path: dir, kind: 'agent' });
      }
      await options.artefacts.register({ path: OPENHANDS_STREAM_FILE, kind: 'output' });
      await options.artefacts.register({ path: OPENHANDS_STDERR_FILE, kind: 'output' });
      await options.artefacts.register({ path: OPENHANDS_TRANSCRIPT_FILE, kind: 'output' });
    }

    const startedAt = Date.now();
    const perfStart = performance.now();
    const state = newOpenHandsStreamState();
    const stdoutChunks: Buffer[] = [];
    const stderrCap = new CappedStderr();
    const splitter = createLineSplitter((line) => handleLine(line), (msg) => warnings.push(msg));
    const decoder = new StringDecoder('utf8');
    const handleLine = (line: string): void => {
      parseOpenHandsStreamLine(line, performance.now() - perfStart, state);
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

    const rawPath = path.join(runDir, OPENHANDS_STREAM_FILE);
    const written = await safeWriteFile(runDir, rawPath, Buffer.concat(stdoutChunks));
    // ADR-0025 D2: a symlink planted at the stream name was unlinked, never written through;
    // the manifest records it as a planted output (a finding, so the run is never resisted).
    if (written.replacedSymlink) options.artefacts?.report({ path: OPENHANDS_STREAM_FILE, kind: 'output', what: 'planted' });
    await safeWriteFile(runDir, OPENHANDS_STDERR_FILE, stderrCap.fileContent());

    const versionAfter = probeVersion(bin, env);
    if (versionBefore && versionAfter && versionAfter !== versionBefore) {
      warnings.push(`agent version drifted during the run: ${versionBefore} -> ${versionAfter}`);
    }

    // The single-subdirectory fallback is safe only in a run-scoped conversations dir; in an
    // operator's dir it could pick up an older conversation (stale model / cost).
    const rel = path.relative(runDir, conversationsDir);
    const runScoped = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    const persisted = await readConversation(conversationsDir, state.conversationId, runScoped);
    let transcriptPath: string | undefined;
    if (persisted.eventTexts.length > 0) {
      transcriptPath = path.join(runDir, OPENHANDS_TRANSCRIPT_FILE);
      await safeWriteFile(runDir, transcriptPath, persisted.eventTexts.map((t) => compactJson(t)).join('\n') + '\n');
    }
    warnings.push(...persisted.warnings);

    const observation = assembleOpenHandsObservation(state, {
      rawEventsPath: rawPath,
      transcriptPath,
      transcriptEvents: persisted.eventTexts,
      baseState: persisted.baseState,
      requestedModel: profile.model,
      localModel: env.LLM_BASE_URL ? isLocalUrl(env.LLM_BASE_URL) : false,
      exitCode,
      startedAt,
      endedAt,
      agentVersionReported: versionBefore,
      agentFlags: openhandsFlagNames(argv),
      warnings,
    });
    observation.env_forwarded = envNames(env);
    return observation;
  }
}

// --- pure parse step (evidence-spec §4.5) ------------------------------------------------

export interface OpenHandsStreamState {
  calls: ToolCall[];
  byToolCallId: Map<string, ToolCall>;
  /** Observation results by tool_call_id: observation kind and terminal exit_code if any. */
  observations: Map<string, { kind?: string; exit_code?: number }>;
  orphanObservations: string[];
  actionCount: number;
  effectiveModel?: string;
  conversationId?: string;
  sawSettingsMissing: boolean;
  /** Events whose `kind` the parser does not interpret, kept raw (ADR-0019 §Decision 6). */
  unknownEvents: Record<string, unknown>[];
  failures: string[]; // AgentErrorEvent / UserRejectObservation / blocked hooks, verbatim
  /** s4.1 "Assistant text" (block 3, shape UNVERIFIED): `text` of `llm_message.content[]`
   *  entries with `type: "text"` on MessageEvent with `source: "agent"`; set once seen. */
  assistantText?: string[];
}

export function newOpenHandsStreamState(): OpenHandsStreamState {
  return {
    calls: [],
    byToolCallId: new Map(),
    observations: new Map(),
    orphanObservations: [],
    actionCount: 0,
    sawSettingsMissing: false,
    unknownEvents: [],
    failures: [],
  };
}

/** Event kinds parsed for something other than tool calls, or deliberately not tool calls. */
const KNOWN_NON_TOOL_KINDS = new Set(['MessageEvent', 'SystemPromptEvent']);

/** Name and input of an ActionEvent (ADR-0019 §Decision 6). Exported for tests. */
export function describeOpenHandsAction(evt: Record<string, unknown>): { name: string; input: unknown } {
  const action = asRecord(evt.action);
  const kind = typeof action?.kind === 'string' ? action.kind : undefined;
  const name = typeof evt.tool_name === 'string' ? evt.tool_name : kind ?? 'unknown';
  if (!action) return { name, input: undefined };
  if (kind === 'TerminalAction') return { name, input: { command: action.command } };
  if (kind === 'FileEditorAction') {
    const input: Record<string, unknown> = {};
    for (const k of ['command', 'path', 'file_text', 'old_str', 'new_str', 'insert_line', 'view_range']) {
      if (action[k] !== undefined && action[k] !== null) input[k] = action[k];
    }
    return { name, input };
  }
  if (kind === 'MCPToolAction') return { name, input: { tool_name: evt.tool_name, arguments: action.data } };
  return { name, input: action };
}

const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MODEL_ECHO = /Agent initialized with model:\s*(\S+)/;
const CONVERSATION_ID = /Conversation ID:\s*([0-9a-fA-F-]+)/;

/** Parse one stdout line into `state`. Rich text lines are skipped except the model echo, the
 *  "Conversation ID:" line and the missing-settings message (the raw file keeps everything). */
export function parseOpenHandsStreamLine(line: string, at: number, state: OpenHandsStreamState): void {
  // Rich may colour text lines; strip ANSI SGR/CSI sequences before matching (raw file keeps them).
  const text = line.replace(ANSI_CSI, '').trim();
  if (!text) return;
  let evt: Record<string, unknown> | undefined;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      evt = asRecord(parsed);
    } catch {
      evt = undefined;
    }
  }
  if (!evt) {
    const m = MODEL_ECHO.exec(text);
    if (m && state.effectiveModel === undefined) state.effectiveModel = m[1];
    const c = CONVERSATION_ID.exec(text);
    if (c) state.conversationId = c[1];
    if (text.includes('Headless mode requires existing settings')) state.sawSettingsMissing = true;
    return;
  }
  applyOpenHandsEvent(evt, at, state);
}

/** Apply one parsed SDK event (stream or transcript) to `state`. */
export function applyOpenHandsEvent(evt: Record<string, unknown>, at: number, state: OpenHandsStreamState): void {
  const kind = evt.kind;
  const tcid = typeof evt.tool_call_id === 'string' ? evt.tool_call_id : undefined;
  if (kind === 'ActionEvent') {
    state.actionCount++;
    const desc = describeOpenHandsAction(evt);
    const existing = tcid ? state.byToolCallId.get(tcid) : undefined;
    if (existing) {
      existing.name = desc.name;
      existing.input = desc.input;
      return;
    }
    const call: ToolCall = { id: tcid, name: desc.name, input: desc.input, at, source: 'stream', sources: ['stream'] };
    state.calls.push(call);
    if (tcid) state.byToolCallId.set(tcid, call);
  } else if (kind === 'ObservationEvent') {
    const obs = asRecord(evt.observation);
    const rec: { kind?: string; exit_code?: number } = {};
    if (typeof obs?.kind === 'string') rec.kind = obs.kind;
    if (typeof obs?.exit_code === 'number') rec.exit_code = obs.exit_code;
    if (tcid) {
      state.observations.set(tcid, rec);
      if (!state.byToolCallId.has(tcid)) state.orphanObservations.push(tcid);
    }
  } else if (kind === 'AgentErrorEvent') {
    state.failures.push(`AgentErrorEvent: ${typeof evt.error === 'string' ? evt.error : 'no message'}`);
  } else if (kind === 'UserRejectObservation') {
    state.failures.push(
      `UserRejectObservation (${typeof evt.rejection_source === 'string' ? evt.rejection_source : 'unknown source'}): ${typeof evt.rejection_reason === 'string' ? evt.rejection_reason : 'no reason'}`,
    );
  } else if (kind === 'HookExecutionEvent') {
    if (evt.blocked === true) {
      state.failures.push(
        `HookExecutionEvent blocked ${typeof evt.hook_event_type === 'string' ? evt.hook_event_type : 'hook'}: ${typeof evt.reason === 'string' ? evt.reason : 'no reason'}`,
      );
    }
  } else if (kind === 'MessageEvent' && evt.source === 'agent') {
    // s4.1 "Assistant text" (block 3): the agent's own message; shape UNVERIFIED, so only the
    // named form is read and the field stays absent when it never matches.
    const llm = asRecord(evt.llm_message);
    if (Array.isArray(llm?.content)) {
      state.assistantText ??= [];
      for (const entry of llm.content as unknown[]) {
        const e = asRecord(entry);
        if (e && e.type === 'text' && typeof e.text === 'string') state.assistantText.push(e.text);
      }
    }
  } else if (typeof kind === 'string' && KNOWN_NON_TOOL_KINDS.has(kind)) {
    // Not a tool call; kept verbatim in the raw file.
  } else {
    state.unknownEvents.push(evt);
  }
}

export interface OpenHandsObservationMeta {
  rawEventsPath: string;
  transcriptPath?: string;
  /** Raw text of each persisted event file, in file-name order. */
  transcriptEvents?: string[];
  /** Parsed base_state.json, if read. */
  baseState?: unknown;
  requestedModel?: string;
  localModel?: boolean;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  agentVersionReported?: string;
  agentFlags?: string[];
  warnings?: string[];
}

export function assembleOpenHandsObservation(state: OpenHandsStreamState, meta: OpenHandsObservationMeta): RunObservation {
  const warnings = [...OPENHANDS_POSTURE_WARNINGS, ...(meta.warnings ?? [])];
  const base = asRecord(meta.baseState);
  const stateModel = asRecord(asRecord(base?.agent)?.llm)?.model;
  const effectiveModel = state.effectiveModel ?? (typeof stateModel === 'string' ? stateModel : undefined);
  if (effectiveModel === undefined) {
    warnings.push('openhands reported no model (no "Agent initialized with model" line and no base_state.json agent.llm.model)');
  } else if (meta.requestedModel !== undefined && effectiveModel !== meta.requestedModel) {
    warnings.push(`model mismatch: pinned ${meta.requestedModel}, agent reports ${effectiveModel}`);
  }
  if (state.sawSettingsMissing) warnings.push('openhands printed "Headless mode requires existing settings."; the agent did not run');
  for (const f of state.failures) warnings.push(f);
  for (const id of state.orphanObservations) warnings.push(`observation for tool_call_id ${id} has no matching ActionEvent in the stream`);
  if (state.unknownEvents.length > 0) {
    const kinds = [...new Set(state.unknownEvents.map((e) => (typeof e.kind === 'string' ? e.kind : '(no kind)')))];
    warnings.push(`stream carried ${state.unknownEvents.length} event(s) of uninterpreted kind: ${kinds.join(', ')} (kept raw)`);
  }

  // Transcript cross-check (ADR-0019 §Decision 7): actions persisted but not streamed.
  if (meta.transcriptEvents && meta.transcriptEvents.length > 0) {
    const t = newOpenHandsStreamState();
    for (const text of meta.transcriptEvents) {
      try {
        const e = asRecord(JSON.parse(text) as unknown);
        if (e) applyOpenHandsEvent(e, 0, t);
      } catch {
        /* a malformed event file stays on disk verbatim */
      }
    }
    const missing = t.calls.filter((c) => c.id !== undefined && !state.byToolCallId.has(c.id)).map((c) => c.id);
    if (missing.length > 0) {
      warnings.push(`transcript has ${missing.length} action(s) absent from the stream: ${missing.join(', ')}`);
    }
  }

  if (meta.exitCode === 0 && state.actionCount === 0) {
    warnings.push(
      meta.localModel
        ? 'no ActionEvent seen: inconclusive run (local models may answer like a plain chatbot and never call tools)'
        : 'no ActionEvent seen: inconclusive run',
    );
  }

  const cost = sumAccumulatedCost(base);
  return {
    raw_events_path: meta.rawEventsPath,
    ...(meta.transcriptPath ? { transcript_path: meta.transcriptPath } : {}),
    tool_calls: state.calls,
    exit_code: meta.exitCode,
    // Only a non-zero persisted accumulated_cost is reported (local models may have no price).
    cost_usd: cost !== undefined && cost > 0 ? cost : undefined,
    started_at: meta.startedAt,
    ended_at: meta.endedAt,
    effective_model: effectiveModel,
    agent_version_reported: meta.agentVersionReported,
    warnings,
    ...(meta.agentFlags ? { agent_flags: [...meta.agentFlags] } : {}),
    ...(state.assistantText ? { assistant_text: [...state.assistantText] } : {}),
    // §4.2 "Attempts": empty on purpose. Headless is NeverConfirm, so no permission gate refuses
    // calls; UserRejectObservation semantics are UNVERIFIED (ADR-0019 §Decision 8).
    attempts: [],
  };
}

/** Sum every `accumulated_cost` found under any `usage_to_metrics` map in base_state.json. */
function sumAccumulatedCost(base: Record<string, unknown> | undefined): number | undefined {
  if (!base) return undefined;
  let total: number | undefined;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    const r = asRecord(v);
    if (!r) return;
    for (const [k, child] of Object.entries(r)) {
      if (k === 'usage_to_metrics') {
        const m = asRecord(child);
        if (!m) continue;
        for (const metrics of Object.values(m)) {
          const c = asRecord(metrics)?.accumulated_cost;
          if (typeof c === 'number') total = (total ?? 0) + c;
        }
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(base, 0);
  return total;
}

export interface ObserveOpenHandsRunInput extends OpenHandsObservationMeta {
  streamText: string;
  streamAt?: number;
}

/** The pure parse step over recorded text: no I/O, no clock, no process (for a future replay). */
export function observeOpenHandsRun(input: ObserveOpenHandsRunInput): RunObservation {
  const state = newOpenHandsStreamState();
  const at = input.streamAt ?? 0;
  for (const line of input.streamText.split('\n')) parseOpenHandsStreamLine(line, at, state);
  return assembleOpenHandsObservation(state, input);
}

// --- helpers --------------------------------------------------------------------------------

/** Read the persisted conversation: `<conversations>/<id>/base_state.json` and
 *  `events/event-*.json` in name order (NOTES: one file per event). */
async function readConversation(
  conversationsDir: string,
  conversationId: string | undefined,
  allowSingleDirFallback: boolean,
): Promise<{ eventTexts: string[]; baseState?: unknown; warnings: string[] }> {
  const warnings: string[] = [];
  let dir: string | undefined;
  const candidates = conversationId ? [conversationId, conversationId.replace(/-/g, '')] : [];
  for (const c of candidates) {
    if (await exists(path.join(conversationsDir, c))) {
      dir = path.join(conversationsDir, c);
      break;
    }
  }
  if (!dir && !allowSingleDirFallback) {
    warnings.push('no Conversation ID line matched and the conversations dir is not run-scoped; transcript not read');
  } else if (!dir) {
    let entries: string[] = [];
    try {
      const all = await readdir(conversationsDir, { withFileTypes: true });
      entries = all.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      entries = [];
    }
    if (entries.length === 1) dir = path.join(conversationsDir, entries[0]);
    else if (entries.length > 1) warnings.push(`conversations dir has ${entries.length} conversations and no Conversation ID line matched; transcript not read`);
  }
  if (!dir) return { eventTexts: [], warnings };
  let baseState: unknown;
  try {
    baseState = JSON.parse(await readFile(path.join(dir, 'base_state.json'), 'utf8')) as unknown;
  } catch {
    baseState = undefined;
  }
  const eventTexts: string[] = [];
  try {
    const names = (await readdir(path.join(dir, 'events'))).filter((n) => /^event-\d+.*\.json$/.test(n)).sort();
    for (const n of names) eventTexts.push(await readFile(path.join(dir, 'events', n), 'utf8'));
  } catch {
    /* no events dir */
  }
  return { eventTexts, baseState, warnings };
}

function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify({ unparsed_event_file: text });
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

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
    return out.length > 0 ? out : undefined; // recorded raw (format from source, not from a run)
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

function versionMatches(pinned: string, reported: string): boolean {
  const a = pinned.match(/\d+\.\d+\.\d+/)?.[0];
  const b = reported.match(/\d+\.\d+\.\d+/)?.[0];
  return a !== undefined && a === b;
}

