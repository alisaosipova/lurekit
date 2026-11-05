// ADR-0024 run lifecycle tests (test plan T1, T1b, T2, T2b, T3, T5, T6). Offline: a StubAdapter
// drives the REAL detectors and an in-memory fixture through the strict state machine, the
// per-run deadline and the resisted guard. Nothing here spawns an agent; the only child process
// is none at all (the grandchild-kill tests live in test/child-process.test.ts).

import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import {
  ABANDON_AFTER_MS,
  BenchmarkRunner,
  DEFAULT_RUN_TIMEOUT_S,
  RESISTED_GUARD_WARNING,
  canScoreResisted,
  runWithDeadline,
  type DeadlineRunner,
  type EvidenceRecord,
  type RunCompletion,
  type RunConfig,
  type RunManifest,
  type RunnerIds,
} from '../src/runner/runner.js';
import type { Scenario } from '../src/scenario/types.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import type { Detector } from '../src/detectors/detector.js';
import { getDetector } from '../src/detectors/index.js';
import { main, type CliDeps } from '../src/cli.js';
import { StubAdapter, type StubScript } from './helpers/stubAdapter.js';
import { InMemoryNoopFixture } from './helpers/inMemoryNoopFixture.js';
import { mkScratch } from './helpers/scratch.js';
import { LOAD_SLACK_MS, TIMER_EARLY_MS } from './helpers/deadline.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const RECORDING = path.join(repoRoot, 'test/fixtures/recordings/claude-sample');
const realScenarios = path.join(repoRoot, 'scenarios');

type AjvCtor = new (opts: Record<string, unknown>) => {
  compile<T = unknown>(schema: unknown): ValidateFunction<T>;
};
const Ajv2020 = ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? _Ajv2020) as AjvCtor;
function schemaValidator(file: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(JSON.parse(readFileSync(path.join(repoRoot, 'schemas', file), 'utf8')));
}
const validateEvidence = schemaValidator('evidence.schema.json');
const validateManifest = schemaValidator('manifest.schema.json');

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkScratch('aab-lifecycle-');
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
function makeScenario(over: Partial<Scenario> & { id: string }): Scenario {
  return {
    schema_version: '0.1',
    name: 'lifecycle test scenario',
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
    ...over,
  };
}
async function readEvidence(cfg: RunConfig, runId: string, scenarioId: string, rep = 0): Promise<EvidenceRecord> {
  return JSON.parse(await readFile(path.join(cfg.resultsRoot, runId, scenarioId, String(rep), 'evidence.json'), 'utf8')) as EvidenceRecord;
}
function allWarnings(ev: EvidenceRecord): string[] {
  return [...(ev.warnings ?? []), ...(ev.observation?.warnings ?? [])];
}
function expectValid(ev: EvidenceRecord): void {
  const ok = validateEvidence(ev);
  expect(validateEvidence.errors ?? [], JSON.stringify(validateEvidence.errors)).toEqual([]);
  expect(ok).toBe(true);
}

/** A detector teardown spy around the real detector. */
function spiedDetector(kind: Detector['kind'], hooks: { onTeardown?: () => void; evaluateThrows?: string }): Detector {
  const real = getDetector(kind);
  return {
    kind,
    provisionAfterFixtures: real.provisionAfterFixtures,
    async provision(runId, runDir, ctx) {
      const p = await real.provision(runId, runDir, ctx);
      return {
        ...p,
        teardown: async () => {
          hooks.onTeardown?.();
          await p.teardown();
        },
      };
    },
    evaluate: (ctx) => {
      if (hooks.evaluateThrows) throw new Error(hooks.evaluateThrows);
      return real.evaluate(ctx);
    },
    selfTest: (ctx) => real.selfTest(ctx),
  };
}

let scenarioCounter = 0;

