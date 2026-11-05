// SARIF 2.1.0 report (evidence-spec §6.1, optional, for code-scanning UIs). PURE and
// deterministic. Mirrors the mcp-review-check SARIF structure: a single run, a driver with
// informationUri + one rule per reported scenario, and one result per `vulnerable` (level
// error), `degraded` (level note) or `inconclusive` (level warning, block B17) scenario. No secrets: scenarios touch only canaries.

import type { RunManifest, RunOutcome } from '../runner/types.js';
import type { Report } from './score.js';

/** Repository URL for the SARIF driver.informationUri (matches the schemas' $id origin). */
export const REPOSITORY_URL = 'https://github.com/alisaosipova/lurekit';

/** Scenarios surfaced as SARIF results and their level. `resisted`/`inconclusive` are omitted. */
/** B17: inconclusive is a `warning` (not measured must not read as a pass); resisted is omitted. */
const LEVEL: Partial<Record<RunOutcome, string>> = { vulnerable: 'error', degraded: 'note', inconclusive: 'warning' };

export function renderSarif(manifest: RunManifest, report: Report): string {
  return JSON.stringify(toSarif(manifest, report), null, 2) + '\n';
}

export function toSarif(manifest: RunManifest, report: Report): Record<string, unknown> {
  const byId = new Map(manifest.results.map((r) => [r.scenario_id, r]));
  const reported = report.scenarios.filter((s) => LEVEL[s.verdict] !== undefined);

  // One rule per reported scenario: ruleId = scenario id, helpUri = disclosure source URL.
  const rules = reported.map((s) => ({
    id: s.id,
    name: byId.get(s.id)?.name ?? s.id,
    shortDescription: { text: byId.get(s.id)?.name ?? s.id },
    ...(s.source ? { helpUri: s.source } : {}),
    properties: { detector: byId.get(s.id)?.detector, verdict: s.verdict },
  }));

  const results = reported.map((s) => ({
    ruleId: s.id,
    level: LEVEL[s.verdict],
    message: {
      text:
        s.verdict === 'inconclusive'
          ? `${s.id} ${byId.get(s.id)?.name ?? ''}: inconclusive, not measured${byId.get(s.id)?.inconclusive_reason ? ` (${byId.get(s.id)!.inconclusive_reason})` : ''} (${s.confidence})`
          : `${s.id} ${byId.get(s.id)?.name ?? ''}: ${s.verdict} (${s.confidence})`.trim(),
    },
    partialFingerprints: {
      scenarioId: s.id,
      detector: byId.get(s.id)?.detector ?? '',
      profileDigest: report.profile_digest,
    },
    locations: [
      { physicalLocation: { artifactLocation: { uri: s.evidence_ref, uriBaseId: 'LUREKIT_RUN' } } },
    ],
    properties: { confidence: s.confidence, ...(s.source ? { source: s.source } : {}), ...(s.low_confidence ? { low_confidence: true } : {}) },
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'LureKit',
            version: manifest.tool_version,
            informationUri: REPOSITORY_URL,
            rules,
          },
        },
        results,
        originalUriBaseIds: { LUREKIT_RUN: { description: { text: 'the benchmark run directory (results/<benchmark_run_id>/)' } } },
        // B17: one code-scanning category per agent across uploads (GitHub uses the part up to the last '/').
        automationDetails: { id: `lurekit/${manifest.profile.agent}/${manifest.benchmark_run_id}` },
        properties: { profileDigest: report.profile_digest, headline: report.headline },
      },
    ],
  };
}
