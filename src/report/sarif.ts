// SARIF 2.1.0 report (evidence-spec §6.1, optional, for code-scanning UIs). PURE and
// deterministic. Mirrors the mcp-review-check SARIF structure: a single run, a driver with
// informationUri + one rule per reported scenario, and one result per `vulnerable` (level
// error), `degraded` (level note) or `inconclusive` (level warning, block B17) scenario. No secrets: scenarios touch only canaries.

import type { RunManifest, RunOutcome } from '../runner/types.js';
import type { Report } from './score.js';
import { HARDENING_KNOBS, type SurfaceLookup } from './guidance.js';
import { asiBreakdown, type ClassLookup } from './frameworks.js';

/** Repository URL for the SARIF driver.informationUri (matches the schemas' $id origin). */
export const REPOSITORY_URL = 'https://github.com/alisaosipova/lurekit';

/** Scenarios surfaced as SARIF results and their level. `resisted`/`inconclusive` are omitted. */
/** B17: inconclusive is a `warning` (not measured must not read as a pass); resisted is omitted. */
const LEVEL: Partial<Record<RunOutcome, string>> = { vulnerable: 'error', degraded: 'note', inconclusive: 'warning' };

export function renderSarif(manifest: RunManifest, report: Report, surfaceOf?: SurfaceLookup, classOf?: ClassLookup): string {
  return JSON.stringify(toSarif(manifest, report, surfaceOf, classOf), null, 2) + '\n';
}

/** FEATURE-13 (evidence-spec s6.1 amendment): the "What to change" mapping as data, one entry
 *  per attack surface with a vulnerable scenario and a known hardening knob for this agent. */
export function remediation(manifest: RunManifest, report: Report, surfaceOf?: SurfaceLookup): Array<Record<string, unknown>> {
  if (!surfaceOf) return [];
  const bySurface = new Map<string, string[]>();
  for (const s of report.scenarios) {
    if (s.verdict !== 'vulnerable') continue;
    const surface = surfaceOf(s.id);
    if (!surface) continue;
    bySurface.set(surface, [...(bySurface.get(surface) ?? []), s.id]);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [surface, scenarios] of [...bySurface].sort(([a], [b]) => a.localeCompare(b))) {
    const knob = HARDENING_KNOBS[surface];
    out.push({
      surface,
      scenarios,
      ...(knob && knob.agent === manifest.profile.agent
        ? { setting: knob.setting, run_flags: knob.run_flags, proven_on: knob.proven_on, agent_version: knob.agent_version, trade_off: knob.trade_off }
        : { setting: null }),
    });
  }
  return out;
}

export function toSarif(manifest: RunManifest, report: Report, surfaceOf?: SurfaceLookup, classOf?: ClassLookup): Record<string, unknown> {
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
    properties: { confidence: s.confidence, ...(s.source ? { source: s.source } : {}), ...(s.low_confidence ? { low_confidence: true } : {}), ...(s.headless_fidelity ? { headless_fidelity: s.headless_fidelity } : {}) },
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
        properties: { profileDigest: report.profile_digest, headline: report.headline, ...(surfaceOf ? { remediation: remediation(manifest, report, surfaceOf) } : {}), ...(classOf ? { by_asi: asiBreakdown(report, classOf) } : {}) },
      },
    ],
  };
}
