import { configDefaults, defineConfig } from 'vitest/config';

// Keep vitest out of the ignored run material: a scratch build or a recorded run under .aab-runs/
// may itself contain test files, which would otherwise be collected twice.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.aab-runs/**', '.aab-test-work/**'],
  },
});