async function runStub(
  id: string,
  script: StubScript,
  cfgOver: Partial<RunConfig> = {},
  opts: { detector?: Detector; fixture?: InMemoryNoopFixture; runWithDeadline?: DeadlineRunner; abandonAfterMs?: number } = {},
) {
  const root = await tmpRoot();
  const runner = new BenchmarkRunner({
    ids: ids(id),
    ...(opts.detector ? { detectorFor: () => opts.detector! } : {}),
    ...(opts.fixture ? { fixtures: () => [opts.fixture!] } : {}),
    ...(opts.runWithDeadline ? { runWithDeadline: opts.runWithDeadline } : {}),
    ...(opts.abandonAfterMs !== undefined ? { abandonAfterMs: opts.abandonAfterMs } : {}),
  });
  const cfg = makeCfg(root, cfgOver);
  scenarioCounter += 1;
  const scenario = makeScenario({ id: `AAB-9${String(scenarioCounter).padStart(2, '0')}` });
  const adapter = new StubAdapter(script);
  const started = Date.now();
  const result = await runner.runScenario(scenario, adapter, makeProfile(path.join(root, 'work')), cfg);
  const tookMs = Date.now() - started;
  const evidence = await readEvidence(cfg, id, scenario.id);
  return { root, runner, cfg, scenario, adapter, result, evidence, tookMs };
}

// --- T1: timeout ----------------------------------------------------------------------------

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('T1 per-run timeout (ADR-0024 D1/D3)', { retry: 1 }, () => {
  it('a run that sleeps past run_timeout_ms is inconclusive(run_timeout) with timed_out and elapsed_ms', async () => {
    const T1_LIMIT_MS = 200;
    const { result, evidence, cfg, runner, scenario } = await runStub('T1', { sleepMs: 5_000, benignText: 'DONE-BENIGN' }, { run_timeout_ms: T1_LIMIT_MS });
    const run = result.runs[0];
    expect(run.outcome).toBe('inconclusive');
    expect(run.inconclusive_reason).toBe('run_timeout');
    expect(result.verdict).toBe('inconclusive');
    expect(evidence.outcome).toBe('inconclusive');
    expect(evidence.inconclusive_reason).toBe('run_timeout');
    expect(evidence.timed_out).toBe(true);
    // Bounds from the named constants (ADR-0012 amendment 2026-11-05, rule a.2): the timer may
    // fire a little early; the upper bound only says the stub's 5 s sleep was not waited out.
    expect(evidence.elapsed_ms).toBeGreaterThanOrEqual(T1_LIMIT_MS - TIMER_EARLY_MS);
    expect(evidence.elapsed_ms).toBeLessThan(T1_LIMIT_MS + LOAD_SLACK_MS);
    // The stub rejected on the signal: no observation, the warnings are top-level.
    expect(evidence.observation).toBeUndefined();
    const w = allWarnings(evidence);
    expect(w.some((x) => /^run timed out after \d+ ms \(limit 200 ms\)$/.test(x))).toBe(true);
    expectValid(evidence);
    const manifest = await runner.writeManifest(makeProfile(''), cfg, [scenario], [result], { createdAt: '2026-11-04T00:00:00.000Z', toolVersion: 'test' });
    expect(manifest.config.run_timeout_ms).toBe(T1_LIMIT_MS);
    const mok = validateManifest(manifest);
    expect(validateManifest.errors ?? []).toEqual([]);
    expect(mok).toBe(true);
  });

  it('T1b: an adapter that ignores its signal is abandoned after abandonAfterMs; the run continues', async () => {
    const T1B_LIMIT_MS = 100;
    const T1B_ABANDON_MS = 300;
    const { result, evidence, tookMs } = await runStub(
      'T1B',
      { sleepMs: 5_000, ignoreSignal: true, benignText: 'DONE-BENIGN' },
      { run_timeout_ms: T1B_LIMIT_MS },
      { abandonAfterMs: T1B_ABANDON_MS },
    );
    // The run is bounded by the timer plus the abandon window; anything past that plus the
    // load slack means the non-cooperating stub was waited out (rule a.2).
    expect(tookMs).toBeLessThan(T1B_LIMIT_MS + T1B_ABANDON_MS + LOAD_SLACK_MS);
    expect(result.runs[0].outcome).toBe('inconclusive');
    expect(result.runs[0].inconclusive_reason).toBe('run_timeout');
    expect(evidence.timed_out).toBe(true);
    expect(evidence.observation).toBeUndefined();
    const w = allWarnings(evidence);
    expect(w.some((x) => x.startsWith('run timed out after'))).toBe(true);
    expect(w.some((x) => x.startsWith('adapter did not return within 300 ms of the abort'))).toBe(true);
    expectValid(evidence);
  });

  it('a completed run under a generous timeout writes none of the lifecycle fields', async () => {
    const { result, evidence } = await runStub('T1C', { benignText: 'DONE-BENIGN' }, { run_timeout_ms: DEFAULT_RUN_TIMEOUT_S * 1000 });
    expect(result.runs[0].outcome).toBe('resisted');
    expect('timed_out' in evidence).toBe(false);
    expect('elapsed_ms' in evidence).toBe(false);
    expect('teardown_error' in evidence).toBe(false);
    expectValid(evidence);
  });

  it('no run_timeout_ms (direct runner use, replay) arms no timer: a slow adapter completes', async () => {
    const { result, evidence } = await runStub('T1D', { sleepMs: 300, benignText: 'DONE-BENIGN' });
    expect(result.runs[0].outcome).toBe('resisted');
    expect('timed_out' in evidence).toBe(false);
    expect('elapsed_ms' in evidence).toBe(false);
  });
});

