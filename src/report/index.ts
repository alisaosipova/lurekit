// Reporter dispatch (evidence-spec §6). A reporter is a PURE function of the run manifest
// (§2.3) and the per-run evidence records (§2.2): it adds no facts, never re-runs an agent,
// never hits the network, never posts anywhere (§6.3). Emits a string; the CLI decides stdout
// or file. Markdown's evidence excerpt is supplied through an injected lookup, so no format
// does file I/O here.

import type { ClassLookup } from './frameworks.js';
import type { RunManifest } from '../runner/types.js';
import { renderJson } from './json.js';
import { renderMarkdown, type EvidenceLookup } from './markdown.js';
import type { ReMeasureContext, SurfaceLookup } from './guidance.js';
import { renderSarif } from './sarif.js';
import { buildScore, type Report } from './score.js';
import { renderTerminal, type TerminalOptions } from './terminal.js';

export { buildScore, REPORT_SCHEMA_VERSION, profileDigest, lowConfidenceCount } from './score.js';
export type { Report, ReportScenario } from './score.js';
export { renderJson } from './json.js';
export { renderMarkdown, MARKDOWN_SCORING_NOTES, LOW_CONFIDENCE_LABEL, headlineTail } from './markdown.js';
export type { EvidenceLookup, MarkdownOptions } from './markdown.js';
export {
  HARDENING_KNOBS, NO_VERIFIED_FIX, UNKNOWN_SURFACE, plainLanguageSummary, whatToChange, vulnerableBySurface,
} from './guidance.js';
export type { SurfaceLookup, HardeningKnob, KnobEvidence, ReMeasureContext } from './guidance.js';
export { leadingSemver, sameAgentVersion, reMeasureCommand, UNKNOWN_CORPUS } from './guidance.js';
export { PUBLISHED_CLAUDE_VERSION, REPORT_REPOSITORY_URLS, INTERPRETING_RESULTS_URL, repoFileUrl } from './guidance.js';
export { renderSarif, toSarif, REPOSITORY_URL } from './sarif.js';
export {
  renderTerminal, colorEnabled, terminalWidth, sourceRef, verdictWords, confidenceCell, shortDigest, plain, wrap, truncate,
  DEFAULT_WIDTH, MIN_WIDTH,
} from './terminal.js';
export type { TerminalData, TerminalOptions } from './terminal.js';

/** `text` is the terminal view (ADR-0021 amendment): the same data as `markdown`, for a person
 *  reading a terminal; `markdown` is the artifact format on disk (report.md). */
export type ReportFormat = 'json' | 'markdown' | 'sarif' | 'text';

export interface ReportOptions {
  format: ReportFormat;
  /** Supplied by the CLI for Markdown's per-vulnerable evidence excerpt; unused by json/sarif. */
  evidenceLookup?: EvidenceLookup;
  /** Markdown only (ADR-0021): scenario id -> attack surface, for the plain-language layers. */
  surfaceOf?: SurfaceLookup;
  /** UB-1: OWASP Agentic classes per scenario, from the corpus. */
  classOf?: ClassLookup;
  /** Markdown only (ADR-0021 amendment): corpus path and budget estimate for the re-measure line. */
  reMeasure?: ReMeasureContext;
  /** `text` only: the width and colour decided by the CLI, and the demo banner lines, if any. */
  terminal?: TerminalOptions & { banner?: string[] };
}

/** Build the scoring block from the manifest and render it in the chosen format. */
export function report(manifest: RunManifest, opts: ReportOptions): string {
  const score: Report = buildScore(manifest);
  switch (opts.format) {
    case 'json':
      return renderJson(manifest, score);
    case 'markdown':
      return renderMarkdown(manifest, score, opts.evidenceLookup, { surfaceOf: opts.surfaceOf, ...(opts.reMeasure ? { reMeasure: opts.reMeasure } : {}) });
    case 'sarif':
      return renderSarif(manifest, score, opts.surfaceOf, opts.classOf);
    case 'text': {
      const t = opts.terminal ?? { width: 100, color: false };
      return renderTerminal(
        {
          manifest, report: score,
          ...(opts.evidenceLookup ? { evidenceLookup: opts.evidenceLookup } : {}),
          ...(opts.surfaceOf ? { surfaceOf: opts.surfaceOf } : {}),
          ...(opts.classOf ? { classOf: opts.classOf } : {}),
          ...(opts.reMeasure ? { reMeasure: opts.reMeasure } : {}),
          ...(t.banner ? { banner: t.banner } : {}),
        },
        { width: t.width, color: t.color, ...(t.evidenceBase ? { evidenceBase: t.evidenceBase } : {}) },
      );
    }
    default: {
      const bad: never = opts.format;
      throw new Error(`unknown report format: ${String(bad)}`);
    }
  }
}
