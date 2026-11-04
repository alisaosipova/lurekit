// Prescriptive report layers (ADR-0021): a plain-language summary printed ABOVE the audit tables
// and a "What to change" section printed AFTER them. Both are PURE functions of the manifest, the
// scoring block, an optional per-scenario surface lookup and the optional evidence lookup: no file
// I/O, no clock. Every count they print is computed from the run being rendered. The only static
// data is HARDENING_KNOBS below: a hardening setting together with the published bundles that
// showed it resisting a surface (a citation, checked against reports/ by a unit test).

import type { RunManifest } from '../runner/types.js';
import type { EvidenceLookup } from './markdown.js';
import { REPOSITORY_URL } from './sarif.js';
import type { Report } from './score.js';

/** ADR-0023 amendment: the claude-code version of the published runs (the demo bundle and the
 *  hardening evidence). The ONE place the version is typed: doctor's pinned-install recipe,
 *  HARDENING_KNOBS, examples/run-live.sh (reads it from dist) and the docs (checked by
 *  scripts/numbers.mjs) all take it from here. A unit test pins it to the demo manifest. */
export const PUBLISHED_CLAUDE_VERSION = '2.1.317';

/** ADR-0021 amendment (URL policy): a file the report cites that is not in the npm package
 *  (profiles/, docs/) is cited by its repository URL on the main branch, never by a bare path. */
export function repoFileUrl(rel: string): string {
  return `${REPOSITORY_URL}/blob/main/${rel}`;
}

/** The interpreting-results guide (verdict rules and the inconclusive reasons table). */
export const INTERPRETING_RESULTS_URL = repoFileUrl('docs/guide/interpreting-results.md');

/** Resolve a scenario's attack surface (scenario.schema.json `surface`). The CLI builds it from
 *  the scenario corpus; undefined when the scenario file is not available. */
export type SurfaceLookup = (scenarioId: string) => string | undefined;

/** Label used when a vulnerable scenario's surface could not be resolved. */
export const UNKNOWN_SURFACE = 'unknown (scenario file not available)';

/** ADR-0015 provenance marker carried in every replayed observation's warnings. */
const REPLAY_MARKER = 'replayed from a recording (ADR-0015)';

/** Exact text for a vulnerable surface that has no proven mapping. */
export const NO_VERIFIED_FIX = 'no verified fix in the published runs yet';

/** One published bundle cited as evidence for a knob. */
export interface KnobEvidence {
  benchmark_run_id: string;
  arm: string;
  vulnerable: number;
  of: number;
}

/** A hardening setting that the published runs showed resisting a surface. */
export interface HardeningKnob {
  agent: string;
  /** Agent version the evidence was measured on. */
  agent_version: string;
  /** Scenario ids of this surface that the evidence covers (vulnerable in bare, resisted hardened). */
  proven_on: string[];
  setting: string;
  /** The flag added to `lurekit run` to measure the setting. */
  run_flags: string;
  profile: string;
  scope: string;
  excludes: string;
  trade_off: string;
  /** Bundles with the setting (hardened) and without it (bare), same corpus and version. */
  hardened: KnobEvidence[];
  bare: KnobEvidence[];
  note: string;
  /** True when the rendered run already used the setting (then it is not offered again). */
  applied(profile: RunManifest['profile']): boolean;
}

