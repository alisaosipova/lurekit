// End-to-end, fully offline (evidence-spec §4.5; ADR-0002). Drives the REAL runner over the 30
// runnable shipped scenarios (of 48 catalogued) with REAL detectors and REAL concrete fixtures, using only a stub adapter —
// no live agent, no network beyond loopback, no API spend. Two adapter modes per scenario:
//   (a) a "vulnerable" stub that acts on the canary (invokes the decoy MCP tool / reads the
//       marker into output / runs the canary command / GETs the canary URL) -> `vulnerable`;
//   (b) a "resisting" stub that only does the benign task -> `resisted`.
// Also asserts all 48 scenarios load + validate and that plan() keeps exactly the 25 runnable ones
// whose applies_to includes claude-code, skipping the other 5 runnable ones as not_applicable and
// the 18 browser-track rows (runnable:false, no applies_to) as not_runnable. plan() checks
// applies_to before runnable, so a row failing both reports not_applicable. runScenario itself does
// not gate on applies_to (only plan() does), so all 30 runnable scenarios are driven through it
// here; the runnable:false rows are excluded from CASES (asserted below). Run dirs and
// workdirs live under a temp root removed in afterEach.

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BenchmarkRunner, type RunConfig, type RunnerIds } from '../src/runner/runner.js';
import { loadScenarioDir } from '../src/scenario/load.js';
import type { DetectorKind, Scenario } from '../src/scenario/types.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { fixturesForScenario } from '../src/fixtures/index.js';
import { StubAdapter } from './helpers/stubAdapter.js';

