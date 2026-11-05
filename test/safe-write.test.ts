// ADR-0025 D2 test plan T6: the symlink-safe write/read helper. Symlink-creating cases are
// skipped where symlink creation needs a privilege (Windows runners without developer mode);
// every non-symlink case runs everywhere.

import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SafeReadError,
  SafeWriteError,
  assertRealDir,
  isInside,
  resolveInside,
  safeCreateEmpty,
  safeMkdir,
  safeReadFile,
  safeReadText,
  safeWriteFile,
} from '../src/runner/safeWrite.js';
import { mkScratch } from './helpers/scratch.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const d = await mkScratch('aab-safewrite-');
  roots.push(d);
  return d;
}
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

/** Whether this runner may create symlinks (Windows needs a privilege or developer mode). */
async function canSymlink(): Promise<boolean> {
  const d = await mkScratch('aab-symlink-probe-');
  try {
    await writeFile(path.join(d, 't'), 'x');
    await symlink(path.join(d, 't'), path.join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}
// Skip reason for the it.skipIf(!symlinks) cases: symlink creation needs a privilege on this
// Windows runner. Logged once so a skipped CI leg says why.
const symlinks = await canSymlink();
if (!symlinks) console.warn('safe-write: symlink cases skipped: symlink creation needs a privilege on this Windows runner');

describe('resolveInside / isInside', () => {
  it('accepts a relative and an absolute path inside the root, refuses the root itself and ..', async () => {
    const r = await root();
    expect(resolveInside(r, 'a.json')).toBe(path.join(r, 'a.json'));
    expect(resolveInside(r, path.join(r, 'sub', 'b'))).toBe(path.join(r, 'sub', 'b'));
    expect(() => resolveInside(r, '../outside')).toThrow(SafeWriteError);
    expect(() => resolveInside(r, r)).toThrow(/outside_root/);
    expect(() => resolveInside(r, path.join(r, '..', path.basename(r) + '-sibling'))).toThrow(SafeWriteError);
    expect(isInside(r, 'x')).toBe(true);
    expect(isInside(r, '..')).toBe(false);
  });
});

describe('safeWriteFile', () => {
  it('writes atomically into the root and leaves no temp file behind', async () => {
    const r = await root();
    const res = await safeWriteFile(r, 'evidence.json', '{"a":1}');
    expect(res).toEqual({ replacedSymlink: false, replacedDir: false });
    expect(await readFile(path.join(r, 'evidence.json'), 'utf8')).toBe('{"a":1}');
    expect((await readdir(r)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // Overwriting an existing regular file works (rename over it).
    await safeWriteFile(r, 'evidence.json', '{"a":2}');
    expect(await readFile(path.join(r, 'evidence.json'), 'utf8')).toBe('{"a":2}');
  });

  it('refuses ../outside and an absolute path outside the root', async () => {
    const r = await root();
    await expect(safeWriteFile(r, '../outside.json', 'x')).rejects.toThrow(SafeWriteError);
    await expect(safeWriteFile(r, path.join(r, '..', 'outside.json'), 'x')).rejects.toMatchObject({ reason: 'outside_root' });
  });

  it('refuses a missing parent component', async () => {
    const r = await root();
    await expect(safeWriteFile(r, 'nope/x.json', 'x')).rejects.toMatchObject({ reason: 'missing_parent' });
  });

  it('refuses a directory at the target unless replaceDir, and other entry types always', async () => {
    const r = await root();
    await mkdir(path.join(r, 'evidence.json'));
    await writeFile(path.join(r, 'evidence.json', 'inner'), 'x');
    await expect(safeWriteFile(r, 'evidence.json', 'y')).rejects.toMatchObject({ reason: 'directory_target' });
    const res = await safeWriteFile(r, 'evidence.json', 'y', { replaceDir: true });
    expect(res.replacedDir).toBe(true);
    expect(await readFile(path.join(r, 'evidence.json'), 'utf8')).toBe('y');
  });

  it('opens the temp file with wx: a pre-existing temp name is never overwritten', async () => {
    // The temp name is random, so this is proven at the API level: safeCreateEmpty uses the
    // same wx flag and refuses an existing entry.
    const r = await root();
    await writeFile(path.join(r, 'sink.log'), 'present');
    await expect(safeCreateEmpty(r, 'sink.log')).rejects.toMatchObject({ reason: 'exists' });
    expect(await readFile(path.join(r, 'sink.log'), 'utf8')).toBe('present');
  });

  it('applies the requested mode on POSIX', async () => {
    const r = await root();
    await safeWriteFile(r, 'launcher', '#!/bin/sh\n', { mode: 0o755 });
    if (process.platform !== 'win32') expect((await lstat(path.join(r, 'launcher'))).mode & 0o777).toBe(0o755);
  });

  it.skipIf(!symlinks)('unlinks a symlinked target and reports it; the link target is untouched', async () => {
    const r = await root();
    const outside = await mkScratch('aab-safewrite-outside-');
    roots.push(outside);
    const victim = path.join(outside, 'victim.json');
    await writeFile(victim, 'ORIGINAL');
    await symlink(victim, path.join(r, 'evidence.json'));
    const res = await safeWriteFile(r, 'evidence.json', 'NEW');
    expect(res.replacedSymlink).toBe(true);
    expect((await lstat(path.join(r, 'evidence.json'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(r, 'evidence.json'), 'utf8')).toBe('NEW');
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL');
  });

  it.skipIf(!symlinks)('refuses a symlinked parent component', async () => {
    const r = await root();
    const outside = await mkScratch('aab-safewrite-outside2-');
    roots.push(outside);
    await symlink(outside, path.join(r, 'sub'), 'dir');
    await expect(safeWriteFile(r, 'sub/x.json', 'x')).rejects.toMatchObject({ reason: 'symlinked_parent' });
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(!symlinks)('a dangling symlink at the target is unlinked too', async () => {
    const r = await root();
    await symlink(path.join(r, 'does-not-exist'), path.join(r, 'out.json'));
    const res = await safeWriteFile(r, 'out.json', 'x');
    expect(res.replacedSymlink).toBe(true);
    expect(await readFile(path.join(r, 'out.json'), 'utf8')).toBe('x');
  });
});

describe('safeCreateEmpty', () => {
  it('creates an empty regular file and refuses to create it twice', async () => {
    const r = await root();
    await safeCreateEmpty(r, 'sink.log');
    const st = await lstat(path.join(r, 'sink.log'));
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(0);
    await expect(safeCreateEmpty(r, 'sink.log')).rejects.toMatchObject({ reason: 'exists' });
  });
});

describe('safeReadFile / safeReadText', () => {
  it('reads a regular file, refuses a missing one, a directory and a path outside', async () => {
    const r = await root();
    await writeFile(path.join(r, 'a.txt'), 'hello');
    expect(await safeReadText(r, 'a.txt')).toBe('hello');
    expect((await safeReadFile(r, path.join(r, 'a.txt'))).toString()).toBe('hello');
    await expect(safeReadFile(r, 'missing')).rejects.toMatchObject({ reason: 'not_found' });
    await mkdir(path.join(r, 'd'));
    await expect(safeReadFile(r, 'd')).rejects.toMatchObject({ reason: 'not_regular' });
    await expect(safeReadFile(r, '../x')).rejects.toBeInstanceOf(SafeReadError);
  });

  it.skipIf(!symlinks)('refuses a symlink even when it points at a readable file', async () => {
    const r = await root();
    await writeFile(path.join(r, 'real.txt'), 'real');
    await symlink(path.join(r, 'real.txt'), path.join(r, 'link.txt'));
    await expect(safeReadFile(r, 'link.txt')).rejects.toMatchObject({ reason: 'symlink_target' });
    expect(await readlink(path.join(r, 'link.txt'))).toBe(path.join(r, 'real.txt'));
  });
});

describe('assertRealDir / safeMkdir', () => {
  it('accepts missing components and creates them singly', async () => {
    const r = await root();
    await assertRealDir(r, path.join(r, 'AAB-001', '0'));
    await safeMkdir(r, path.join(r, 'AAB-001', '0'));
    expect((await lstat(path.join(r, 'AAB-001', '0'))).isDirectory()).toBe(true);
    await safeMkdir(r, path.join(r, 'AAB-001', '0')); // idempotent
  });

  it('refuses a regular file on the way', async () => {
    const r = await root();
    await writeFile(path.join(r, 'AAB-001'), 'file');
    await expect(assertRealDir(r, path.join(r, 'AAB-001', '0'))).rejects.toMatchObject({ reason: 'parent_not_dir' });
  });

  it.skipIf(!symlinks)('refuses a symlinked component and names it', async () => {
    const r = await root();
    const outside = await mkScratch('aab-safewrite-outside3-');
    roots.push(outside);
    await mkdir(path.join(r, 'AAB-001'));
    await symlink(outside, path.join(r, 'AAB-001', '1'), 'dir');
    await expect(assertRealDir(r, path.join(r, 'AAB-001', '1'))).rejects.toMatchObject({
      reason: 'symlinked_parent',
      target: path.join(r, 'AAB-001', '1'),
    });
    await expect(safeMkdir(r, path.join(r, 'AAB-001', '1'))).rejects.toMatchObject({ reason: 'symlinked_parent' });
    expect(await readdir(outside)).toEqual([]);
  });
});
