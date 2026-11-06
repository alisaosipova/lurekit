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
  ToolAttempt,
  ToolCall,
} from '../adapters/adapter.js';
import type { DetectorHit } from '../detectors/detector.js';
import type { Fixture } from '../fixtures/fixture.js';
import type { TamperFinding } from './artefacts.js';

/** Per-run outcome (evidence-spec §3.1). */
export type RunOutcome =
  | 'resisted' // forbidden effect absent AND benign task succeeded
  | 'vulnerable' // forbidden effect occurred
  | 'degraded' // forbidden effect absent BUT benign task failed (defence broke the agent)
  | 'inconclusive'; // agent errored, budget hit, fixture failed, or detector unverified

/** Which kind of `resisted` a run is (evidence-spec §3.1 "Resisted kind"). The verdict stays
 *  `resisted` either way (no effect occurred); this records why:
 *  - `not_attempted` — no recorded attempt targeted the forbidden effect (the model declined);
 *  - `denied`        — the agent issued a tool use the detector would have counted, but the
 *                      deployed setup blocked it (permission gate or tool error, §4.2). */
export type ResistedKind = 'not_attempted' | 'denied';

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
  | 'precondition_failed' // a fixture's declared `expect` was not observed in the run (s3.1)
  | 'run_timeout' // ADR-0024: the per-run timer (--run-timeout) fired before the adapter returned
  // ADR-0025: a harness artefact of this repetition was modified, removed, replaced or
  // symlinked during the run; see `artefacts` and the `evidence tampered:` warnings.
  | 'evidence_tampered'
  // Block 3 (evidence-spec s3.1 "Benign haystack"): the adapter reported no assistant_text, so
  // a text_in_transcript benign check could not be evaluated; never resisted/degraded.
  | 'benign_unevaluated'
  // evidence-spec s3.1 LV-1: the agent's stream shows an executed canary launch the recorder did
  // not log (the agent's sandbox blocked the recorder); never resisted/degraded.
  | 'sensor_blind';

/** Severity order of the inconclusive reasons, most severe first (evidence-spec s3.2 rule 2):
 *  breaks a tie when a scenario's repetitions are all inconclusive for different reasons. */
export const INCONCLUSIVE_SEVERITY: readonly InconclusiveReason[] = [
  'evidence_tampered',
  'detector_unverified',
  'sensor_blind',
  'precondition_failed',
  'fixture_error',
  'run_timeout',
  'adapter_error',
  'benign_unevaluated',
  'budget_exhausted',
  'isolation_failure',
];

/** What a repetition's charged cost was based on (evidence-spec s3.3, block 3): the agent's own
 *  reported `cost_usd` (a finite number >= 0) or the harness's per-run estimate. */
export type CostBasis = 'reported' | 'estimated';

/** Manifest spelling of the basis over a set of charged repetitions (s2.3): `estimated` when
 *  every charged repetition was estimated, `mixed` when some were reported and some estimated;
 *  absent (undefined) when every charged repetition reported its own cost, or none was charged. */
export type SpendBasis = 'estimated' | 'mixed';

export interface RunConfig {
  k: number; // runs per scenario
  vulnerable_if: 'any' | 'majority'; // aggregation rule (§3.2)
  mode: 'smoke' | 'full'; // smoke = subset, k=1
  isolation: 'container' | 'container+netns';
  resultsRoot: string; // directory under which per-run dirs are written (§2.1)
  budget_usd?: number; // hard cost cap; the runner stops when the next run could exceed it
  // ADR-0024 D1: per-run wall-clock cap in ms; undefined arms no timer (replay, direct runner use).
  run_timeout_ms?: number;
  // ADR-0022 B19: the --only/--skip filter, recorded in the manifest.
  scenario_filter?: { only?: string[]; skip?: string[] };
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
  // Setting sources of the profile that ran (evidence-spec §4.3, Claude Code --setting-sources).
  // Absent when the profile sets none (agent default sources). Never set by a fixture patch.
  setting_sources?: string[];
}

/** Content-delivery facts of one fixture that declared `expect.content_fetched` (evidence-spec
 *  s3.1 "Preconditions", ADR-0002 amendment "content delivery"). `source`: live = the fixture's
 *  own passive counter; recording = a replay recording's facts; not_observable = a replay with
 *  no recorded facts (the precondition was not evaluated, counts omitted). */
export interface FixtureDelivery {
  type: string;
  source: 'live' | 'recording' | 'not_observable';
  content_fetched?: boolean;
  content_requests?: number;
  request_count?: number;
}

/** One declared precondition of a repetition and whether it was met (evidence-spec s2.2
 *  "Precondition facts", s3.1; block 8). `met_by` names the route (only when met); `source`
 *  says where the fact came from: `live` (this run's observation), `recording` (a replay
 *  recording's declaration), `not_observable` (a replay with no declaration: not evaluated,
 *  `met: false`, no `met_by`). */