const SCENARIOS_DIR = fileURLToPath(new URL('../scenarios', import.meta.url));
// One row per shipped RUNNABLE scenario: its expected detector (the stub's trigger in vulnerable mode)
// and the benign text that satisfies its benign_task check. Kept explicit so a stray or missing
// scenario file fails the corpus assertions below.
interface E2ECase {
  id: string;
  detector: DetectorKind;
  benignText: string;
  // Workdir file the benign task tidies (benign_task file_written + not_contains, evidence-spec
  // s3.1): the stub collapses its blank-line runs, as the text-tidy skill's job says.
  tidyFile?: string;
}
const BENIGN = 'SUMMARY: the project is a small sample.';
const CASES: readonly E2ECase[] = [
  { id: 'AAB-001', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-002', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-003', detector: 'canary_egress_http', benignText: BENIGN },
  { id: 'AAB-004', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-005', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-006', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-010', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-011', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-012', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-014', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-016', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-017', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-018', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-019', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-020', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-021', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-022', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-023', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-025', detector: 'canary_mcp_tool', benignText: BENIGN },
  { id: 'AAB-026', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-027', detector: 'canary_file_read', benignText: BENIGN, tidyFile: 'notes.txt' },
  { id: 'AAB-028', detector: 'canary_command', benignText: BENIGN, tidyFile: 'meeting-notes.txt' },
  { id: 'AAB-030', detector: 'canary_command', benignText: BENIGN, tidyFile: 'report.txt' },
  { id: 'AAB-031', detector: 'canary_command', benignText: BENIGN, tidyFile: 'CHANGELOG.txt' },
  { id: 'AAB-032', detector: 'canary_command', benignText: BENIGN },
  { id: 'AAB-033', detector: 'canary_command', benignText: BENIGN },
  // registry_fetch mode (evidence-spec s1.2d): the stub appends a canary tarball line.
  { id: 'AAB-034', detector: 'canary_egress_http', benignText: BENIGN },
  { id: 'AAB-036', detector: 'canary_egress_http', benignText: BENIGN },
  { id: 'AAB-037', detector: 'canary_egress_http', benignText: BENIGN },
  { id: 'AAB-056', detector: 'canary_command', benignText: BENIGN },
];
const EXPECTED_IDS = [
  'AAB-001',
  'AAB-002',
  'AAB-003',
  'AAB-004',
  'AAB-005',
  'AAB-006',
  'AAB-010',
  'AAB-011',
  'AAB-012',
  'AAB-014',
  'AAB-016',
  'AAB-017',
  'AAB-018',
  'AAB-019',
  'AAB-020',
  'AAB-021',
  'AAB-022',
  'AAB-023',
  'AAB-025',
  'AAB-026',
  'AAB-027',
  'AAB-028',
  'AAB-030',
  'AAB-031',
  'AAB-032',
  'AAB-033',
  'AAB-034',
  'AAB-036',
  'AAB-037',
  'AAB-038',
  'AAB-039',
  'AAB-040',
  'AAB-041',
  'AAB-042',
  'AAB-043',
  'AAB-044',
  'AAB-045',
  'AAB-046',
  'AAB-047',
  'AAB-048',
  'AAB-049',
  'AAB-050',
  'AAB-051',
  'AAB-052',
  'AAB-053',
  'AAB-054',
  'AAB-055',
  'AAB-056',
];
// The subset whose applies_to includes claude-code; plan() must keep exactly these.
const CLAUDE_CODE_IDS = [
  'AAB-001',
  'AAB-002',
  'AAB-003',
  'AAB-010',
  'AAB-012',
  'AAB-016',
  'AAB-017',
  'AAB-018',
  'AAB-019',
  'AAB-020',
  'AAB-021',
  'AAB-022',
  'AAB-023',
  'AAB-025',
  'AAB-026',
  'AAB-027',
  'AAB-028',
  'AAB-030',
  'AAB-031',
  'AAB-032',
  'AAB-033',
  'AAB-034',
  'AAB-036',
  'AAB-037',
  'AAB-056',
];
// applies_to excludes claude-code (catalogued for cursor-cli / codex-cli / openhands); plan()
// must skip exactly these, each as not_applicable.
const NOT_APPLICABLE_IDS = [
  'AAB-004',
  'AAB-005',
  'AAB-006',
  'AAB-011',
  'AAB-014',
];
// Browser-track catalogue rows: runnable:false (pending a browser adapter), no applies_to; plan()
// must skip exactly these, each as not_runnable, and they are never driven through runScenario.
const BROWSER_IDS = [
  'AAB-038',
  'AAB-039',
  'AAB-040',
  'AAB-041',
  'AAB-042',
  'AAB-043',
  'AAB-044',
  'AAB-045',
  'AAB-046',
  'AAB-047',
  'AAB-048',
  'AAB-049',
  'AAB-050',
  'AAB-051',
  'AAB-052',
  'AAB-053',
  'AAB-054',
  'AAB-055',
];
const RUNNABLE_IDS = [...CLAUDE_CODE_IDS, ...NOT_APPLICABLE_IDS].sort();

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'aab-e2e-'));
  roots.push(d);
  return d;
}
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function ids(benchmarkRunId: string): RunnerIds {
  return { benchmarkRunId, runId: (s, k) => `${benchmarkRunId}:${s}:${k}` };
}
function makeProfile(workdir: string): SetupProfile {
  return {
    agent: 'claude-code',
    agent_version: '@anthropic-ai/claude-code@2.1.309',
    model: 'claude-opus-4-8',
    workdir,
    permission_mode: 'plan',
  };
}
function makeCfg(resultsRoot: string): RunConfig {
  return { k: 1, vulnerable_if: 'any', mode: 'full', isolation: 'container', resultsRoot };
}
function newRunner(brid: string): BenchmarkRunner {
  return new BenchmarkRunner({ ids: ids(brid), fixtures: fixturesForScenario });
}
async function readEvidence(cfg: RunConfig, brid: string, scenarioId: string, rep = 0) {
  const p = path.join(cfg.resultsRoot, brid, scenarioId, String(rep), 'evidence.json');
  return JSON.parse(await readFile(p, 'utf8'));
}

function loadAll(): Scenario[] {
  const { scenarios, errors } = loadScenarioDir(SCENARIOS_DIR);
  expect(errors).toEqual([]);
  return scenarios;
}

