// ADR-0026 amendment (UB-4): `run --baseline <runDir>` diffs the finished run against a baseline
// and exits 3 on a regression. Offline: a replayed AAB-030 run (degraded) against edited copies of
// its own manifest.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, type CliDeps } from '../src/cli.js';
import type { RunManifest } from '../src/runner/types.js';
import { mkScratchSync } from './helpers/scratch.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const RECORDING = path.join(repoRoot, 'test/fixtures/recordings/claude-sample');

let tmp: string;
beforeEach(() => {
  tmp = mkScratchSync('aab-baseline-');
  mkdirSync(path.join(tmp, 'corpus'), { recursive: true });
  copyFileSync(path.join(repoRoot, 'scenarios', 'AAB-030.yaml'), path.join(tmp, 'corpus', 'AAB-030.yaml'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function harness(runId: string) {
  const out: string[] = [];
  const err: string[] = [];
  let adapterCalls = 0;
  const deps: CliDeps = {
    now: () => '2026-11-05T00:00:00.000Z',
    newRunId: () => runId,
    adapterFor: () => {
      adapterCalls += 1;
      throw new Error('unused under --replay');
    },
    cwd: () => tmp,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  };
  return { out, err, deps, adapterCalls: () => adapterCalls };
}

const runArgs = (extra: string[]) => ['run', path.join(tmp, 'corpus'), '--model', 'claude-sonnet-4-6', '--results', path.join(tmp, 'runs'), '--replay', RECORDING, '--format', 'json', ...extra];

/** A baseline run directory whose AAB-030 verdict is `verdict`. */
async function baselineWith(verdict: RunManifest['results'][number]['verdict']): Promise<string> {
  const h = harness('aab-base');
  expect(await main(runArgs([]), h.deps)).toBe(0);
  const p = path.join(tmp, 'runs', 'aab-base', 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8')) as RunManifest;
  m.results[0].verdict = verdict;
  writeFileSync(p, JSON.stringify(m));
  return path.join('runs', 'aab-base');
}

describe('run --baseline (UB-4)', () => {
  it('exits 3 and names the scenario when the run is worse than the baseline', async () => {
    const base = await baselineWith('resisted'); // this run: degraded, worse than resisted
    const h = harness('aab-new');
    expect(await main(runArgs(['--baseline', base]), h.deps)).toBe(3);
    const err = h.err.join('');
    expect(err).toContain(`Compared with the baseline ${base}`);
    expect(err).toMatch(/gate: --baseline tripped by AAB-030 \(exit 3\)/);
  });

  it('exits 0 and still prints the comparison when nothing got worse', async () => {
    const base = await baselineWith('degraded');
    const h = harness('aab-new');
    expect(await main(runArgs(['--baseline', base]), h.deps)).toBe(0);
    expect(h.err.join('')).toContain('Compared with the baseline');
    expect(h.err.join('')).not.toContain('gate: --baseline');
  });

  it('refuses an unreadable baseline before the run starts', async () => {
    const h = harness('aab-new');
    expect(await main(runArgs(['--baseline', 'runs/missing']), h.deps)).toBe(1);
    expect(h.err.join('')).toMatch(/refusing to run: --baseline: cannot read .*manifest\.json/);
    expect(h.out.join('')).toBe('');
    expect(h.adapterCalls()).toBe(0);
  });

  it('is a run-only flag', async () => {
    const h = harness('x');
    const code = await main(['report', 'runs', '--baseline', 'runs'], h.deps).catch(() => 1);
    expect(code).not.toBe(0);
  });
});
