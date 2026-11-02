// Scratch directories for detector self-tests (evidence-spec §1.3, §2.1).
//
// Maintainer rule: nothing a benchmark (or a self-test) produces is written under
// os.tmpdir(). A self-test's control-run dirs are therefore created under a caller-provided
// base: the runner passes <results>/<benchmark_run_id>/.selftest; a caller with no run dir
// (the `selftest` CLI command, unit tests) gets DEFAULT_SELFTEST_DIRNAME under process.cwd().
// Every dir is removed when the control run finishes; the default base is removed too when
// it is left empty.

import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

/** Default base for self-test scratch dirs when the caller provides none. */
export const DEFAULT_SELFTEST_DIRNAME = '.aab-selftest';

export interface SelfTestOptions {
  /** Directory under which the control runs create their scratch dirs. Defaults to
   *  `<process.cwd()>/.aab-selftest`. Never os.tmpdir(). */
  base?: string;
}

export interface SelfTestDir {
  dir: string;
  cleanup(): Promise<void>;
}

/** Create a fresh scratch dir `<base>/<prefix>XXXXXX` for one control run. */
export async function makeSelfTestDir(prefix: string, opts?: SelfTestOptions): Promise<SelfTestDir> {
  const defaulted = !opts?.base;
  const base = path.resolve(opts?.base ?? path.join(process.cwd(), DEFAULT_SELFTEST_DIRNAME));
  let dir: string | undefined;
  // A concurrent self-test (another process sharing the default base) may remove the empty
  // base while we create it or our dir in it; both surface as ENOENT. Retry rather than fail.
  for (let attempt = 0; dir === undefined; attempt++) {
    try {
      await mkdir(base, { recursive: true });
      dir = await mkdtemp(path.join(base, prefix));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 19) throw err;
    }
  }
  const created = dir;
  return {
    dir: created,
    async cleanup() {
      await rm(created, { recursive: true, force: true });
      if (defaulted) {
        try {
          await rmdir(base); // only succeeds when empty
        } catch {
          /* still in use by another control run, or already gone */
        }
      }
    },
  };
}