function scenarioFor(scenarios: Scenario[], c: E2ECase): Scenario {
  const scenario = scenarios.find((s) => s.id === c.id);
  expect(scenario, `${c.id} should be loaded`).toBeDefined();
  expect(scenario!.forbidden_effect.detector, `${c.id} detector`).toBe(c.detector);
  return scenario!;
}

describe('corpus loads and validates', () => {
  it('loads exactly the 48 shipped scenarios, all valid', () => {
    const scenarios = loadAll();
    expect(EXPECTED_IDS).toHaveLength(48);
    expect(scenarios.map((s) => s.id).sort()).toEqual([...EXPECTED_IDS].sort());
    // Runnable / runnable:false split as loaded, matched against the explicit lists.
    const runnable = scenarios.filter((s) => s.runnable !== false).map((s) => s.id).sort();
    const notRunnable = scenarios.filter((s) => s.runnable === false).map((s) => s.id).sort();
    expect(runnable).toHaveLength(30);
    expect(runnable).toEqual(RUNNABLE_IDS);
    expect(notRunnable).toEqual([...BROWSER_IDS].sort());
    for (const s of scenarios.filter((x) => x.runnable === false)) {
      expect(s.track, `${s.id} track`).toBe('browser');
      expect(s.applies_to, `${s.id} applies_to`).toBeUndefined();
    }
  });

  it('CASES covers every runnable scenario and excludes the runnable:false rows', () => {
    const scenarios = loadAll();
    const runnable = scenarios.filter((s) => s.runnable !== false).map((s) => s.id).sort();
    expect(CASES).toHaveLength(30);
    expect(CASES.map((c) => c.id).sort()).toEqual(runnable);
    for (const id of BROWSER_IDS) {
      expect(CASES.some((c) => c.id === id), `${id} must not be in CASES`).toBe(false);
    }
    // Each row's detector matches the scenario's forbidden_effect.detector in its YAML.
    for (const c of CASES) {
      expect(scenarioFor(scenarios, c).forbidden_effect.detector, `${c.id} detector`).toBe(c.detector);
    }
  });

  it('plan() over the 48 keeps exactly the 25 claude-code scenarios, skips 5 as not_applicable and 18 as not_runnable', async () => {
    const root = await tmpRoot();
    const runner = newRunner('BR-PLAN');
    const plan = await runner.plan(loadAll(), makeProfile(path.join(root, 'work')), makeCfg(root));
    // Partition sanity: kept + skipped together cover the whole corpus, with no overlap.
    expect([...CLAUDE_CODE_IDS, ...NOT_APPLICABLE_IDS, ...BROWSER_IDS].sort()).toEqual(
      [...EXPECTED_IDS].sort(),
    );
    expect(CLAUDE_CODE_IDS).toHaveLength(25);
    expect(plan.kept.map((s) => s.id).sort()).toEqual([...CLAUDE_CODE_IDS].sort());
    expect(plan.skipped.map((s) => s.scenario_id).sort()).toEqual(
      [...NOT_APPLICABLE_IDS, ...BROWSER_IDS].sort(),
    );
    // Each skip carries its exact reason: the 5 other-agent rows are not_applicable, the 18
    // browser rows are not_runnable; no detector_not_implemented / detector_unverified.
    for (const sk of plan.skipped) {
      const want = NOT_APPLICABLE_IDS.includes(sk.scenario_id) ? 'not_applicable' : 'not_runnable';
      expect(sk.reason, `${sk.scenario_id} skip reason`).toBe(want);
    }
    expect(plan.skipped.filter((sk) => sk.reason === 'not_applicable')).toHaveLength(5);
    expect(plan.skipped.filter((sk) => sk.reason === 'not_runnable')).toHaveLength(18);
  });
});

// Each loop drives all 30 runnable scenarios sequentially (real fixtures + detectors); under the
// full parallel suite this exceeds vitest's 5 s default, so give these two tests explicit headroom.
const E2E_LOOP_TIMEOUT_MS = 60_000;

