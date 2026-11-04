// Per-run deadline (ADR-0024 D1). The ONLY place in src/runner/ that reads a clock: the
// per-repetition timer (`setTimeout`) and the elapsed measurement (`performance.now()`) live
// here, so the runner's own logic stays free of wall-clock reads (runner.ts header). Elapsed time
// is reported only for a run that did not complete, which is never byte-reproducible anyway.
//
// runWithDeadline(fn, opts) calls fn with ONE signal that fires when either the caller's signal
// (the operator's Ctrl-C) or the per-run timer fires. It then waits for fn to settle; after an
// abort it waits at most `abandonAfterMs` more and then abandons the promise (a non-cooperating
// adapter cannot hang the benchmark). The result names the completion state the runner scores on.

import { performance } from 'node:perf_hooks';

/** Default `--run-timeout`, seconds: three times the slowest published repetition (60 005 ms over
 *  410 evidence records in demo/ and reports/, ADR-0024 "Measured run durations"). */
export const DEFAULT_RUN_TIMEOUT_S = 180;

/** How long the runner waits for the adapter to return after the abort signal fired before it
 *  proceeds without an observation (ADR-0024 D1). Covers KILL_GRACE_MS + STDIO_DRAIN_MS of the
 *  child-process helper with room to spare. */
export const ABANDON_AFTER_MS = 10_000;

/** Largest delay a Node timer accepts (2^31 - 1 ms, about 24.8 days). A larger value would make
 *  setTimeout fire after 1 ms (TimeoutOverflowWarning), i.e. every run would time out at once;
 *  the CLI refuses `--run-timeout` above MAX_RUN_TIMEOUT_S and the helper clamps anyway. */
export const MAX_TIMER_MS = 2_147_483_647;
export const MAX_RUN_TIMEOUT_S = Math.floor(MAX_TIMER_MS / 1000);

/** Upper bound for one detector/fixture teardown() (ADR-0024 D2 "teardown"): a teardown that
 *  does not settle within it is recorded as a teardown_error and the lifecycle moves on. */
export const TEARDOWN_TIMEOUT_MS = 10_000;

/** Await `p` for at most `ms`; resolves `true` when it settled in time (rejections propagate),
 *  `false` when it did not (the promise is then detached and its rejection swallowed). */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), Math.min(Math.max(0, ms), MAX_TIMER_MS));
  });
  try {
    const r = await Promise.race([p.then(() => true as const), late]);
    if (r === false) p.catch(() => undefined);
    return r;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How the adapter call ended (ADR-0024 D2). Only `completed` can ever score `resisted`. */
export type RunCompletion =
  | 'completed' // the adapter returned normally before any signal fired
  | 'threw' // the adapter rejected before any signal fired
  | 'timed_out' // the per-run timer fired (the adapter returned or rejected afterwards)
  | 'aborted' // the caller's signal fired (operator abort)
  | 'abandoned'; // a signal fired and the adapter did not settle within abandonAfterMs

export interface DeadlineOptions {
  /** Per-run cap in ms; undefined arms no timer (replay, direct runner use). */
  timeoutMs?: number;
  /** The caller's signal (operator abort), chained into the signal fn receives. */
  signal?: AbortSignal;
  /** Test seam for ABANDON_AFTER_MS. */
  abandonAfterMs?: number;
}

export interface DeadlineResult<T> {
  completion: RunCompletion;
  /** fn's resolved value, also when it resolved after the signal fired (a partial observation). */
  value?: T;
  /** fn's rejection, when it rejected (before or after the signal). */
  error?: unknown;
  /** Wall-clock ms from the fn call to the moment the signal fired; only when one fired. */
  elapsedMs?: number;
  /** Which signal fired first, when one did. */
  fired?: 'timer' | 'caller';
}

export type DeadlineRunner = <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: DeadlineOptions,
) => Promise<DeadlineResult<T>>;

/** Combine the caller's signal with the per-run controller: fires when either fires. */
function chainSignals(caller: AbortSignal | undefined, perRun: AbortSignal): AbortSignal {
  if (!caller) return perRun;
  return AbortSignal.any([caller, perRun]);
}

export const runWithDeadline: DeadlineRunner = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: DeadlineOptions,
): Promise<DeadlineResult<T>> => {
  const perRun = new AbortController();
  const signal = chainSignals(opts.signal, perRun.signal);
  const abandonAfterMs = opts.abandonAfterMs ?? ABANDON_AFTER_MS;

  const start = performance.now();
  let fired: 'timer' | 'caller' | undefined;
  let elapsedMs: number | undefined;
  let resolveFired: (() => void) | undefined;
  const firedPromise = new Promise<void>((r) => {
    resolveFired = r;
  });
  const markFired = (who: 'timer' | 'caller'): void => {
    if (fired !== undefined) return;
    fired = who;
    elapsedMs = Math.max(0, Math.round(performance.now() - start));
    resolveFired?.();
  };

  let timer: NodeJS.Timeout | undefined;
  if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)) {
    timer = setTimeout(() => {
      markFired('timer');
      perRun.abort(new Error(`run timed out after ${elapsedMs} ms`));
    }, Math.min(Math.max(0, opts.timeoutMs), MAX_TIMER_MS));
  }
  const onCallerAbort = (): void => markFired('caller');
  if (opts.signal) {
    if (opts.signal.aborted) onCallerAbort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  type Settled = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };
  const settled: Promise<Settled> = fn(signal).then(
    (value) => ({ kind: 'value', value }),
    (error: unknown) => ({ kind: 'error', error }),
  );

  // Phase 1: wait for fn to settle or a signal to fire.
  let outcome = await Promise.race([settled, firedPromise.then(() => undefined)]);
  // Phase 2: a signal fired first -> give the adapter abandonAfterMs to return.
  let abandoned = false;
  if (outcome === undefined) {
    let grace: NodeJS.Timeout | undefined;
    const gracePromise = new Promise<undefined>((r) => {
      grace = setTimeout(() => r(undefined), abandonAfterMs);
    });
    outcome = await Promise.race([settled, gracePromise]);
    if (grace) clearTimeout(grace);
    if (outcome === undefined) {
      abandoned = true;
      settled.catch(() => undefined); // never an unhandled rejection
    }
  }

  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onCallerAbort);

  let completion: RunCompletion;
  if (abandoned) completion = 'abandoned';
  else if (fired === 'timer') completion = 'timed_out';
  else if (fired === 'caller') completion = 'aborted';
  else completion = outcome && outcome.kind === 'error' ? 'threw' : 'completed';

  const result: DeadlineResult<T> = { completion };
  if (outcome && outcome.kind === 'value') result.value = outcome.value;
  if (outcome && outcome.kind === 'error') result.error = outcome.error;
  if (elapsedMs !== undefined) result.elapsedMs = elapsedMs;
  if (fired !== undefined) result.fired = fired;
  return result;
};
