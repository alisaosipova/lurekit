// OpenHands CLI adapter tests (ADR-0019; evidence-spec §4.1, §4.5). Fully offline: the adapter is
// pointed at test/fixtures/agents/stub-openhands.mjs, so NO real `openhands` is spawned, no
// network is touched and nothing is spent.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  OPENHANDS_BIN_ENV,
  OPENHANDS_POSTURE_WARNINGS,
  OpenHandsAdapter,
  buildOpenHandsArgv,
  buildOpenHandsEnv,
  describeOpenHandsAction,
  newOpenHandsStreamState,
  observeOpenHandsRun,
  openhandsFlagNames,
  openhandsLocalModelEnv,
  parseOpenHandsPermissionMode,
  parseOpenHandsStreamLine,
} from '../src/adapters/openhands.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { defaultDeps } from '../src/cli.js';
import { realpathOf } from './helpers/osPaths.js';
import { mkScratch } from './helpers/scratch.js';
import { pollUntil } from './helpers/deadline.js';

const STUB = fileURLToPath(new URL('./fixtures/agents/stub-openhands.mjs', import.meta.url));
const MODEL = 'anthropic/claude-sonnet-4-5';
const TASK = 'do the benign thing';
const ACK = 'always-approve';
const LOOSENING = ['--always-approve', '--yolo', '--llm-approve', '--exit-without-confirmation'];

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface StubEnv {
  cwd: string; HOME: string | null; OPENHANDS_PERSISTENCE_DIR: string | null; OPENHANDS_CONVERSATIONS_DIR: string | null;
  OPENHANDS_WORK_DIR: string | null; LLM_MODEL: string | null; LLM_BASE_URL: string | null; LLM_API_KEY_set: boolean;
}
interface Harness { profile: SetupProfile; runDir: string; argvPath: string; envPath: string; versionFile: string; }

async function harness(overrides: Partial<SetupProfile> = {}, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const base = await mkScratch('aab-openhands-adapter-');
  tmpDirs.push(base);
  const runDir = path.join(base, 'run');
  const argvPath = path.join(base, 'stub-argv.json');
  const envPath = path.join(base, 'stub-env.json');
  const versionFile = path.join(base, 'stub-version');
  await writeFile(versionFile, 'OpenHands CLI 1.16.0', 'utf8');
  const workdir = path.join(base, 'work');
  await mkdir(workdir, { recursive: true });
  const profile: SetupProfile = {
    agent: 'openhands',
    agent_version: 'openhands@1.16.0',
    model: MODEL,
    workdir,
    permission_mode: ACK,
    // Placeholder value only: the stub never reads it beyond presence.
    env: { AAB_STUB_ARGV_OUT: argvPath, AAB_STUB_ENV_OUT: envPath, AAB_STUB_VERSION_FILE: versionFile, LLM_API_KEY: 'aab-test-placeholder', ...extraEnv },
    ...overrides,
  };
  return { profile, runDir, argvPath, envPath, versionFile };
}

const adapter = (opts: { isolateHome?: boolean } = {}): OpenHandsAdapter => new OpenHandsAdapter({ bin: STUB, ...opts });
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const run = async (h: Harness, a = adapter(), bare?: boolean) =>
  a.run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir, ...(bare ? { bare } : {}) });
const extra = (w: string[] | undefined): string[] => (w ?? []).filter((x) => !OPENHANDS_POSTURE_WARNINGS.includes(x));

describe('OpenHandsAdapter.capabilities (ADR-0019 §Decision 3)', () => {
  it('declares stream only, no version pin, model pin', () => {
    expect(adapter().capabilities()).toEqual({ headless: true, observes: ['stream'], can_pin_version: false, can_pin_model: true });
    expect(adapter().id).toBe('openhands');
  });
});

