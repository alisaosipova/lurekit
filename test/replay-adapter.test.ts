// Replay adapter tests (ADR-0015, evidence-spec §4.2/§4.5). Fully offline: a recorded Claude
// Code run is re-driven through the REAL parse/merge code (observeClaudeRun); no process is
// spawned, no network is touched, nothing is spent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReplayAdapter, REPLAY_WARNING } from '../src/adapters/replay.js';
import { observeClaudeRun } from '../src/adapters/claudeCode.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { main, type CliDeps } from '../src/cli.js';
import type { RunManifest } from '../src/runner/types.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const RECORDING = path.join(repoRoot, 'test/fixtures/recordings/claude-sample');
const realScenarios = path.join(repoRoot, 'scenarios');

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aab-replay-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function profile(): SetupProfile {
  return {
    agent: 'claude-code',
    agent_version: '@anthropic-ai/claude-code@2.1.309',
    model: 'claude-sonnet-4-6',
    workdir: path.join(tmp, 'work'),
  };
}

describe('ReplayAdapter', () => {
  it('declares id claude-code', () => {
    expect(new ReplayAdapter({ recordingDir: RECORDING }).id).toBe('claude-code');
  });

  it('re-drives the recording through the shared parser and merges by tool_use_id', async () => {
    const runDir = path.join(tmp, 'run');
    const obs = await new ReplayAdapter({ recordingDir: RECORDING }).run(
      profile(), 'summarise notes.txt', new AbortController().signal, { runDir },
    );

    expect(obs.tool_calls).toHaveLength(1);
    const call = obs.tool_calls[0];
    expect(call.id).toBe('toolu_rec_0001');
    expect(call.name).toBe('Read');
    expect(call.source).toBe('stream');
    expect(call.sources).toEqual(['stream', 'hook']);

    expect(obs.cost_usd).toBe(0.0087);
    expect(obs.effective_model).toBe('claude-sonnet-4-6');
    expect(obs.effective_permission_mode).toBe('default');
    expect(obs.exit_code).toBe(0);
    expect(obs.used_bare).toBe(false);
    expect(obs.started_at).toBe(1767225600000);
    expect(obs.ended_at).toBe(1767225605210);
    expect(obs.agent_version_reported).toBe('2.1.309 (Claude Code)');
    expect(obs.transcript_path).toMatch(/rec-session-0001\.jsonl$/);
    expect(obs.warnings).toEqual([REPLAY_WARNING]); // provenance marker, ADR-0015

    // Raw evidence is copied verbatim into the run dir.
    expect(obs.raw_events_path).toBe(path.join(runDir, 'claude-stream.jsonl'));
    expect(readFileSync(obs.raw_events_path, 'utf8')).toBe(
      readFileSync(path.join(RECORDING, 'claude-stream.jsonl'), 'utf8'),
    );
    expect(existsSync(path.join(runDir, 'claude-hooks.jsonl'))).toBe(true);
  });

  it('is deterministic: two replays give the same observation modulo run dir', async () => {
    const a = await new ReplayAdapter({ recordingDir: RECORDING }).run(
      profile(), 't', new AbortController().signal, { runDir: path.join(tmp, 'a') },
    );
    const b = await new ReplayAdapter({ recordingDir: RECORDING }).run(
      profile(), 't', new AbortController().signal, { runDir: path.join(tmp, 'b') },
    );
    expect({ ...a, raw_events_path: '' }).toEqual({ ...b, raw_events_path: '' });
  });

  it('works without a hook log (stream-only) and defaults exit_code/timestamps', async () => {
    const rec = path.join(tmp, 'rec');
    mkdirSync(rec);
    copyFileSync(path.join(RECORDING, 'claude-stream.jsonl'), path.join(rec, 'claude-stream.jsonl'));
    const obs = await new ReplayAdapter({ recordingDir: rec }).run(
      profile(), 't', new AbortController().signal, { runDir: path.join(tmp, 'run') },
    );
    expect(obs.tool_calls[0].sources).toEqual(['stream']);
    expect(obs.exit_code).toBe(0);
    expect(obs.started_at).toBe(0);
    expect(obs.ended_at).toBe(0);
  });

  it('rejects a recording without a stream file', async () => {
    await expect(
      new ReplayAdapter({ recordingDir: tmp }).run(profile(), 't', new AbortController().signal, {
        runDir: path.join(tmp, 'run'),
      }),
    ).rejects.toThrow(/claude-stream\.jsonl/);
  });
});

