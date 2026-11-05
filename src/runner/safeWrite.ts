// Symlink-safe writes and reads inside a run dir (ADR-0025 D2).
//
// The agent under test runs as the same OS user as the harness and its cwd is one `..` from
// the run dir, so a plain `writeFile` of a fixed name after the agent ran could be redirected
// through a symlink the agent planted (at the target name or at a parent component). Every
// harness write or read of a file below a run dir goes through this module:
//
//   - the target must resolve inside the trusted `root` (no `..` escape);
//   - every path component between `root` and the target's parent is lstat-ed and must be a
//     real directory, never a symlink;
//   - a symlink AT the target is unlinked (the link only, never what it points to) and the
//     caller is told (`replacedSymlink`), a directory is removed only on `replaceDir`;
//   - the data goes to a sibling temp file opened with `wx` (O_EXCL) and is renamed over the
//     target, so a reader never sees a partial file.
//
// `root` is trusted as given (the operator's results tree, or the run dir the runner created
// through assertRealDir/safeMkdir); it is not realpath-ed, because the component walk starts at
// the root and refuses every symlink below it. The temp name uses randomBytes, never Date.now()
// (the runner's determinism rule).

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type SafeWriteReason =
  | 'outside_root'
  | 'missing_parent'
  | 'symlinked_parent'
  | 'parent_not_dir'
  | 'symlink_target'
  | 'directory_target'
  | 'not_regular'
  | 'exists';

export class SafeWriteError extends Error {
  constructor(
    readonly reason: SafeWriteReason,
    readonly target: string,
    detail?: string,
  ) {
    super(`safe write refused (${reason}): ${target}${detail ? `: ${detail}` : ''}`);
    this.name = 'SafeWriteError';
  }
}

export class SafeReadError extends Error {
  constructor(
    readonly reason: SafeWriteReason | 'not_found' | 'io',
    readonly target: string,
    readonly code?: string,
  ) {
    super(`safe read refused (${reason}): ${target}${code ? ` (${code})` : ''}`);
    this.name = 'SafeReadError';
  }
}

export interface SafeWriteOptions {
  /** Remove a directory found at the target (rm -r, never following links). Default false:
   *  a directory at the target throws `directory_target`. */
  replaceDir?: boolean;
  /** File mode for the created file (POSIX), e.g. 0o755 for a launcher. */
  mode?: number;
}

export interface SafeWriteResult {
  /** A symlink sat at the target path and was unlinked (the link, not what it pointed to). */
  replacedSymlink: boolean;
  /** A directory sat at the target path and was removed (only with `replaceDir`). */
  replacedDir: boolean;
}

/** The absolute target, or a throw when it does not resolve inside `root`. Pure. */
export function resolveInside(root: string, target: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, target);
  const rel = path.relative(rootAbs, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SafeWriteError('outside_root', target, `root ${rootAbs}`);
  }
  return abs;
}

/** Whether `target` resolves strictly inside `root` (no throw). Pure. */
export function isInside(root: string, target: string): boolean {
  try {
    resolveInside(root, target);
    return true;
  } catch {
    return false;
  }
}

/** Every component from `root` (exclusive) down to `dir` (inclusive) must be a real directory.
 *  Missing components are fine when `allowMissing` (the caller creates them next). */
async function walkComponents(root: string, dir: string, allowMissing: boolean): Promise<void> {
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, dir);
  if (rel === '') return;
  const parts = rel.split(path.sep).filter((p) => p.length > 0);
  let cur = rootAbs;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return;
      throw new SafeWriteError('missing_parent', cur, (err as NodeJS.ErrnoException).code);
    }
    if (st.isSymbolicLink()) throw new SafeWriteError('symlinked_parent', cur);
    if (!st.isDirectory()) throw new SafeWriteError('parent_not_dir', cur);
  }
}

