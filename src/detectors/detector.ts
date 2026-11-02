// Effect detectors = control sensors OUTSIDE the agent. A scenario's forbidden_effect
// names exactly one. Detectors observe signals only; they do not generate attacks.
//
// Soundness requirement (brief week-2): each detector ships with two control runs —
//  - a POSITIVE control that deliberately triggers the sensor via a harness-owned stub,
//    proving the detector fires (no false negative);
//  - a NEGATIVE control with no trigger, proving it stays silent (no false positive).
// The self-test is these control runs, not an enumeration of evasion techniques.

import type { DetectorKind } from '../scenario/types.js';
import type { SelfTestOptions } from './selftestDir.js';
import type { ToolCall } from '../adapters/adapter.js';

export interface DetectorHit {
  detector: DetectorKind;
  matched: Record<string, unknown>;   // which canary identifier fired
  attributed_tool_call?: ToolCall;    // best-effort link to the tool call that caused it
  evidence_ref: string;               // path to the raw evidence (pcap line, access log, fs diff)
  at: number;
}

/** Optional provisioning context (evidence-spec §1.5). Sensors that observe only the run dir
 *  ignore it; fs_diff (§1.2c) requires `workdir` and honours `match.paths`. */
export interface DetectorProvisionOptions {
  /** The post-fixture profile workdir the agent runs in. */
  workdir?: string;
  /** The scenario's forbidden_effect.match (detector-specific canary identifiers). */
  match?: Record<string, unknown>;
}

export interface Detector {
  readonly kind: DetectorKind;
  // Canary values this detector watches for, provisioned per run (never real secrets).
  // `runDir` is the per-run directory the sensor writes its raw evidence into (access
  // log, decoy file, argv recorder); the SAME directory is handed back to evaluate() as
  // ctx.runDir. provision() received only runId originally, but a sensor must write its
  // evidence where evaluate() later reads it, so runDir is required here too (noted in
  // the step-2 report as the one genuinely-missing interface field).
  // The optional third argument carries the workdir + scenario match (§1.5); existing
  // run-dir-only sensors omit it and compile unchanged.
  provision(
    runId: string,
    runDir: string,
    opts?: DetectorProvisionOptions,
  ): Promise<{ canaries: Record<string, string>; teardown(): Promise<void>; }>;
  // Inspect the collected evidence for the run and report hits. `workdir` is optional and
  // only consulted by sensors that observe the agent's working directory (fs_diff, §1.2c).
  evaluate(ctx: { runDir: string; toolCalls: ToolCall[]; workdir?: string }): Promise<DetectorHit[]>;
  // Control runs that prove the sensor cannot silently miss its own signal. Scratch dirs are
  // created under `opts.base` (the runner passes <results>/<benchmark_run_id>/.selftest);
  // without one, under <cwd>/.aab-selftest. Never under os.tmpdir() (evidence-spec §1.3).
  selfTest(opts?: SelfTestOptions): Promise<{ positive: boolean; negative: boolean }>;
}
