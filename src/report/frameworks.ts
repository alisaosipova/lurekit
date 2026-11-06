// Results by OWASP Top 10 for Agentic Applications (ADR-0021 amendment UB-1). PURE: the scoring
// block plus a class lookup from the corpus; names from docs/research/landscape.md (source:
// https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/, CC BY-SA 4.0).

import type { Report } from './score.js';

export const ASI_NAMES: Readonly<Record<string, string>> = {
  ASI01: 'Agent Goal Hijack',
  ASI02: 'Tool Misuse and Exploitation',
  ASI03: 'Identity and Privilege Abuse',
  ASI04: 'Agentic Supply Chain Vulnerabilities',
  ASI05: 'Unexpected Code Execution',
  ASI06: 'Memory and Context Poisoning',
  ASI07: 'Insecure Inter-Agent Communication',
  ASI08: 'Cascading Failures',
  ASI09: 'Human-Agent Trust Exploitation',
  ASI10: 'Rogue Agents',
};

/** The ASI classes of a scenario id (from the corpus), empty when unknown. */
export type ClassLookup = (scenarioId: string) => readonly string[];

export interface AsiRow {
  id: string;
  name: string;
  measured: number;
  vulnerable: number;
  resisted: number;
  degraded: number;
  inconclusive: number;
  scenarios: string[];
}

export function asiBreakdown(report: Report, classOf: ClassLookup): AsiRow[] {
  const rows = new Map<string, AsiRow>();
  for (const s of report.scenarios) {
    for (const asi of new Set(classOf(s.id))) {
      const r = rows.get(asi) ?? { id: asi, name: ASI_NAMES[asi] ?? '', measured: 0, vulnerable: 0, resisted: 0, degraded: 0, inconclusive: 0, scenarios: [] };
      r.measured += 1;
      r[s.verdict] += 1;
      r.scenarios.push(s.id);
      rows.set(asi, r);
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}