// --- T2: a hit is a hit ------------------------------------------------------------------------

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('T2 a detector hit outranks every failure (evidence-spec s3.1 rule 1)', { retry: 1 }, () => {
  it('signal then throw -> vulnerable, one hit, the throw is only a warning', async () => {
    const { result, evidence } = await runStub('T2A', { trigger: 'canary_file_read', throwAfterSignal: 'boom after signal' });
    expect(result.runs[0].outcome).toBe('vulnerable');
    expect(result.runs[0].detector_hits).toHaveLength(1);
    // The hit comes from the stream the adapter wrote before it threw, not from the best-effort
    // atime branch (ADR-0025 D3: outputs declared by the adapter are read when it returns nothing).
    expect(result.runs[0].detector_hits[0].evidence_ref).toContain('(adapter returned no observation) (marker present)');
    expect(result.verdict).toBe('vulnerable');
    expect(evidence.outcome).toBe('vulnerable');
    expect(evidence.inconclusive_reason).toBeUndefined();
    expect(allWarnings(evidence)).toContain('adapter run failed: boom after signal');
    expectValid(evidence);
  });

  it('signal then sleep past the timeout -> vulnerable with timed_out: true', async () => {
    const { result, evidence } = await runStub('T2B', { trigger: 'canary_file_read', sleepMs: 5_000 }, { run_timeout_ms: 150 });
    expect(result.runs[0].outcome).toBe('vulnerable');
    expect(evidence.outcome).toBe('vulnerable');
    expect(evidence.timed_out).toBe(true);
    expect(typeof evidence.elapsed_ms).toBe('number');
    expect(allWarnings(evidence).some((x) => x.startsWith('run timed out after'))).toBe(true);
    expectValid(evidence);
  });

  it('the original throwError path (no signal) is still inconclusive(adapter_error) with no hits', async () => {
    const { result, evidence } = await runStub('T2C', { throwError: 'boom' });
    expect(result.runs[0].outcome).toBe('inconclusive');
    expect(result.runs[0].inconclusive_reason).toBe('adapter_error');
    expect(evidence.benign.evidence_ref).toBe('not evaluated (adapter error)');
    expect(evidence.observation).toBeUndefined();
  });
});

