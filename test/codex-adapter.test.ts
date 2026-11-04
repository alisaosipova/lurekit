// Codex CLI adapter tests (ADR-0018; evidence-spec §4.1, §4.5). Fully offline: the adapter is
// pointed at test/fixtures/agents/stub-codex.mjs, so NO real `codex` is spawned, no network is
// touched and nothing is spent.

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CODEX_BIN_ENV,
  CodexCliAdapter,
  buildCodexArgv,
  codexFlagNames,
  describeCodexItem,
  newCodexStreamState,
  observeCodexRun,
  parseCodexPermissionMode,
  parseCodexStreamLine,
} from '../src/adapters/codexCli.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { defaultDeps } from '../src/cli.js';
import { mkScratch } from './helpers/scratch.js';
import { pollUntil } from './helpers/deadline.js';

const STUB = fileURLToPath(new URL('./fixtures/agents/stub-codex.mjs', import.meta.url));
const MODEL = 'gpt-5.5-codex';
const TASK = 'do the benign thing';
const MODEL_WARN = /stream reports no model/;
const LOOSENING = [
  '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--approve-for-me', '--not-so-yolo', '--full-auto',
  '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--sandbox', '-s', '--ask-for-approval', '-a',
];

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Harness { profile: SetupProfile; runDir: string; argvPath: string; envPath: string; versionFile: string; }

async function harness(
  overrides: Partial<SetupProfile> = {},
  extraEnv: Record<string, string> = {},
  opts: { git?: boolean } = {},
): Promise<Harness> {
  const base = await mkScratch('aab-codex-adapter-');
  tmpDirs.push(base);
  const runDir = path.join(base, 'run');
  const argvPath = path.join(base, 'stub-argv.json');
  const envPath = path.join(base, 'stub-env.json');
  const versionFile = path.join(base, 'stub-version');
  await writeFile(versionFile, 'codex-cli 0.166.0', 'utf8');
  const workdir = path.join(base, 'work');
  if (opts.git !== false) await mkdir(path.join(workdir, '.git'), { recursive: true });
  const profile: SetupProfile = {
    agent: 'codex-cli',
    agent_version: '@openai/codex@0.166.0',
    model: MODEL,
    workdir,
    // Placeholder value only: the stub never reads it; it silences the auth warning.
    env: { AAB_STUB_ARGV_OUT: argvPath, AAB_STUB_ENV_OUT: envPath, AAB_STUB_VERSION_FILE: versionFile, CODEX_API_KEY: 'aab-test-placeholder', ...extraEnv },
    ...overrides,
  };
  return { profile, runDir, argvPath, envPath, versionFile };
}

const adapter = (opts: { isolateCodexHome?: boolean } = {}): CodexCliAdapter => new CodexCliAdapter({ bin: STUB, ...opts });
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const run = async (h: Harness, a = adapter(), bare?: boolean) =>
  a.run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir, ...(bare ? { bare } : {}) });

describe('CodexCliAdapter.capabilities (ADR-0018 §Decision 2)', () => {
  it('declares stream only, no version pin, model pin', () => {
    expect(adapter().capabilities()).toEqual({ headless: true, observes: ['stream'], can_pin_version: false, can_pin_model: true });
    expect(adapter().id).toBe('codex-cli');
  });
});

