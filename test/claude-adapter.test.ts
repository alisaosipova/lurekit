// Claude Code adapter tests (evidence-spec §4, §4.5). Fully offline and deterministic: the
// adapter is pointed at a stub agent binary (test/fixtures/agents/stub-claude.mjs) via the
// constructor bin arg, so NO real `claude` is ever spawned, no network is touched, and no API
// is spent. We assert argv construction, that permission_mode is passed verbatim and never
// loosened, that --bare is not used by default, stream+hook parsing, merge-by-tool_use_id,
// cost, effective model/mode from system/init, and that the AbortSignal kills the child.

import { afterEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ClaudeCodeAdapter,
  HOOK_SETTINGS_FILE,
  LAUNCH_RETRY_DELAYS_MS,
  flagNames,
  isRetryableLaunchError,
  resolveAgentBinary,
  retryLaunch,
} from '../src/adapters/claudeCode.js';
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
      '--settings',
      path.join(runDir, HOOK_SETTINGS_FILE),
      // §4.3: strict MCP isolation on every run, even with no MCP config of the profile's own.
      '--strict-mcp-config',
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

    // The adapter wrote the real hook into its harness-only --settings file; drive it exactly
    // as Claude Code would (payload on stdin) and prove it observes without steering.
    const settings = JSON.parse(
      await readFile(path.join(runDir, HOOK_SETTINGS_FILE), 'utf8'),
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

describe('ClaudeCodeAdapter observe hook leaves project settings untouched (§4.2)', () => {
  it('a fixture-planted .claude/settings.json hook survives the run byte-for-byte', async () => {
    const { profile, runDir, argvPath } = await harness({ permission_mode: 'plan' });
    const settingsPath = path.join(profile.workdir!, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    // Deliberately unusual formatting: a rewrite (even one that preserved the hook) would show.
    const planted =
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"aab-canary-setup"}]}],' +
      '\n  "PreToolUse": [ {"matcher":"Bash","hooks":[{"type":"command","command":"true"}]} ]}}\n';
    await writeFile(settingsPath, planted, 'utf8');

    const obs = await adapter().run(profile, TASK, new AbortController().signal, { runDir });

    expect(await readFile(settingsPath, 'utf8')).toBe(planted);
    // The harness hook went in through --settings (run dir), and still observed the call.
    const argv = await readArgv(argvPath);
    expect(argv[argv.indexOf('--settings') + 1]).toBe(path.join(runDir, HOOK_SETTINGS_FILE));
    expect(obs.tool_calls[0].sources).toEqual(['stream', 'hook']);
    // No harness file was written into the workdir besides what the fixture planted.
    expect(await readdir(profile.workdir!)).toEqual(['.claude']);
    expect(await readdir(path.dirname(settingsPath))).toEqual(['settings.json']);
  });

  it('records the option names actually passed as agent_flags (values omitted)', async () => {
    const { profile, runDir } = await harness({ permission_mode: 'plan' });
    const obs = await adapter().run(profile, TASK, new AbortController().signal, { runDir });
    expect(obs.agent_flags).toEqual([
      '-p',
      '--output-format',
      '--verbose',
      '--model',
      '--permission-mode',
      '--settings',
      '--strict-mcp-config',
    ]);
    // A task that looks like a flag is a value, never a recorded flag.
    expect(flagNames(['-p', '--evil', '--model', 'm', '--strict-mcp-config'])).toEqual([
      '-p',
      '--model',
      '--strict-mcp-config',
    ]);
  });
});

