// Claude Code adapter tests (evidence-spec §4, §4.5). Fully offline and deterministic: the
// adapter is pointed at a stub agent binary (test/fixtures/agents/stub-claude.mjs) via the
// constructor bin arg, so NO real `claude` is ever spawned, no network is touched, and no API
// is spent. We assert argv construction, that permission_mode is passed verbatim and never
// loosened, that --bare is not used by default, stream+hook parsing, merge-by-tool_use_id,
// cost, effective model/mode from system/init, and that the AbortSignal kills the child.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';
import type { RunObservation, SetupProfile } from '../src/adapters/adapter.js';

const STUB = fileURLToPath(new URL('./fixtures/agents/stub-claude.mjs', import.meta.url));
const MODEL = 'claude-opus-4-8';
const PINNED_VERSION = '@anthropic-ai/claude-code@2.1.309';
const TASK = 'do the benign thing';

const tmpDirs: string[] = [];

interface Harness {
  profile: SetupProfile;
  runDir: string;
  argvPath: string;
}

async function harness(
  overrides: Partial<SetupProfile> = {},
  extraEnv: Record<string, string> = {},
): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), 'aab-cc-adapter-'));
  tmpDirs.push(base);
  const workdir = path.join(base, 'work');
  const runDir = path.join(base, 'run');
  const argvPath = path.join(runDir, 'stub-argv.json');
  const profile: SetupProfile = {
    agent: 'claude-code',
    agent_version: PINNED_VERSION,
    model: MODEL,
    workdir,
    env: { AAB_STUB_ARGV_OUT: argvPath, ...extraEnv },
    ...overrides,
  };
  return { profile, runDir, argvPath };
}

function adapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ bin: STUB });
}

async function readArgv(argvPath: string): Promise<string[]> {
  return JSON.parse(await readFile(argvPath, 'utf8')) as string[];
}

/** Poll until a file exists (used to abort only once the stub has emitted init). */
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(file);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('ClaudeCodeAdapter.capabilities (§4.4)', () => {
  it('declares headless, stream+hook, pinned version+model', () => {
    expect(adapter().capabilities()).toEqual({
      headless: true,
      observes: ['stream', 'hook'],
      can_pin_version: true,
      can_pin_model: true,
    });
  });

  it('has id claude-code', () => {
    expect(adapter().id).toBe('claude-code');
  });
});

describe('ClaudeCodeAdapter.run argv construction (§4.2/§4.3)', () => {
  it('builds headless argv and passes permission_mode verbatim; no --bare, no dangerous flag', async () => {
    const { profile, runDir, argvPath } = await harness({ permission_mode: 'plan' });
    await adapter().run(profile, TASK, new AbortController().signal, { runDir });

    const argv = await readArgv(argvPath);
    expect(argv).toEqual([
      '-p',
      TASK,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      MODEL,
      '--permission-mode',
      'plan',
    ]);
    // §4.1: never loosen — the dangerous flag is absent for an ordinary mode.
    expect(argv).not.toContain('--dangerously-skip-permissions');
    // §4.3: --bare not used by default.
    expect(argv).not.toContain('--bare');
  });

  it('omits --permission-mode when the profile leaves it undefined', async () => {
    const { profile, runDir, argvPath } = await harness({ permission_mode: undefined });
    const obs = await adapter().run(profile, TASK, new AbortController().signal, { runDir });

    const argv = await readArgv(argvPath);
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    // The effective mode is recorded from system/init instead.
    expect(obs.effective_permission_mode).toBe('default');
  });

  it('passes a restrictive mode through unchanged (never substituted for a looser one)', async () => {
    const { profile, runDir, argvPath } = await harness({ permission_mode: 'acceptEdits' });
    await adapter().run(profile, TASK, new AbortController().signal, { runDir });

    const argv = await readArgv(argvPath);
    const i = argv.indexOf('--permission-mode');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('acceptEdits');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  it('only emits --dangerously-skip-permissions when the mode literally asks for it', async () => {
    const { profile, runDir, argvPath } = await harness({
      permission_mode: 'dangerously-skip-permissions',
    });
    await adapter().run(profile, TASK, new AbortController().signal, { runDir });

    const argv = await readArgv(argvPath);
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--permission-mode');
  });

  it('records --bare when the run option asks for it', async () => {
    const { profile, runDir, argvPath } = await harness({ permission_mode: 'plan' });
    const obs = await adapter().run(profile, TASK, new AbortController().signal, {
      runDir,
      bare: true,
    });
    expect(await readArgv(argvPath)).toContain('--bare');
    expect(obs.used_bare).toBe(true);
  });
});

describe('ClaudeCodeAdapter.run observation (§4.2, §4.5)', () => {
  let obs: RunObservation;
  let runDir: string;

  async function runOnce(): Promise<void> {
    const h = await harness({ permission_mode: 'plan' });
    runDir = h.runDir;
    obs = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir });
  }

  it('parses the stream tool_use and the hook line, merging by tool_use_id into one call', async () => {
    await runOnce();
    expect(obs.tool_calls).toHaveLength(1);
    const call = obs.tool_calls[0];
    expect(call.id).toBe('toolu_canary_0001');
    expect(call.name).toBe('Bash');
    expect(call.input).toEqual({ command: 'echo aab-canary' });
    // Seen on BOTH layers -> sources carries stream and hook (§4.2).
    expect(call.sources).toBeDefined();
    expect([...call.sources!].sort()).toEqual(['hook', 'stream']);
    // Back-compat single source stays populated (stream has priority).
    expect(call.source).toBe('stream');
  });

  it('retains a stream-only call (seen on stream but never on the hook) alongside the merged one', async () => {
    const h = await harness({ permission_mode: 'plan' }, { AAB_STUB_STREAM_ONLY_ID: 'toolu_stream_only_0002' });
    const o = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(o.tool_calls).toHaveLength(2);
    const merged = o.tool_calls.find((c) => c.id === 'toolu_canary_0001')!;
    const streamOnly = o.tool_calls.find((c) => c.id === 'toolu_stream_only_0002')!;
    // The canary call was seen on both layers; the second only on stream and is still kept.
    expect([...merged.sources!].sort()).toEqual(['hook', 'stream']);
    expect(streamOnly).toBeDefined();
    expect(streamOnly.sources).toEqual(['stream']);
    expect(streamOnly.source).toBe('stream');
    expect(streamOnly.name).toBe('Read');
  });

  it('reads total_cost_usd from the result event', async () => {
    await runOnce();
    expect(obs.cost_usd).toBe(0.0123);
  });

  it('records effective model and permission mode from system/init', async () => {
    await runOnce();
    expect(obs.effective_model).toBe(MODEL);
    expect(obs.effective_permission_mode).toBe('plan');
    expect(obs.mcp_servers).toEqual([{ name: 'canary-mcp', status: 'connected' }]);
  });

  it('captures stdout verbatim to raw_events_path and finishes with exit 0', async () => {
    await runOnce();
    expect(obs.exit_code).toBe(0);
    expect(obs.raw_events_path).toBe(path.join(runDir, 'claude-stream.jsonl'));
    const raw = await readFile(obs.raw_events_path, 'utf8');
    expect(raw).toContain('"subtype":"init"');
    expect(raw).toContain('toolu_canary_0001');
    expect(raw).toContain('total_cost_usd');
  });

  it('asserts the agent version and records it without a warning on a match', async () => {
    await runOnce();
    expect(obs.agent_version_reported).toContain('2.1.309');
    expect(obs.warnings).toBeUndefined();
    expect(obs.started_at).toBeLessThanOrEqual(obs.ended_at);
  });

  it('records a non-fatal warning when the running version does not match the pin', async () => {
    const h = await harness({ permission_mode: 'plan', agent_version: '@anthropic-ai/claude-code@9.9.9' });
    const o = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(o.warnings).toBeDefined();
    expect(o.warnings!.join(' ')).toMatch(/version mismatch/);
    // Mismatch is non-fatal: the run still completed and parsed.
    expect(o.exit_code).toBe(0);
    expect(o.tool_calls).toHaveLength(1);
  });
});

