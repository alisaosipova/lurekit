// Cursor CLI adapter tests (ADR-0016; evidence-spec §4.1, §4.5). Fully offline: the adapter is
// pointed at test/fixtures/agents/stub-cursor.mjs, so NO real `agent` is spawned, no network
// is touched and nothing is spent.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CURSOR_BIN_ENV,
  CursorCliAdapter,
  buildCursorArgv,
  describeCursorToolCall,
  observeCursorRun,
  parseCursorPermissionMode,
} from '../src/adapters/cursorCli.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { defaultDeps } from '../src/cli.js';
import { mkScratch } from './helpers/scratch.js';
import { pollUntil } from './helpers/deadline.js';

const STUB = fileURLToPath(new URL('./fixtures/agents/stub-cursor.mjs', import.meta.url));
const MODEL = 'claude-4-sonnet';
const TASK = 'do the benign thing';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Harness { profile: SetupProfile; runDir: string; argvPath: string; versionFile: string; }

async function harness(overrides: Partial<SetupProfile> = {}, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const base = await mkScratch('aab-cursor-adapter-');
  tmpDirs.push(base);
  const runDir = path.join(base, 'run');
  const argvPath = path.join(base, 'stub-argv.json');
  const versionFile = path.join(base, 'stub-version');
  await writeFile(versionFile, '2026.10.22', 'utf8');
  const profile: SetupProfile = {
    agent: 'cursor-cli',
    agent_version: 'agent@2026.10.22',
    model: MODEL,
    workdir: path.join(base, 'work'),
    env: { AAB_STUB_ARGV_OUT: argvPath, AAB_STUB_VERSION_FILE: versionFile, AAB_STUB_MODEL_NAME: MODEL, ...extraEnv },
    ...overrides,
  };
  return { profile, runDir, argvPath, versionFile };
}

const adapter = (opts: { disableAutoUpdate?: boolean } = {}): CursorCliAdapter => new CursorCliAdapter({ bin: STUB, ...opts });
const readArgv = async (p: string): Promise<string[]> => JSON.parse(await readFile(p, 'utf8')) as string[];

describe('CursorCliAdapter.capabilities (ADR-0016 §Decision 2)', () => {
  it('declares stream only, no version pin, model pin', () => {
    // delivers_mcp_config: false (evidence-spec s4.4, block 8): this adapter writes no MCP config for the agent.
    expect(adapter().capabilities()).toEqual({ headless: true, observes: ['stream'], can_pin_version: false, can_pin_model: true, delivers_mcp_config: false });
    expect(adapter().id).toBe('cursor-cli');
  });
});

describe('permission_mode grammar and argv (§4.1 invariant 1)', () => {
  it('builds the base headless argv and adds no permission flag when mode is undefined', () => {
    const argv = buildCursorArgv({ model: MODEL, workdir: '/w', permission_mode: undefined }, TASK);
    // s4.1 leading-dash guard (block 3): options first, then the verified `--`, then the task.
    expect(argv).toEqual(['-p', '--output-format', 'stream-json', '--workspace', '/w', '--model', MODEL, '--', TASK]);
    for (const f of ['--force', '--yolo', '--trust', '--approve-mcps', '--mode', '--sandbox', '--disable-auto-update']) {
      expect(argv).not.toContain(f);
    }
  });

  it('maps each token to exactly one flag', () => {
    const argv = buildCursorArgv(
      { model: MODEL, workdir: '/w', permission_mode: 'mode=plan, sandbox=enabled trust,approve-mcps,force' },
      TASK,
    );
    expect(argv.slice(7)).toEqual(['--mode', 'plan', '--sandbox', 'enabled', '--force', '--trust', '--approve-mcps', '--', TASK]);
  });

  it('plan alone emits --mode plan and nothing looser', () => {
    const argv = buildCursorArgv({ model: MODEL, workdir: '/w', permission_mode: 'plan' }, TASK);
    expect(argv.slice(7)).toEqual(['--mode', 'plan', '--', TASK]);
  });

  it('rejects unknown and conflicting tokens rather than dropping them', () => {
    expect(() => parseCursorPermissionMode('acceptEdits')).toThrow(/unknown permission_mode token/);
    expect(() => parseCursorPermissionMode('plan,ask')).toThrow(/conflicting/);
    expect(() => parseCursorPermissionMode('sandbox=enabled,sandbox=disabled')).toThrow(/conflicting/);
  });

  it('refuses a task that starts with "-" (would be parsed as an option such as --force)', () => {
    expect(() => buildCursorArgv({ model: MODEL, workdir: '/w' }, '--force do it')).toThrow(/must not start with "-"/);
    expect(() => buildCursorArgv({ model: MODEL, workdir: '/w' }, '-f')).toThrow(/must not start with "-"/);
  });

  it('passes --disable-auto-update only when configured', () => {
    expect(buildCursorArgv({ model: MODEL, workdir: '/w' }, TASK, { disableAutoUpdate: true })).toContain('--disable-auto-update');
  });
});

