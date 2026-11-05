// ADR-0012 amendment (2026-11-05, block B15): the CI prose cannot drift from the workflow, the
// publish job fetches nothing from the registry, and the timing-tolerant test rules hold.
// Offline: reads the repository, writes nothing. Test plan B15-T2, B15-T3, B15-T4.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, it, expect } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const CI_JOBS = ['test', 'docs', 'replay', 'package', 'hygiene'];

/** The CI passage of a document: from its CI heading/bullet to the next heading or bullet of the same level. */
function ciPassage(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start, `${startMarker} not found`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('B15-T4 the five CI jobs and the degraded rule are documented as ci.yml enforces them (ADR-0012 b)', () => {
  const ci = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, unknown> };
  const jobIds = Object.keys(ci.jobs);
  const contributing = ciPassage(read('CONTRIBUTING.md'), '## How CI validates', '## Running the offline commands');
  const overview = ciPassage(read('docs/guide/architecture-overview.md'), '- **CI** (', '- **Release** (');

  it('ci.yml has exactly the five jobs the amendment names', () => {
    expect(jobIds.sort()).toEqual([...CI_JOBS].sort());
  });

  it.each(CI_JOBS)('job id "%s" is named in CONTRIBUTING.md and docs/guide/architecture-overview.md', (id) => {
    expect(contributing).toMatch(new RegExp(`\`${id}\``));
    expect(overview).toMatch(new RegExp(`\`${id}\``));
  });

  it('both CI passages state the degraded rule with its file_written qualifier and never claim "vulnerable or degraded"', () => {
    for (const doc of [contributing, overview]) {
      expect(doc).toContain('file_written');
      expect(doc).not.toMatch(/vulnerable or degraded/);
    }
    // The replay job itself enforces the rule the prose states.
    const replay = read('.github/workflows/ci.yml');
    expect(replay).toContain('e.benign.check === "file_written"');
    expect(replay).toContain('m.totals.vulnerable !== 0');
  });

  it('the hygiene job fetches the tags and runs the frozen-CHANGELOG check (ADR-0012 c)', () => {
    const hygiene = ci.jobs.hygiene as { steps: Array<{ run?: string; with?: Record<string, unknown> }> };
    expect(hygiene.steps.some((s) => s.with?.['fetch-depth'] === 0)).toBe(true);
    expect(hygiene.steps.some((s) => (s.run ?? '').includes('scripts/changelog-frozen.mjs'))).toBe(true);
    expect((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['changelog:check']).toBe('node scripts/changelog-frozen.mjs');
  });
});

describe('B15-T4 the publish job runs no registry-fetched code (ADR-0010 amendment 2026-11-05)', () => {
  const release = read('.github/workflows/release.yml');
  const wf = parse(release) as { jobs: Record<string, { steps: Array<{ run?: string; name?: string }> }> };

  it('release.yml contains no `npm install -g` step', () => {
    expect(release).not.toMatch(/npm\s+install\s+-g/);
    expect(release).not.toMatch(/npm\s+i\s+-g/);
  });

  it('the publish job asserts the bundled npm version before any registry command and installs nothing', () => {
    const steps = wf.jobs.publish.steps;
    const assertIdx = steps.findIndex((s) => (s.run ?? '').includes('older than 11.5.1'));
    expect(assertIdx).toBeGreaterThanOrEqual(0);
    const firstRegistry = steps.findIndex((s) => /npm (view|publish)/.test(s.run ?? ''));
    expect(firstRegistry).toBeGreaterThan(assertIdx);
    for (const s of steps) expect(s.run ?? '').not.toMatch(/npm (install|i|ci)\b/);
  });

  it('the version comparison is numeric: 11.5.1 passes, 11.4.9 and 10.9.9 fail, 12.0.0 passes', async () => {
    // Re-run the exact node -e program from the workflow, so the test pins the shipped text.
    const step = wf.jobs.publish.steps.find((s) => (s.run ?? '').includes('older than 11.5.1'))!;
    const program = step.run!.slice(step.run!.indexOf("node -e '") + "node -e '".length, step.run!.lastIndexOf("' \"$v\""));
    const { spawnSync } = await import('node:child_process');
    const check = (v: string): number => spawnSync(process.execPath, ['-e', program, v], { encoding: 'utf8' }).status ?? -1;
    expect(check('11.5.1')).toBe(0);
    expect(check('11.21.0')).toBe(0);
    expect(check('12.0.0')).toBe(0);
    expect(check('11.4.9')).toBe(1);
    expect(check('10.9.9')).toBe(1);
    expect(check('11.5.0')).toBe(1);
    expect(check('garbage')).toBe(1);
  });
});

describe('B15-T2/T3 timing-tolerant test rules (ADR-0012 a.2, a.4)', () => {
  const testFiles = readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts'));
  const RETRY_FILES = ['child-process.test.ts', 'run-lifecycle.test.ts'];
  // A wall-clock quantity compared with a bare numeric literal.
  const BARE_BOUND = /(Date\.now\(\) - t0|tookMs|elapsed_ms|elapsedMs)\)\s*\.\s*toBe(LessThan|GreaterThan)(OrEqual)?\(\s*[0-9][0-9_]*\s*\)/;

  it('test/helpers/deadline.ts exports TIMER_EARLY_MS and LOAD_SLACK_MS', async () => {
    const h = await import('./helpers/deadline.js');
    expect(h.TIMER_EARLY_MS).toBeGreaterThan(0);
    expect(h.LOAD_SLACK_MS).toBeGreaterThan(h.TIMER_EARLY_MS);
  });

  it.each(RETRY_FILES)('%s compares no wall-clock bound with a bare literal', (f) => {
    const lines = read(`test/${f}`).split('\n');
    const hits = lines.filter((l) => BARE_BOUND.test(l));
    expect(hits).toEqual([]);
    // Positive control for the regex itself.
    expect(BARE_BOUND.test('    expect(Date.now() - t0).toBeLessThan(10_000);')).toBe(true);
    expect(BARE_BOUND.test('    expect(Date.now() - t0).toBeLessThan(CAP_MS + LOAD_SLACK_MS);')).toBe(false);
  });

  it('describe-level retry: 1 appears in exactly the two files that drive real processes or timers', () => {
    const withRetry = testFiles.filter((f) => /retry:\s*\d/.test(read(`test/${f}`)) && f !== 'ci-docs.test.ts');
    expect(withRetry.sort()).toEqual([...RETRY_FILES].sort());
    for (const f of RETRY_FILES) {
      const text = read(`test/${f}`);
      const topLevel = text.match(/^describe\(/gm) ?? [];
      const withOpt = text.match(/^describe\('[^']+', \{ retry: 1 \}, /gm) ?? [];
      expect(withOpt.length, `${f}: every top-level describe carries { retry: 1 }`).toBe(topLevel.length);
      expect(text).not.toMatch(/retry:\s*(?!1\b)\d/);
    }
  });

  it('vitest.config.ts sets no retry and keeps the single TEST_TIMEOUT_MS budget', () => {
    const cfg = read('vitest.config.ts');
    expect(cfg).not.toMatch(/retry/);
    expect(cfg).toContain('testTimeout: TEST_TIMEOUT_MS');
  });

  it('B3-T2 in verdict-arithmetic sleeps nowhere: no setTimeout, no sleepMs', () => {
    const text = read('test/verdict-arithmetic.test.ts');
    const start = text.indexOf("describe('B3-T2 manifest fields");
    const end = text.indexOf('// --- B3-T3', start);
    expect(start).toBeGreaterThan(0);
    const block = text.slice(start, end);
    expect(block).not.toMatch(/setTimeout|sleepMs|run_timeout_ms: 60\b/);
    expect(block).toContain('runWithDeadline: forced');
  });
});
