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

/** Marker appended to a verdict whose runs did not have full MCP isolation (evidence-spec §4.3). */
export const PARTIAL_MARKER = '[isolation: partial]';
const PARTIAL_NOTE =
  `${PARTIAL_MARKER}: --strict-mcp-config was not in effect for at least one run (e.g. the ` +
  'scenario measures project .mcp.json auto-load), so MCP servers from the operator\'s own ' +
  'config may have been visible to the agent; see the evidence warnings';

/** §3.1/§6.1: label shown next to a resisted verdict. */
export const RESISTED_KIND_LABEL: Record<string, string> = {
  not_attempted: '(not attempted)',
  denied: '(denied)',
};

function verdictCell(verdict: string, isolation: string | undefined, resistedKind?: string): string {
  let v = verdict;
  if (verdict === 'resisted' && resistedKind && RESISTED_KIND_LABEL[resistedKind]) {
    v = `${v} ${RESISTED_KIND_LABEL[resistedKind]}`;
  }
  return isolation === 'partial' ? `${v} ${PARTIAL_MARKER}` : v;
}

export function renderMarkdown(
  manifest: RunManifest,
  report: Report,
  evidenceLookup?: EvidenceLookup,
): string {
  const h = report.headline;
  const byId = new Map(manifest.results.map((r) => [r.scenario_id, r]));
  const out: string[] = [];

  out.push(`# LureKit report: ${cell(manifest.profile.agent)} ${cell(manifest.profile.agent_version)}`, '');
  // Headline line (§6.1): "vulnerable to N of M scenarios".
  out.push(`**Vulnerable to ${h.vulnerable} of ${h.of} scenarios** (degraded: ${h.degraded}, inconclusive: ${h.inconclusive}).`, '');
  // §6.2: resisted split (§3.1) — the model declined vs the setup denied an attempted action.
  if (report.resisted && report.resisted.not_attempted + report.resisted.denied > 0) {
    out.push(
      `Resisted: ${report.resisted.not_attempted} not attempted, ${report.resisted.denied} denied ` +
        '(the agent attempted the forbidden action and the setup blocked it).',
      '',
    );
  }
  out.push(`- model: ${cell(manifest.profile.model)}`);
  out.push(`- profile digest: \`${cell(report.profile_digest)}\``);
  out.push(`- benchmark run: ${cell(manifest.benchmark_run_id)}`);
  out.push('');

  // Table: id | name | verdict | confidence | source.
  out.push('| id | name | verdict | confidence | source |');
  out.push('|---|---|---|---|---|');
  for (const s of report.scenarios) {
    const name = byId.get(s.id)?.name ?? '';
    out.push(`| ${cell(s.id)} | ${cell(name)} | ${cell(verdictCell(s.verdict, s.isolation, s.resisted_kind))} | ${cell(s.confidence)} | ${cell(s.source)} |`);
  }
  out.push('');
  if (report.scenarios.some((s) => s.isolation === 'partial')) {
    out.push(`_${PARTIAL_NOTE}_`, '');
  }

  // Per-vulnerable block with a SHORT evidence excerpt (detector kind + one tool-call line).
  const vulnerable = report.scenarios.filter((s) => s.verdict === 'vulnerable');
  if (vulnerable.length > 0) {
    out.push('## Vulnerable scenarios', '');
    for (const s of vulnerable) {
      const name = byId.get(s.id)?.name ?? '';
      out.push(`### ${cell(s.id)} — ${cell(name)}`, '');
      out.push(`- source: ${cell(s.source)}`);
      if (s.isolation === 'partial') out.push(`- isolation: partial ${PARTIAL_MARKER}`);
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
