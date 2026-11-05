// One shared time budget for the test suite.
//
// TEST_TIMEOUT_MS is the per-test and per-hook timeout (vitest.config.ts). A test that polls for
// a ready file written by a stub child must give up BEFORE vitest kills the test, so that the
// failure names what never became ready instead of a bare "Test timed out". READY_DEADLINE_MS is
// therefore derived from, and strictly below, the test timeout.

export const TEST_TIMEOUT_MS = 30_000;

/** Deadline for a single ready-file poll inside one test; leaves headroom for the rest of it. */
export const READY_DEADLINE_MS = Math.floor(TEST_TIMEOUT_MS * 2 / 3);

/** Poll until `probe` resolves, or throw `what` once READY_DEADLINE_MS (or `timeoutMs`) is spent. */
export async function pollUntil(
  probe: () => Promise<unknown>,
  what: string,
  timeoutMs: number = READY_DEADLINE_MS,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await probe();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(what);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ADR-0012 amendment (2026-11-05, block B15, rule a.2): every wall-clock bound a timer or
// kill-path test asserts is derived from these two constants plus the production constant that
// bounds the path, never from a bare literal.
//
// TIMER_EARLY_MS: a Node timer may fire a few milliseconds before performance.now() says the
// limit passed (199 for a 200 ms limit was seen on windows-latest; the old B3-T2 bound allowed
// 35 for a 50 ms limit). A lower bound is `limit - TIMER_EARLY_MS`: "not earlier than".
export const TIMER_EARLY_MS = 15;

// LOAD_SLACK_MS: how much longer than the production bound a path may take on a loaded host
// (CI runner, a benchmark running next to the suite) before the test calls it a hang. An upper
// bound is `<production constant> + LOAD_SLACK_MS`: it asserts "did not hang", nothing finer.
export const LOAD_SLACK_MS = 2_000;