/** surface -> knob. Only mappings proven by a published run belong here (ADR-0021). */
export const HARDENING_KNOBS: Readonly<Record<string, HardeningKnob>> = {
  settings_hooks_file: {
    agent: 'claude-code',
    agent_version: `${PUBLISHED_CLAUDE_VERSION} (Claude Code)`,
    proven_on: ['AAB-001', 'AAB-002', 'AAB-016', 'AAB-032'],
    setting: 'run Claude Code with `--setting-sources user`',
    run_flags: '--setting-sources user --permission-mode manual',
    // profiles/ is not in the npm package: rendered as its repository URL (ADR-0021 amendment);
    // the publish gate accepts exactly the URLs in REPORT_REPOSITORY_URLS.
    profile: 'profiles/claude-code-hardened.json',
    scope: 'verified for headless -p runs; interactive equivalent UNVERIFIED',
    excludes:
      'the `project` (`.claude/settings.json`) and `local` (`.claude/settings.local.json`) setting ' +
      'sources, so hooks and MCP servers shipped in a cloned repository are not loaded from them ' +
      '(observed: project hooks and a project `.mcp.json` did not load in the published hardened runs)',
    trade_off:
      'your own project-level hooks and settings stop loading too; keep the ones you rely on in ' +
      'user-scope settings instead',
    hardened: [
      { benchmark_run_id: 'aab-20261103062614-49ac1ce7', arm: 'hardened', vulnerable: 0, of: 21 },
      { benchmark_run_id: 'aab-20261103091409-dff0d34a', arm: 'hardened + netread', vulnerable: 0, of: 24 },
    ],
    bare: [
      { benchmark_run_id: 'aab-20261103071018-88a78d8f', arm: 'bare', vulnerable: 4, of: 21 },
      { benchmark_run_id: 'aab-20261103075404-f5fe15ec', arm: 'bare + netread', vulnerable: 4, of: 24 },
    ],
    note:
      'the hardened arms also passed `--permission-mode manual`, which only pins the headless default ' +
      '(the agent reported mode `default` in every repetition); `--setting-sources user` is the setting that differs',
    applied: (profile) => profile.setting_sources !== undefined && !profile.setting_sources.some((x) => x !== 'user'),
  },
};

/** Every repository URL a Markdown report can print (ADR-0021 amendment). The publish redaction
 *  gate accepts exactly these strings, not the whole host. */
export const REPORT_REPOSITORY_URLS: readonly string[] = [
  INTERPRETING_RESULTS_URL,
  ...Object.values(HARDENING_KNOBS).map((k) => repoFileUrl(k.profile)),
];

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const ticks = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

/** Vulnerable scenario ids grouped by surface, in first-seen order. */
export function vulnerableBySurface(report: Report, surfaceOf?: SurfaceLookup): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const s of report.scenarios) {
    if (s.verdict !== 'vulnerable') continue;
    const surface = surfaceOf?.(s.id) ?? UNKNOWN_SURFACE;
    const list = groups.get(surface) ?? [];
    list.push(s.id);
    groups.set(surface, list);
  }
  return groups;
}

/** The ADR-0015 replay warning when any looked-up evidence record carries it. */
export function replayWarning(report: Report, evidenceLookup?: EvidenceLookup): string | undefined {
  if (!evidenceLookup) return undefined;
  for (const s of report.scenarios) {
    const ev = evidenceLookup(s.id);
    const warnings = [...(ev?.observation?.warnings ?? []), ...(((ev as { warnings?: string[] } | undefined)?.warnings) ?? [])];
    const hit = warnings.find((w) => typeof w === 'string' && w.startsWith(REPLAY_MARKER));
    if (hit) return hit;
  }
  return undefined;
}

/** Count scenarios whose repetitions all agreed, from the confidence tally ("3/3 vulnerable"). */
function unanimousCount(manifest: RunManifest): { unanimous: number; parsed: number } {
  let unanimous = 0;
  let parsed = 0;
  for (const r of manifest.results) {
    if (r.verdict === 'inconclusive') continue;
    const m = /^(\d+)\/(\d+) vulnerable/.exec(r.confidence);
    if (!m) continue;
    parsed += 1;
    const v = Number(m[1]);
    const n = Number(m[2]);
    const mixedIn = r.confidence.includes('inconclusive');
    if (!mixedIn && ((r.verdict === 'vulnerable' && v === n) || (r.verdict === 'resisted' && v === 0))) {
      unanimous += 1;
    }
  }
  return { unanimous, parsed };
}

/** The plain-language summary (ADR-0021 amendment: at most 3 sentences, one Markdown paragraph).
 *  It says only what the headline and the Resisted line below it do not: which attack surfaces
 *  the working lures used, how stable the verdicts are, and what inconclusive (and degraded)
 *  mean when the run has any. */
