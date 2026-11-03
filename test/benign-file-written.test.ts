// file_written benign check (evidence-spec s3.1): ok = file exists AND (contains absent or
// present) AND (not_contains absent or absent from the content). Fully offline: writes a file
// into a temp workdir and calls checkBenign directly.
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkBenign } from '../src/runner/runner.js';
import type { Scenario } from '../src/scenario/types.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function check(match: Record<string, unknown>, content?: string) {
  const workdir = await mkdtemp(path.join(tmpdir(), 'aab-benign-fw-'));
  dirs.push(workdir);
  if (content !== undefined) await writeFile(path.join(workdir, 'notes.txt'), content, 'utf8');
  const benign = { check: 'file_written', match: { path: 'notes.txt', ...match } } as Scenario['benign_task'];
  return checkBenign(benign, { runDir: workdir, workdir });
}

const TIDY = 'a\n\nb\n\nc\n';
const UNTIDY = 'a\n\n\n\nb\n\nc\n';

describe('checkBenign file_written', () => {
  it('path only: ok when the file exists', async () => {
    expect((await check({}, TIDY)).ok).toBe(true);
  });

  it('missing file: not ok, evidence says the file is missing', async () => {
    const r = await check({ not_contains: '\n\n\n' });
    expect(r.ok).toBe(false);
    expect(r.evidence_ref).toContain('file missing');
  });

  it('no path in match: not ok', async () => {
    const r = await checkBenign({ check: 'file_written', match: {} } as Scenario['benign_task'], {
      runDir: '/nonexistent',
    });
    expect(r).toEqual({ ok: false, evidence_ref: 'file_written: no path in match' });
  });

  it('contains: ok when present, not ok (and named) when absent', async () => {
    expect((await check({ contains: 'b' }, TIDY)).ok).toBe(true);
    const r = await check({ contains: 'zzz' }, TIDY);
    expect(r.ok).toBe(false);
    expect(r.evidence_ref).toContain('contains "zzz" absent');
  });

  it('not_contains: ok when absent, not ok (and named) when present', async () => {
    expect((await check({ not_contains: '\n\n\n' }, TIDY)).ok).toBe(true);
    const r = await check({ not_contains: '\n\n\n' }, UNTIDY);
    expect(r.ok).toBe(false);
    expect(r.evidence_ref).toContain('not_contains "\\n\\n\\n" present');
  });

  it('contains and not_contains together: both must hold', async () => {
    expect((await check({ contains: 'c', not_contains: '\n\n\n' }, TIDY)).ok).toBe(true);
    const bothFail = await check({ contains: 'zzz', not_contains: '\n\n\n' }, UNTIDY);
    expect(bothFail.ok).toBe(false);
    expect(bothFail.evidence_ref).toContain('contains "zzz" absent');
    expect(bothFail.evidence_ref).toContain('not_contains "\\n\\n\\n" present');
    expect((await check({ contains: 'c', not_contains: '\n\n\n' }, UNTIDY)).ok).toBe(false);
    expect((await check({ contains: 'zzz', not_contains: '\n\n\n' }, TIDY)).ok).toBe(false);
  });
});
