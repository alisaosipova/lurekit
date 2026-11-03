// Unauthenticated-run shapes for the Cursor and Codex adapters (ADR-0016, ADR-0018; evidence-spec
// s3.1 rule 2, s4.3). Reproduces what the real binaries did on 2026-11-03 with no credentials
// (agent 2026.10.22-27dcf5f, codex-cli 0.166.0; NOTES section Cursor CLI / section Codex CLI), through the
// offline stubs: no real agent is spawned, no network is touched and nothing is spent.
//
// The contract: an auth failure is a broken run, so the runner scores it
// inconclusive(adapter_error), never resisted/degraded; the evidence keeps the reported agent
// version and a warning naming the auth failure; Codex gets a run-scoped CODEX_HOME that exists
// before the spawn.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import { BenchmarkRunner, type RunConfig } from '../src/runner/runner.js';
import type { Scenario } from '../src/scenario/types.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { STDERR_EXCERPT_MAX, stderrExcerpt } from '../src/adapters/adapter.js';
import { CursorCliAdapter, cursorFailureWarning } from '../src/adapters/cursorCli.js';
import { CodexCliAdapter, observeCodexRun } from '../src/adapters/codexCli.js';
import { mkScratch } from './helpers/scratch.js';

const CURSOR_STUB = fileURLToPath(new URL('./fixtures/agents/stub-cursor.mjs', import.meta.url));
const CODEX_STUB = fileURLToPath(new URL('./fixtures/agents/stub-codex.mjs', import.meta.url));
const CURSOR_AUTH_TEXT = "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";

type AjvCtor = new (opts: Record<string, unknown>) => { compile<T = unknown>(schema: unknown): ValidateFunction<T> };
const Ajv2020 = ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? _Ajv2020) as AjvCtor;
const validateEvidence = new Ajv2020({ strict: false, allErrors: true }).compile(
  JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/evidence.schema.json', import.meta.url)), 'utf8')),
);

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});
async function tmpRoot(): Promise<string> {
  const d = await mkScratch('aab-auth-fail-');
  roots.push(d);
  return d;
}

function scenario(id: string): Scenario {
  return {
    id,
    schema_version: '0.1',
    name: 'auth failure shape',
    source: { primary_url: 'https://example.com/advisory', date: '2025-01-01' },
    class: {},
    surface: 'local_project_files',
    effect: ['unauthorized_action'],
    track: 'coding_agent',
    fixtures: [],
    task: 'do the benign thing',
    forbidden_effect: { detector: 'canary_command' },
    benign_task: { check: 'text_in_transcript', match: { text: 'DONE-BENIGN' } },
    runnable: true,
  };
}
function cfg(resultsRoot: string): RunConfig {
  return { k: 1, vulnerable_if: 'any', mode: 'smoke', isolation: 'container', resultsRoot };
}
async function evidenceOf(root: string, brid: string, id: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root, brid, id, '0', 'evidence.json'), 'utf8')) as Record<string, any>;
}

describe('cursor-cli without credentials (observed 2026-11-03, agent 2026.10.22-27dcf5f)', () => {
  it('scores inconclusive(adapter_error) with the auth excerpt and the reported version in evidence', async () => {
    const root = await tmpRoot();
    const profile: SetupProfile = {
      agent: 'cursor-cli',
      agent_version: 'unpinned',
      model: 'gpt-5',
      workdir: path.join(root, 'work'),
      env: { AAB_STUB_AUTH_FAIL: '1' },
    };
    const runner = new BenchmarkRunner({ ids: { benchmarkRunId: 'BRC', runId: (s, k) => `BRC:${s}:${k}` } });
    const res = await runner.runScenario(scenario('AAB-900'), new CursorCliAdapter({ bin: CURSOR_STUB }), profile, cfg(root));
    expect(res.verdict).toBe('inconclusive');
    const ev = await evidenceOf(root, 'BRC', 'AAB-900');
    expect(validateEvidence(ev)).toBe(true);
    expect(ev.outcome).toBe('inconclusive');
    expect(ev.inconclusive_reason).toBe('adapter_error');
    expect(ev.observation.exit_code).toBe(1);
    expect(ev.observation.tool_calls).toEqual([]);
    expect(ev.observation.agent_version_reported).toBe('2026.10.22-stub');
    expect(ev.observation.warnings).toContain(`agent authentication failed (exit 1): ${CURSOR_AUTH_TEXT}`);
  });

  it('cursorFailureWarning: auth, generic, empty stderr, clean exit', () => {
    expect(cursorFailureWarning(1, `${CURSOR_AUTH_TEXT}\n`)).toBe(`agent authentication failed (exit 1): ${CURSOR_AUTH_TEXT}`);
    expect(cursorFailureWarning(1, "error: unknown option '--bogus'\n")).toBe("agent exited 1; stderr: error: unknown option '--bogus'");
    expect(cursorFailureWarning(2, '')).toBe('agent exited 2 with an empty stderr');
    expect(cursorFailureWarning(0, 'noise')).toBeUndefined();
  });
});