describe('observeClaudeRun (pure parse/merge step)', () => {
  it('keeps id-less calls separate and fills name from the hook layer', () => {
    const streamText = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', input: { a: 1 } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob' }] } }),
      'not json',
    ].join('\n');
    const hooksText = JSON.stringify({ tool_use_id: 'x1', tool_name: 'Bash', aab_hook_at: 50 }) + '\n';
    const obs = observeClaudeRun({
      streamText, hooksText, rawEventsPath: 'r', exitCode: 3, startedAt: 10, endedAt: 20, usedBare: false,
    });
    expect(obs.tool_calls.map((c) => [c.id, c.name, c.sources])).toEqual([
      ['x1', 'Bash', ['stream', 'hook']],
      [undefined, 'Glob', ['stream']],
    ]);
    expect(obs.exit_code).toBe(3);
    expect(obs.cost_usd).toBeUndefined();
  });
});

describe('cli run --replay (offline)', () => {
  it('runs a one-scenario corpus from a recording and writes a manifest', async () => {
    const scenDir = path.join(tmp, 'corpus');
    mkdirSync(scenDir, { recursive: true });
    copyFileSync(path.join(realScenarios, 'AAB-030.yaml'), path.join(scenDir, 'AAB-030.yaml'));
    const resultsRoot = path.join(tmp, 'runs');
    const out: string[] = [];
    const err: string[] = [];
    let adapterForCalls = 0;
    const deps: CliDeps = {
      now: () => '2026-11-02T00:00:00.000Z',
      newRunId: () => 'aab-replay-run',
      adapterFor: () => {
        adapterForCalls += 1;
        throw new Error('adapterFor must be bypassed under --replay');
      },
      cwd: () => tmp,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    };

    const code = await main(
      ['run', scenDir, '--model', 'claude-sonnet-4-6', '--results', resultsRoot, '--replay', RECORDING, '--format', 'json'],
      deps,
    );
    expect(code).toBe(0);
    expect(adapterForCalls).toBe(0);

    const manifestPath = path.join(resultsRoot, 'aab-replay-run', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;
    expect(manifest.results[0].scenario_id).toBe('AAB-030');
    expect(manifest.totals.vulnerable).toBe(0);
    expect(manifest.totals.resisted).toBe(1); // benign 'SUMMARY:' marker found in the replayed stream
    expect(manifest.totals.spend_usd).toBeCloseTo(0.0087);
    expect(err.join('')).toContain('replaying recording');

    // The replay is identifiable from its artefacts alone (ADR-0015).
    const evidence = JSON.parse(
      readFileSync(path.join(resultsRoot, 'aab-replay-run', 'AAB-030', '0', 'evidence.json'), 'utf8'),
    ) as { observation: { warnings?: string[] } };
    expect(evidence.observation.warnings).toContain(REPLAY_WARNING);
  });

  it('rejects --replay with a non-claude-code agent', async () => {
    const deps: CliDeps = {
      now: () => '2026-11-02T00:00:00.000Z',
      newRunId: () => 'x',
      adapterFor: () => { throw new Error('unused'); },
      cwd: () => tmp,
      stdout: () => {},
      stderr: () => {},
    };
    await expect(
      main(['run', realScenarios, '--model', 'm', '--agent', 'codex', '--replay', RECORDING], deps),
    ).rejects.toThrow(/--replay only supports --agent claude-code/);
  });

  it('still requires --model under --replay', async () => {
    const deps: CliDeps = {
      now: () => '2026-11-02T00:00:00.000Z',
      newRunId: () => 'x',
      adapterFor: () => { throw new Error('unused'); },
      cwd: () => tmp,
      stdout: () => {},
      stderr: () => {},
    };
    await expect(main(['run', realScenarios, '--replay', RECORDING], deps)).rejects.toThrow(/--model/);
  });

  it('usage mentions --replay', async () => {
    const out: string[] = [];
    await main(['--help'], {
      now: () => '', newRunId: () => '', adapterFor: () => { throw new Error('unused'); },
      cwd: () => tmp, stdout: (s) => out.push(s), stderr: () => {},
    });
    expect(out.join('')).toContain('--replay <dir>');
  });
});