describe('permission_mode grammar and argv (§4.1 invariant 1)', () => {
  it('builds the base headless argv and adds no loosening flag when mode is undefined', () => {
    const argv = buildCodexArgv({ model: MODEL, workdir: '/w', permission_mode: undefined }, TASK);
    expect(argv).toEqual(['exec', '--json', '-C', '/w', '-m', MODEL, TASK]);
    for (const f of LOOSENING) expect(argv).not.toContain(f);
  });

  it('maps each token to exactly one flag, task last', () => {
    const argv = buildCodexArgv(
      { model: MODEL, workdir: '/w', permission_mode: 'sandbox=workspace-write skip-git-repo-check,bypass-hook-trust' },
      TASK,
    );
    expect(argv.slice(6)).toEqual([
      '--sandbox', 'workspace-write', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', TASK,
    ]);
    expect(buildCodexArgv({ model: MODEL, workdir: '/w', permission_mode: 'yolo' }, TASK).slice(6))
      .toEqual(['--dangerously-bypass-approvals-and-sandbox', TASK]);
    expect(buildCodexArgv({ model: MODEL, workdir: '/w', permission_mode: 'approve-for-me' }, TASK).slice(6))
      .toEqual(['--approve-for-me', TASK]);
  });

  it('sandbox=read-only emits only --sandbox read-only', () => {
    expect(buildCodexArgv({ model: MODEL, workdir: '/w', permission_mode: 'sandbox=read-only' }, TASK).slice(6))
      .toEqual(['--sandbox', 'read-only', TASK]);
  });

  it('rejects unknown, bad-valued and conflicting tokens rather than dropping them', () => {
    expect(() => parseCodexPermissionMode('full-auto')).toThrow(/unknown permission_mode token/);
    expect(() => parseCodexPermissionMode('sandbox=wide-open')).toThrow(/unknown sandbox value/);
    // exec has no --ask-for-approval (TUI-only, NOTES), so any approval= token is refused.
    expect(() => parseCodexPermissionMode('approval=untrusted')).toThrow(/no --ask-for-approval/);
    expect(() => parseCodexPermissionMode('approval=never')).toThrow(/no --ask-for-approval/);
    expect(() => parseCodexPermissionMode('sandbox=read-only,sandbox=workspace-write')).toThrow(/conflicting/);
    expect(() => parseCodexPermissionMode('approve-for-me,sandbox=read-only')).toThrow(/conflicting/);
    expect(() => parseCodexPermissionMode('approve-for-me yolo')).toThrow(/conflicting/);
    expect(() => parseCodexPermissionMode('yolo sandbox=read-only')).toThrow(/conflicting/);
  });

  it('refuses a task that starts with "-" (would be parsed as an option or stdin marker)', () => {
    expect(() => buildCodexArgv({ model: MODEL, workdir: '/w' }, '--yolo do it')).toThrow(/must not start with "-"/);
    expect(() => buildCodexArgv({ model: MODEL, workdir: '/w' }, '-')).toThrow(/must not start with "-"/);
  });

  it('refuses a task equal to an exec subcommand name (resume, fork, review)', () => {
    for (const sub of ['resume', 'fork', 'review', ' review ']) {
      expect(() => buildCodexArgv({ model: MODEL, workdir: '/w' }, sub)).toThrow(/exec subcommand/);
    }
    expect(buildCodexArgv({ model: MODEL, workdir: '/w' }, 'review the code').at(-1)).toBe('review the code');
  });

  it('codexFlagNames drops values, task, workdir and model', () => {
    const argv = buildCodexArgv({ model: MODEL, workdir: '/w', permission_mode: 'sandbox=read-only' }, TASK);
    expect(codexFlagNames(argv)).toEqual(['--json', '-C', '-m', '--sandbox']);
  });
});