// --- T2b: the resisted guard --------------------------------------------------------------------

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('T2b the resisted guard canScoreResisted (ADR-0024 D2)', { retry: 1 }, () => {
  const completions: RunCompletion[] = ['completed', 'threw', 'timed_out', 'aborted', 'abandoned'];
  it('is true for exactly one row of the truth table', () => {
    let trues = 0;
    for (const completion of completions) {
      for (const exitCode of [0, 1, 137, undefined]) {
        for (const hits of [0, 1]) {
          for (const unmet of [0, 1]) {
            for (const settleFailed of [false, true]) {
              // ADR-0025 D5: the guard gains `tampered`; a tampered run is never resisted.
              for (const tampered of [false, true]) {
                const ok = canScoreResisted({ completion, exitCode, hits, unmet, settleFailed, tampered });
                const expected = completion === 'completed' && exitCode === 0 && hits === 0 && unmet === 0 && !settleFailed && !tampered;
                expect(ok, JSON.stringify({ completion, exitCode, hits, unmet, settleFailed, tampered })).toBe(expected);
                if (ok) trues += 1;
              }
            }
          }
        }
      }
    }
    expect(trues).toBe(1);
  });

  it('a forced non-completed completion with exit_code 0 and a passing benign never scores resisted', async () => {
    const forced: DeadlineRunner = async (fn, opts) => {
      const r = await runWithDeadline(fn, opts);
      return { ...r, completion: 'aborted', fired: 'caller', elapsedMs: 5 };
    };
    const { result, evidence } = await runStub('T2D', { benignText: 'DONE-BENIGN' }, {}, { runWithDeadline: forced });
    expect(result.runs[0].outcome).toBe('inconclusive');
    expect(result.runs[0].inconclusive_reason).toBe('adapter_error');
    expect(result.runs[0].resisted_kind).toBeUndefined();
    expect(evidence.outcome).toBe('inconclusive');
    expect(evidence.observation?.exit_code).toBe(0);
    expect(evidence.elapsed_ms).toBe(5);
    expect('timed_out' in evidence).toBe(false);
    expect(allWarnings(evidence)).toContain('run aborted by operator after 5 ms');
    expectValid(evidence);
  });

  it('a forced timed_out completion keeps the (partial) observation and its cost', async () => {
    const forced: DeadlineRunner = async (fn, opts) => {
      const r = await runWithDeadline(fn, opts);
      return { ...r, completion: 'timed_out', fired: 'timer', elapsedMs: 7 };
    };
    const { result, evidence } = await runStub('T2E', { benignText: 'DONE-BENIGN', cost: 0.25 }, { run_timeout_ms: 60_000 }, { runWithDeadline: forced });
    expect(result.runs[0].outcome).toBe('inconclusive');
    expect(result.runs[0].inconclusive_reason).toBe('run_timeout');
    expect(result.runs[0].cost_usd).toBe(0.25);
    expect(result.spend_usd).toBe(0.25);
    expect(evidence.timed_out).toBe(true);
    expect(evidence.elapsed_ms).toBe(7);
    expect(allWarnings(evidence)).toContain('run timed out after 7 ms (limit 60000 ms)');
  });

  it('RESISTED_GUARD_WARNING is the documented text', () => {
    expect(RESISTED_GUARD_WARNING).toBe('resisted guard: run did not complete normally');
  });
});

// --- T3: teardown in finally ------------------------------------------------------------------

class ThrowingTeardownFixture extends InMemoryNoopFixture {
  async teardown(): Promise<void> {
    this.teardownCalls += 1;
    throw new Error('port still busy');
  }
}

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('T3 teardown runs in finally and never changes the verdict (ADR-0024 D2/D4)', { retry: 1 }, () => {
  it('a fixture teardown that throws: resisted stays resisted, teardown_error recorded, detector teardown ran', async () => {
    const fixture = new ThrowingTeardownFixture();
    let detectorTeardowns = 0;
    const detector = spiedDetector('canary_file_read', { onTeardown: () => (detectorTeardowns += 1) });
    const { result, evidence } = await runStub('T3A', { benignText: 'DONE-BENIGN' }, { k: 2 }, { fixture, detector });
    expect(result.runs.map((r) => r.outcome)).toEqual(['resisted', 'resisted']);
    expect(result.verdict).toBe('resisted');
    expect(evidence.outcome).toBe('resisted');
    expect(evidence.teardown_error).toEqual(['web_server: port still busy']);
    expect(evidence.observation?.warnings).toContain('teardown failed: web_server: port still busy');
    expect(detectorTeardowns).toBe(2);
    expect(fixture.teardownCalls).toBe(2);
    expectValid(evidence);
  });

  it('a fixture teardown that throws on a triggering run: vulnerable stays vulnerable', async () => {
    const fixture = new ThrowingTeardownFixture();
    const { result, evidence } = await runStub('T3B', { trigger: 'canary_file_read' }, {}, { fixture });
    expect(result.runs[0].outcome).toBe('vulnerable');
    expect(evidence.outcome).toBe('vulnerable');
    expect(evidence.teardown_error).toEqual(['web_server: port still busy']);
    expectValid(evidence);
  });

  it('detector.evaluate() throws -> inconclusive(fixture_error), fixture torn down, evidence written', async () => {
    const fixture = new InMemoryNoopFixture();
    let detectorTeardowns = 0;
    const detector = spiedDetector('canary_file_read', { onTeardown: () => (detectorTeardowns += 1), evaluateThrows: 'sensor exploded' });
    const { result, evidence } = await runStub('T3C', { benignText: 'DONE-BENIGN' }, {}, { fixture, detector });
    expect(result.runs[0].outcome).toBe('inconclusive');
    expect(result.runs[0].inconclusive_reason).toBe('fixture_error');
    expect(evidence.outcome).toBe('inconclusive');
    expect(evidence.inconclusive_reason).toBe('fixture_error');
    expect(allWarnings(evidence)).toContain('detector evaluation failed: sensor exploded');
    expect(fixture.teardownCalls).toBe(1);
    expect(detectorTeardowns).toBe(1);
    expect('teardown_error' in evidence).toBe(false);
    expectValid(evidence);
  });

  it('a fixture teardown that throws on a timed-out run: run_timeout and teardown_error both recorded', async () => {
    const fixture = new ThrowingTeardownFixture();
    const { result, evidence } = await runStub('T3D', { sleepMs: 5_000 }, { run_timeout_ms: 100 }, { fixture });
    expect(result.runs[0].inconclusive_reason).toBe('run_timeout');
    expect(evidence.timed_out).toBe(true);
    expect(evidence.teardown_error).toEqual(['web_server: port still busy']);
    expect(evidence.warnings).toContain('teardown failed: web_server: port still busy');
    expectValid(evidence);
  });
});

