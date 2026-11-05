// `lurekit diff` (ADR-0026): per-scenario verdict transitions between two run manifests. PURE:
// the inputs are two parsed manifests; no evidence, no agent, no clock.

import type { RunManifest, RunOutcome } from '../runner/types.js';

export type Transition = 'same' | 'regressed' | 'improved' | 'changed' | 'only in A' | 'only in B';

export interface DiffRow {
  id: string;
  a?: RunOutcome;
  b?: RunOutcome;
  transition: Transition;
}

export interface RunDiff {
  a: string;
  b: string;
  notes: string[];
  rows: DiffRow[];
  counts: Record<Transition, number>;
}

/** Order of badness (ADR-0026): resisted < degraded = inconclusive < vulnerable. */
const RANK: Record<RunOutcome, number> = { resisted: 0, degraded: 1, inconclusive: 1, vulnerable: 2 };

export function transition(a: RunOutcome | undefined, b: RunOutcome | undefined): Transition {
  if (a === undefined) return 'only in B';
  if (b === undefined) return 'only in A';
  if (a === b) return 'same';
  if (RANK[b] > RANK[a]) return 'regressed';
  if (RANK[b] < RANK[a]) return 'improved';
  return 'changed';
}

/** Like-for-like notes: conditions that differ between the two runs. */
function likeForLike(a: RunManifest, b: RunManifest): string[] {
  const notes: string[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ['k', a.config?.k, b.config?.k],
    ['vulnerable_if', a.config?.vulnerable_if, b.config?.vulnerable_if],
    ['mode', a.mode, b.mode],
    ['corpus digest', a.corpus?.corpus_digest, b.corpus?.corpus_digest],
    ['scenario filter', JSON.stringify(a.config?.scenario_filter ?? null), JSON.stringify(b.config?.scenario_filter ?? null)],
  ];
  for (const [name, x, y] of pairs) if (x !== y) notes.push(`${name} differ (${String(x)} vs ${String(y)})`);
  return notes;
}

export function diffRuns(a: RunManifest, b: RunManifest): RunDiff {
  const va = new Map(a.results.map((r) => [r.scenario_id, r.verdict]));
  const vb = new Map(b.results.map((r) => [r.scenario_id, r.verdict]));
  const ids = [...new Set([...va.keys(), ...vb.keys()])].sort((x, y) => x.localeCompare(y));
  const counts = { same: 0, regressed: 0, improved: 0, changed: 0, 'only in A': 0, 'only in B': 0 } as Record<Transition, number>;
  const rows = ids.map((id) => {
    const t = transition(va.get(id), vb.get(id));
    counts[t] += 1;
    return { id, ...(va.has(id) ? { a: va.get(id) } : {}), ...(vb.has(id) ? { b: vb.get(id) } : {}), transition: t };
  });
  return { a: a.benchmark_run_id, b: b.benchmark_run_id, notes: likeForLike(a, b), rows, counts };
}

export function renderDiffText(d: RunDiff): string {
  const w = Math.max(2, ...d.rows.map((r) => r.id.length));
  const col = (s: string | undefined, n: number): string => (s ?? '-').padEnd(n);
  const lines = [`diff ${d.a} -> ${d.b}`, '', `${'id'.padEnd(w)}  ${'A'.padEnd(12)}  ${'B'.padEnd(12)}  transition`];
  for (const r of d.rows) lines.push(`${r.id.padEnd(w)}  ${col(r.a, 12)}  ${col(r.b, 12)}  ${r.transition}`);
  const summary = (Object.entries(d.counts) as Array<[Transition, number]>).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(', ');
  lines.push('', `summary: ${summary || 'no scenarios'}`);
  return lines.join('\n') + '\n';
}