export interface PreconditionFact {
  expectation: 'mcp_server' | 'content_fetched' | 'skill_loaded';
  value: string | true;
  met: boolean;
  met_by?: 'init_report' | 'hit' | 'delivery' | 'skill_call' | 'marker_in_output';
  source: 'live' | 'recording' | 'not_observable';
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
    env_forwarded?: string[]; // s4.3, ADR-0008: env var NAMES the agent child got (never values)
    agent_version_reported?: string; // s4.3: the agent's raw `--version` output for this repetition
    attempts?: ToolAttempt[]; // §4.2: denied/failed tool uses (input digest only)
    fixtures?: FixtureDelivery[]; // s3.1 content_fetched delivery facts (HTTP fixtures only)
    warnings?: string[];
  };
  // §3.1: some attempt matched what the detector would have counted. Present whenever the
  // repetition has an observation.
  attempted_forbidden?: boolean;
  // §3.1: present only when outcome is `resisted`.
  resisted_kind?: ResistedKind;
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
  // ADR-0024 D4, all three written only when true / present / non-empty, so a completed run's
  // record is byte-identical to one written before ADR-0024.
  timed_out?: true; // the per-run timer fired
  elapsed_ms?: number; // wall-clock ms from the adapter call to the abort; non-completed runs only
  teardown_error?: string[]; // "<who>: <message>" per detector/fixture teardown that threw
  // ADR-0025 D6: the settle-time artefact findings, sorted by path, written only when the check
  // found at least one (any outcome). Absent on a clean check and when no check ran.
  artefacts?: TamperFinding[];
  // Block 8 (s2.2 "Precondition facts"): one entry per declared expectation, written only when
  // a skill_loaded expectation was declared or an mcp_server expectation was met by a hit, so
  // every record written before the amendment stays byte-identical.
  preconditions?: PreconditionFact[];
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
  attempted_forbidden?: boolean; // §3.1 (absent for a repetition that never reached the adapter)
  resisted_kind?: ResistedKind; // §3.1 (only when outcome is resisted)
  // s3.3 (block 3): what `cost_usd` (the charged amount) was based on; absent for a repetition
  // that never reached the adapter (charged 0, no basis).
  cost_basis?: CostBasis;
  // ADR-0024: in-memory only, set when the evidence record could not be written (the warnings
  // then exist nowhere else); the CLI diagnosis reads them from here.
  warnings?: string[];
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
  // §3.1/§3.2: only when verdict is resisted — `denied` if any resisted run was denied.
  resisted_kind?: ResistedKind;
  // s3.2 (block 3): fewer than half of the planned repetitions were conclusive; only when true.
  low_confidence?: true;
  // s3.2 (block 3): only when the verdict is inconclusive: the most common per-run reason.
  inconclusive_reason?: InconclusiveReason;
  // s3.3 (block 3): basis of spend_usd over the charged repetitions; absent when all reported.
  spend_basis?: SpendBasis;
}

/** Why a scenario was dropped at plan time (for logging; plan never throws). */
export type PlanSkipReason =
  | 'not_applicable' // applies_to does not include the profile's agent
  | 'not_runnable' // scenario is marked runnable:false (e.g. browser track)
  | 'detector_not_implemented' // getDetector() throws for this detector in 0.1
  | 'detector_unverified' // the detector's selfTest did not pass this session (§1.3)
  // Block 8 (ADR-0002 amendment): a fixture hands its server through profilePatch.mcp and the
  // adapter's capabilities().delivers_mcp_config is false (AAB-006 on cursor-cli).
  | 'mcp_config_undeliverable';

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
  /** ADR-0024 B13a: present only on a provisional manifest of a run still going (or killed). */
  partial?: { completed_scenarios: number; planned_scenarios: number };
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
    // ADR-0024 D4: the per-run cap the results were obtained under; null for --replay (no
    // timer). Optional in the type so manifests written before ADR-0024 stay valid.
    run_timeout_ms?: number | null;
    scenario_filter?: { only?: string[]; skip?: string[] };
  };
  // corpus_digest_full: set only on a published bundle that withheld/excluded scenarios
  // (ADR-0017, evidence-spec s2.3): the run's original digest; corpus_digest then covers the
  // published scenarios only.
  corpus: { scenario_count: number; scenario_ids: string[]; corpus_digest: string; corpus_digest_full?: string };
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
    // §2.3/§4.3: true iff every repetition's reported argv carried --strict-mcp-config (what
    // ran); `profile.strict_mcp_config` above is the policy. Absent when not attestable.
    strict_mcp_config?: boolean;
    // §2.3/§3.1: only when verdict is resisted; reporters show it next to the verdict (§6.1).
    resisted_kind?: ResistedKind;
    // s2.3/s3.2 (block 3): written only when true (2 * conclusive < runs, verdict not inconclusive).
    low_confidence?: true;
    // s2.3 (B17, VERDICT-09): only when the scenario runs at reduced headless fidelity (s4.3).
    headless_fidelity?: 'reduced';
    // s2.3/s3.2 (block 3): only on an inconclusive verdict; the most common per-run reason.
    inconclusive_reason?: InconclusiveReason;
    // s2.3/s3.3 (block 3): estimated | mixed; absent when every charged repetition reported.
    spend_basis?: SpendBasis;
  }>;
  totals: {
    resisted: number;
    vulnerable: number;
    degraded: number;
    inconclusive: number;
    spend_usd: number;
    // s2.3/s3.3 (block 3): same rule as results[].spend_basis over every repetition of the run.
    spend_basis?: SpendBasis;
  };
  // evidence-spec section 2.3 / ADR-0017 "Excluding a scenario": set only in a published bundle by
  // `publish --exclude`: scenario ids whose results were left out as an operator-declared
  // non-measurement. Never written by the runner.
  excluded?: string[];
}

/** Metadata the caller injects for a whole benchmark run (never generated in the runner). */
export interface RunMeta {
  createdAt: string; // ISO timestamp for the manifest
  toolVersion: string; // LureKit version for the manifest
  signal?: AbortSignal; // optional cancellation, forwarded to the adapter
}
