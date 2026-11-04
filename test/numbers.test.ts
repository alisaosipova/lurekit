// ADR-0023 amendment: the numbers quoted in README.md, docs/guide/getting-started.md and
// docs/guide/cli-reference.md are emitted by scripts/numbers.mjs from the tree and checked through
// marker comments. The marker checker is tested on synthetic text (always); the full check of the
// real docs needs a fresh dist/ (the facts come from the built CLI) and runs when dist/ is fresh
// (CI builds before the tests; the docs job runs npm run docs:check, which builds first).
// Offline: the script writes only under .aab-runs/_numbers and removes it.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, it, expect } from 'vitest';

import { PUBLISHED_CLAUDE_VERSION } from '../src/report/index.js';
import { PINNED_CLAUDE_FALLBACK } from '../src/doctor.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'numbers.mjs');

interface Facts { tests: number | null; lines: Record<string, string>; [k: string]: unknown }
interface NumbersModule {
  CHECKED_DOCS: string[];
  checkText(rel: string, text: string, facts: Facts): { markers: number; problems: string[] };
  checkRunLive(text: string): string[];
}
const load = async (): Promise<NumbersModule> => (await import(pathToFileURL(SCRIPT).href)) as NumbersModule;

function distFresh(): boolean {
  let fresh = true;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const js = path.join(ROOT, 'dist', path.relative(path.join(ROOT, 'src'), p)).replace(/\.ts$/, '.js');
        if (!existsSync(js) || statSync(js).mtimeMs < statSync(p).mtimeMs) fresh = false;
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return fresh;
}

const facts: Facts = {
  scenarios: { total: 52 },
  versions: { claude_published: '2.1.317' },
  tests: null,
  lines: { plan_claude: 'plan: 25 would run, 27 skipped (x)' },
};

describe('number markers (scripts/numbers.mjs)', () => {
  it('accepts matching inline and block markers', async () => {
    const { checkText } = await load();
    const doc = [
      'We ship <!-- n:scenarios.total -->52<!-- /n --> scenarios on <!-- n:versions.claude_published -->2.1.317<!-- /n -->.',
      '<!-- n-line:plan_claude -->',
      '```',
      'KEEP ...',
      '  plan: 25 would run, 27 skipped (x)',
      '```',
      'Tests: <!-- n:tests -->1<!-- /n --> (skipped when tests is null).',
    ].join('\n');
    expect(checkText('doc.md', doc, facts)).toEqual({ markers: 4, problems: [] });
  });

  it('reports a drifted value, an unknown key, a missing line, a malformed marker and an unmarked doc', async () => {
    const { checkText } = await load();
    const doc = [
      '<!-- n:scenarios.total -->51<!-- /n -->',
      '<!-- n:scenarios.nope -->1<!-- /n -->',
      '<!-- n:scenarios -->x<!-- /n -->',
      '<!-- n-line:plan_claude -->',
      '```',
      'plan: 25 would run, 23 skipped (x)',
      '```',
      '<!-- n: scenarios.total -->52<!-- /n -->',
    ].join('\n');
    const { problems } = checkText('doc.md', doc, facts);
    expect(problems.join('\n')).toMatch(/scenarios\.total is "52", the doc says "51"/);
    expect(problems.join('\n')).toMatch(/unknown number key "scenarios\.nope"/);
    expect(problems.join('\n')).toMatch(/unknown number key "scenarios"/);
    expect(problems.join('\n')).toMatch(/lacks the current plan_claude line/);
    expect(problems.join('\n')).toMatch(/malformed marker/);
    expect(checkText('empty.md', 'no numbers here', facts).problems).toEqual(['empty.md: no number markers (every quoted number must be marked)']);
  });

  it('examples/run-live.sh reads the pinned version from dist and types none', async () => {
    const { checkRunLive } = await load();
    expect(checkRunLive(readFileSync(path.join(ROOT, 'examples', 'run-live.sh'), 'utf8'))).toEqual([]);
    expect(checkRunLive('PIN=2.1.317\n').length).toBe(2);
  });

  it('one pinned Claude Code version: doctor reuses the report constant', () => {
    expect(PINNED_CLAUDE_FALLBACK).toBe(PUBLISHED_CLAUDE_VERSION);
  });

  it.skipIf(!distFresh())('the real docs match the numbers emitted from the tree (needs a fresh dist/)', async () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check', '--skip-tests'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^numbers: \d+ marker\(s\) in 3 docs match the tree/);
    expect(/[^\x00-\x7f]/.test(readFileSync(SCRIPT, 'utf8'))).toBe(false);
  }, 240_000); // one spawn: four plans, a replay and the demo render; slow on a loaded host
});