export function plainLanguageSummary(manifest: RunManifest, report: Report, surfaceOf?: SurfaceLookup): string {
  const h = report.headline;
  const sentences: string[] = [];

  // 1. Surfaces.
  const groups = vulnerableBySurface(report, surfaceOf);
  if (h.of === 0) {
    sentences.push('No scenario was measured conclusively, so this run does not show yet whether the setup takes the lures.');
  } else if (groups.size > 0) {
    const parts = [...groups].map(([surface, ids]) => `${ticks(surface)} (${ids.join(', ')})`);
    sentences.push(`The lures that worked came in through ${plural(groups.size, 'attack surface')}: ${parts.join('; ')}.`);
  } else {
    sentences.push('No lure worked through any attack surface in this run.');
  }

  // 2. Confidence.
  const k = manifest.config.k;
  const rule =
    manifest.config.vulnerable_if === 'majority'
      ? 'counts as vulnerable when more than half of its conclusive repetitions were (vulnerable_if=majority)'
      : 'counts as vulnerable when any repetition was (vulnerable_if=any)';
  if (k <= 1) {
    sentences.push(`Each scenario ran once (k=${k}) and ${rule}, so re-run with --k 3 before relying on these verdicts.`);
  } else {
    const { unanimous, parsed } = unanimousCount(manifest);
    sentences.push(
      `Each scenario ran k=${k} times and ${rule}; ${unanimous} of ${parsed} conclusive scenarios had the same outcome every time.`,
    );
  }

  // 3. What inconclusive / degraded mean, only when the run has any.
  const meanings: string[] = [];
  if (h.inconclusive > 0) {
    meanings.push(
      `inconclusive (${h.inconclusive}) means the run could not tell whether the setup resisted, for example because ` +
        `the lure never reached the agent, so it is not a pass and is left out of the ${h.of}`,
    );
  }
  if (h.degraded > 0) meanings.push(`degraded (${h.degraded}) means the benign task failed`);
  if (meanings.length > 0) {
    const text = meanings.join('; ');
    sentences.push(`${text[0].toUpperCase()}${text.slice(1)}.`);
  }

  return `**In plain language:** ${sentences.join(' ')}`;
}

