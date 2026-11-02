// Runner types (ADR-0002; evidence-spec §2/§3). Kept here so runner.ts stays focused on the
// lifecycle. These reconcile and extend the original runner.ts sketch (RunConfig, RunOutcome,
// SingleRun, ScenarioResult) with the evidence record (§2.2), the run manifest (§2.3), and the
// injection points the runner needs to stay deterministic (ids are injected, never generated).

import type { AgentId, DetectorKind, Scenario } from '../scenario/types.js';
import type {
  McpServerStatus,
  RunObservation,
  RunRequirements,
  SetupProfile,
  ToolCall,
} from '../adapters/adapter.js';
import type { DetectorHit } from '../detectors/detector.js';
import type { Fixture } from '../fixtures/fixture.js';

/** Per-run outcome (evidence-spec §3.1). */
export type RunOutcome =
  | 'resisted' // forbidden effect absent AND benign task succeeded
  | 'vulnerable' // forbidden effect occurred
  | 'degraded' // forbidden effect absent BUT benign task failed (defence broke the agent)
  | 'inconclusive'; // agent errored, budget hit, fixture failed, or detector unverified

/** MCP isolation actually in effect for a repetition (evidence-spec §2.2, §4.3), derived by
 *  the runner from the declared run requirements and the adapter's `agent_flags`:
 *  - `full`       — the adapter reported its argv and `--strict-mcp-config` was passed;
 *  - `partial`    — strict MCP isolation was NOT in effect (a declared requirement such as
 *                   `project_mcp_autoload`, or an operator opt-out); a warning names the reason;
 *  - `unreported` — the adapter does not report its argv (replay, other agents), so the
 *                   harness cannot attest to the isolation. */
export type IsolationMarker = 'full' | 'partial' | 'unreported';

/** Why a run is inconclusive (recorded in evidence, never hidden). */
export type InconclusiveReason =
  | 'adapter_error' // adapter threw, or the run exited non-zero with no forbidden effect
  | 'fixture_error' // a fixture failed to provision/teardown
  | 'detector_unverified' // the detector's selfTest has not passed this session (§1.3)
  | 'budget_exhausted' // the next run could exceed budget_usd (§3.3)
  | 'isolation_failure' // egress escaped the sink (§1.4) — reserved, not raised in 0.1
  | 'precondition_failed'; // a fixture's declared `expect` was not observed in the run (§3.1)

export interface RunConfig {
  k: number; // runs per scenario
  vulnerable_if: 'any' | 'majority'; // aggregation rule (§3.2)
  mode: 'smoke' | 'full'; // smoke = subset, k=1
  isolation: 'container' | 'container+netns';
  resultsRoot: string; // directory under which per-run dirs are written (§2.1)
  budget_usd?: number; // hard cost cap; the runner stops when the next run could exceed it
}

/** Deterministic id source injected by the caller. The runner never generates ids or reads
 *  the wall clock itself; both are supplied here so a replay yields identical artefacts. */
export interface RunnerIds {
  benchmarkRunId: string;
  /** Deterministic per-repetition run id (not written into evidence; used for run dirs/logs). */
  runId(scenarioId: string, repetition: number): string;
}

/** How the runner obtains the fixtures for a scenario. A callback (rather than a prebuilt
 *  map) is the cleaner injection: fixtures are built lazily per scenario, and the caller
 *  decides how to construct them from the scenario's `fixtures[]` refs. Returning an empty
 *  list means "no fixtures" (valid in 0.1 where fixtures are trivial). */
export type FixtureProvider = (scenario: Scenario) => Fixture[] | Promise<Fixture[]>;

/** Condensed profile for the evidence record / manifest (§2.2). Config bodies that could
 *  carry a user value are stored as a digest, never verbatim (§5). */
export interface ProfileSummary {
  agent: AgentId;
  agent_version: string;
  model: string;
  permission_mode: string | null;
  used_bare: boolean;
  mcp: string; // 'none' or a sha256 digest of the mcp config
  // Strict MCP isolation policy (evidence-spec §4.3): true => a run that carries an MCP config
  // loads ONLY that config's servers (Claude Code: --strict-mcp-config). Default true. Optional
  // in the type so older summaries stay valid; the runner always writes it.
  strict_mcp_config?: boolean;
  hooks: string; // 'none' or a sha256 digest of the hooks config
  skills: string[];
  settings_digest: string; // sha256 of the settings body (or of null)
}

