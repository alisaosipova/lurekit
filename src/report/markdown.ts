// Markdown report (evidence-spec §6.1, human / blog-ready). A PURE function of the data handed
// to it: the manifest, the scoring block, and an injected `evidenceLookup`. It performs NO file
// I/O — the CLI supplies the lookup that reads evidence.json, so the renderer stays pure and
// deterministic. No secrets appear: scenarios touch only canaries, and the per-vulnerable
// excerpt prints the detector kind and a single tool-call NAME (never tool arguments, which is
// where a value could ride), plus the relative evidence pointer.

import type { EvidenceRecord } from '../runner/types.js';
import type { RunManifest } from '../runner/types.js';
import type { Report } from './score.js';

/** Resolve the evidence record for a scenario (the CLI reads it from disk). Pure data in. */
export type EvidenceLookup = (scenarioId: string) => EvidenceRecord | undefined;

const EOL = /\r\n?|\n/g;
/** One line, control characters stripped, pipes escaped so a cell cannot break the table. */
const cell = (s: string): string => s.replace(EOL, ' ').replace(/[\p{Cc}]/gu, ' ').replace(/\|/g, '\\|');

export function renderMarkdown(
  manifest: RunManifest,
  report: Report,
  evidenceLookup?: EvidenceLookup,
): string {
  const h = report.headline;
  const byId = new Map(manifest.results.map((r) => [r.scenario_id, r]));
  const out: string[] = [];

  out.push(`# agent-attack-bench report: ${cell(manifest.profile.agent)} ${cell(manifest.profile.agent_version)}`, '');
  // Headline line (§6.1): "vulnerable to N of M scenarios".
  out.push(`**Vulnerable to ${h.vulnerable} of ${h.of} scenarios** (degraded: ${h.degraded}, inconclusive: ${h.inconclusive}).`, '');
  out.push(`- model: ${cell(manifest.profile.model)}`);
  out.push(`- profile digest: \`${cell(report.profile_digest)}\``);
  out.push(`- benchmark run: ${cell(manifest.benchmark_run_id)}`);
  out.push('');

  // Table: id | name | verdict | confidence | source.
  out.push('| id | name | verdict | confidence | source |');
  out.push('|---|---|---|---|---|');
  for (const s of report.scenarios) {
    const name = byId.get(s.id)?.name ?? '';
    out.push(`| ${cell(s.id)} | ${cell(name)} | ${cell(s.verdict)} | ${cell(s.confidence)} | ${cell(s.source)} |`);
  }
  out.push('');

  // Per-vulnerable block with a SHORT evidence excerpt (detector kind + one tool-call line).
  const vulnerable = report.scenarios.filter((s) => s.verdict === 'vulnerable');
  if (vulnerable.length > 0) {
    out.push('## Vulnerable scenarios', '');
    for (const s of vulnerable) {
      const name = byId.get(s.id)?.name ?? '';
      out.push(`### ${cell(s.id)} — ${cell(name)}`, '');
      out.push(`- source: ${cell(s.source)}`);
      out.push(`- evidence: \`${cell(s.evidence_ref)}\``);
      const ev = evidenceLookup?.(s.id);
      if (ev) {
        const hit = ev.detector_hits[0];
        const detector = hit?.detector ?? ev.forbidden_effect.detector;
        out.push(`- detector: \`${cell(detector)}\``);
        const call = hit?.attributed_tool_call ?? ev.observation?.tool_calls?.[0];
        if (call) out.push(`- tool call: \`${cell(call.name)}\` (+${call.at}ms)`);
      }
      out.push('');
    }
  }

  out.push(`_${cell(report.scoring_notes)}_`, '');
  return out.join('\n');
}