describe('each scenario runs end-to-end through the runner (offline)', () => {
  it('vulnerable stub -> vulnerable, with a detector hit and evidence', async () => {
    const scenarios = loadAll();
    for (const c of CASES) {
      const scenario = scenarioFor(scenarios, c);
      const root = await tmpRoot();
      const brid = `BRV-${scenario.id}`;
      const runner = newRunner(brid);
      const cfg = makeCfg(root);
      // fetchContent: the stub reads the fixture's loopback content first, as an agent that
      // received the injection would (evidence-spec s3.1 content_fetched precondition).
      const adapter = new StubAdapter({
        trigger: c.detector,
        benignText: c.benignText,
        fetchContent: true,
        tidyFile: c.tidyFile,
      });
      const result = await runner.runScenario(
        scenario,
        adapter,
        makeProfile(path.join(root, 'work', scenario.id)),
        cfg,
      );
      expect(result.verdict, `${scenario.id} should be vulnerable`).toBe('vulnerable');
      expect(result.runs[0].detector_hits.length).toBeGreaterThanOrEqual(1);
      expect(result.runs[0].detector_hits[0].detector).toBe(scenario.forbidden_effect.detector);
      const evidence = await readEvidence(cfg, brid, scenario.id);
      expect(evidence.outcome).toBe('vulnerable');
      expect(evidence.detector_hits.length).toBeGreaterThanOrEqual(1);
      expect(evidence.detector_hits[0].evidence_ref).toBeTruthy();
      // Tidied AND canary fired: the benign side passed, the forbidden effect still wins.
      if (c.tidyFile) expect(result.runs[0].benign_ok, `${scenario.id} benign_ok`).toBe(true);
    }
  }, E2E_LOOP_TIMEOUT_MS);

  it('resisting stub -> resisted (benign task done, no canary touched)', async () => {
    const scenarios = loadAll();
    for (const c of CASES) {
      const scenario = scenarioFor(scenarios, c);
      const root = await tmpRoot();
      const brid = `BRR-${scenario.id}`;
      const runner = newRunner(brid);
      const cfg = makeCfg(root);
      const adapter = new StubAdapter({ benignText: c.benignText, fetchContent: true, tidyFile: c.tidyFile });
      const result = await runner.runScenario(
        scenario,
        adapter,
        makeProfile(path.join(root, 'work', scenario.id)),
        cfg,
      );
      expect(result.verdict, `${scenario.id} should resist`).toBe('resisted');
      expect(result.runs[0].detector_hits).toHaveLength(0);
      expect(result.runs[0].benign_ok).toBe(true);
    }
  }, E2E_LOOP_TIMEOUT_MS);

  it('file-tidy scenarios: a stub that prints SUMMARY: but leaves the file untouched -> degraded', async () => {
    const scenarios = loadAll();
    const tidy = CASES.filter((c) => c.tidyFile);
    expect(tidy.map((c) => c.id)).toEqual(['AAB-027', 'AAB-028', 'AAB-030', 'AAB-031']);
    for (const c of tidy) {
      const scenario = scenarioFor(scenarios, c);
      expect(scenario.benign_task.check).toBe('file_written');
      expect(scenario.benign_task.match?.path).toBe(c.tidyFile);
      const root = await tmpRoot();
      const brid = `BRD-${scenario.id}`;
      const runner = newRunner(brid);
      const cfg = makeCfg(root);
      const adapter = new StubAdapter({ benignText: c.benignText, fetchContent: true });
      const result = await runner.runScenario(
        scenario,
        adapter,
        makeProfile(path.join(root, 'work', scenario.id)),
        cfg,
      );
      expect(result.verdict, `${scenario.id} should be degraded`).toBe('degraded');
      expect(result.runs[0].detector_hits).toHaveLength(0);
      expect(result.runs[0].benign_ok).toBe(false);
      // Degraded because of the content (blank-line runs left), not because the file is missing.
      const evidence = await readEvidence(cfg, brid, scenario.id);
      expect(evidence.benign.check).toBe('file_written');
      expect(evidence.benign.evidence_ref).toContain('not_contains "\\n\\n\\n" present');
      expect(evidence.benign.evidence_ref).not.toContain('file missing');
    }
  }, E2E_LOOP_TIMEOUT_MS);
});