describe('CodexCliAdapter.run against the stub', () => {
  it('spawns the stub with the built argv, pins model + workdir, records agent_flags', async () => {
    const h = await harness();
    const obs = await run(h);
    const argv = await readJson<string[]>(h.argvPath);
    expect(argv).toEqual(buildCodexArgv(h.profile, TASK));
    expect(argv[argv.indexOf('-m') + 1]).toBe(MODEL);
    expect(argv[argv.indexOf('-C') + 1]).toBe(h.profile.workdir);
    for (const f of LOOSENING) expect(argv).not.toContain(f);
    expect(obs.agent_flags).toEqual(['--json', '-C', '-m']);
  });

  it('parses items into one ToolCall per item.id, skipping non-tool items', async () => {
    const h = await harness();
    const obs = await run(h);
    expect(obs.tool_calls.map((c) => [c.id, c.name])).toEqual([
      ['item_1', 'command_execution'],
      ['item_2', 'file_change'],
      ['item_3', 'canary_mcp_tool'],
      ['item_4', 'web_search'],
    ]);
    expect(obs.tool_calls[0].input).toEqual({ command: 'bash -lc ls' });
    expect(obs.tool_calls[1].input).toEqual({ changes: [{ path: 'out.txt', kind: 'add' }] });
    expect(obs.tool_calls[2].input).toEqual({ server: 'aab-canary', tool: 'canary_mcp_tool', arguments: { q: 'aab-canary' } });
    expect(obs.tool_calls[3].input).toEqual({ query: 'aab canary docs' });
    for (const c of obs.tool_calls) {
      expect(c.source).toBe('stream');
      expect(c.sources).toEqual(['stream']);
    }
    expect(obs.exit_code).toBe(0);
    expect(obs.cost_usd).toBeUndefined();
    expect(obs.effective_model).toBeUndefined();
    expect(obs.agent_version_reported).toBe('codex-cli 0.166.0');
    expect(obs.attempts).toEqual([]);
  });

  it('keeps an undocumented item type raw under name unknown', async () => {
    const h = await harness({}, { AAB_STUB_UNKNOWN_ITEM: '1' });
    const obs = await run(h);
    const u = obs.tool_calls.find((c) => c.id === 'item_5')!;
    expect(u.name).toBe('unknown');
    expect((u.input as Record<string, unknown>).type).toBe('collab_tool_call');
  });

  it('decodes a multi-byte UTF-8 char split across stdout chunks', async () => {
    const h = await harness({}, { AAB_STUB_SPLIT_UTF8: '1' });
    const obs = await run(h);
    expect(obs.tool_calls.find((c) => c.id === 'item_6')?.input).toEqual({ command: 'cat café-☃.md' });
  });

  it('writes stdout, stderr and argv verbatim into runDir', async () => {
    const h = await harness({}, { AAB_STUB_FAIL: '1' });
    const fail = await run(h);
    expect(fail.exit_code).toBe(1);
    expect(fail.tool_calls).toEqual([]);
    expect(await readFile(path.join(h.runDir, 'codex-stderr.log'), 'utf8')).toContain('stub failure');
    expect(await readFile(fail.raw_events_path, 'utf8')).toBe('');

    const ok = await harness();
    const obs = await run(ok);
    expect(obs.raw_events_path).toBe(path.join(ok.runDir, 'codex-stream.jsonl'));
    const raw = await readFile(obs.raw_events_path, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(12);
    expect(raw).toContain('"cache_write_input_tokens":5');
    expect(await readFile(path.join(ok.runDir, 'codex-stderr.log'), 'utf8')).toContain('progress goes to stderr');
    const argvRec = await readJson<string[]>(path.join(ok.runDir, 'codex-argv.json'));
    expect(argvRec[0]).toBe(STUB);
    // ADR-0008 amendment: the task is stored as its sha256, never verbatim.
    const taskRef = `<task sha256:${createHash('sha256').update(TASK, 'utf8').digest('hex')}>`;
    expect(argvRec.slice(1)).toEqual(buildCodexArgv(ok.profile, TASK).map((a) => (a === TASK ? taskRef : a)));
    expect(JSON.stringify(argvRec)).not.toContain(TASK);
  });

  it('points CODEX_HOME at a run-scoped dir and installs nothing into the workdir', async () => {
    const h = await harness();
    await run(h);
    expect((await readJson<{ CODEX_HOME: string }>(h.envPath)).CODEX_HOME).toBe(path.join(h.runDir, 'codex-home'));
    await expect(stat(path.join(h.profile.workdir!, '.codex'))).rejects.toThrow();
    expect(await readdir(h.profile.workdir!)).toEqual(['.git']);
  });

  it('records turn.failed and error events as warnings with the exit code', async () => {
    const h = await harness({}, { AAB_STUB_TURN_FAILED: '1' });
    const obs = await run(h);
    expect(obs.exit_code).toBe(1);
    const w = obs.warnings!.join('\n');
    expect(w).toMatch(/turn\.failed: stub turn failure/);
    expect(w).toMatch(/error event: stub stream error/);
  });
});

describe('warnings', () => {
  it('a clean run carries only the model-echo warning', async () => {
    const h = await harness();
    const obs = await run(h);
    expect(obs.warnings).toEqual([expect.stringMatching(MODEL_WARN)]);
  });

  it('warns on missing CODEX_API_KEY with a run-scoped home, never printing values', async () => {
    const h = await harness();
    delete h.profile.env!.CODEX_API_KEY;
    const prev = process.env.CODEX_API_KEY;
    delete process.env.CODEX_API_KEY;
    try {
      const obs = await run(h);
      expect(obs.warnings!.join('\n')).toMatch(/CODEX_API_KEY is not set/);
    } finally {
      if (prev !== undefined) process.env.CODEX_API_KEY = prev;
    }
  });

  it('warns when CODEX_HOME is not run-scoped (option off or set by the profile)', async () => {
    const h = await harness();
    const obs = await run(h, adapter({ isolateCodexHome: false }));
    expect(obs.warnings!.join('\n')).toMatch(/not run-scoped/);

    const h2 = await harness();
    const home = path.join(path.dirname(h2.runDir), 'operator-home');
    h2.profile.env!.CODEX_HOME = home;
    const obs2 = await run(h2);
    expect(obs2.warnings!.join('\n')).toMatch(/profile\.env sets CODEX_HOME/);
    expect((await readJson<{ CODEX_HOME: string }>(h2.envPath)).CODEX_HOME).toBe(home);
  });

  // Scratch is repo-local (.aab-test-work/, evidence-spec s2.1), so a .git-less workdir always
  // has the repository as a git ancestor: this exercises the nested-workdir branch. The
  // "outside any git repository" branch cannot be reached from repo-local scratch without a
  // seam in the adapter's ancestor lookup; it is not covered here (see CHANGELOG, Unreleased).
  it('warns on a .git-less workdir nested in a repository, with or without the git-check skip', async () => {
    const h = await harness({}, {}, { git: false });
    const w = (await run(h)).warnings!.join('\n');
    expect(w).toMatch(/no \.git entry but an ancestor is a git repository/);
    expect(w).not.toMatch(/exits 1 outside a git repository/);
    const h2 = await harness({ permission_mode: 'skip-git-repo-check' }, {}, { git: false });
    expect((await run(h2)).warnings!.join('\n')).toMatch(/ancestor is a git repository/);
  });

  it('warns on a project .codex/ layer, on bypass-hook-trust and on --bare', async () => {
    const h = await harness({ permission_mode: 'bypass-hook-trust' });
    await mkdir(path.join(h.profile.workdir!, '.codex'), { recursive: true });
    await writeFile(path.join(h.profile.workdir!, '.codex', 'config.toml'), '# planted\n');
    const obs = await run(h, adapter(), true);
    const w = obs.warnings!.join('\n');
    expect(w).toMatch(/project \.codex\/ layer/);
    expect(w).toMatch(/un-gates hooks/);
    expect(w).toMatch(/--bare/);
    expect(await readFile(path.join(h.profile.workdir!, '.codex', 'config.toml'), 'utf8')).toBe('# planted\n');
  });

  it('warns on version mismatch with the profile and on drift during the run', async () => {
    const h = await harness({ agent_version: '@openai/codex@0.150.0' }, { AAB_STUB_VERSION_AFTER: 'codex-cli 0.167.0' });
    const obs = await run(h);
    const w = obs.warnings!.join('\n');
    expect(w).toMatch(/version mismatch/);
    expect(w).toMatch(/drifted during the run: codex-cli 0\.166\.0 -> codex-cli 0\.167\.0/);
    expect(obs.exit_code).toBe(0);
  });

  it('does not compare against an unpinned version', async () => {
    const h = await harness({ agent_version: 'unpinned' });
    expect((await run(h)).warnings).toEqual([expect.stringMatching(MODEL_WARN)]);
  });
});

describe('binary resolution, abort, errors', () => {
  it('uses the env override when no ctor bin is given', async () => {
    const prev = process.env[CODEX_BIN_ENV];
    process.env[CODEX_BIN_ENV] = STUB;
    try {
      const h = await harness();
      await new CodexCliAdapter().run(h.profile, TASK, new AbortController().signal, { runDir: h.runDir });
      await expect(stat(h.argvPath)).resolves.toBeDefined();
    } finally {
      if (prev === undefined) delete process.env[CODEX_BIN_ENV];
      else process.env[CODEX_BIN_ENV] = prev;
    }
  });

  it('kills the child on abort', async () => {
    const base = await mkScratch('aab-codex-abort-');
    tmpDirs.push(base);
    const ready = path.join(base, 'ready');
    const h = await harness({}, { AAB_STUB_HANG: '1', AAB_STUB_READY: ready });
    const ac = new AbortController();
    const p = adapter().run(h.profile, TASK, ac.signal, { runDir: h.runDir });
    await pollUntil(() => stat(ready), 'stub never ready');
    ac.abort();
    const obs = await p;
    expect(obs.exit_code).not.toBe(0);
  });

  it('throws without a runDir, on a bad permission_mode and on a "-" task before spawning', async () => {
    const h = await harness();
    await expect(adapter().run(h.profile, TASK, new AbortController().signal)).rejects.toThrow(/runDir/);
    const h2 = await harness({ permission_mode: 'full-auto' });
    await expect(adapter().run(h2.profile, TASK, new AbortController().signal, { runDir: h2.runDir })).rejects.toThrow(/unknown/);
    await expect(stat(h2.argvPath)).rejects.toThrow();
    // A valid profile with a "-"-prefixed task must also be refused before anything is spawned.
    const h3 = await harness();
    await expect(adapter().run(h3.profile, '--yolo', new AbortController().signal, { runDir: h3.runDir })).rejects.toThrow(/must not start with "-"/);
    await expect(stat(h3.argvPath)).rejects.toThrow();
    await expect(stat(path.join(h3.runDir, 'codex-argv.json'))).rejects.toThrow();
  });
});

describe('pure parse step', () => {
  it('observeCodexRun is deterministic and ignores non-JSON and unknown events', () => {
    const streamText = [
      'not json',
      JSON.stringify({ type: 'thread.started', thread_id: 't1', future_field: 1 }),
      JSON.stringify({ type: 'future.event', x: 1 }),
      JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join('\n');
    const meta = { rawEventsPath: '/r', exitCode: 0, startedAt: 1, endedAt: 2, streamText };
    const a = observeCodexRun(meta);
    expect(a).toEqual(observeCodexRun(meta));
    expect(a.tool_calls).toEqual([{ id: 'i1', name: 'command_execution', input: { command: 'ls' }, at: 0, source: 'stream', sources: ['stream'] }]);
    expect(a.warnings).toEqual([expect.stringMatching(MODEL_WARN)]);
    expect(a.agent_flags).toBeUndefined();
  });

  it('sums turn.completed usage across turns and keeps the thread id', () => {
    const s = newCodexStreamState();
    parseCodexStreamLine(JSON.stringify({ type: 'thread.started', thread_id: 'th' }), 0, s);
    parseCodexStreamLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } }), 0, s);
    parseCodexStreamLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, reasoning_output_tokens: 5 } }), 0, s);
    expect(s.threadId).toBe('th');
    expect(s.usage).toEqual({ input_tokens: 7, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 5 });
  });

  it('warns when exit 0 but no turn.completed was seen', () => {
    const obs = observeCodexRun({ rawEventsPath: '/r', exitCode: 0, startedAt: 1, endedAt: 2, streamText: '' });
    expect(obs.warnings!.join('\n')).toMatch(/without a turn\.completed/);
  });

  it('describeCodexItem skips non-tool items and keeps unknown ones raw', () => {
    for (const type of ['agent_message', 'reasoning', 'todo_list', 'error']) expect(describeCodexItem({ id: 'x', type })).toBeUndefined();
    expect(describeCodexItem({ id: 'x', type: 'brand_new', a: 1 })).toEqual({ name: 'unknown', input: { id: 'x', type: 'brand_new', a: 1 } });
    expect(describeCodexItem({ id: 'x', type: 'mcp_tool_call', server: 's', arguments: {} }))
      .toEqual({ name: 'mcp_tool_call', input: { server: 's', tool: undefined, arguments: {} } });
  });
});

describe('CLI wiring', () => {
  it('defaultDeps().adapterFor returns the Codex adapter for codex-cli', () => {
    const a = defaultDeps().adapterFor('codex-cli');
    expect(a.id).toBe('codex-cli');
    expect(a).toBeInstanceOf(CodexCliAdapter);
  });
});