describe('permission_mode and argv (§4.1 invariant 1)', () => {
  it('builds the headless argv with no approval or sandbox flag', () => {
    const argv = buildOpenHandsArgv({ permission_mode: ACK }, TASK);
    expect(argv).toEqual(['--headless', '--json', '--override-with-envs', '-t', TASK]);
    for (const f of LOOSENING) expect(argv).not.toContain(f);
    expect(buildOpenHandsArgv({ permission_mode: 'yolo' }, TASK)).toEqual(argv);
  });

  it('refuses a profile that does not acknowledge always-approve, and modes headless cannot honour', () => {
    expect(() => parseOpenHandsPermissionMode(undefined)).toThrow(/must state permission_mode: always-approve/);
    expect(() => parseOpenHandsPermissionMode('')).toThrow(/must state/);
    expect(() => parseOpenHandsPermissionMode('llm-approve')).toThrow(/not available in headless/);
    expect(() => parseOpenHandsPermissionMode('always-approve,confirm')).toThrow(/not available in headless/);
    expect(() => parseOpenHandsPermissionMode('always-approve sandbox=docker')).toThrow(/unknown permission_mode token/);
    expect(parseOpenHandsPermissionMode('always-approve')).toEqual({ alwaysApprove: true });
  });

  it('refuses a task that starts with "-"', () => {
    expect(() => buildOpenHandsArgv({ permission_mode: ACK }, '--llm-approve x')).toThrow(/must not start with "-"/);
    expect(() => buildOpenHandsArgv({ permission_mode: ACK }, '-')).toThrow(/must not start with "-"/);
  });

  it('openhandsFlagNames drops the task value', () => {
    expect(openhandsFlagNames(buildOpenHandsArgv({ permission_mode: ACK }, TASK))).toEqual(['--headless', '--json', '--override-with-envs', '-t']);
  });
});

describe('env construction (ADR-0019 §Decision 4, §5)', () => {
  it('pins LLM_MODEL and the workdir and run-scopes HOME and state dirs', () => {
    const r = buildOpenHandsEnv({ model: MODEL, env: { LLM_API_KEY: 'x' } }, '/w', '/run', { isolateHome: true, baseEnv: {} });
    expect(r.env.LLM_MODEL).toBe(MODEL);
    expect(r.env.OPENHANDS_WORK_DIR).toBe('/w');
    expect(r.env.HOME).toBe(path.join('/run', 'openhands-home'));
    expect(r.env.OPENHANDS_PERSISTENCE_DIR).toBe(path.join('/run', 'openhands-home', '.openhands'));
    expect(r.env.OPENHANDS_CONVERSATIONS_DIR).toBe(path.join('/run', 'openhands-home', '.openhands', 'conversations'));
    expect(r.warnings).toEqual([]);
  });

  it('overrides a conflicting LLM_MODEL / OPENHANDS_WORK_DIR from the profile, with warnings', () => {
    const r = buildOpenHandsEnv({ model: MODEL, env: { LLM_API_KEY: 'x', LLM_MODEL: 'other', OPENHANDS_WORK_DIR: '/elsewhere' } }, '/w', '/run', { isolateHome: true, baseEnv: {} });
    expect(r.env.LLM_MODEL).toBe(MODEL);
    expect(r.env.OPENHANDS_WORK_DIR).toBe('/w');
    expect(r.warnings.join('\n')).toMatch(/LLM_MODEL; overridden/);
    expect(r.warnings.join('\n')).toMatch(/OPENHANDS_WORK_DIR; overridden/);
  });

  it('warns on a missing key by name and on a base URL inherited from the operator', () => {
    const r = buildOpenHandsEnv({ model: MODEL }, '/w', '/run', { isolateHome: true, baseEnv: { LLM_BASE_URL: 'https://proxy.example/v1' } });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/LLM_API_KEY is not set/);
    expect(w).toMatch(/LLM_BASE_URL is inherited from the operator/);
  });

  it('local-model configuration path: Ollama on loopback, placeholder key, flagged UNVERIFIED', () => {
    expect(openhandsLocalModelEnv()).toEqual({ LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LLM_API_KEY: 'local-llm' });
    expect(openhandsLocalModelEnv({ port: 8000, apiKey: 'dummy' })).toEqual({ LLM_BASE_URL: 'http://127.0.0.1:8000/v1', LLM_API_KEY: 'dummy' });
    const r = buildOpenHandsEnv({ model: 'openai/qwen3.6:35b-a3b', env: openhandsLocalModelEnv() }, '/w', '/run', { isolateHome: true, baseEnv: {} });
    expect(r.env.LLM_MODEL).toBe('openai/qwen3.6:35b-a3b');
    expect(r.env.LLM_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    expect(r.warnings).toEqual([expect.stringMatching(/local-model base URL.*UNVERIFIED/)]);
    // Not a default: without the helper no base URL is set.
    expect(buildOpenHandsEnv({ model: MODEL, env: { LLM_API_KEY: 'x' } }, '/w', '/run', { isolateHome: true, baseEnv: {} }).env.LLM_BASE_URL).toBeUndefined();
  });

  it('a profile HOME wins and is warned; isolateHome:false is warned', () => {
    const r = buildOpenHandsEnv({ model: MODEL, env: { LLM_API_KEY: 'x', HOME: '/op' } }, '/w', '/run', { isolateHome: true, baseEnv: {} });
    expect(r.env.HOME).toBe('/op');
    expect(r.warnings.join('\n')).toMatch(/profile\.env sets HOME/);
    const r2 = buildOpenHandsEnv({ model: MODEL, env: { LLM_API_KEY: 'x' } }, '/w', '/run', { isolateHome: false, baseEnv: { HOME: '/op' } });
    expect(r2.env.HOME).toBe('/op');
    expect(r2.persistenceDir).toBe(path.join('/op', '.openhands'));
    expect(r2.warnings.join('\n')).toMatch(/not run-scoped/);
  });
});