describe('ClaudeCodeAdapter stub isolation + abort (§4.5)', () => {
  it('always drives the stub, never a real claude (stub records its argv)', async () => {
    const { profile, runDir, argvPath } = await harness({ permission_mode: 'plan' });
    await adapter().run(profile, TASK, new AbortController().signal, { runDir });
    // The stub-argv file exists only because our stub ran; a real claude would not write it.
    await expect(stat(argvPath)).resolves.toBeDefined();
  });

  it('kills the child when the AbortSignal fires', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'aab-cc-abort-'));
    tmpDirs.push(base);
    const runDir = path.join(base, 'run');
    const readyPath = path.join(runDir, 'stub-ready');
    const profile: SetupProfile = {
      agent: 'claude-code',
      agent_version: PINNED_VERSION,
      model: MODEL,
      workdir: path.join(base, 'work'),
      env: { AAB_STUB_HANG: '1', AAB_STUB_READY: readyPath },
      permission_mode: 'plan',
    };
    const ac = new AbortController();
    const p = adapter().run(profile, TASK, ac.signal, { runDir });
    // Abort only once the stub has booted and emitted init (deterministic, no boot race).
    await waitForFile(readyPath);
    ac.abort();
    const o = await p;
    // Killed, not a clean exit: SIGKILL -> 128+9. Either way, non-zero and it returned.
    expect(o.exit_code).not.toBe(0);
    // init was parsed before the hang, so the effective fields are present.
    expect(o.effective_model).toBe(MODEL);
  });

  it('throws a clear error when no runDir is available', async () => {
    const { profile } = await harness({ permission_mode: 'plan' });
    await expect(adapter().run(profile, TASK, new AbortController().signal)).rejects.toThrow(/runDir/);
  });
});

describe('ClaudeCodeAdapter observation hook is non-blocking (§4.1 invariant 2)', () => {
  it('the installed PreToolUse hook exits 0 and emits no allow/deny decision on stdout', async () => {
    const { profile, runDir } = await harness({ permission_mode: 'plan' });
    await adapter().run(profile, TASK, new AbortController().signal, { runDir });

    // The adapter wrote the real hook into the profile's settings; drive it exactly as
    // Claude Code would (payload on stdin) and prove it observes without steering.
    const settings = JSON.parse(
      await readFile(path.join(profile.workdir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> } };
    const groups = settings.hooks?.PreToolUse ?? [];
    const commands = groups.flatMap((g) => g.hooks ?? []).filter((h) => h.type === 'command' && h.command);
    expect(commands.length).toBeGreaterThan(0);

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'toolu_hook_probe',
      tool_name: 'Bash',
      tool_input: { command: 'echo probe' },
    });
    for (const h of commands) {
      const res = spawnSync(h.command!, { shell: true, input: payload, encoding: 'utf8' });
      // Exit 0: never blocks the call.
      expect(res.status).toBe(0);
      // Observation hook must emit no permission decision (would otherwise steer the agent).
      expect(res.stdout ?? '').not.toMatch(/"(decision|permissionDecision|hookSpecificOutput|continue)"/);
    }
  });
});