/** Every existing component between `root` and `dir` must be a real directory (a planted
 *  symlink anywhere on the way is refused). Missing trailing components are allowed: the caller
 *  creates them with safeMkdir. */
export async function assertRealDir(root: string, dir: string): Promise<void> {
  const abs = path.resolve(path.resolve(root), dir);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new SafeWriteError('outside_root', dir, `root ${root}`);
  await walkComponents(root, abs, true);
}

/** Create `dir` (and missing parents) below `root` without ever creating through a symlink:
 *  the existing components are checked first, then each missing one is created singly. */
export async function safeMkdir(root: string, dir: string): Promise<void> {
  const abs = path.resolve(path.resolve(root), dir);
  await assertRealDir(root, abs);
  const rootAbs = path.resolve(root);
  const parts = path.relative(rootAbs, abs).split(path.sep).filter((p) => p.length > 0);
  let cur = rootAbs;
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      await mkdir(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = await lstat(cur);
      if (st.isSymbolicLink()) throw new SafeWriteError('symlinked_parent', cur);
      if (!st.isDirectory()) throw new SafeWriteError('parent_not_dir', cur);
    }
  }
}

/** Write `data` to `target` below `root` atomically and without following any symlink. */
export async function safeWriteFile(
  root: string,
  target: string,
  data: string | Uint8Array,
  opts: SafeWriteOptions = {},
): Promise<SafeWriteResult> {
  const abs = resolveInside(root, target);
  const parent = path.dirname(abs);
  await walkComponents(root, parent, false);
  const result: SafeWriteResult = { replacedSymlink: false, replacedDir: false };
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    st = undefined;
  }
  if (st !== undefined) {
    if (st.isSymbolicLink()) {
      await unlink(abs); // the link only; its target is never touched
      result.replacedSymlink = true;
    } else if (st.isDirectory()) {
      if (opts.replaceDir !== true) throw new SafeWriteError('directory_target', abs);
      await rm(abs, { recursive: true, force: true }); // rm never follows links
      result.replacedDir = true;
    } else if (!st.isFile()) {
      throw new SafeWriteError('not_regular', abs);
    }
  }
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, 'wx', opts.mode ?? 0o644);
    await fh.writeFile(data);
    await fh.close();
    fh = undefined;
    await rename(tmp, abs);
  } catch (err) {
    if (fh) await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return result;
}

/** Create an empty regular file at `target` (a sink, ADR-0025 D1) with `wx`: an existing entry
 *  of any type is refused (`exists`), so the sink's inode is known before the agent runs. */
export async function safeCreateEmpty(root: string, target: string): Promise<void> {
  const abs = resolveInside(root, target);
  await walkComponents(root, path.dirname(abs), false);
  let fh: FileHandle;
  try {
    fh = await open(abs, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new SafeWriteError('exists', abs);
    throw err;
  }
  await fh.close();
}

/** Read `target` below `root`: same component checks, the target itself must be a regular
 *  file (a symlink is refused). Throws SafeReadError on anything but a clean read. */
export async function safeReadFile(root: string, target: string): Promise<Buffer> {
  let abs: string;
  try {
    abs = resolveInside(root, target);
    await walkComponents(root, path.dirname(abs), false);
  } catch (err) {
    if (err instanceof SafeWriteError) throw new SafeReadError(err.reason, target);
    throw err;
  }
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new SafeReadError(code === 'ENOENT' ? 'not_found' : 'io', abs, code);
  }
  if (st.isSymbolicLink()) throw new SafeReadError('symlink_target', abs);
  if (!st.isFile()) throw new SafeReadError('not_regular', abs);
  try {
    return await readFile(abs);
  } catch (err) {
    throw new SafeReadError('io', abs, (err as NodeJS.ErrnoException).code);
  }
}

/** safeReadFile decoded as UTF-8. */
export async function safeReadText(root: string, target: string): Promise<string> {
  return (await safeReadFile(root, target)).toString('utf8');
}