describe('OpenHandsAdapter.run against the stub', () => {
  it('spawns with the built argv, pins model + workdir, records agent_flags', async () => {
    const h = await harness();
    const obs = await run(h);
    expect(await readJson<string[]>(h.argvPath)).toEqual(buildOpenHandsArgv(h.profile, TASK));
    const e = await readJson<StubEnv>(h.envPath);
    // The child's process.cwd() is realpath-resolved (macOS tmpdir: /var -> /private/var).
    expect(realpathOf(e.cwd)).toBe(realpathOf(h.profile.workdir!));
    expect(e.OPENHANDS_WORK_DIR).toBe(h.profile.workdir);
    expect(e.LLM_MODEL).toBe(MODEL);
    expect(e.LLM_API_KEY_set).toBe(true);
    expect(e.HOME).toBe(path.join(h.runDir, 'openhands-home'));
    expect(e.OPENHANDS_CONVERSATIONS_DIR).toBe(path.join(h.runDir, 'openhands-home', '.openhands', 'conversations'));
    expect(obs.agent_flags).toEqual(['--headless', '--json', '--override-with-envs', '-t']);
    expect(obs.effective_model).toBe(MODEL);
    expect(obs.exit_code).toBe(0);
  });

  it('parses ActionEvents into ToolCalls keyed by tool_call_id', async () => {
    const h = await harness();
    const obs = await run(h);
    expect(obs.tool_calls.map((c) => [c.id, c.name])).toEqual([
      ['call_1', 'terminal'],
      ['call_2', 'file_editor'],
      ['call_3', 'canary_mcp_tool'],
    ]);
    expect(obs.tool_calls[0].input).toEqual({ command: 'ls' });
    expect(obs.tool_calls[1].input).toEqual({ command: 'create', path: path.join(h.profile.workdir!, 'out.txt'), file_text: 'summary: café ☃\n' });
    expect(obs.tool_calls[2].input).toEqual({ tool_name: 'canary_mcp_tool', arguments: { q: 'aab-canary' } });
    for (const c of obs.tool_calls) expect(c.sources).toEqual(['stream']);
    expect(obs.cost_usd).toBeUndefined();
    expect(obs.attempts).toEqual([]);
    expect(obs.agent_version_reported).toBe('OpenHands CLI 1.16.0');
  });

  it('writes stdout, stderr, argv and the transcript into runDir, nothing into the workdir', async () => {
    const h = await harness();
    const obs = await run(h);
    expect(obs.raw_events_path).toBe(path.join(h.runDir, 'openhands-stream.jsonl'));
    const raw = await readFile(obs.raw_events_path, 'utf8');
    expect(raw).toContain('✓ Agent initialized with model:');
    expect(raw).toContain('"kind":"ActionEvent"');
    const argvRec = await readJson<string[]>(path.join(h.runDir, 'openhands-argv.json'));
    expect(argvRec[0]).toBe(STUB);
    expect(argvRec.slice(1)).toEqual(buildOpenHandsArgv(h.profile, TASK));
    await expect(stat(path.join(h.runDir, 'openhands-stderr.log'))).resolves.toBeDefined();
    expect(obs.transcript_path).toBe(path.join(h.runDir, 'openhands-transcript.jsonl'));
    const t = (await readFile(obs.transcript_path!, 'utf8')).trim().split('\n');
    expect(t).toHaveLength(8);
    expect(JSON.parse(t[1]).kind).toBe('ActionEvent');
    expect(await readdir(h.profile.workdir!)).toEqual([]);
  });

  it('a clean run carries only the posture warnings', async () => {
    const h = await harness();
    const obs = await run(h);
    expect(obs.warnings).toEqual([...OPENHANDS_POSTURE_WARNINGS]);
  });

  it('reports a non-zero accumulated_cost and ignores zero', async () => {
    const h = await harness({}, { AAB_STUB_COST: '0.0123' });
    expect((await run(h)).cost_usd).toBeCloseTo(0.0123);
  });

  it('warns on model mismatch and falls back to base_state when there is no echo', async () => {
    const h = await harness({}, { AAB_STUB_MODEL_ECHO: 'openai/other' });
    const obs = await run(h);
    expect(obs.effective_model).toBe('openai/other');
    expect(extra(obs.warnings).join('\n')).toMatch(/model mismatch: pinned/);
    const h2 = await harness({}, { AAB_STUB_NO_ECHO: '1' });
    const obs2 = await run(h2);
    expect(obs2.effective_model).toBeUndefined();
    expect(extra(obs2.warnings).join('\n')).toMatch(/reported no model/);
  });

  it('warns on AgentErrorEvent, uninterpreted kinds and transcript-only actions', async () => {
    const h = await harness({}, { AAB_STUB_AGENT_ERROR: '1', AAB_STUB_UNKNOWN_KIND: '1', AAB_STUB_TRANSCRIPT_EXTRA: '1' });
    const w = extra((await run(h)).warnings).join('\n');
    expect(w).toMatch(/AgentErrorEvent: stub agent error/);
    expect(w).toMatch(/uninterpreted kind: FutureEvent/);
    expect(w).toMatch(/absent from the stream: call_hidden/);
  });

  it('a local-model run with no actions is flagged inconclusive', async () => {
    const h = await harness({ model: 'openai/qwen3.6:35b-a3b' }, { ...openhandsLocalModelEnv(), AAB_STUB_NO_ACTIONS: '1' });
    const obs = await run(h);
    expect(obs.tool_calls).toEqual([]);
    expect(obs.exit_code).toBe(0);
    const w = extra(obs.warnings).join('\n');
    expect(w).toMatch(/inconclusive run \(local models/);
    expect(w).toMatch(/local-model base URL/);
    const e = await readJson<StubEnv>(h.envPath);
    expect(e.LLM_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    expect(e.LLM_MODEL).toBe('openai/qwen3.6:35b-a3b');
  });

  it('missing LLM_API_KEY: warned by name, CLI exits 1', async () => {
    const h = await harness();
    delete h.profile.env!.LLM_API_KEY;
    const prev = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      const obs = await run(h);
      expect(obs.exit_code).toBe(1);
      expect(extra(obs.warnings).join('\n')).toMatch(/LLM_API_KEY is not set/);
      expect(await readFile(path.join(h.runDir, 'openhands-stderr.log'), 'utf8')).toContain('Missing required environment variable');
    } finally {
      if (prev !== undefined) process.env.LLM_API_KEY = prev;
    }
  });

  it('warns on a planted .openhands/hooks.json and on --bare, leaving the file untouched', async () => {
    const h = await harness();
    await mkdir(path.join(h.profile.workdir!, '.openhands'), { recursive: true });
    await writeFile(path.join(h.profile.workdir!, '.openhands', 'hooks.json'), '{}\n');
    const w = extra((await run(h, adapter(), true)).warnings).join('\n');
    expect(w).toMatch(/\.openhands\/hooks\.json/);
    expect(w).toMatch(/--bare/);
    expect(await readFile(path.join(h.profile.workdir!, '.openhands', 'hooks.json'), 'utf8')).toBe('{}\n');
  });

  it('warns on version mismatch and drift', async () => {
    const h = await harness({ agent_version: 'openhands@1.15.0' }, { AAB_STUB_VERSION_AFTER: 'OpenHands CLI 1.16.1' });
    const w = extra((await run(h)).warnings).join('\n');
    expect(w).toMatch(/version mismatch/);
    expect(w).toMatch(/drifted during the run: OpenHands CLI 1\.16\.0 -> OpenHands CLI 1\.16\.1/);
  });
});

describe('binary resolution, abort, errors', () => {
  it('uses the env override when no ctor bin is given', async () => {
    const prev = process.env[OPENHANDS_BIN_ENV];
    process.env[OPENHANDS_BIN_ENV] = STUB;
    try {
      const h = await harness();
      await new OpenHandsAdapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
      await expect(stat(h.argvPath)).resolves.toBeDefined();
    } finally {
      if (prev === undefined) delete process.env[OPENHANDS_BIN_ENV];
      else process.env[OPENHANDS_BIN_ENV] = prev;
    }
  });

  it('kills the child on abort', async () => {
    const base = await mkScratch('aab-openhands-abort-');
    tmpDirs.push(base);
    const ready = path.join(base, 'ready');
    const h = await harness({}, { AAB_STUB_HANG: '1', AAB_STUB_READY: ready });
    const ac = new AbortController();
    const p = adapter().run(h.profile, TASK, ac.signal, { runDir: h.runDir });
    await pollUntil(() => stat(ready), 'stub never ready');
    ac.abort();
    expect((await p).exit_code).not.toBe(0);
  });

  it('throws before spawning without a runDir, without the ack, and on a "-" task', async () => {
    const h = await harness();
    await expect(adapter().run(h.profile, TASK, new AbortController().signal)).rejects.toThrow(/runDir/);
    const h2 = await harness({ permission_mode: undefined });
    await expect(adapter().run(h2.profile, TASK, new AbortController().signal, { runDir: h2.runDir })).rejects.toThrow(/always-approve/);
    await expect(stat(h2.argvPath)).rejects.toThrow();
    await expect(stat(h2.runDir)).rejects.toThrow();
    const h3 = await harness();
    await expect(adapter().run(h3.profile, '--llm-approve', new AbortController().signal, { runDir: h3.runDir })).rejects.toThrow(/must not start with "-"/);
    await expect(stat(h3.argvPath)).rejects.toThrow();
  });
});

describe('conversation lookup without a Conversation ID line', () => {
  it('falls back to the single run-scoped conversation', async () => {
    const h = await harness({}, { AAB_STUB_NO_CONV_ID: '1', AAB_STUB_COST: '2.5' });
    const obs = await run(h);
    expect(obs.transcript_path).toBeDefined();
    expect(obs.cost_usd).toBe(2.5);
  });

  it('does not guess a conversation in a conversations dir outside runDir', async () => {
    const h = await harness({}, { AAB_STUB_NO_CONV_ID: '1', AAB_STUB_COST: '2.5' });
    const external = path.join(path.dirname(h.runDir), 'operator-conversations');
    h.profile.env = { ...h.profile.env, OPENHANDS_CONVERSATIONS_DIR: external };
    const obs = await run(h);
    expect(obs.transcript_path).toBeUndefined();
    expect(obs.cost_usd).toBeUndefined();
    expect(obs.warnings).toContain('no Conversation ID line matched and the conversations dir is not run-scoped; transcript not read');
  });
});

describe('pure parse step', () => {
  it('strips ANSI colour codes from Rich lines before reading the model echo', () => {
    const state = newOpenHandsStreamState();
    parseOpenHandsStreamLine('\u001b[1;32m✓ Agent initialized with model: openai/x\u001b[0m', 0, state);
    parseOpenHandsStreamLine('\u001b[2mConversation ID: 0123abcd\u001b[0m', 0, state);
    expect(state.effectiveModel).toBe('openai/x');
    expect(state.conversationId).toBe('0123abcd');
  });

  it('observeOpenHandsRun is deterministic, skips Rich lines and reads echo + conversation id', () => {
    const streamText = [
      'Initializing agent...',
      '✓ Agent initialized with model: m1',
      '{not json',
      JSON.stringify({ kind: 'ActionEvent', id: 'e1', timestamp: 't', source: 'agent', tool_name: 'terminal', tool_call_id: 'c1', action: { kind: 'TerminalAction', command: 'ls' } }),
      JSON.stringify({ kind: 'ObservationEvent', id: 'e2', timestamp: 't', source: 'environment', tool_call_id: 'c1', observation: { kind: 'TerminalObservation', exit_code: 3 } }),
      'Conversation ID: abc123',
    ].join('\n');
    const meta = { rawEventsPath: '/r', exitCode: 0, startedAt: 1, endedAt: 2, streamText, requestedModel: 'm1' };
    const a = observeOpenHandsRun(meta);
    expect(a).toEqual(observeOpenHandsRun(meta));
    expect(a.tool_calls).toEqual([{ id: 'c1', name: 'terminal', input: { command: 'ls' }, at: 0, source: 'stream', sources: ['stream'] }]);
    expect(a.effective_model).toBe('m1');
    expect(a.warnings).toEqual([...OPENHANDS_POSTURE_WARNINGS]);
    const s = newOpenHandsStreamState();
    for (const l of streamText.split('\n')) parseOpenHandsStreamLine(l, 0, s);
    expect(s.conversationId).toBe('abc123');
    expect(s.observations.get('c1')).toEqual({ kind: 'TerminalObservation', exit_code: 3 });
  });

  it('warns on orphan observations, rejections, blocked hooks and missing settings', () => {
    const streamText = [
      'Headless mode requires existing settings.',
      JSON.stringify({ kind: 'ObservationEvent', tool_call_id: 'zz', observation: { kind: 'TerminalObservation' } }),
      JSON.stringify({ kind: 'UserRejectObservation', tool_call_id: 'c2', rejection_reason: 'no', rejection_source: 'hook' }),
      JSON.stringify({ kind: 'HookExecutionEvent', hook_event_type: 'PreToolUse', blocked: true, reason: 'policy' }),
    ].join('\n');
    const w = observeOpenHandsRun({ rawEventsPath: '/r', exitCode: 0, startedAt: 1, endedAt: 2, streamText }).warnings!.join('\n');
    expect(w).toMatch(/requires existing settings/);
    expect(w).toMatch(/tool_call_id zz has no matching ActionEvent/);
    expect(w).toMatch(/UserRejectObservation \(hook\): no/);
    expect(w).toMatch(/HookExecutionEvent blocked PreToolUse: policy/);
    expect(w).toMatch(/no ActionEvent seen: inconclusive run$/m);
  });

  it('describeOpenHandsAction keeps unknown action kinds raw and falls back to the kind as name', () => {
    expect(describeOpenHandsAction({ tool_name: 't', action: { kind: 'TaskTrackerAction', x: 1 } })).toEqual({ name: 't', input: { kind: 'TaskTrackerAction', x: 1 } });
    expect(describeOpenHandsAction({ action: { kind: 'TerminalAction', command: 'pwd' } })).toEqual({ name: 'TerminalAction', input: { command: 'pwd' } });
  });
});

describe('CLI wiring', () => {
  it('defaultDeps().adapterFor returns the OpenHands adapter for openhands', () => {
    const a = defaultDeps().adapterFor('openhands');
    expect(a.id).toBe('openhands');
    expect(a).toBeInstanceOf(OpenHandsAdapter);
  });
});
