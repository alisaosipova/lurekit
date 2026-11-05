// Shared, side-effect-light helpers for the control-sensor detectors (evidence-spec §1).
// Kept deliberately tiny: canary metadata is persisted into the run dir so evaluate() is
// self-contained from ctx.runDir alone (it does not depend on the provision() call's return
// value still being in memory), and attribution is clock-independent (it matches the canary
// identifier against the tool call's serialised input, never wall-clock vs monotonic time).

import type { ToolCall } from '../adapters/adapter.js';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { safeReadText, safeWriteFile } from '../runner/safeWrite.js';

/** Persist per-run canary metadata next to the evidence, so evaluate() can recover the
 *  random token/marker/command from the run dir without shared in-memory state. Written
 *  through safeWriteFile (ADR-0025 D2): never through a symlink. */
export async function writeMeta(runDir: string, name: string, meta: unknown): Promise<void> {
  await safeWriteFile(runDir, name, JSON.stringify(meta, null, 2));
}

/** Read back metadata written by writeMeta(); returns undefined if it is absent or not a
 *  regular file (a symlink is refused). A missing/altered meta file is caught by the artefact
 *  manifest (ADR-0025 D1), so the zero hits this yields can never score resisted. */
export async function readMeta<T>(runDir: string, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await safeReadText(runDir, name)) as T;
  } catch {
    return undefined;
  }
}

/** Read a newline-delimited JSON log inside `runDir` (`file` absolute or relative to it),
 *  tolerating a missing file (returns []) and skipping blank/corrupt lines; a symlink is refused
 *  (ADR-0025 D2). Each kept entry carries its 1-based line number for evidence refs. */
export async function readJsonl<T>(runDir: string, file: string): Promise<Array<{ line: number; entry: T }>> {
  let raw: string;
  try {
    raw = await safeReadText(runDir, file);
  } catch {
    return [];
  }
  const out: Array<{ line: number; entry: T }> = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    try {
      out.push({ line: i + 1, entry: JSON.parse(text) as T });
    } catch {
      // Corrupt line — skip, but keep the line number stable for the rest.
    }
  }
  return out;
}

/** Best-effort attribution (§1.4): the tool call whose serialised input references the
 *  canary identifier (the egress URL/token, the decoy path/marker, or the command/argv).
 *  This is clock-independent, so it works even though ToolCall.at is monotonic-since-start
 *  while evidence timestamps are wall-clock. Returns the LAST matching call (closest cause),
 *  or undefined when no tool-call id/input lines up — recorded, never hidden. */
export function attribute(toolCalls: ToolCall[], needles: string[]): ToolCall | undefined {
  const wanted = needles.filter((n) => n && n.length > 0);
  if (wanted.length === 0) return undefined;
  let match: ToolCall | undefined;
  for (const call of toolCalls) {
    let hay: string;
    try {
      hay = `${call.name} ${JSON.stringify(call.input ?? '')}`;
    } catch {
      hay = call.name;
    }
    if (wanted.some((n) => hay.includes(n))) match = call;
  }
  return match;
}

/** A sink appender (ADR-0025 D1, block B10 ENGINE-05): appends run one at a time through a single
 *  promise chain and the witness is extended inside the same chain, so the witness always equals
 *  the file's byte order even under concurrent requests (unordered `appendFile` calls could land
 *  in a different order than their `.then` callbacks, a spurious `modified` tamper finding). */
/** Append flags that never follow a symlink at the sink path (SECURITY-09; O_NOFOLLOW is POSIX,
 *  on Windows the plain append flags are used). */
export const SINK_APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | ((constants as Record<string, number>).O_NOFOLLOW ?? 0);

export function serialSinkAppender(filePath: string): { append(line: string): Promise<void>; witness(): string; close(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  let witnessed = '';
  // ADR-0025 D7 follow-up (SECURITY-09): one descriptor, opened on the first append without
  // following a symlink and held, so a sink swapped for a link or re-created afterwards is never
  // written through (the verify step then sees the swap).
  let fh: FileHandle | undefined;
  return {
    append(line: string): Promise<void> {
      const next = chain.then(async () => {
        fh ??= await open(filePath, SINK_APPEND_FLAGS, 0o600);
        await fh.appendFile(line);
        witnessed += line;
      });
      chain = next.catch(() => undefined);
      return next;
    },
    witness: () => witnessed,
    async close(): Promise<void> {
      await chain;
      await fh?.close().catch(() => undefined);
      fh = undefined;
    },
  };
}
