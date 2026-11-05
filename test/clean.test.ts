// ADR-0027 (ENGINE-14): lurekit clean removes only codex-home/.tmp caches, and only with --yes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { mkScratch, rmScratch } from './helpers/scratch.js';

let work: string;
beforeEach(async () => {
  work = await mkScratch('clean-');
});
afterEach(async () => {
  await rmScratch(work);
});

function deps() {
  const out: string[] = [];
  return { out, d: { now: () => 'x', newRunId: () => 'x', adapterFor: () => { throw new Error('no'); }, cwd: () => work, stdout: (s: string) => out.push(s), stderr: () => undefined } };
}

describe('lurekit clean (ADR-0027)', () => {
  it('lists the codex cache without --yes and removes only it with --yes', async () => {
    const rep = path.join(work, '.aab-runs', 'aab-1', 'AAB-060', '0');
    mkdirSync(path.join(rep, 'codex-home', '.tmp', 'plugins'), { recursive: true });
    writeFileSync(path.join(rep, 'codex-home', '.tmp', 'plugins', 'pack'), Buffer.alloc(4096));
    mkdirSync(path.join(rep, 'work'), { recursive: true });
    writeFileSync(path.join(rep, 'evidence.json'), '{}');
    writeFileSync(path.join(rep, 'work', 'notes.txt'), 'x');
    writeFileSync(path.join(rep, 'codex-home', 'config.toml'), 'x');
    const a = deps();
    expect(await main(['clean'], a.d)).toBe(0);
    expect(a.out.join('')).toMatch(/would remove .*codex-home[\\/]\.tmp/);
    expect(existsSync(path.join(rep, 'codex-home', '.tmp'))).toBe(true);
    const b = deps();
    expect(await main(['clean', '--yes'], b.d)).toBe(0);
    expect(existsSync(path.join(rep, 'codex-home', '.tmp'))).toBe(false);
    for (const kept of ['evidence.json', path.join('work', 'notes.txt'), path.join('codex-home', 'config.toml')]) {
      expect(existsSync(path.join(rep, kept)), kept).toBe(true);
    }
  });
  it('a missing results root is not an error', async () => {
    const a = deps();
    expect(await main(['clean'], a.d)).toBe(0);
    expect(a.out.join('')).toMatch(/does not exist; nothing to clean/);
  });
});
