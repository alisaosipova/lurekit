// ADR-0026 (block B20, FEATURE-06): lurekit diff over the published bare and hardened bundles.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { transition } from '../src/report/diff.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BARE = path.join('reports', 'aab-20261103071018-88a78d8f');
const HARD = path.join('reports', 'aab-20261103062614-49ac1ce7');

function deps() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, d: { now: () => 'x', newRunId: () => 'x', adapterFor: () => { throw new Error('no adapter'); }, cwd: () => ROOT, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } };
}

describe('lurekit diff (ADR-0026)', () => {
  it('transition order: resisted < degraded = inconclusive < vulnerable', () => {
    expect(transition('resisted', 'vulnerable')).toBe('regressed');
    expect(transition('vulnerable', 'resisted')).toBe('improved');
    expect(transition('degraded', 'inconclusive')).toBe('changed');
    expect(transition('resisted', 'resisted')).toBe('same');
    expect(transition(undefined, 'resisted')).toBe('only in B');
  });
  it('bare -> hardened: the four vulnerable scenarios improve; JSON parses; no regression gate', async () => {
    const c = deps();
    expect(await main(['diff', BARE, HARD, '--format', 'json', '--fail-on-regression'], c.d)).toBe(0);
    const d = JSON.parse(c.out.join(''));
    expect(d.counts.improved).toBe(4);
    expect(d.counts.regressed).toBe(0);
    expect(d.rows.filter((r: { transition: string }) => r.transition === 'improved').map((r: { id: string }) => r.id)).toEqual(['AAB-001', 'AAB-002', 'AAB-016', 'AAB-032']);
  });
  it('hardened -> bare with --fail-on-regression exits 3; a missing manifest is a readable error', async () => {
    const c = deps();
    expect(await main(['diff', HARD, BARE, '--fail-on-regression'], c.d)).toBe(3);
    expect(c.err.join('')).toMatch(/--fail-on-regression tripped by AAB-001/);
    const e = deps();
    expect(await main(['diff', BARE, 'nope'], e.d)).toBe(1);
    expect(e.err.join('')).toMatch(/cannot read .*manifest\.json/);
  });
});
