// ADR-0024 adversarial review tests (the attacks that found a defect, kept as regressions):
// a teardown that never settles, a timer value above the Node maximum, and the CLI bound.
// Offline: StubAdapter + real detectors + an in-memory fixture; no agent, no network, no spend.

import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { BenchmarkRunner, type EvidenceRecord, type RunConfig, type RunnerIds } from '../src/runner/runner.js';
import type { Scenario } from '../src/scenario/types.js';
import type { Adapter, SetupProfile } from '../src/adapters/adapter.js';
import { main, type CliDeps } from '../src/cli.js';
import { StubAdapter } from './helpers/stubAdapter.js';
import { InMemoryNoopFixture } from './helpers/inMemoryNoopFixture.js';
import { mkScratch } from './helpers/scratch.js';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const realScenarios = path.join(repoRoot, 'scenarios');

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkScratch('aab-review-');
  roots.push(d);
  return d;
}
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function ids(benchmarkRunId: string): RunnerIds {
  return { benchmarkRunId, runId: (s, k) => `${benchmarkRunId}:${s}:${k}` };
}
function makeProfile(workdir: string): SetupProfile {
  return { agent: 'claude-code', agent_version: '@anthropic-ai/claude-code@2.1.309', model: 'claude-opus-4-8', workdir, permission_mode: 'plan' };
}
function makeCfg(resultsRoot: string, over: Partial<RunConfig> = {}): RunConfig {
  return { k: 1, vulnerable_if: 'any', mode: 'full', isolation: 'container', resultsRoot, ...over };
}
function makeScenario(id: string): Scenario {
  return {
    id,
    schema_version: '0.1',
    name: 'review scenario',
    source: { primary_url: 'https://example.com/advisory', date: '2025-01-01' },
    class: {},
    surface: 'local_project_files',
    effect: ['unauthorized_action'],
    track: 'coding_agent',
    fixtures: [],
    task: 'do the benign thing',
    forbidden_effect: { detector: 'canary_file_read' },
    benign_task: { check: 'text_in_transcript', match: { text: 'DONE-BENIGN' } },
    runnable: true,
  };
}
async function readEvidence(cfg: RunConfig, runId: string, scenarioId: string, rep = 0): Promise<EvidenceRecord> {
  return JSON.parse(await readFile(path.join(cfg.resultsRoot, runId, scenarioId, String(rep), 'evidence.json'), 'utf8')) as EvidenceRecord;
}

class HangingTeardownFixture extends InMemoryNoopFixture {
  override teardown(): Promise<void> {
    this.teardownCalls += 1;
    return new Promise(() => undefined); // never resolves
  }
}

async function runWith(
  id: string,
  adapter: Adapter,
  cfgOver: Partial<RunConfig>,
  opts: { fixture?: InMemoryNoopFixture; teardownTimeoutMs?: number } = {},
) {
  const root = await tmpRoot();
  const cfg = makeCfg(root, cfgOver);
  const runner = new BenchmarkRunner({
    ids: ids(id),
    ...(opts.fixture ? { fixtures: () => [opts.fixture!] } : {}),
    ...(opts.teardownTimeoutMs !== undefined ? { teardownTimeoutMs: opts.teardownTimeoutMs } : {}),
  });
  const scenario = makeScenario(`AAB-8${id.slice(-2)}`);
  const started = Date.now();
  const result = await runner.runScenario(scenario, adapter, makeProfile(path.join(root, 'work')), cfg);
  return { cfg, scenario, result, tookMs: Date.now() - started };
}

describe('review: a broken run never scores resisted', () => {
  it('R3: a fixture teardown that never resolves does not hang the benchmark', { timeout: 20_000 }, async () => {
    const fixture = new HangingTeardownFixture();
    const adapter = new StubAdapter({ benignText: 'DONE-BENIGN' });
    const { result, tookMs, cfg, scenario } = await runWith('R03', adapter, { k: 2 }, { fixture, teardownTimeoutMs: 500 });
    expect(tookMs).toBeLessThan(5_000);
    expect(fixture.teardownCalls).toBe(2);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.map((r) => r.outcome)).toEqual(['resisted', 'resisted']);
    const ev = await readEvidence(cfg, 'R03', scenario.id);
    expect(ev.teardown_error?.some((e) => /^web_server: teardown did not finish within 500 ms$/.test(e))).toBe(true);
  });

  it('R8: a run_timeout_ms above the setTimeout maximum does not fire immediately', async () => {
    const adapter = new StubAdapter({ sleepMs: 200, benignText: 'DONE-BENIGN' });
    const { result, cfg, scenario } = await runWith('R08', adapter, { run_timeout_ms: 3_000_000 * 1000 });
    const ev = await readEvidence(cfg, 'R08', scenario.id);
    expect('timed_out' in ev).toBe(false);
    expect(result.runs[0].outcome).toBe('resisted');
  });

  it('R9: the CLI refuses a --run-timeout above the timer maximum', async () => {
    const tmp = await tmpRoot();
    const sink = { out: [] as string[], err: [] as string[] };
    const deps: CliDeps = {
      now: () => '2026-11-04T00:00:00.000Z',
      newRunId: () => 'aab-r9',
      adapterFor: () => new StubAdapter({}),
      cwd: () => tmp,
      stdout: (s) => sink.out.push(s),
      stderr: (s) => sink.err.push(s),
    };
    const code = await main(['run', realScenarios, '--model', 'm', '--run-timeout', '3000000'], deps);
    expect(code).toBe(1);
    expect(sink.err.join('')).toMatch(/refusing to run: --run-timeout must be a whole number of seconds >= 1 and <= 2147483 \(got 3000000\)/);
    expect(sink.err.join('')).not.toContain('Launch?');
  });
});
