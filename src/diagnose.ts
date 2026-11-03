// Post-run diagnosis for `lurekit run` (ADR-0022): turn the warnings of repetitions that did not
// measure anything into "what happened" plus "the next command". Pure: the CLI reads the
// evidence records and passes the warnings in; nothing here touches the disk or the clock.
//
// The patterns match texts recorded by the adapters and the runner (NOTES "Verified on the
// installed binary", src/adapters/*.ts). A repetition is put in the FIRST matching category in
// CATEGORY_ORDER, so a run that failed to launch is never also reported as an auth problem.

import type { AgentId } from './scenario/types.js';
import { agentInfo } from './doctor.js';

export type IssueCategory = 'budget' | 'binary' | 'permission' | 'auth' | 'network' | 'model' | 'adapter';

export interface RepIssue {
  scenario_id: string;
  repetition: number;
  outcome: string;
  inconclusive_reason?: string;
  warnings: string[];
  evidence_path?: string;
}

export interface Diagnosis {
  category: IssueCategory;
  count: number;
  /** One recorded warning that put a repetition in this category (capped). */
  example: string;
  what: string;
  next: string;
  evidence_path?: string;
}

const PATTERNS: Array<[Exclude<IssueCategory, 'budget' | 'adapter'>, RegExp]> = [
  ['binary', /not found or not executable|failed to spawn agent binary|\bENOENT\b|\bEACCES\b/],
  ['permission', /permission_mode: always-approve|permission_mode "[^"]*" is not available|unknown permission_mode token/],
  [
    'auth',
    /authentication (failed|required)|\b401 Unauthorized\b|not logged in|invalid api key|please run \/login|LLM_API_KEY is not set|Missing required environment variable|CODEX_API_KEY is not set/i,
  ],
  [
    'network',
    /failed to lookup address|waiting for network|\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|getaddrinfo|Connection failed|network is unreachable|fetch failed/i,
  ],
  ['model', /Model metadata for .* not found|unknown model|invalid model|model_not_found|\bmodel\b.*\b(does not exist|not found)/i],
];

export const CATEGORY_ORDER: readonly IssueCategory[] = ['budget', 'binary', 'permission', 'auth', 'network', 'model', 'adapter'];

/** Category of one repetition, or undefined when it measured something / needs no advice. */
export function classifyRep(rep: RepIssue): { category: IssueCategory; example: string } | undefined {
  if (rep.inconclusive_reason === 'budget_exhausted') {
    return { category: 'budget', example: rep.warnings[0] ?? 'budget_exhausted' };
  }
  if (rep.outcome !== 'inconclusive') return undefined;
  for (const [cat, re] of PATTERNS) {
    const hit = rep.warnings.find((w) => re.test(w));
    if (hit !== undefined) return { category: cat, example: hit };
  }
  if (rep.inconclusive_reason === 'adapter_error') {
    // Prefer the warning that says why the run failed over incidental ones (version mismatch).
    const why = rep.warnings.find((w) => /^(adapter run failed|agent exited|result event reports is_error|turn\.failed|error (event|item))/.test(w));
    return { category: 'adapter', example: why ?? rep.warnings[0] ?? 'no warning recorded' };
  }
  return undefined;
}

export interface DiagnoseContext {
  agent: AgentId;
  model: string;
  budgetUsd?: number;
  spentUsd: number;
}

function cap(s: string, n = 240): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}...` : one;
}

function advice(cat: IssueCategory, ctx: DiagnoseContext): { what: string; next: string } {
  const info = agentInfo(ctx.agent);
  const doctor = `lurekit doctor --agent ${ctx.agent}`;
  switch (cat) {
    case 'budget': {
      const b = ctx.budgetUsd ?? 0;
      const higher = Math.max(Math.ceil(b * 2), Math.ceil(ctx.spentUsd + 1));
      return {
        what: `not run: the next repetition could have exceeded --budget ${b} USD (spent ${ctx.spentUsd.toFixed(2)} USD so far); they are inconclusive(budget_exhausted), not passes`,
        next: `re-run with a higher cap, e.g. --budget ${higher}, or narrow the scenario directory`,
      };
    }
    case 'binary':
      return {
        what: `the ${ctx.agent} binary could not be launched`,
        next: `${doctor}   (it prints the path it looked for; fix: ${info.install}, or export ${info.envVar}=<absolute path>)`,
      };
    case 'permission':
      return {
        what: 'the adapter refused the profile before launching the agent',
        next: 'add --permission-mode always-approve (openhands headless cannot run any other way), then re-run',
      };
    case 'auth':
      return {
        what: `${ctx.agent} is not authenticated for this run`,
        next: `${info.login}, then ${doctor}`,
      };
    case 'network':
      return {
        what: `${ctx.agent} could not reach its model API (network or DNS failure)`,
        next: `check the network or proxy the agent uses, then ${doctor} and re-run`,
      };
    case 'model':
      return {
        what: `the model id "${ctx.model}" is not one ${ctx.agent} knows`,
        next: `re-run with a model id the agent accepts${ctx.agent === 'claude-code' ? ' (e.g. --model sonnet)' : ''}; ${doctor} --model <id> shows what is checked`,
      };
    case 'adapter':
    default:
      return {
        what: 'the adapter failed before the run could be scored (inconclusive(adapter_error))',
        next: `${doctor}; the full warning list is in the evidence file`,
      };
  }
}

/** Group the non-measuring repetitions by category, in CATEGORY_ORDER. */
export function diagnoseRun(reps: RepIssue[], ctx: DiagnoseContext): Diagnosis[] {
  const groups = new Map<IssueCategory, { count: number; example: string; evidence_path?: string }>();
  for (const rep of reps) {
    const c = classifyRep(rep);
    if (!c) continue;
    const g = groups.get(c.category);
    if (g) g.count += 1;
    else groups.set(c.category, { count: 1, example: cap(c.example), evidence_path: rep.evidence_path });
  }
  const out: Diagnosis[] = [];
  for (const cat of CATEGORY_ORDER) {
    const g = groups.get(cat);
    if (!g) continue;
    out.push({ category: cat, count: g.count, example: g.example, ...advice(cat, ctx), ...(g.evidence_path ? { evidence_path: g.evidence_path } : {}) });
  }
  return out;
}

/** True when nothing was measured and at least one repetition failed for a setup reason, so
 *  `run` exits 1 instead of 0 (a newcomer's script must not read it as a clean run). */
export function nothingMeasured(reps: RepIssue[], diagnoses: Diagnosis[]): boolean {
  const measured = reps.some((r) => r.outcome !== 'inconclusive');
  return !measured && diagnoses.some((d) => d.category !== 'budget');
}

export function renderDiagnosis(diagnoses: Diagnosis[]): string {
  if (diagnoses.length === 0) return '';
  const lines = ['', 'what went wrong:'];
  for (const d of diagnoses) {
    lines.push(`- ${d.count} repetition(s): ${d.what}.`);
    lines.push(`  recorded: ${d.example}`);
    if (d.evidence_path) lines.push(`  evidence: ${d.evidence_path}`);
    lines.push(`  next: ${d.next}`);
  }
  return lines.join('\n') + '\n';
}