// --- operator abort ---------------------------------------------------------------------------

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('operator abort through the caller signal (ADR-0024 D1)', { retry: 1 }, () => {
  it('an abort during the run -> inconclusive(adapter_error) with the aborted warning; later repetitions are not launched', async () => {
    const root = await tmpRoot();
    const runner = new BenchmarkRunner({ ids: ids('OPA') });
    const cfg = makeCfg(root, { k: 3, run_timeout_ms: 60_000 });
    const scenario = makeScenario({ id: 'AAB-950' });
    const adapter = new StubAdapter({ sleepMs: 5_000, benignText: 'DONE-BENIGN' });
    const ac = new AbortController();
    // Abort only once the adapter is inside its first run (the detector self-test runs first).
    const aborter = setInterval(() => {
      if (adapter.runCount >= 1) {
        clearInterval(aborter);
        ac.abort();
      }
    }, 10);
    const result = await runner.runScenario(scenario, adapter, makeProfile(path.join(root, 'work')), cfg, { signal: ac.signal });
    clearInterval(aborter);
    expect(adapter.runCount).toBe(1);
    expect(result.runs.map((r) => r.outcome)).toEqual(['inconclusive', 'inconclusive', 'inconclusive']);
    expect(result.runs.map((r) => r.inconclusive_reason)).toEqual(['adapter_error', 'adapter_error', 'adapter_error']);
    const first = await readEvidence(cfg, 'OPA', scenario.id, 0);
    expect(allWarnings(first).some((w) => /^run aborted by operator after \d+ ms$/.test(w))).toBe(true);
    expect('timed_out' in first).toBe(false);
    expect(typeof first.elapsed_ms).toBe('number');
    const second = await readEvidence(cfg, 'OPA', scenario.id, 1);
    expect(second.warnings).toContain('run aborted by operator before the adapter was launched');
    expectValid(first);
    expectValid(second);
  });
});

// --- deadline helper ----------------------------------------------------------------------------

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('runWithDeadline (src/runner/deadline.ts)', { retry: 1 }, () => {
  it('completed / threw without a signal carry no elapsed', async () => {
    const ok = await runWithDeadline(async () => 42, {});
    expect(ok).toEqual({ completion: 'completed', value: 42 });
    const bad = await runWithDeadline(async () => {
      throw new Error('x');
    }, {});
    expect(bad.completion).toBe('threw');
    expect((bad.error as Error).message).toBe('x');
    expect(bad.elapsedMs).toBeUndefined();
  });

  it('the timer fires and the signal fn received is aborted; a value returned afterwards is kept', async () => {
    const UNIT_LIMIT_MS = 50;
    let seen: AbortSignal | undefined;
    const r = await runWithDeadline(
      (signal) =>
        new Promise<string>((resolve) => {
          seen = signal;
          signal.addEventListener('abort', () => resolve('partial'), { once: true });
        }),
      { timeoutMs: UNIT_LIMIT_MS },
    );
    expect(seen?.aborted).toBe(true);
    expect(r.completion).toBe('timed_out');
    expect(r.fired).toBe('timer');
    expect(r.value).toBe('partial');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(UNIT_LIMIT_MS - TIMER_EARLY_MS);
  });

  it('an already-aborted caller signal yields aborted; a non-returning fn is abandoned', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runWithDeadline(() => new Promise<never>(() => {}), { signal: ac.signal, abandonAfterMs: 50 });
    expect(r.completion).toBe('abandoned');
    expect(r.fired).toBe('caller');
    expect(ABANDON_AFTER_MS).toBe(10_000);
  });
});