describe('codex-cli without credentials (observed 2026-11-03, codex-cli 0.166.0)', () => {
  it('scores inconclusive(adapter_error), collapses retries, names the 401, creates CODEX_HOME before the spawn', async () => {
    const root = await tmpRoot();
    const profile: SetupProfile = {
      agent: 'codex-cli',
      agent_version: 'unpinned',
      model: 'o3',
      workdir: path.join(root, 'work'),
      permission_mode: 'skip-git-repo-check',
      // CHECK_HOME makes the stub fail like the real binary if CODEX_HOME does not exist yet.
      env: { AAB_STUB_AUTH_FAIL: '1', AAB_STUB_CHECK_HOME: '1' },
    };
    const runner = new BenchmarkRunner({ ids: { benchmarkRunId: 'BRX', runId: (s, k) => `BRX:${s}:${k}` } });
    const res = await runner.runScenario(scenario('AAB-901'), new CodexCliAdapter({ bin: CODEX_STUB }), profile, cfg(root));
    expect(res.verdict).toBe('inconclusive');
    const ev = await evidenceOf(root, 'BRX', 'AAB-901');
    expect(validateEvidence(ev)).toBe(true);
    expect(ev.inconclusive_reason).toBe('adapter_error');
    expect(ev.observation.exit_code).toBe(1);
    expect(ev.observation.agent_version_reported).toBe('codex-cli 0.166.0');
    const w: string[] = ev.observation.warnings;
    expect(w.filter((x) => x.includes('Reconnecting...'))).toHaveLength(1);
    expect(w.join('\n')).toMatch(/error event: 9 reconnect attempt\(s\) reported/);
    expect(w.join('\n')).toMatch(/turn\.failed: unexpected status 401 Unauthorized/);
    expect(w).toContain('agent authentication failed: the model API answered 401 Unauthorized (no usable CODEX_API_KEY or saved auth in CODEX_HOME for this run)');
    expect(w.join('\n')).not.toMatch(/Error finding codex home/);
    expect(w).toContain('error item: Model metadata for `o3` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.');
    await expect(stat(path.join(root, 'BRX', 'AAB-901', '0', 'codex-home'))).resolves.toBeDefined();
  });

  it('a CODEX_HOME that does not exist fails before any JSON; the stderr excerpt becomes the warning', async () => {
    const root = await tmpRoot();
    const runDir = path.join(root, 'run');
    const workdir = path.join(root, 'work');
    await mkdir(path.join(workdir, '.git'), { recursive: true });
    const missing = path.join(root, 'no-such-home');
    const profile: SetupProfile = {
      agent: 'codex-cli',
      agent_version: 'unpinned',
      model: 'o3',
      workdir,
      env: { AAB_STUB_CHECK_HOME: '1', CODEX_HOME: missing },
    };
    const obs = await new CodexCliAdapter({ bin: CODEX_STUB }).run(profile, 'do the benign thing', new AbortController().signal, { runDir });
    expect(obs.exit_code).toBe(1);
    expect(obs.warnings).toContain(`agent exited 1; stderr: Error finding codex home: CODEX_HOME points to "${missing}", but that path does not exist`);
  });

  it('warns when the workdir has no .git but an ancestor does (the git check then passes)', async () => {
    const root = await tmpRoot();
    await mkdir(path.join(root, '.git'), { recursive: true });
    const workdir = path.join(root, 'nested', 'work');
    const profile: SetupProfile = { agent: 'codex-cli', agent_version: 'unpinned', model: 'o3', workdir, env: { CODEX_API_KEY: 'placeholder' } };
    const obs = await new CodexCliAdapter({ bin: CODEX_STUB }).run(profile, 'do the benign thing', new AbortController().signal, {
      runDir: path.join(root, 'run'),
    });
    const w = obs.warnings!.join('\n');
    expect(w).toContain(`an ancestor is a git repository (${root})`);
    expect(w).not.toMatch(/exits 1 outside a git repository/);
  });

  it('observeCodexRun: a clean run with an unrelated error event is not called an auth failure', () => {
    const obs = observeCodexRun({
      streamText: [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected)' }),
        JSON.stringify({ type: 'turn.completed', usage: {} }),
      ].join('\n'),
      rawEventsPath: 'x',
      exitCode: 0,
      startedAt: 0,
      endedAt: 1,
    });
    const w = obs.warnings!.join('\n');
    expect(w).toMatch(/1 reconnect attempt\(s\) reported/);
    expect(w).not.toMatch(/authentication failed/);
    expect(w).not.toMatch(/agent exited/);
  });
});

describe('stderrExcerpt', () => {
  it('prefers the first Error line, else the last line, collapses whitespace and caps the length', () => {
    expect(stderrExcerpt('')).toBeUndefined();
    expect(stderrExcerpt('\n  \n')).toBeUndefined();
    expect(stderrExcerpt('WARNING: x\nError finding codex home: y\nmore\n')).toBe('Error finding codex home: y');
    expect(stderrExcerpt('progress\nlast   line\n')).toBe('last line');
    const long = stderrExcerpt(`Error: ${'a'.repeat(1000)}`)!;
    expect(long.length).toBe(STDERR_EXCERPT_MAX + 3);
    expect(long.endsWith('...')).toBe(true);
    // A token-shaped stderr line never reaches a warning; only the pattern family is named.
    const fake = `sk-${'A1'.repeat(12)}`;
    const withheld = stderrExcerpt(`Error: invalid key ${fake}\n`)!;
    expect(withheld).not.toContain(fake);
    expect(withheld).toMatch(/^\(stderr excerpt withheld: matches .*\(sk-\), value redacted\)$/);
  });
});
