// Per-run workdir isolation (ADR-0002 runner lifecycle; evidence-spec §2.1/§2.2). Fully
// offline: StubAdapter + REAL detectors. Proves that every repetition gets its own fresh
// workdir under the run dir, that a scenario never sees files left by the previous one, that
// the workdir is recorded in evidence, that the CLI works without --workdir, and that a stub
// run creates nothing under os.tmpdir() (TMPDIR is redirected to an empty sentinel dir and its
// listing is snapshotted before/after). Test roots live under the repo, not os.tmpdir().

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { chmod, mkdir, readdir, readFile, rm, rmdir, writeFile, stat, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import { BenchmarkRunner, mergeProfilePatch, type RunConfig, type RunnerIds } from '../src/runner/runner.js';
import { PoisonedRepoFixture, SkillPackageFixture } from '../src/fixtures/index.js';
import type { EvidenceRecord } from '../src/runner/types.js';
import type { Scenario } from '../src/scenario/types.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { FixtureBase, type FixtureContext, type FixtureProvision } from '../src/fixtures/fixture.js';
import type { FixtureKind } from '../src/scenario/types.js';
import { CanaryCommandDetector } from '../src/detectors/canaryCommand.js';
import { main, type CliDeps } from '../src/cli.js';
import { StubAdapter } from './helpers/stubAdapter.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

type AjvCtor = new (opts: Record<string, unknown>) => { compile(schema: unknown): ValidateFunction };
const Ajv2020 = ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? _Ajv2020) as AjvCtor;
const validateEvidence = new Ajv2020({ strict: false, allErrors: true }).compile(
  JSON.parse(readFileSync(path.join(repoRoot, 'schemas/evidence.schema.json'), 'utf8')),
);

/** Records what the workdir looked like when the fixture was provisioned into it. */
class WorkdirProbeFixture extends FixtureBase {
  readonly type: FixtureKind = 'web_server';
  static seen: Array<{ workdir: string; entries: string[] }> = [];
  protected async provisionInert(ctx: FixtureContext): Promise<FixtureProvision> {
    WorkdirProbeFixture.seen.push({ workdir: ctx.workdir, entries: await readdir(ctx.workdir) });
    return { canaries: { host: '127.0.0.1' } };
  }
  async teardown(): Promise<void> {}
}

let root: string;
let sentinelTmp: string;
const savedEnv: Record<string, string | undefined> = {};
const TMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

