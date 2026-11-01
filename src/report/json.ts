// JSON report (evidence-spec §6.1 machine format): the run manifest plus the scoring block.
// Pure and deterministic — stable pretty JSON, no clock, no I/O. A third party re-derives the
// verdict from the manifest + evidence records alone; this format bundles the manifest with the
// already-derived score so the published number travels with its inputs.

import type { RunManifest } from '../runner/types.js';
import type { Report } from './score.js';

/** The machine format: `{ manifest, score }`. Stable key order, pretty-printed, trailing newline. */
export function renderJson(manifest: RunManifest, report: Report): string {
  return JSON.stringify({ manifest, score: report }, null, 2) + '\n';
}
