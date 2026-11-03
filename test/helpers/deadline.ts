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
