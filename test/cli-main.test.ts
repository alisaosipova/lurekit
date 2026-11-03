// Regression test for the CLI entry-point guard (src/cli.ts isMainModule).
// npm installs the bin as a symlink, so process.argv[1] is the symlink path while
// import.meta.url is the real file; the guard must resolve both to the same real path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../src/cli.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aab-cli-main-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('isMainModule', () => {
  it('treats the real module path as main', () => {
    const real = path.join(tmp, 'real', 'cli.js');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, '// dummy\n');
    const url = pathToFileURL(real).href;

    expect(isMainModule(real, url)).toBe(true);
  });

  it('treats a symlink to the module file as main (npm bin install)', (ctx) => {
    const real = path.join(tmp, 'real', 'cli.js');
    const binDir = path.join(tmp, 'bin');
    mkdirSync(path.dirname(real), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(real, '// dummy\n');
    const link = path.join(binDir, 'lurekit');
    try {
      symlinkSync(real, link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows without admin / Developer Mode cannot create symlinks. Skip explicitly
      // (reported as skipped, never a silent pass); any other platform or error fails.
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        ctx.skip(`symlinkSync failed with ${code} on win32 (needs admin or Developer Mode)`);
      }
      throw err;
    }
    const url = pathToFileURL(real).href;

    expect(isMainModule(link, url)).toBe(true);
    expect(isMainModule(real, url)).toBe(true);
  });

  it('rejects a different file and a missing argv[1]', () => {
    const real = path.join(tmp, 'cli.js');
    const other = path.join(tmp, 'other.js');
    writeFileSync(real, '// dummy\n');
    writeFileSync(other, '// other\n');
    const url = pathToFileURL(real).href;

    expect(isMainModule(other, url)).toBe(false);
    expect(isMainModule(undefined, url)).toBe(false);
    expect(isMainModule('', url)).toBe(false);
  });

  it('falls back to path.resolve when argv[1] does not exist', () => {
    const real = path.join(tmp, 'cli.js');
    writeFileSync(real, '// dummy\n');
    const url = pathToFileURL(real).href;
    expect(isMainModule(path.join(tmp, 'missing.js'), url)).toBe(false);
  });
});
