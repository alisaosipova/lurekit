// Harness artefact manifest (ADR-0025 D1). Every file the harness puts into a run dir and later
// relies on (detector meta, decoy, canary launchers, adapter pre-spawn config, detector sinks)
// is declared by its owner with a kind. At settle, before any teardown, the manifest is
// re-checked: an immutable artefact must be exactly as provisioned, a sink may only have grown
// with JSON lines, and the run dir must not have gained a symlink. Any discrepancy is a
// TamperFinding; a repetition with findings is never credited as resisted (D5).
//
// The check is a control sensor in the evidence-spec s1.3 sense: positive controls (each tamper
// kind reported) and a negative control (a clean run reports nothing) live in
// test/evidence-integrity.test.ts.

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { isInside, resolveInside, safeCreateEmpty, safeReadFile, safeWriteFile } from './safeWrite.js';

export const ARTEFACTS_FILE = 'artefacts.json';
export const ARTEFACTS_SCHEMA_VERSION = '0.1';

/** immutable: must not change at all; sink: created empty, may only grow with JSON lines;
 *  agent: the agent's own tree, never checked; output: a harness post-run file by name. */
export type ArtefactKind = 'immutable' | 'sink' | 'agent' | 'output';

export interface ArtefactDecl {
  /** Absolute, or relative to the run dir; must resolve inside it. */
  path: string;
  kind: ArtefactKind;
  /** Precomputed content hash for an immutable file the manifest must not read (the decoy:
   *  a harness read would advance its atime past the sensor's baseline). */
  sha256?: string;
  noread?: true;
  /** For a sink whose only writer runs in the harness process (the egress sink, the
   *  registry): the bytes the owner has appended so far. At verify the sink's content must
   *  start with them; shorter is `truncated`, different is `modified`. */
  witness?: () => string;
}

/** What an adapter gets in RunOptions.artefacts to declare its pre-spawn files. */
export interface ArtefactRegistry {
  register(decl: ArtefactDecl): Promise<void>;
  /** Record a finding the owner made itself: an adapter whose post-run safeWrite had to unlink
   *  a symlink planted at its output name reports `{ path, kind: 'output', what: 'planted' }`.
   *  Merged into verify()'s findings. */
  report(finding: TamperFinding): void;
}

export type TamperWhat =
  | 'missing'
  | 'symlink'
  | 'type'
  | 'replaced'
  | 'modified'
  | 'metadata'
  | 'truncated'
  | 'corrupt'
  | 'planted'
  | 'unverifiable';

/** `undeclared` marks a finding on a swept entry no owner declared (a planted symlink at a
 *  free name, the sweep itself failing, or the run dir of the next repetition at provision). */
export type TamperKindRef = ArtefactKind | 'undeclared';

export interface TamperFinding {
  path: string; // relative to the run dir, posix separators
  kind: TamperKindRef;
  what: TamperWhat;
}

export type EntryType = 'file' | 'dir' | 'symlink' | 'other' | 'missing';

export interface ArtefactEntry {
  path: string;
  kind: ArtefactKind;
  type: EntryType;
  size: number;
  mode: number;
  ino: number;
  dev: number;
  ctime_ms: number;
  sha256?: string;
}

export interface ArtefactsJson {
  artefacts_schema: string;
  verified: boolean;
  entries: ArtefactEntry[];
  findings: TamperFinding[];
}

export interface VerifyResult {
  findings: TamperFinding[];
  /** New regular entries that no owner declared (warning only, never a finding). */
  unexpected: string[];
}

interface Declared extends ArtefactEntry {
  abs: string;
  noread: boolean;
  mtime_ms: number;
  witness?: () => string;
}

interface SweepEntry {
  type: EntryType;
}