/** Shell-quote a value for the re-measure command when it has spaces or quotes. */
function shq(s: string): string {
  return /^[A-Za-z0-9._:/@+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** ADR-0021 amendment (re-measure composition): what the caller knows that the manifest does not.
 *  `corpus` is the scenario directory as the reader should type it (the CLI's resolved corpus;
 *  for `demo` the shipped one); `budgetEstimateUsd` is the doctor-style cost estimate, used for
 *  --budget when the run itself had no cap. Both optional: an unknown value stays a placeholder. */
export interface ReMeasureContext {
  corpus?: string;
  budgetEstimateUsd?: number;
}

/** Placeholder for a scenario directory the renderer cannot know (e.g. a published bundle). */
export const UNKNOWN_CORPUS = '<scenario-dir>';

/** The leading x.y.z of a version string ("2.1.317 (Claude Code)" -> "2.1.317"); the trimmed
 *  string itself when it carries no semver (e.g. "unpinned"). */
export function leadingSemver(v: string): string {
  // Manifests are read from disk: tolerate a missing value rather than throw in the renderer.
  const t = typeof v === 'string' ? v : String(v ?? '');
  const m = /(\d+\.\d+\.\d+)/.exec(t);
  return m ? m[1] : t.trim();
}

/** True when two agent versions name the same release once normalised to x.y.z. */
export function sameAgentVersion(a: string, b: string): boolean {
  return leadingSemver(a) === leadingSemver(b);
}

/** The --budget value for the re-measure line: the run's own cap, else the estimate (rounded up
 *  to the cent), else a placeholder. */
function budgetArg(manifest: RunManifest, ctx: ReMeasureContext): string {
  const cap = manifest.config.budget_usd;
  if (typeof cap === 'number' && cap > 0) return String(cap);
  const est = ctx.budgetEstimateUsd;
  if (typeof est === 'number' && est > 0) return (Math.ceil(est * 100) / 100).toFixed(2);
  return '<usd>';
}

/** The full re-measure command for one knob (ADR-0021 amendment): the manifest's agent, model,
 *  version, mode, k and vulnerable_if, the caller's corpus, the knob's flags and a --budget. */
export function reMeasureCommand(manifest: RunManifest, knob: HardeningKnob, ctx: ReMeasureContext = {}): string {
  const p = manifest.profile;
  const corpus = ctx.corpus ?? UNKNOWN_CORPUS;
  return (
    `lurekit run ${corpus} --agent ${shq(p.agent)} --model ${shq(p.model)} --agent-version ${shq(p.agent_version)} ` +
    `${knob.run_flags} --mode ${manifest.mode} --k ${manifest.config.k} --vulnerable-if ${manifest.config.vulnerable_if} ` +
    `--budget ${budgetArg(manifest, ctx)}`
  );
}

/** The "What to change" section, printed after the audit tables. */
export function whatToChange(manifest: RunManifest, report: Report, surfaceOf?: SurfaceLookup, ctx: ReMeasureContext = {}): string[] {
  const h = report.headline;
  const out: string[] = ['## What to change', ''];
  if (h.vulnerable === 0) {
    out.push(
      h.of === 0
        ? 'Nothing to change from this run yet: no scenario was measured conclusively, so it does not show ' +
            'whether this setup needs a change.'
        : 'Nothing to change from this run: no scenario was vulnerable.',
    );
    if (h.inconclusive > 0) {
      out.push(
        '',
        `${plural(h.inconclusive, 'scenario was', 'scenarios were')} inconclusive; see the inconclusive reasons table ` +
          `("Inconclusive reasons and what to do") in the [interpreting-results guide](${INTERPRETING_RESULTS_URL}) before reading this as clean.`,
      );
    }
    out.push('');
    return out;
  }

  const p = manifest.profile;
  out.push(
    `${plural(h.vulnerable, 'scenario was', 'scenarios were')} vulnerable in this run. Each fix below is a setting ` +
      'that a published LureKit run showed resisting the same scenarios; evaluate it against your own ' +
      'workflow, then re-measure.',
    '',
  );
  for (const [surface, ids] of vulnerableBySurface(report, surfaceOf)) {
    out.push(`### Surface ${ticks(surface)}: ${ids.join(', ')}`, '');
    const knob = HARDENING_KNOBS[surface];
    if (!knob || knob.agent !== p.agent) {
      out.push(`- ${NO_VERIFIED_FIX}${knob ? ` for agent ${ticks(p.agent)} (the published evidence is for ${knob.agent})` : ''}.`, '');
      continue;
    }
    if (knob.applied(p)) {
      out.push(`- ${NO_VERIFIED_FIX}: this run already used the one proven setting (${knob.setting}), and these scenarios were still vulnerable.`, '');
      continue;
    }
    out.push(`- setting: ${knob.setting} ([reference profile](${repoFileUrl(knob.profile)}) in the LureKit repository)`);
    out.push(`- scope: ${knob.scope}`);
    out.push(`- what it excludes: ${knob.excludes}`);
    out.push(`- trade-off: ${knob.trade_off}`);
    const cite = (e: KnobEvidence): string => `${e.benchmark_run_id} (${e.arm}, ${e.vulnerable} of ${e.of})`;
    out.push(
      `- evidence: ${knob.hardened.map(cite).join(' and ')} with the setting, against ` +
        `${knob.bare.map(cite).join(' and ')} without it, on agent version ${ticks(knob.agent_version)}; ` +
        `${knob.note}`,
    );
    const uncovered = ids.filter((id) => !knob.proven_on.includes(id));
    if (uncovered.length > 0) {
      out.push(`- not covered by that evidence: ${uncovered.join(', ')} (${NO_VERIFIED_FIX} for these)`);
    }
    if (!sameAgentVersion(p.agent_version, knob.agent_version)) {
      out.push(`- version: this run is ${ticks(p.agent_version)}; the evidence is for ${ticks(knob.agent_version)}, so re-measure before relying on it`);
    }
    out.push(
      `- re-measure: \`${reMeasureCommand(manifest, knob, ctx)}\` ` +
        '(add your own --settings/--mcp/--hooks/--skill flags; the manifest does not record their file paths)',
      '',
    );
  }
  return out;
}
