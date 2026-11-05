// `lurekit clean` (ADR-0027): find (and with --yes remove) adapter caches under a results root
// that are not evidence: <run>/<scenario>/<rep>/codex-home/.tmp. Nothing else is ever removed.

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CODEX_HOME_DIR } from './adapters/codexCli.js';

export interface CacheDir {
  path: string;
  bytes: number;
}

/** Total bytes of a tree, without following symlinks. */
export function treeBytes(p: string): number {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return st.isFile() ? st.size : 0;
  let total = 0;
  for (const name of readdirSync(p)) total += treeBytes(path.join(p, name));
  return total;
}

function dirsOf(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => path.join(p, e.name));
  } catch {
    return [];
  }
}

/** The removable caches under `root`: exactly <run>/<scenario>/<rep>/codex-home/.tmp, real dirs. */
export function findCaches(root: string): CacheDir[] {
  const out: CacheDir[] = [];
  for (const run of dirsOf(root)) {
    for (const scenario of dirsOf(run)) {
      for (const rep of dirsOf(scenario)) {
        const cache = path.join(rep, CODEX_HOME_DIR, '.tmp');
        try {
          const st = lstatSync(cache);
          if (st.isDirectory() && !st.isSymbolicLink()) out.push({ path: cache, bytes: treeBytes(cache) });
        } catch {
          /* no cache here */
        }
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function removeCaches(caches: CacheDir[]): void {
  for (const c of caches) rmSync(c.path, { recursive: true, force: true });
}

export function humanBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