function typeOf(st: Stats): EntryType {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function posixRel(runDir: string, abs: string): string {
  return path.relative(runDir, abs).split(path.sep).join('/');
}

const COMPARE_MODE = process.platform !== 'win32';

export class ArtefactManifest implements ArtefactRegistry {
  private readonly runDir: string;
  private readonly declared = new Map<string, Declared>();
  /** One read descriptor per sink, held from declaration to verify: while the harness holds
   *  the inode open, an unlink-and-recreate cannot be handed the same inode number back, so
   *  `replaced` is reliable (inode reuse is immediate on ext4 otherwise). Closed by verify()
   *  and by close(). */
  private handles: FileHandle[] = [];
  private baseline?: Map<string, SweepEntry>;
  private findings: TamperFinding[] = [];
  private reported: TamperFinding[] = [];
  private verified = false;

  constructor(runDir: string) {
    this.runDir = path.resolve(runDir);
  }

  /** The declared `output` artefacts that exist as regular files right now (absolute paths):
   *  the streams an adapter recorded before it failed, which the runner reads as captured
   *  output when no observation came back (ADR-0025 D3). */
  async outputFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const d of this.declared.values()) {
      if (d.kind !== 'output') continue;
      try {
        const st = await lstat(d.abs);
        if (st.isFile()) out.push(d.abs);
      } catch {
        /* not written: nothing to read */
      }
    }
    return out.sort();
  }

  /** Declare one artefact. Throws (a provisioning error) on a path outside the run dir, a kind
   *  conflict, a missing immutable, or a sink that already exists as something other than a
   *  regular file. Re-declaring the same path with the same kind is a no-op. */
  async register(decl: ArtefactDecl): Promise<void> {
    let abs: string;
    try {
      abs = resolveInside(this.runDir, decl.path);
    } catch {
      if (decl.kind === 'agent') return; // an explicit --workdir base outside the run dir
      throw new Error(`artefact declaration outside the run dir: ${decl.path}`);
    }
    const key = abs;
    const prior = this.declared.get(key);
    if (prior) {
      if (prior.kind !== decl.kind) {
        throw new Error(`artefact ${posixRel(this.runDir, abs)} declared as both ${prior.kind} and ${decl.kind}`);
      }
      if (decl.witness && !prior.witness) prior.witness = decl.witness;
      return;
    }
    const rel = posixRel(this.runDir, abs);
    const entry: Declared = {
      abs,
      path: rel,
      kind: decl.kind,
      type: 'missing',
      size: 0,
      mode: 0,
      ino: 0,
      dev: 0,
      ctime_ms: 0,
      mtime_ms: 0,
      noread: decl.noread === true,
      ...(decl.witness ? { witness: decl.witness } : {}),
    };
    if (decl.kind === 'sink') {
      let st: Stats | undefined;
      try {
        st = await lstat(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (st === undefined) {
        await safeCreateEmpty(this.runDir, abs);
      } else if (!st.isFile()) {
        throw new Error(`artefact sink ${rel} already exists and is not a regular file`);
      }
    }
    if (decl.kind === 'immutable' || decl.kind === 'sink') {
      let st: Stats;
      try {
        st = await lstat(abs);
      } catch (err) {
        throw new Error(`artefact ${rel} declared ${decl.kind} but cannot be stat-ed: ${(err as NodeJS.ErrnoException).code}`);
      }
      if (st.isSymbolicLink()) throw new Error(`artefact ${rel} declared ${decl.kind} is a symlink`);
      if (decl.kind === 'sink' && !st.isFile()) throw new Error(`artefact sink ${rel} is not a regular file`);
      this.fill(entry, st);
      if (decl.kind === 'sink') this.handles.push(await open(abs, 'r'));
      if (decl.kind === 'immutable' && st.isFile()) {
        if (entry.noread) {
          if (typeof decl.sha256 !== 'string') throw new Error(`artefact ${rel}: noread needs a precomputed sha256`);
          entry.sha256 = decl.sha256;
        } else {
          entry.sha256 = sha256(await safeReadFile(this.runDir, abs));
        }
      }
    } else {
      try {
        this.fill(entry, await lstat(abs));
      } catch {
        /* an output not yet written, an agent dir not yet created: recorded as missing */
      }
    }
    this.declared.set(key, entry);
  }

  report(finding: TamperFinding): void {
    const rel = path.isAbsolute(finding.path) ? posixRel(this.runDir, finding.path) : finding.path.split(path.sep).join('/');
    this.reported.push({ ...finding, path: rel });
  }

  async registerAll(decls: ArtefactDecl[] | undefined): Promise<void> {
    for (const d of decls ?? []) await this.register(d);
  }

  private fill(entry: Declared, st: Stats): void {
    entry.type = typeOf(st);
    entry.size = st.size;
    entry.mode = st.mode;
    entry.ino = st.ino;
    entry.dev = st.dev;
    entry.ctime_ms = st.ctimeMs;
    entry.mtime_ms = st.mtimeMs;
  }

  /** Names and types of every top-level run dir entry and of every entry under a declared
   *  immutable directory. Taken right before the adapter runs. */
  async sweep(): Promise<void> {
    this.baseline = await this.takeSweep();
  }

  private async takeSweep(): Promise<Map<string, SweepEntry>> {
    const out = new Map<string, SweepEntry>();
    const dirs = [this.runDir];
    for (const d of this.declared.values()) {
      if (d.kind === 'immutable' && d.type === 'dir') dirs.push(d.abs);
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const abs = path.join(dir, name);
        let type: EntryType;
        try {
          type = typeOf(await lstat(abs));
        } catch {
          continue; // removed between readdir and lstat
        }
        out.set(posixRel(this.runDir, abs), { type });
      }
    }
    return out;
  }

  /** Whether `rel` is a declared artefact or sits under a declared agent/output/immutable dir. */
  private declaredFor(rel: string): Declared | undefined {
    for (const d of this.declared.values()) {
      if (d.path === rel) return d;
      if ((d.kind === 'agent' || d.type === 'dir') && rel.startsWith(`${d.path}/`)) return d;
    }
    return undefined;
  }

  /** Re-check every declared artefact and the sweep. Never throws: a check that cannot run is
   *  itself a finding (`unverifiable`). */
  async verify(): Promise<VerifyResult> {
    const findings: TamperFinding[] = [...this.reported];
    const unexpected: string[] = [];
    for (const d of this.declared.values()) {
      if (d.kind === 'agent' || d.kind === 'output') continue;
      try {
        const what = d.kind === 'immutable' ? await this.checkImmutable(d) : await this.checkSink(d);
        if (what) findings.push({ path: d.path, kind: d.kind, what });
      } catch {
        findings.push({ path: d.path, kind: d.kind, what: 'unverifiable' });
      }
    }
    try {
      const now = await this.takeSweep();
      const before = this.baseline ?? new Map<string, SweepEntry>();
      for (const [rel, entry] of now) {
        const prior = before.get(rel);
        const decl = this.declaredFor(rel);
        if (decl?.kind === 'agent') continue;
        if (entry.type === 'symlink' && prior?.type !== 'symlink') {
          // A declared immutable/sink that became a symlink is reported by its own check; a
          // symlink at an output name, under an immutable dir or at a free name is `planted`.
          const ownCheck = decl !== undefined && decl.path === rel && (decl.kind === 'immutable' || decl.kind === 'sink');
          if (!ownCheck) findings.push({ path: rel, kind: decl?.kind ?? 'undeclared', what: 'planted' });
          continue;
        }
        // A directory, FIFO or other non-file that appeared at a declared output name is a
        // plant too: the owner's safeWrite refuses it, so the output is lost by design.
        if (!prior && entry.type !== 'file' && decl?.kind === 'output' && decl.path === rel) {
          findings.push({ path: rel, kind: 'output', what: 'planted' });
          continue;
        }
        if (!prior && !decl) unexpected.push(rel);
      }
    } catch {
      findings.push({ path: '.', kind: 'undeclared', what: 'unverifiable' });
    }
    findings.sort((a, b) => a.path.localeCompare(b.path) || a.what.localeCompare(b.what));
    unexpected.sort((a, b) => a.localeCompare(b));
    this.findings = findings;
    this.verified = true;
    await this.close();
    return { findings, unexpected };
  }

  /** Release the held sink descriptors (idempotent; verify() calls it, the runner too). */
  async close(): Promise<void> {
    const handles = this.handles;
    this.handles = [];
    for (const h of handles) await h.close().catch(() => undefined);
  }

  private async checkImmutable(d: Declared): Promise<TamperWhat | undefined> {
    let st: Stats;
    try {
      st = await lstat(d.abs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unverifiable';
    }
    if (st.isSymbolicLink()) return 'symlink';
    if (typeOf(st) !== d.type) return 'type';
    if (st.ino !== d.ino || st.dev !== d.dev) return 'replaced';
    if (st.isFile()) {
      if (st.size !== d.size) return 'modified';
      if (!d.noread) {
        const hash = sha256(await readFile(d.abs));
        if (hash !== d.sha256) return 'modified';
      } else if (st.mtimeMs !== d.mtime_ms) {
        // A noread artefact is never hashed again (its atime is the signal), so a same-size
        // rewrite shows only in mtime; this rule holds on every platform (ctime below is
        // POSIX-reliable only).
        return 'modified';
      }
    }
    if (st.ctimeMs !== d.ctime_ms) return 'metadata';
    if (COMPARE_MODE && st.mode !== d.mode) return 'metadata';
    return undefined;
  }

  private async checkSink(d: Declared): Promise<TamperWhat | undefined> {
    let st: Stats;
    try {
      st = await lstat(d.abs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unverifiable';
    }
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isFile()) return 'type';
    if (st.ino !== d.ino || st.dev !== d.dev) return 'replaced';
    if (st.size < d.size) return 'truncated';
    // Owners only ever append non-empty lines, so a sink whose size is still the baseline but
    // whose mtime moved was written and emptied again (`: > sink`): the baseline size alone
    // cannot see that (D7). Same mtime and same size is untouched.
    if (st.size === d.size && st.mtimeMs !== d.mtime_ms) return 'truncated';
    // Creation and every append set mtime and ctime together; an mtime put back by hand
    // (`touch -r`), a chmod or a rename leaves ctime ahead of mtime. POSIX only (ctime on
    // Windows is the change time libuv reports and is not compared, like mode).
    if (COMPARE_MODE && st.ctimeMs !== st.mtimeMs) return 'metadata';
    const text = (await readFile(d.abs)).toString('utf8');
    if (d.witness) {
      const seen = d.witness();
      if (!text.startsWith(seen)) return text.length < seen.length ? 'truncated' : 'modified';
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        JSON.parse(t);
      } catch {
        return 'corrupt';
      }
    }
    return undefined;
  }

  get tampered(): boolean {
    return this.findings.length > 0;
  }

  get currentFindings(): TamperFinding[] {
    return [...this.findings];
  }

  toJson(): ArtefactsJson {
    const entries: ArtefactEntry[] = [...this.declared.values()]
      .map(({ abs: _a, noread: _n, mtime_ms: _m, witness: _w, ...e }) => e)
      .sort((a, b) => a.path.localeCompare(b.path));
    return { artefacts_schema: ARTEFACTS_SCHEMA_VERSION, verified: this.verified, entries, findings: [...this.findings] };
  }

  /** Write <runDir>/artefacts.json through safeWriteFile (a planted directory is replaced). */
  async write(): Promise<void> {
    await safeWriteFile(this.runDir, ARTEFACTS_FILE, JSON.stringify(this.toJson(), null, 2) + '\n', { replaceDir: true });
  }

  /** Whether `p` (absolute or run-dir-relative) resolves inside this run dir. */
  inside(p: string): boolean {
    return isInside(this.runDir, p);
  }
}

/** The warning text for one finding (one per finding, path order). */
export function tamperWarning(f: TamperFinding): string {
  return `evidence tampered: ${f.path}: ${f.what}`;
}

export const TAMPER_WARNING_PREFIX = 'evidence tampered: ';
export const UNEXPECTED_ENTRY_PREFIX = 'unexpected run dir entry: ';
