// Shared child-process helper for the live adapters (ADR-0024 D5; ADR-0008 adapter contract).
// Every agent child is spawned here so that one abort kills the WHOLE tree the agent started
// (the shell its Bash tool ran, curl/npm, the MCP servers it spawned from the run's mcp.json),
// not only the direct child:
//   - POSIX: `detached: true` makes the agent the leader of its own process group;
//     killTree() signals the group (`kill(-pid)`): SIGTERM first (the agent can flush its final
//     stream line, e.g. the `result` event with the cost), SIGKILL after KILL_GRACE_MS.
//   - Windows: `taskkill /PID <pid> /T /F` takes the tree; child.kill() is the fallback.
// waitExit() resolves on `exit`, then waits for `close` at most STDIO_DRAIN_MS, so a grandchild
// that inherited the agent's stdout pipe cannot block the adapter's return after the kill.
// Every live child is tracked; a process 'exit' hook kills every tracked group (best effort),
// so a harness crash or a second Ctrl-C leaves no agent tree behind.
//
// Not covered (documented limits): a grandchild that called setsid() on POSIX; the `--version`
// probes are synchronous (spawnSync) and kill the direct child only, under a hard cap.

import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { constants as osConstants } from 'node:os';

/** Grace between SIGTERM and SIGKILL of the agent's process group. */
export const KILL_GRACE_MS = 2_000;
/** How long waitExit() waits for `close` after `exit` before releasing the stdio pipes. */
export const STDIO_DRAIN_MS = 2_000;
/** Hard cap for a synchronous `--version` probe (SIGKILL on expiry). */
export const VERSION_PROBE_TIMEOUT_MS = 15_000;

const IS_WIN = process.platform === 'win32';

export interface SpawnAgentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Code (`exit`'s code, else `128 + signal number`, else -1) plus the raw facts. */
export interface ExitInfo {
  exitCode: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The child's `error` event, when it fired before `exit` (spawn failure). */
  error?: NodeJS.ErrnoException;
  /** `close` did not follow `exit` within STDIO_DRAIN_MS: something still held the stdio pipes. */
  drainTimedOut: boolean;
}

/** Live children spawned through spawnAgent(), removed on `exit`. */
const tracked = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Best-effort synchronous kill of every tracked tree; used by the process 'exit' hook. */
function killTrackedSync(): void {
  for (const child of tracked) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (IS_WIN) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  tracked.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', killTrackedSync);
}

/** Spawn an agent child with piped stdout/stderr, no stdin, hidden window, and on POSIX as the
 *  leader of its own process group (never unref()ed: the harness waits for it). */
export function spawnAgent(cmd: string, args: readonly string[], opts: SpawnAgentOptions): ChildProcess {
  installExitHook();
  const child = spawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(IS_WIN ? {} : { detached: true }),
  });
  tracked.add(child);
  child.once('exit', () => tracked.delete(child));
  child.once('error', () => {
    // A spawn failure never reaches `exit`; do not keep a dead handle around.
    if (child.pid === undefined) tracked.delete(child);
  });
  return child;
}

/** Number of live tracked children (test seam). */
export function trackedChildren(): number {
  return tracked.size;
}

/** Kill every tracked tree now and forget them (test seam: afterEach hygiene). */
export function resetTrackedChildren(): void {
  killTrackedSync();
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isEsrch(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

/** Signal the child's whole group (POSIX) or the child itself (fallback). ESRCH is success. */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (!IS_WIN) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch (err) {
      if (isEsrch(err)) return;
      // Not a group leader (should not happen with detached) or EPERM: fall through.
    }
  }
  try {
    child.kill(sig);
  } catch {
    /* already gone */
  }
}

/** Resolve once the child has exited, or after `ms` (false). */
function waitExitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onExit = (): void => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    child.once('exit', onExit);
  });
}

export interface KillTreeOptions {
  /** Grace between SIGTERM and SIGKILL (POSIX). Default KILL_GRACE_MS. */
  graceMs?: number;
  /** Test seam: how the Windows tree kill is invoked. */
  taskkill?: (pid: number) => { status: number | null; error?: Error };
}

/** The Windows tree kill: `taskkill /PID <pid> /T /F`, once. */
export function taskkillTree(pid: number): { status: number | null; error?: Error } {
  const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  return { status: res.status, ...(res.error ? { error: res.error } : {}) };
}

/** Kill the agent and everything it started (ADR-0024 D5). Resolves once the direct child has
 *  exited (or the SIGKILL was sent); never throws. */
export async function killTree(child: ChildProcess, opts: KillTreeOptions = {}): Promise<void> {
  if (child.pid === undefined || exited(child)) return;
  if (IS_WIN) {
    const kill = opts.taskkill ?? taskkillTree;
    const r = kill(child.pid);
    if (r.error || r.status !== 0) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    await waitExitedWithin(child, opts.graceMs ?? KILL_GRACE_MS);
    return;
  }
  signalTree(child, 'SIGTERM');
  const done = await waitExitedWithin(child, opts.graceMs ?? KILL_GRACE_MS);
  if (!done) signalTree(child, 'SIGKILL');
}

