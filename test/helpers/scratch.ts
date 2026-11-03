// Repo-local scratch space for tests (evidence-spec s2.1: nothing under os.tmpdir()).
//
// Every scratch directory is allocated under <repo>/.aab-test-work/, which is git-ignored and
// excluded from vitest collection (vitest.config.ts). The one deliberate exception is
// test/per-run-workdir.test.ts, which redirects TMPDIR to an empty sentinel to prove the runner
// writes nothing to the system temp dir.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const TEST_WORK_ROOT = path.join(repoRoot, '.aab-test-work');

// Another test file may rmdir an empty .aab-test-work/ between our mkdir and mkdtemp
// (test/per-run-workdir.test.ts does so in afterEach), so ENOENT is retried a few times.
const RETRIES = 5;

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Create a fresh unique directory `<repo>/.aab-test-work/<prefix>XXXXXX`. */
export async function mkScratch(prefix: string): Promise<string> {
  for (let i = 0; ; i++) {
    await mkdir(TEST_WORK_ROOT, { recursive: true });
    try {
      return await mkdtemp(path.join(TEST_WORK_ROOT, prefix));
    } catch (e) {
      if (!isEnoent(e) || i >= RETRIES) throw e;
    }
  }
}

/** Synchronous twin of mkScratch, for beforeEach hooks written synchronously. */
export function mkScratchSync(prefix: string): string {
  for (let i = 0; ; i++) {
    mkdirSync(TEST_WORK_ROOT, { recursive: true });
    try {
      return mkdtempSync(path.join(TEST_WORK_ROOT, prefix));
    } catch (e) {
      if (!isEnoent(e) || i >= RETRIES) throw e;
    }
  }
}

function assertInside(dir: string): void {
  const rel = path.relative(TEST_WORK_ROOT, path.resolve(dir));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to remove ${dir}: not inside ${TEST_WORK_ROOT}`);
  }
}

/** Remove a scratch directory created by mkScratch; refuses anything outside .aab-test-work/. */
export async function rmScratch(dir: string): Promise<void> {
  assertInside(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Synchronous twin of rmScratch. */
export function rmScratchSync(dir: string): void {
  assertInside(dir);
  rmSync(dir, { recursive: true, force: true });
}