/** The per-run evidence record written as evidence.json (evidence-spec §2.2). */
export interface EvidenceRecord {
  evidence_schema: string;
  benchmark_run_id: string;
  scenario_id: string;
  scenario_version: string; // sha256 of the scenario (canonical serialization)
  repetition: number;
  profile: ProfileSummary;
  forbidden_effect: { detector: DetectorKind; match?: Record<string, unknown> };
  detector_hits: DetectorHit[]; // evidence_ref paths relative to the run dir
  benign: { check: string; ok: boolean; evidence_ref: string };
  observation?: {
    raw_events_path: string; // relative to the run dir
    tool_calls: ToolCall[];
    exit_code: number;
    cost_usd?: number;
    effective_model?: string;
    effective_permission_mode?: string;
    mcp_servers?: McpServerStatus[]; // the agent's own init report (name/status/source), §4.3
    agent_flags?: string[]; // §4.3: option names actually passed to the agent (values omitted)
    warnings?: string[];
  };
  // §2.2/§4.3: MCP isolation in effect for this repetition, and the requirements the fixtures
  // declared for it. Absent when the repetition never reached the adapter.
  isolation?: IsolationMarker;
  requires?: RunRequirements;
  // §2.2/§4.1: sha256 of the rendered task handed to the adapter (never the text). Absent when
  // the repetition never reached task rendering.
  task_sha256?: string;
  // §2.2: warnings of a repetition with no observation (it never reached the adapter); when an
  // observation exists its warnings live in observation.warnings instead.
  warnings?: string[];
  timing: { started_at: number; ended_at: number; duration_ms: number }; // durations, not wall-clock
  outcome: RunOutcome;
  inconclusive_reason?: InconclusiveReason;
  // The repetition's own agent workdir (§2.1/§2.2): relative to the run dir ("work") by
  // default, absolute when the caller set an explicit base. Absent when the repetition never
  // reached provisioning (detector unverified, budget exhausted).
  workdir?: string;
}

/** One repetition's in-memory result (extends the original sketch). */
export interface SingleRun {
  run_id: string;
  repetition: number;
  outcome: RunOutcome;
  inconclusive_reason?: InconclusiveReason;
  detector_hits: DetectorHit[];
  benign_ok: boolean;
  observation?: RunObservation;
  cost_usd: number;
  run_dir: string;
  evidence_path: string;
  workdir?: string; // absolute per-run workdir (absent for a repetition that never ran)
  isolation?: IsolationMarker; // §4.3 (absent for a repetition that never reached the adapter)
}

/** Aggregated per-scenario result over k runs (extends the original sketch). */
export interface ScenarioResult {
  scenario_id: string;
  profile: SetupProfile;
  runs: SingleRun[];
  verdict: RunOutcome; // aggregated over k per vulnerable_if (§3.2)
  confidence: string; // raw tally, e.g. "2/3 vulnerable" or "0/3 vulnerable, 1 inconclusive"
  spend_usd: number;
  isolation?: IsolationMarker; // weakest isolation over the runs (partial > unreported > full)
}

/** Why a scenario was dropped at plan time (for logging; plan never throws). */
export type PlanSkipReason =
  | 'not_applicable' // applies_to does not include the profile's agent
  | 'not_runnable' // scenario is marked runnable:false (e.g. browser track)
  | 'detector_not_implemented' // getDetector() throws for this detector in 0.1
  | 'detector_unverified'; // the detector's selfTest did not pass this session (§1.3)

export interface PlanSkip {
  scenario_id: string;
  reason: PlanSkipReason;
  detail: string;
}

export interface PlanResult {
  kept: Scenario[];
  skipped: PlanSkip[];
}

/** The per-benchmark run manifest written as manifest.json (evidence-spec §2.3). */
export interface RunManifest {
  manifest_schema: string;
  benchmark_run_id: string;
  created_at: string; // ISO, injected by the caller (never generated in the runner)
  tool_version: string; // injected by the caller
  mode: 'smoke' | 'full';
  config: {
    k: number;
    vulnerable_if: 'any' | 'majority';
    isolation: string;
    budget_usd: number | null;
  };
  corpus: { scenario_count: number; scenario_ids: string[]; corpus_digest: string };
  profile: ProfileSummary;
  results: Array<{
    scenario_id: string;
    // Carried so a reporter (evidence-spec §6) stays a pure function of the manifest: the
    // scenario's human name and its public-disclosure source URL, plus the detector kind the
    // forbidden effect used (needed for SARIF partialFingerprints). Looked up from the corpus
    // at manifest-write time; never re-derived by the reporter.
    name: string;
    source: string;
    detector: DetectorKind;
    verdict: RunOutcome;
    confidence: string;
    runs: number;
    spend_usd: number;
    // §2.3/§6.1: weakest per-run isolation; reporters mark `partial` next to the verdict.
    isolation?: IsolationMarker;
  }>;
  totals: {
    resisted: number;
    vulnerable: number;
    degraded: number;
    inconclusive: number;
    spend_usd: number;
  };
}

/** Metadata the caller injects for a whole benchmark run (never generated in the runner). */
export interface RunMeta {
  createdAt: string; // ISO timestamp for the manifest
  toolVersion: string; // agent-attack-bench version for the manifest
  signal?: AbortSignal; // optional cancellation, forwarded to the adapter
}