describe('ClaudeCodeAdapter --setting-sources hardening knob (§4.3)', () => {
  it('passes no --setting-sources when the profile leaves it unset (no default change)', async () => {
    const { profile, runDir, argvPath } = await harness();
    const obs = await adapter().run(profile, TASK, new AbortController().signal, { runDir });
    expect(await readArgv(argvPath)).not.toContain('--setting-sources');
    expect(obs.agent_flags).not.toContain('--setting-sources');
  });

  it('passes --setting-sources <csv> when set and records the flag name (value omitted)', async () => {
    const { profile, runDir, argvPath } = await harness({ setting_sources: ['user', 'local'] });
    const obs = await adapter().run(profile, TASK, new AbortController().signal, { runDir });
    const argv = await readArgv(argvPath);
    const i = argv.indexOf('--setting-sources');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('user,local');
    expect(obs.agent_flags).toContain('--setting-sources');
    expect(obs.agent_flags).not.toContain('user,local');
  });

  it.each([
    [['user', 'managed']],
    [[]],
    [['user', 'user']],
    [['User']],
  ])('rejects invalid setting_sources %j before spawning the agent', async (bad) => {
    const { profile, runDir, argvPath } = await harness({ setting_sources: bad as string[] });
    await expect(adapter().run(profile, TASK, new AbortController().signal, { runDir })).rejects.toThrow(
      /setting_sources/,
    );
    // The stub writes its argv on spawn; no argv file means nothing was spawned.
    await expect(stat(argvPath)).rejects.toThrow();
  });
});

// §4.3 "Binary resolution and launch retry": the binary is resolved once per adapter instance
// to an absolute real path; a launch that hits ENOENT/EACCES (an auto-update replacing the
// binary in place) is retried with backoff; the spawned path and per-repetition version are
// recorded and a version change within one adapter instance is warned about. The sleep is
// injected, so no test waits on the real 1s/2s/4s schedule.
describe('ClaudeCodeAdapter binary resolution and launch retry (§4.3)', () => {
  async function binDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'aab-cc-bin-'));
    tmpDirs.push(d);
    return d;
  }

  /** A wrapper bin that reports the version in <dir>/version.txt and otherwise runs the stub. */
  async function versionedStub(dir: string, version: string): Promise<{ bin: string; setVersion: (v: string) => Promise<void> }> {
    const bin = path.join(dir, 'claude-wrapper.mjs');
    const versionFile = path.join(dir, 'version.txt');
    await writeFile(
      bin,
      [
        "import fs from 'node:fs';",
        "if (process.argv.includes('--version')) {",
        `  process.stdout.write(fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8'));`,
        '  process.exit(0);',
        '}',
        `await import(${JSON.stringify(new URL('./fixtures/agents/stub-claude.mjs', import.meta.url).href)});`,
        '',
      ].join('\n'),
      'utf8',
    );
    const setVersion = (v: string): Promise<void> => writeFile(versionFile, `${v} (Claude Code)\n`, 'utf8');
    await setVersion(version);
    return { bin, setVersion };
  }

  it('uses the documented default backoff of 1s/2s/4s', () => {
    expect([...LAUNCH_RETRY_DELAYS_MS]).toEqual([1000, 2000, 4000]);
  });

  it('records the absolute real path of the spawned binary (symlink resolved)', async () => {
    const dir = await binDir();
    const link = path.join(dir, 'claude-link.mjs');
    await symlink(STUB, link);
    const { profile, runDir } = await harness();
    const obs = await new ClaudeCodeAdapter({ bin: link }).run(profile, TASK, new AbortController().signal, { runDir });
    expect(obs.exit_code).toBe(0);
    expect(obs.agent_binary_path).toBe(realpathSync(STUB));
    expect(path.isAbsolute(obs.agent_binary_path!)).toBe(true);
    expect(obs.agent_version_reported).toBe('2.1.309 (Claude Code)');
  });

  it('resolves a bare name on PATH to its real path', async () => {
    const dir = await binDir();
    const target = path.join(dir, 'real-claude.mjs');
    await copyFile(STUB, target);
    await chmod(target, 0o755);
    await symlink(target, path.join(dir, 'claude'));
    expect(resolveAgentBinary('claude', dir)).toBe(realpathSync(target));
    expect(resolveAgentBinary('claude', path.join(dir, 'nope'))).toBeUndefined();
  });

  it('retries while the binary is absent, then succeeds, recording each retry', async () => {
    const dir = await binDir();
    const bin = path.join(dir, 'claude-late.mjs');
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      // The binary appears after the second backoff (absent for the first 2 attempts).
      if (slept.length === 2) await copyFile(STUB, bin);
    };
    const { profile, runDir, argvPath } = await harness();
    const obs = await new ClaudeCodeAdapter({ bin, sleep }).run(profile, TASK, new AbortController().signal, { runDir });

    expect(slept).toEqual([1000, 2000]);
    expect(obs.exit_code).toBe(0);
    expect(obs.tool_calls.length).toBeGreaterThan(0);
    expect(await readArgv(argvPath)).toContain('-p');
    expect(obs.agent_binary_path).toBe(realpathSync(bin));
    const retries = (obs.warnings ?? []).filter((w) => w.startsWith('launch retry '));
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatch(/^launch retry 1\/3 \(version probe\) in 1000ms: agent binary ".*claude-late\.mjs" not found/);
    expect(retries[1]).toMatch(/^launch retry 2\/3 \(version probe\) in 2000ms/);
  });

  it('gives up with an adapter error after the retries are exhausted (binary never appears)', async () => {
    const dir = await binDir();
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };
    const { profile, runDir, argvPath } = await harness();
    const a = new ClaudeCodeAdapter({ bin: path.join(dir, 'missing-claude'), sleep });
    await expect(a.run(profile, TASK, new AbortController().signal, { runDir })).rejects.toThrow(
      /version probe failed after 4 attempt\(s\): agent binary ".*missing-claude" not found or not executable/,
    );
    expect(slept).toEqual([1000, 2000, 4000]); // 3 retries after the first attempt
    await expect(stat(argvPath)).rejects.toThrow(); // nothing was ever spawned
  });

  it('stops retrying when the run is aborted during the backoff', async () => {
    const dir = await binDir();
    const ac = new AbortController();
    const sleep = async (): Promise<void> => {
      ac.abort();
    };
    const { profile, runDir } = await harness();
    const a = new ClaudeCodeAdapter({ bin: path.join(dir, 'missing-claude'), sleep });
    await expect(a.run(profile, TASK, ac.signal, { runDir })).rejects.toThrow(/aborted during launch retry/);
  });

  it('warns "agent updated during the run" when a later repetition reports another version', async () => {
    const dir = await binDir();
    const { bin, setVersion } = await versionedStub(dir, '2.1.316');
    const a = new ClaudeCodeAdapter({ bin });

    const h1 = await harness({ agent_version: '2.1.316' });
    const first = await a.run(h1.profile, TASK, new AbortController().signal, { runDir: h1.runDir });
    expect(first.agent_version_reported).toBe('2.1.316 (Claude Code)');
    expect((first.warnings ?? []).some((w) => w.startsWith('agent updated during the run'))).toBe(false);

    await setVersion('2.1.317'); // background auto-update between repetitions
    const h2 = await harness({ agent_version: '2.1.316' });
    const second = await a.run(h2.profile, TASK, new AbortController().signal, { runDir: h2.runDir });
    expect(second.agent_version_reported).toBe('2.1.317 (Claude Code)');
    expect(second.agent_binary_path).toBe(realpathSync(bin));
    expect(second.warnings).toContain(
      `agent updated during the run: first observed 2.1.316 (Claude Code), this repetition reports 2.1.317 (Claude Code) (${realpathSync(bin)})`,
    );
    // The pinned-version mismatch warning is still recorded independently (§4.4).
    expect((second.warnings ?? []).some((w) => w.startsWith('agent version mismatch'))).toBe(true);
  });
});

