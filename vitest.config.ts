import { configDefaults, defineConfig } from 'vitest/config';

import { TEST_TIMEOUT_MS } from './test/helpers/deadline.js';

// Keep vitest out of the ignored run material: a scratch build or a recorded run under .aab-runs/
// may itself contain test files, which would otherwise be collected twice.
//
// Timeouts: the suite spawns many child processes (stub agents, the inert MCP server, the CLI)
// and on a loaded host (load average well above the core count) a single test can take several
// seconds. The vitest default of 5 s produced spurious timeouts; one shared budget lives in
// test/helpers/deadline.ts, and every in-test ready-file poll derives its deadline from it.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.aab-runs/**', '.aab-test-work/**'],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