// --- T5: replay byte-identity -------------------------------------------------------------------

function cliDeps(tmp: string, sink: { out: string[]; err: string[] }, runId: string): CliDeps {
  return {
    now: () => '2026-11-04T00:00:00.000Z',
    newRunId: () => runId,
    adapterFor: () => new StubAdapter({}),
    cwd: () => tmp,
    stdout: (s) => sink.out.push(s),
    stderr: (s) => sink.err.push(s),
  };
}

async function evidenceFiles(dir: string): Promise<Map<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const out = new Map<string, string>();
  for (const scenario of await readdir(dir, { withFileTypes: true })) {
    if (!scenario.isDirectory()) continue;
    for (const rep of await readdir(path.join(dir, scenario.name), { withFileTypes: true })) {
      if (!rep.isDirectory()) continue;
      const file = path.join(dir, scenario.name, rep.name, 'evidence.json');
      try {
        out.set(`${scenario.name}/${rep.name}`, await readFile(file, 'utf8'));
      } catch {
        /* no evidence here */
      }
    }
  }
  return out;
}

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('T5 replay byte-identity (ADR-0024 D4)', { retry: 1 }, () => {
  // Two full replays of the 25-scenario recording; well above the shared per-test budget.
  it('--replay ignores --run-timeout: identical evidence bytes, no lifecycle fields, run_timeout_ms null', { timeout: 180_000 }, async () => {
    const tmp = await tmpRoot();
    const a = { out: [] as string[], err: [] as string[] };
    const codeA = await main(['run', realScenarios, '--model', 'claude-sonnet-4-5', '--replay', RECORDING, '--results', 'ra', '--format', 'json'], cliDeps(tmp, a, 'aab-replay-fixed'));
    expect(codeA, a.err.join('')).toBe(0);
    const b = { out: [] as string[], err: [] as string[] };
    const codeB = await main(['run', realScenarios, '--model', 'claude-sonnet-4-5', '--replay', RECORDING, '--results', 'rb', '--format', 'json', '--run-timeout', '1'], cliDeps(tmp, b, 'aab-replay-fixed'));
    expect(codeB, b.err.join('')).toBe(0);
    expect(b.err.join('')).toContain('note: --run-timeout is ignored for --replay');
    expect(b.err.join('')).not.toContain('per-run timeout:');

    const evA = await evidenceFiles(path.join(tmp, 'ra', 'aab-replay-fixed'));
    const evB = await evidenceFiles(path.join(tmp, 'rb', 'aab-replay-fixed'));
    expect(evA.size).toBeGreaterThan(0);
    expect([...evB.keys()].sort()).toEqual([...evA.keys()].sort());
    // task_sha256 hashes the rendered task, which carries this run's random canaries: the one
    // field that legitimately differs between two replays (evidence-spec s4.1).
    // A benign evidence_ref may carry the absolute results path (ra/ vs rb/): normalised too, in
    // both its raw and its JSON-escaped spelling (on Windows the backslashes are doubled in the
    // evidence text).
    const jsonSpelling = (p: string): string => JSON.stringify(p).slice(1, -1);
    const normalise = (text: string): string =>
      [path.join(tmp, 'ra'), path.join(tmp, 'rb')]
        .flatMap((p) => [p, jsonSpelling(p)])
        .reduce((acc, p) => acc.split(p).join('<results>'),
          text.replace(/"task_sha256": "[0-9a-f]{64}"/, '"task_sha256": "<canary-dependent>"'));
    for (const [key, text] of evA) {
      expect(normalise(evB.get(key) ?? ''), key).toBe(normalise(text));
      expect(text).not.toMatch(/"timed_out"|"elapsed_ms"|"teardown_error"/);
      // ADR-0025 D6: a clean replay carries no artefact findings and no tamper warning.
      expect(text).not.toMatch(/"artefacts"|evidence tampered|unexpected run dir entry/);
    }
    const manifestA = JSON.parse(await readFile(path.join(tmp, 'ra', 'aab-replay-fixed', 'manifest.json'), 'utf8')) as RunManifest;
    const manifestB = JSON.parse(await readFile(path.join(tmp, 'rb', 'aab-replay-fixed', 'manifest.json'), 'utf8')) as RunManifest;
    expect(manifestA.config.run_timeout_ms).toBeNull();
    expect(manifestB.config.run_timeout_ms).toBeNull();
    expect(manifestB.results).toEqual(manifestA.results);
    const mok = validateManifest(manifestA);
    expect(validateManifest.errors ?? []).toEqual([]);
    expect(mok).toBe(true);
    // The two stderr lines scripts/numbers.mjs reads are unchanged by the flag.
    const line = (err: string[], re: RegExp): string | undefined => err.join('').split('\n').find((l) => re.test(l));
    expect(line(b.err, /^running \d+ scenario\(s\) against /)).toBe(line(a.err, /^running \d+ scenario\(s\) against /));
    expect(line(b.err, /^replaying recording /)).toBe(line(a.err, /^replaying recording /));
  });
});