beforeEach(async () => {
  root = path.join(repoRoot, '.aab-test-work', `pw-${randomBytes(6).toString('hex')}`);
  sentinelTmp = path.join(root, 'sentinel-tmp');
  await mkdir(sentinelTmp, { recursive: true });
  for (const v of TMP_VARS) {
    savedEnv[v] = process.env[v];
    process.env[v] = sentinelTmp;
  }
  WorkdirProbeFixture.seen = [];
});
afterEach(async () => {
  for (const v of TMP_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  await chmod(sentinelTmp, 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
  try {
    await rmdir(path.join(repoRoot, '.aab-test-work'));
  } catch {
    /* another test still uses it */
  }
});

function ids(id: string): RunnerIds {
  return { benchmarkRunId: id, runId: (s, k) => `${id}:${s}:${k}` };
}
function profile(over: Partial<SetupProfile> = {}): SetupProfile {
  return { agent: 'claude-code', agent_version: 'unpinned', model: 'test-model', permission_mode: 'plan', ...over };
}
function cfg(resultsRoot: string, over: Partial<RunConfig> = {}): RunConfig {
  return { k: 1, vulnerable_if: 'any', mode: 'full', isolation: 'container', resultsRoot, ...over };
}
function scenario(id: string): Scenario {
  return {
    schema_version: '0.1',
    id,
    name: `workdir isolation ${id}`,
    source: { primary_url: 'https://example.com/advisory', date: '2025-01-01' },
    class: {},
    surface: 'local_project_files',
    effect: ['unauthorized_action'],
    track: 'coding_agent',
    fixtures: [],
    task: 'do the benign thing',
    forbidden_effect: { detector: 'canary_command' },
    benign_task: { check: 'file_written', match: { path: 'leftover.txt' } },
    runnable: true,
  } as Scenario;
}
async function evidenceAt(resultsRoot: string, run: string, sid: string, rep: number): Promise<EvidenceRecord> {
  return JSON.parse(await readFile(path.join(resultsRoot, run, sid, String(rep), 'evidence.json'), 'utf8'));
}

describe('per-run workdir (ADR-0002, evidence-spec §2.1)', () => {
  it('os.tmpdir() is redirected to the empty sentinel for these tests', () => {
    expect(tmpdir()).toBe(sentinelTmp);
  });

  it('two scenarios get distinct fresh workdirs; the second sees nothing the first left', async () => {
    const results = path.join(root, 'runs');
    const runner = new BenchmarkRunner({ ids: ids('BW1'), fixtures: () => [new WorkdirProbeFixture()] });
    const stub = new StubAdapter({ writeFile: { rel: 'leftover.txt', content: 'from a previous scenario' } });
    const { results: rs } = await runner.run(
      [scenario('AAB-901'), scenario('AAB-902')],
      stub,
      profile(),
      cfg(results),
      { createdAt: '2026-11-02T00:00:00.000Z', toolVersion: '0.0.0' },
    );
    expect(stub.runCount).toBe(2);
    const w1 = path.join(results, 'BW1', 'AAB-901', '0', 'work');
    const w2 = path.join(results, 'BW1', 'AAB-902', '0', 'work');
    expect(WorkdirProbeFixture.seen.map((s) => s.workdir)).toEqual([w1, w2]);
    expect(WorkdirProbeFixture.seen.map((s) => s.entries)).toEqual([[], []]);
    expect(rs.map((r) => r.runs[0].workdir)).toEqual([w1, w2]);
    // The first scenario's file stayed in ITS workdir; the second wrote its own.
    expect(await readFile(path.join(w1, 'leftover.txt'), 'utf8')).toBe('from a previous scenario');
    expect((await stat(path.join(w2, 'leftover.txt'))).isFile()).toBe(true);
    for (const sid of ['AAB-901', 'AAB-902']) {
      const ev = await evidenceAt(results, 'BW1', sid, 0);
      expect(ev.workdir).toBe('work');
      expect(ev.outcome).toBe('resisted'); // benign file_written resolved against the per-run workdir
      expect(validateEvidence(ev), JSON.stringify(validateEvidence.errors)).toBe(true);
    }
    // Self-test scratch was cleaned out of the run dir.
    await expect(stat(path.join(results, 'BW1', '.selftest'))).rejects.toThrow();
  });

  it('k repetitions of one scenario each get their own workdir', async () => {
    const results = path.join(root, 'runs');
    const runner = new BenchmarkRunner({ ids: ids('BW2'), fixtures: () => [new WorkdirProbeFixture()] });
    const stub = new StubAdapter({ writeFile: { rel: 'leftover.txt', content: 'x' } });
    const r = await runner.runScenario(scenario('AAB-903'), stub, profile(), cfg(results, { k: 2 }));
    expect(r.runs.map((x) => x.workdir)).toEqual([0, 1].map((k) => path.join(results, 'BW2', 'AAB-903', String(k), 'work')));
    expect(WorkdirProbeFixture.seen.map((s) => s.entries)).toEqual([[], []]);
  });

  it('an explicit profile.workdir is only a BASE: <base>/<scenario_id>/<rep>, recorded absolute', async () => {
    const results = path.join(root, 'runs');
    const base = path.join(root, 'base');
    const runner = new BenchmarkRunner({ ids: ids('BW3'), fixtures: () => [new WorkdirProbeFixture()] });
    const stub = new StubAdapter({ writeFile: { rel: 'leftover.txt', content: 'x' } });
    const r = await runner.runScenario(scenario('AAB-904'), stub, profile({ workdir: base }), cfg(results, { k: 2 }));
    const expected = [0, 1].map((k) => path.join(base, 'AAB-904', String(k)));
    expect(r.runs.map((x) => x.workdir)).toEqual(expected);
    const ev = await evidenceAt(results, 'BW3', 'AAB-904', 1);
    expect(ev.workdir).toBe(expected[1]);
    expect(validateEvidence(ev)).toBe(true);
  });

  it('refuses (fixture_error) a non-fresh per-run dir under an explicit base and never clears it', async () => {
    const results = path.join(root, 'runs');
    const base = path.join(root, 'base');
    const stale = path.join(base, 'AAB-905', '0');
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'stale.txt'), 'old', 'utf8');
    const runner = new BenchmarkRunner({ ids: ids('BW4') });
    const stub = new StubAdapter({});
    const r = await runner.runScenario(scenario('AAB-905'), stub, profile({ workdir: base }), cfg(results));
    expect(r.runs[0].outcome).toBe('inconclusive');
    expect(r.runs[0].inconclusive_reason).toBe('fixture_error');
    expect(stub.runCount).toBe(0);
    expect(await readFile(path.join(stale, 'stale.txt'), 'utf8')).toBe('old');
  });

  it('a stub run (runner + detector selfTests) creates nothing under os.tmpdir()', async () => {
    const before = await readdir(tmpdir());
    // Also catch TRANSIENT use (a temp dir created then removed would leave the listing equal):
    // on POSIX the sentinel is made read-only, so any mkdtemp there throws, the detector
    // selfTest fails, and the scenarios would be skipped as detector_unverified.
    if (process.platform !== 'win32') await chmod(sentinelTmp, 0o500);
    const results = path.join(root, 'runs');
    const runner = new BenchmarkRunner({ ids: ids('BW5'), fixtures: () => [new WorkdirProbeFixture()] });
    const stub = new StubAdapter({ trigger: 'canary_command', writeFile: { rel: 'leftover.txt', content: 'x' } });
    const { plan, results: rs } = await runner.run(
      [scenario('AAB-906'), scenario('AAB-907')],
      stub,
      profile(),
      cfg(results),
      { createdAt: '2026-11-02T00:00:00.000Z', toolVersion: '0.0.0' },
    );
    expect(plan.skipped).toEqual([]);
    expect(stub.runCount).toBe(2);
    expect(rs.map((r) => r.verdict)).toEqual(['vulnerable', 'vulnerable']);
    expect(await readdir(tmpdir())).toEqual(before);
    expect(before).toEqual([]);
  });

  it('detector selfTest scratch goes under the given base and is removed', async () => {
    const base = path.join(root, 'st-base');
    expect(await new CanaryCommandDetector().selfTest({ base })).toEqual({ positive: true, negative: true });
    expect(await readdir(base)).toEqual([]);
    expect(await readdir(tmpdir())).toEqual([]);
  });
});