describe('CursorCliAdapter.run against the stub', () => {
  it('spawns the stub with the built argv and pins model + workspace', async () => {
    const h = await harness({ permission_mode: 'ask' });
    await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    const argv = await readArgv(h.argvPath);
    expect(argv).toEqual(buildCursorArgv(h.profile, TASK));
    expect(argv[argv.indexOf('--model') + 1]).toBe(MODEL);
    expect(argv[argv.indexOf('--workspace') + 1]).toBe(h.profile.workdir);
  });

  it('decodes a multi-byte UTF-8 char split across stdout chunks', async () => {
    const h = await harness({}, { AAB_STUB_SPLIT_UTF8: '1' });
    const obs = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    const call = obs.tool_calls.find((c) => c.id === 'call_canary_utf8_0005');
    expect(call?.input).toEqual({ path: 'caf\u00e9-\u2603.md' });
  });

  it('parses tool_call started/completed into one call per call_id', async () => {
    const h = await harness({ permission_mode: 'plan' });
    const obs = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(obs.tool_calls.map((c) => [c.id, c.name])).toEqual([
      ['call_canary_read_0001', 'readToolCall'],
      ['call_canary_write_0002', 'writeToolCall'],
      ['call_canary_fn_0003', 'canary_mcp_tool'],
    ]);
    expect(obs.tool_calls[0].input).toEqual({ path: 'README.md' });
    expect(obs.tool_calls[1].input).toEqual({ path: 'out.txt', fileText: 'aab-benign', toolCallId: 'call_canary_write_0002' });
    expect(obs.tool_calls[2].input).toBe('{"q":"aab-canary"}');
    for (const c of obs.tool_calls) {
      expect(c.source).toBe('stream');
      expect(c.sources).toEqual(['stream']);
    }
    expect(obs.exit_code).toBe(0);
    expect(obs.cost_usd).toBeUndefined();
    expect(obs.effective_model).toBe(MODEL);
    expect(obs.effective_permission_mode).toBe('plan');
    expect(obs.agent_version_reported).toBe('2026.10.22');
  });

  it('keeps an undocumented tool_call shape raw under name unknown', async () => {
    const h = await harness({}, { AAB_STUB_UNKNOWN_TOOL: '1' });
    const obs = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    const u = obs.tool_calls.find((c) => c.id === 'call_canary_unknown_0004')!;
    expect(u.name).toBe('unknown');
    expect(u.input).toEqual({ somethingNew: 42 });
  });

  it('writes stdout, stderr and argv verbatim into runDir', async () => {
    const h = await harness({}, { AAB_STUB_FAIL: '1' });
    const fail = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(fail.exit_code).toBe(1);
    expect(fail.tool_calls).toEqual([]);
    expect(await readFile(path.join(h.runDir, 'cursor-stderr.log'), 'utf8')).toContain('stub failure');
    expect(await readFile(fail.raw_events_path, 'utf8')).toBe('');

    const ok = await harness();
    const obs = await adapter().run(ok.profile, TASK, new AbortController().signal, { runDir: ok.runDir });
    expect(obs.raw_events_path).toBe(path.join(ok.runDir, 'cursor-stream.jsonl'));
    const raw = await readFile(obs.raw_events_path, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(11);
    expect(raw).toContain('"apiKeySource":"env"');
    const argvRec = JSON.parse(await readFile(path.join(ok.runDir, 'cursor-argv.json'), 'utf8')) as string[];
    expect(argvRec[0]).toBe(STUB);
  });

  it('installs nothing into the workdir (observe, do not steer)', async () => {
    const h = await harness();
    await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    await expect(stat(path.join(h.profile.workdir!, '.cursor'))).rejects.toThrow();
    await expect(stat(path.join(h.profile.workdir!, '.claude'))).rejects.toThrow();
  });
});

describe('warnings', () => {
  it('warns that auto-update is not disabled unless configured', async () => {
    const h = await harness();
    const obs = await adapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(obs.warnings).toEqual([expect.stringMatching(/auto-update not disabled/)]);
    const h2 = await harness();
    const obs2 = await adapter({ disableAutoUpdate: true }).run(h2.profile, TASK, new AbortController().signal, { runDir: h2.runDir });
    expect(obs2.warnings).toBeUndefined();
  });

  it('warns when the reported model display name differs from the requested id', async () => {
    const h = await harness({}, { AAB_STUB_MODEL_NAME: 'Claude 4 Sonnet' });
    const obs = await adapter({ disableAutoUpdate: true }).run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(obs.effective_model).toBe('Claude 4 Sonnet');
    expect(obs.warnings!.join(' ')).toMatch(/display name/);
  });

  it('warns on version mismatch with the profile and on drift during the run', async () => {
    const h = await harness({ agent_version: 'agent@2025.1.1' }, { AAB_STUB_VERSION_AFTER: '2026.10.23' });
    const obs = await adapter({ disableAutoUpdate: true }).run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    const w = obs.warnings!.join('\n');
    expect(w).toMatch(/version mismatch/);
    expect(w).toMatch(/drifted during the run: 2026\.10\.22 -> 2026\.10\.23/);
    expect(obs.exit_code).toBe(0);
  });

  it('does not compare against an unpinned version', async () => {
    const h = await harness({ agent_version: 'unpinned' });
    const obs = await adapter({ disableAutoUpdate: true }).run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
    expect(obs.warnings).toBeUndefined();
  });

  it('warns when the workdir carries Claude Code settings.json hooks, and on --bare', async () => {
    const h = await harness();
    await mkdir(path.join(h.profile.workdir!, '.claude'), { recursive: true });
    await writeFile(path.join(h.profile.workdir!, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
    const obs = await adapter({ disableAutoUpdate: true }).run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir, bare: true });
    const w = obs.warnings!.join('\n');
    expect(w).toMatch(/Claude Code hooks/);
    expect(w).toMatch(/--bare/);
  });
});

describe('binary resolution, abort, errors', () => {
  it('uses the env override when no ctor bin is given', async () => {
    const prev = process.env[CURSOR_BIN_ENV];
    process.env[CURSOR_BIN_ENV] = STUB;
    try {
      const h = await harness();
      await new CursorCliAdapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
      await expect(stat(h.argvPath)).resolves.toBeDefined();
    } finally {
      if (prev === undefined) delete process.env[CURSOR_BIN_ENV];
      else process.env[CURSOR_BIN_ENV] = prev;
    }
  });

  it('kills the child on abort', async () => {
    const base = await mkScratch('aab-cursor-abort-');
    tmpDirs.push(base);
    const ready = path.join(base, 'ready');
    const h = await harness({}, { AAB_STUB_HANG: '1', AAB_STUB_READY: ready });
    const ac = new AbortController();
    const p = adapter().run(h.profile, TASK, ac.signal, { runDir: h.runDir });
    await pollUntil(() => stat(ready), 'stub never ready');
    ac.abort();
    const obs = await p;
    expect(obs.exit_code).not.toBe(0);
    expect(obs.effective_model).toBe(MODEL);
  });

  it('throws without a runDir and on a bad permission_mode before spawning', async () => {
    const h = await harness();
    await expect(adapter().run(h.profile, TASK, new AbortController().signal)).rejects.toThrow(/runDir/);
    const h2 = await harness({ permission_mode: 'bypassPermissions' });
    await expect(adapter().run(h2.profile, TASK, new AbortController().signal, { runDir: h2.runDir })).rejects.toThrow(/unknown/);
    await expect(stat(h2.argvPath)).rejects.toThrow();
  });
});

describe('pure parse step', () => {
  it('observeCursorRun is deterministic and ignores non-JSON and unknown events', () => {
    const streamText = [
      'not json',
      JSON.stringify({ type: 'system', subtype: 'init', model: 'X', permissionMode: 'default', future_field: 1 }),
      JSON.stringify({ type: 'thinking', text: 'ignored' }),
      JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'a' } } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
    ].join('\n');
    const meta = { requestedModel: 'X', rawEventsPath: '/r', exitCode: 0, startedAt: 1, endedAt: 2, streamText };
    const a = observeCursorRun(meta);
    expect(a).toEqual(observeCursorRun(meta));
    expect(a.tool_calls).toEqual([{ id: 'c1', name: 'readToolCall', input: { path: 'a' }, at: 0, source: 'stream', sources: ['stream'] }]);
    expect(a.warnings).toBeUndefined();
  });

  it('describeCursorToolCall prefers function.name and falls back to raw', () => {
    expect(describeCursorToolCall({ function: { name: 'f', arguments: {} } })).toEqual({ name: 'f', input: {} });
    expect(describeCursorToolCall(null)).toEqual({ name: 'unknown', input: null });
  });
});

describe('CLI wiring', () => {
  it('defaultDeps().adapterFor returns the Cursor adapter for cursor-cli', () => {
    const a = defaultDeps().adapterFor('cursor-cli');
    expect(a.id).toBe('cursor-cli');
    expect(a).toBeInstanceOf(CursorCliAdapter);
  });
});