// --- T6: CLI flag ---------------------------------------------------------------------------------

// ADR-0012 amendment (2026-11-05, block B15, rule a.4): real timers; one retry tolerates the host, never the code.
describe('T6 --run-timeout CLI validation (ADR-0024 D1)', { retry: 1 }, () => {
  it.each([['0'], ['-5'], ['1.5']])('refuses --run-timeout %s before the prompt with a next: hint', async (value) => {
    const tmp = await tmpRoot();
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await main(['run', realScenarios, '--model', 'm', '--run-timeout', value], cliDeps(tmp, sink, 'aab-t6'));
    expect(code).toBe(1);
    const err = sink.err.join('');
    expect(err).toMatch(/refusing to run: --run-timeout must be a whole number of seconds >= 1 and <= 2147483 \(got /);
    expect(err).toMatch(/next: lurekit run .*--run-timeout 180/);
    expect(err).not.toContain('Launch?');
    expect(err).not.toContain('running ');
  });

  it('refuses a non-numeric --run-timeout at parse time', async () => {
    const tmp = await tmpRoot();
    const sink = { out: [] as string[], err: [] as string[] };
    await expect(main(['run', realScenarios, '--model', 'm', '--run-timeout', 'abc'], cliDeps(tmp, sink, 'aab-t6b'))).rejects.toThrow(/--run-timeout expects a number\nnext: pass a number, e.g. --run-timeout 180/);
  });

  it('the live-run plan prints the default per-run timeout line; a given value is echoed', async () => {
    const tmp = await tmpRoot();
    const sink = { out: [] as string[], err: [] as string[] };
    // Not a terminal and no --yes: the plan is printed, then the launch is refused (exit 1).
    const code = await main(['run', realScenarios, '--model', 'm'], cliDeps(tmp, sink, 'aab-t6c'));
    expect(code).toBe(1);
    expect(sink.err.join('')).toContain('per-run timeout: 180 s (--run-timeout)');
    const sink2 = { out: [] as string[], err: [] as string[] };
    await main(['run', realScenarios, '--model', 'm', '--run-timeout', '45'], cliDeps(tmp, sink2, 'aab-t6d'));
    expect(sink2.err.join('')).toContain('per-run timeout: 45 s (--run-timeout)');
  });

  it('a live run (stub adapter, --yes) records config.run_timeout_ms in the manifest', async () => {
    const tmp = await tmpRoot();
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await main(['run', realScenarios, '--model', 'm', '--yes', '--run-timeout', '45', '--format', 'json'], cliDeps(tmp, sink, 'aab-t6e'));
    expect(code, sink.err.join('')).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(tmp, '.aab-runs', 'aab-t6e', 'manifest.json'), 'utf8')) as RunManifest;
    expect(manifest.config.run_timeout_ms).toBe(45_000);
  });

  it('plan is unaffected by --run-timeout', async () => {
    const tmp = await tmpRoot();
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await main(['plan', realScenarios, '--model', 'm', '--run-timeout', '45'], cliDeps(tmp, sink, 'aab-t6f'));
    expect(code).toBe(0);
    expect(sink.out.join('')).toMatch(/would run/);
  });
});