/** After a normal exit, kill whatever the agent left running in its process group (ADR-0024 D5
 *  amendment, block B10 VERDICT-12): a background fetcher or server the agent started must not
 *  outlive the repetition and touch the next one's fixtures. POSIX only (the group id outlives
 *  its leader); on Windows the tree of an exited process cannot be walked, recorded as a limit.
 *  Returns true when a leftover group was signalled. Never throws. */
export function reapGroup(child: ChildProcess): boolean {
  if (IS_WIN || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch {
    return false; // ESRCH: nothing left in the group
  }
}

export interface WaitExitOptions {
  /** How long to wait for `close` after `exit`. Default STDIO_DRAIN_MS. */
  drainMs?: number;
}

/** Map a signal name to its number for the 128+n exit-code convention. */
export function signalNumber(sig: NodeJS.Signals): number | undefined {
  const n = (osConstants.signals as Record<string, number>)[sig];
  return typeof n === 'number' ? n : undefined;
}

/** Wait for the child to exit (`exit`, or `error` when it never spawned), then for its stdio to
 *  close for at most `drainMs`; a pipe a grandchild still holds is then released so the
 *  adapter can return. Attach the stdout/stderr `data` listeners BEFORE calling this. */
export function waitExit(child: ChildProcess, opts: WaitExitOptions = {}): Promise<ExitInfo> {
  const drainMs = opts.drainMs ?? STDIO_DRAIN_MS;
  return new Promise<ExitInfo>((resolve) => {
    let closed = false;
    let settled = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null, drainTimedOut: boolean): void => {
      if (settled) return;
      settled = true;
      let exitCode: number;
      if (code !== null) exitCode = code;
      else if (signal) exitCode = 128 + (signalNumber(signal) ?? 0);
      else exitCode = -1;
      resolve({ exitCode, code, signal, drainTimedOut, ...(spawnError ? { error: spawnError } : {}) });
    };
    const afterExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) {
        finish(code, signal, false);
        return;
      }
      const timer = setTimeout(() => {
        child.off('close', onClose);
        // Release the pipes a grandchild still holds; nothing more of theirs is evidence.
        for (const s of [child.stdout, child.stderr]) {
          try {
            s?.destroy();
          } catch {
            /* ignore */
          }
        }
        finish(code, signal, true);
      }, drainMs);
      const onClose = (): void => {
        clearTimeout(timer);
        finish(code, signal, false);
      };
      child.once('close', onClose);
    };
    child.once('close', () => {
      closed = true;
    });
    child.once('exit', (code, signal) => afterExit(code, signal));
    child.once('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      // A spawn failure emits `error` (and `close`) but no `exit`.
      if (child.pid === undefined) afterExit(null, null);
    });
    if (exited(child)) afterExit(child.exitCode, child.signalCode);
  });
}

/** A `--version`-style synchronous probe under a hard cap (ADR-0024 D5): SIGKILL on expiry,
 *  hidden window, utf8 output. The caller interprets `error`/`status`/`stdout` as before. */
export function probeVersionCapped(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): SpawnSyncReturns<string> {
  return spawnSync(cmd, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

/** Longest stdout line an adapter buffers (ENGINE-07); a longer line is dropped with a warning and
 *  parsing resumes at the next newline. */
export const MAX_STREAM_LINE = 16 * 1024 * 1024;

/** A stdout line splitter for the adapters (ENGINE-07): scans only the newly appended text for a
 *  newline (no rescan of the whole buffer per chunk), bounds a line at MAX_STREAM_LINE, and never
 *  lets a parse error escape the `data` listener (it becomes a warning). */
export function createLineSplitter(onLine: (line: string) => void, warn: (msg: string) => void, max = MAX_STREAM_LINE): { push(text: string): void; end(): void } {
  let buf = '';
  let dropping = false;
  let warnedOverflow = false;
  let warnedError = false;
  const emit = (line: string): void => {
    try {
      onLine(line);
    } catch (err) {
      if (!warnedError) {
        warnedError = true;
        warn(`a stream line could not be handled and was skipped: ${(err as Error).message}`);
      }
    }
  };
  return {
    push(text: string): void {
      let from = buf.length;
      buf += text;
      let idx: number;
      while ((idx = buf.indexOf('\n', from)) >= 0) {
        if (dropping) dropping = false;
        else emit(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        from = 0;
      }
      if (buf.length > max) {
        if (!warnedOverflow) {
          warnedOverflow = true;
          warn(`a stream line exceeded ${max} bytes and was dropped; parsing resumed at the next line`);
        }
        buf = '';
        dropping = true;
      }
    },
    end(): void {
      if (buf.length > 0 && !dropping) emit(buf);
      buf = '';
    },
  };
}