describe('retryLaunch (§4.3)', () => {
  it('retries a spawn ENOENT/EACCES and records each retry; does not retry other errors', async () => {
    expect(isRetryableLaunchError({ code: 'ENOENT' })).toBe(true);
    expect(isRetryableLaunchError({ code: 'EACCES' })).toBe(true);
    expect(isRetryableLaunchError({ code: 'E2BIG' })).toBe(false);
    expect(isRetryableLaunchError(undefined)).toBe(false);

    const warnings: string[] = [];
    let n = 0;
    const v = await retryLaunch('spawn', { delaysMs: [1, 2, 4], sleep: async () => {}, warnings }, () =>
      ++n < 3 ? { ok: false, retryable: true, reason: `ENOENT #${n}` } : { ok: true, value: 'child' },
    );
    expect(v).toBe('child');
    expect(warnings).toEqual(['launch retry 1/3 (spawn) in 1ms: ENOENT #1', 'launch retry 2/3 (spawn) in 2ms: ENOENT #2']);

    const w2: string[] = [];
    await expect(
      retryLaunch('spawn', { delaysMs: [1, 2, 4], sleep: async () => {}, warnings: w2 }, () => ({
        ok: false,
        retryable: false,
        reason: 'E2BIG',
      })),
    ).rejects.toThrow('spawn failed after 1 attempt(s): E2BIG');
    expect(w2).toEqual([]);
  });
});

