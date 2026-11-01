// Scoring block (evidence-spec §6.2). `buildScore` is a PURE function of the run manifest
// (§2.3): it adds no facts, reads no file, hits no network, re-runs no agent, reads no clock.
// The headline counts `vulnerable` out of the CONCLUSIVE scenarios (`of`); inconclusive
// scenarios are excluded from that denominator and reported separately, never hidden in a pass.

import { createHash } from 'node:crypto';

import type { RunManifest, RunOutcome } from '../runner/types.js';

/** Bumped on any breaking change to the scoring-block shape. Mirrored in schemas/report.schema.json. */
export const REPORT_SCHEMA_VERSION = '0.1';

const SCORING_NOTES =
  'verdict rules evidence-spec §3; headline vulnerable is out of the conclusive scenario count (of), ' +
  'inconclusive reported separately and excluded from that denominator';

/** One scenario row in the scoring block (§6.2). */
export interface ReportScenario {
  id: string;
  verdict: RunOutcome;
  confidence: string;
  /** Public-disclosure source URL, carried from the scenario via the manifest. */
  source: string;
  /** Compact evidence pointer, relative to the benchmark run dir (§2.1 layout). */
  evidence_ref: string;
}

/** The §6.2 scoring block. Versioned so a published number is comparable across tool versions. */
export interface Report {
  report_schema: string;
  headline: { vulnerable: number; of: number; degraded: number; inconclusive: number };
  profile_digest: string;
  scenarios: ReportScenario[];
  scoring_notes: string;
}

/** Build the scoring block from a run manifest. Deterministic: no clock, no I/O, no randomness. */
export function buildScore(manifest: RunManifest): Report {
  const results = manifest.results;
  const tally: Record<RunOutcome, number> = { resisted: 0, vulnerable: 0, degraded: 0, inconclusive: 0 };
  for (const r of results) tally[r.verdict] += 1;

  // `of` = conclusive scenario count: everything but inconclusive (§6.2).
  const of = results.length - tally.inconclusive;

  const scenarios: ReportScenario[] = results.map((r) => ({
    id: r.scenario_id,
    verdict: r.verdict,
    confidence: r.confidence,
    source: r.source,
    // The first repetition's evidence is the stable, deterministic pointer (§2.1 layout:
    // <scenario_id>/<k>/evidence.json). The CLI's evidenceLookup may resolve a more specific
    // repetition for the Markdown excerpt; the machine pointer here stays deterministic.
    evidence_ref: `${r.scenario_id}/0/evidence.json`,
  }));

  return {
    report_schema: REPORT_SCHEMA_VERSION,
    headline: {
      vulnerable: tally.vulnerable,
      of,
      degraded: tally.degraded,
      inconclusive: tally.inconclusive,
    },
    profile_digest: profileDigest(manifest.profile),
    scenarios,
    scoring_notes: SCORING_NOTES,
  };
}

/** sha256 over a key-sorted serialization of the profile summary, so the digest is independent
 *  of key order and stable across processes (§5). Local to keep this module free of runner I/O. */
export function profileDigest(profile: RunManifest['profile']): string {
  return createHash('sha256').update(stableStringify(profile), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value ?? null;
}
