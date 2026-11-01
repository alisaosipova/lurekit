// Reporter dispatch (evidence-spec §6). A reporter is a PURE function of the run manifest
// (§2.3) and the per-run evidence records (§2.2): it adds no facts, never re-runs an agent,
// never hits the network, never posts anywhere (§6.3). Emits a string; the CLI decides stdout
// or file. Markdown's evidence excerpt is supplied through an injected lookup, so no format
// does file I/O here.

import type { RunManifest } from '../runner/types.js';
import { renderJson } from './json.js';
import { renderMarkdown, type EvidenceLookup } from './markdown.js';
import { renderSarif } from './sarif.js';
import { buildScore, type Report } from './score.js';

export { buildScore, REPORT_SCHEMA_VERSION, profileDigest } from './score.js';
export type { Report, ReportScenario } from './score.js';
export { renderJson } from './json.js';
export { renderMarkdown } from './markdown.js';
export type { EvidenceLookup } from './markdown.js';
export { renderSarif, toSarif, REPOSITORY_URL } from './sarif.js';

export type ReportFormat = 'json' | 'markdown' | 'sarif';

export interface ReportOptions {
  format: ReportFormat;
  /** Supplied by the CLI for Markdown's per-vulnerable evidence excerpt; unused by json/sarif. */
  evidenceLookup?: EvidenceLookup;
}

/** Build the scoring block from the manifest and render it in the chosen format. */
export function report(manifest: RunManifest, opts: ReportOptions): string {
  const score: Report = buildScore(manifest);
  switch (opts.format) {
    case 'json':
      return renderJson(manifest, score);
    case 'markdown':
      return renderMarkdown(manifest, score, opts.evidenceLookup);
    case 'sarif':
      return renderSarif(manifest, score);
    default: {
      const bad: never = opts.format;
      throw new Error(`unknown report format: ${String(bad)}`);
    }
  }
}