// Review additions (§4.3): an agent that ran and exited non-zero is a normal observation and is
// never retried; EACCES (present but not yet executable) is retried; a re-resolved path that
// differs from the cached one is warned about.
describe('ClaudeCodeAdapter launch retry boundaries (§4.3)', () => {
  async function binDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'aab-cc-bin-'));
    tmpDirs.push(d);
    return d;
  }
  const noSleep = (log: number[]) => async (ms: number): Promise<void> => {
    log.push(ms);
  };

  it('does not retry an agent that ran and exited non-zero (normal observation)', async () => {
    const dir = await binDir();
    const bin = path.join(dir, 'claude-fails.mjs');
    const ranMarker = path.join(dir, 'runs.log');
    await writeFile(
      bin,
      [
        "import fs from 'node:fs';",
        "if (process.argv.includes('--version')) { process.stdout.write('2.1.309 (Claude Code)\\n'); process.exit(0); }",
        `fs.appendFileSync(${JSON.stringify(ranMarker)}, 'run\\n');`,
        'process.exit(3);',
        '',
      ].join('\n'),
      'utf8',
    );
    const slept: number[] = [];
    const { profile, runDir } = await harness();
    const obs = await new ClaudeCodeAdapter({ bin, sleep: noSleep(slept) }).run(
      profile,
      TASK,
      new AbortController().signal,
      { runDir },
    );
    expect(obs.exit_code).toBe(3);
    expect(slept).toEqual([]);
    expect((obs.warnings ?? []).some((w) => w.startsWith('launch retry '))).toBe(false);
    expect(await readFile(ranMarker, 'utf8')).toBe('run\n'); // spawned exactly once
  });

  it.skipIf(process.platform === 'win32')(
    'retries while the binary is present but not executable (EACCES window), then succeeds',
    async () => {
      const dir = await binDir();
      const bin = path.join(dir, 'claude-sh');
      await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} "$@"\n`, 'utf8');
      await chmod(bin, 0o644);
      const slept: number[] = [];
      const sleep = async (ms: number): Promise<void> => {
        slept.push(ms);
        if (slept.length === 1) await chmod(bin, 0o755);
      };
      const { profile, runDir } = await harness();
      const obs = await new ClaudeCodeAdapter({ bin, sleep }).run(profile, TASK, new AbortController().signal, {
        runDir,
      });
      expect(slept).toEqual([1000]);
      expect(obs.exit_code).toBe(0);
      expect(obs.agent_binary_path).toBe(realpathSync(bin));
      expect((obs.warnings ?? []).filter((w) => w.startsWith('launch retry '))).toHaveLength(1);
    },
  );

  it('re-resolves when the cached real path vanishes and warns about the changed path', async () => {
    const dir = await binDir();
    const v1 = path.join(dir, 'v1', 'claude.mjs');
    const v2 = path.join(dir, 'v2', 'claude.mjs');
    await mkdir(path.dirname(v1), { recursive: true });
    await mkdir(path.dirname(v2), { recursive: true });
    await copyFile(STUB, v1);
    await copyFile(STUB, v2);
    const link = path.join(dir, 'claude.mjs');
    await symlink(v1, link);
    const a = new ClaudeCodeAdapter({ bin: link, sleep: noSleep([]) });

    const h1 = await harness();
    const first = await a.run(h1.profile, TASK, new AbortController().signal, { runDir: h1.runDir });
    expect(first.agent_binary_path).toBe(realpathSync(v1));

    await rm(v1);
    await rm(link);
    await symlink(v2, link); // an update re-created the PATH symlink to a new location
    const h2 = await harness();
    const second = await a.run(h2.profile, TASK, new AbortController().signal, { runDir: h2.runDir });
    expect(second.exit_code).toBe(0);
    expect(second.agent_binary_path).toBe(realpathSync(v2));
    expect(second.warnings).toContain(
      `agent binary path changed during the run: ${realpathSync(path.dirname(v1))}/claude.mjs -> ${realpathSync(v2)}`,
    );
  });
});
