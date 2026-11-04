// ADR-0023: generated documentation never drifts from its source. docs/catalog.md is generated
// from scenarios/*.yaml (scripts/catalog.mjs), docs/verified-against.md from the published bundles
// under reports/ (scripts/matrix.mjs), and docs/assets/demo-output.svg from the real `lurekit demo`
// output (scripts/render-demo-svg.mjs). Offline: reads the repository, writes nothing.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { main, type CliDeps } from '../src/cli.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const committed = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function script(name: string, args: string[], input?: string): string {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT, encoding: 'utf8', ...(input !== undefined ? { input } : {}),
  });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return r.stdout;
}

async function demoOutput(): Promise<string> {
  const out: string[] = [];
  const deps: CliDeps = {
    now: () => '2026-11-03T00:00:00.000Z',
    newRunId: () => 'aab-test',
    adapterFor: () => { throw new Error('demo must not touch an adapter'); },
    cwd: () => ROOT,
    stdout: (s) => out.push(s),
    stderr: () => undefined,
    // The image is laid out at 110 columns (scripts/render-demo-svg.mjs COLS), no colour.
    terminal: () => ({ isTTY: false, env: { COLUMNS: '110' } }),
  };
  expect(await main(['demo'], deps)).toBe(0);
  return out.join('');
}

describe('generated docs are current (run npm run catalog / matrix / assets:demo to refresh)', () => {
  it('docs/catalog.md equals the output of scripts/catalog.mjs', () => {
    const text = script('catalog.mjs', ['--stdout']);
    expect(text).toBe(committed('docs/catalog.md'));
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
  });

  it('docs/verified-against.md equals the output of scripts/matrix.mjs', () => {
    const text = script('matrix.mjs', ['--stdout']);
    expect(text).toBe(committed('docs/verified-against.md'));
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
  });

  it('docs/assets/demo-output.svg equals the render of the real demo output (ASCII, < 60 KB)', async () => {
    const svg = script('render-demo-svg.mjs', ['--stdin'], await demoOutput());
    expect(svg).toBe(committed('docs/assets/demo-output.svg'));
    expect(/[^\x00-\x7f]/.test(svg)).toBe(false);
    expect(Buffer.byteLength(svg)).toBeLessThan(60 * 1024);
    expect(svg).toContain('Vulnerable to 4 of 21 scenarios');
    // ADR-0021 amendment (terminal view): no Markdown syntax and no wrapped table row in the image.
    expect(svg).not.toMatch(/\*\*|&#96;|\|---/);
    expect(svg).toMatch(/AAB-001<\/tspan><tspan [^>]*fill="#f14c4c"[^>]*>vulnerable/);
  });
});
