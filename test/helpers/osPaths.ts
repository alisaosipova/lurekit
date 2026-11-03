// OS-agnostic test helpers for paths and planted content (3-OS CI: Linux, macOS, Windows).
//   - listPosixFiles: every file under a dir as sorted `/`-separated relative paths, so expected
//     keys like '.claude/settings.json' match on Windows too.
//   - escapedForms / countEscapedOrRaw / containsEscapedOrRaw: a per-run canary path planted
//     inside a JSON/TOML string is written escaped (Windows backslashes doubled), while prose
//     files (README.md, CLAUDE.md, scripts) carry it raw. Both forms count as the same reference.
//   - realpathOf: resolve a path before comparing (macOS tmpdir is a /var -> /private/var symlink).

import { readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Every file under `dir`, as sorted `/`-separated paths relative to `base`. */
export async function listPosixFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listPosixFiles(abs, base)));
    else out.push(toPosix(path.relative(base, abs)));
  }
  return out.sort();
}

/** A relative path with the platform separator replaced by `/`. */
export function toPosix(rel: string): string {
  return rel.split(path.sep).join(path.posix.sep);
}

/** The distinct forms `needle` may take in planted content: raw, and JSON-string-escaped
 *  (identical on POSIX for a plain path, so it is listed once there). */
export function escapedForms(needle: string): string[] {
  const escaped = JSON.stringify(needle).slice(1, -1);
  return escaped === needle ? [needle] : [needle, escaped];
}

/** Occurrences of `needle` in `hay`, counting raw and JSON-escaped forms (they cannot overlap:
 *  an escaped Windows path never contains the raw one, and vice versa). */
export function countEscapedOrRaw(hay: string, needle: string): number {
  return escapedForms(needle).reduce((n, f) => n + hay.split(f).length - 1, 0);
}

/** `hay` references `needle` raw or JSON-escaped. */
export function containsEscapedOrRaw(hay: string, needle: string): boolean {
  return countEscapedOrRaw(hay, needle) > 0;
}

/** The real (symlink-resolved) path, for comparing a recorded cwd with an expected tmp path. */
export function realpathOf(p: string): string {
  return realpathSync.native(p);
}