/** Records the profile each run was handed (the adapter's cwd is profile.workdir). */
class ProfileRecordingStub extends StubAdapter {
  seenWorkdirs: Array<{ workdir: string | undefined; entries: string[] }> = [];
  override async run(...args: Parameters<StubAdapter['run']>): ReturnType<StubAdapter['run']> {
    const wd = args[0].workdir;
    this.seenWorkdirs.push({ workdir: wd, entries: wd ? (await readdir(wd)).sort() : [] });
    return super.run(...args);
  }
}

describe('real fixtures + adapter use the per-run workdir', () => {
  it('poisoned_repo and skill_package provision into <run>/<id>/<rep>/work, the adapter gets it', async () => {
    const results = path.join(root, 'runs');
    const runner = new BenchmarkRunner({
      ids: ids('BW6'),
      fixtures: (sc) => (sc.id === 'AAB-911' ? [new PoisonedRepoFixture()] : [new SkillPackageFixture()]),
    });
    const stub = new ProfileRecordingStub({ writeFile: { rel: 'leftover.txt', content: 'x' } });
    await runner.run([scenario('AAB-911'), scenario('AAB-912')], stub, profile(), cfg(results), {
      createdAt: '2026-11-02T00:00:00.000Z',
      toolVersion: '0.0.0',
    });
    const w1 = path.join(results, 'BW6', 'AAB-911', '0', 'work');
    const w2 = path.join(results, 'BW6', 'AAB-912', '0', 'work');
    expect(stub.seenWorkdirs.map((s) => s.workdir)).toEqual([w1, w2]);
    expect(stub.seenWorkdirs[0].entries).toEqual(expect.arrayContaining(['README.md', '.mcp.json', '.claude']));
    expect(stub.seenWorkdirs[1].entries).toEqual(['.claude']); // skill only; nothing from AAB-911
    expect(await readdir(tmpdir())).toEqual([]);
  });

  it('a fixture profilePatch cannot move the workdir', () => {
    const warnings: string[] = [];
    const merged = mergeProfilePatch(profile({ workdir: '/per/run/work' }), { workdir: '/elsewhere' }, warnings);
    expect(merged.workdir).toBe('/per/run/work');
    expect(warnings.join(' ')).toMatch(/change workdir; ignored/);
  });
});

describe('cli run without --workdir', () => {
  function deps(cwd: string, stub: StubAdapter): CliDeps {
    return {
      now: () => '2026-11-02T00:00:00.000Z',
      newRunId: () => 'aab-test-run',
      adapterFor: () => stub,
      cwd: () => cwd,
      stdout: () => {},
      stderr: () => {},
    };
  }

  it('runs, puts the workdir under --results, records it, and writes nothing to os.tmpdir()', async () => {
    const before = await readdir(tmpdir());
    const scenDir = path.join(root, 'corpus');
    await mkdir(scenDir, { recursive: true });
    await copyFile(path.join(repoRoot, 'scenarios', 'AAB-030.yaml'), path.join(scenDir, 'AAB-030.yaml'));
    const results = path.join(root, 'runs');
    const stub = new StubAdapter({ benignText: 'here is a summary' });
    const code = await main(['run', scenDir, '--model', 'test-model', '--results', results], deps(root, stub));
    expect(code).toBe(0);
    expect(stub.runCount).toBe(1);
    const ev = await evidenceAt(results, 'aab-test-run', 'AAB-030', 0);
    expect(ev.workdir).toBe('work');
    expect((await stat(path.join(results, 'aab-test-run', 'AAB-030', '0', 'work'))).isDirectory()).toBe(true);
    expect(await readdir(tmpdir())).toEqual(before);
  });

  it('--workdir sets only the base for per-run dirs', async () => {
    const scenDir = path.join(root, 'corpus');
    await mkdir(scenDir, { recursive: true });
    await copyFile(path.join(repoRoot, 'scenarios', 'AAB-030.yaml'), path.join(scenDir, 'AAB-030.yaml'));
    const results = path.join(root, 'runs');
    const stub = new StubAdapter({ benignText: 'here is a summary' });
    const code = await main(
      ['run', scenDir, '--model', 'test-model', '--results', results, '--workdir', 'wbase'],
      deps(root, stub),
    );
    expect(code).toBe(0);
    const ev = await evidenceAt(results, 'aab-test-run', 'AAB-030', 0);
    expect(ev.workdir).toBe(path.join(root, 'wbase', 'AAB-030', '0'));
  });
});
