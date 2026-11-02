// Detector registry (evidence-spec §1.5). Maps each DetectorKind to its implementation.
//
// DetectorKind (src/scenario/types.ts) and the forbidden_effect.detector enum in
// schemas/scenario.schema.json must stay in lockstep (§1.5). Both currently list six kinds;
// 0.1 implements the three deterministic control sensors from BOOTSTRAP.md step 2, plus
// canary_mcp_tool (the MCP surface sensor, evidence-spec §1.2b, build step 5) and fs_diff
// (workdir config-file change sensor, §1.2c). The remaining one (canary_egress_dns) is declared
// in the schema but not yet built — getDetector() throws a clear "not implemented" error for it
// rather than silently returning nothing, so a scenario referencing it fails loudly.

import type { Detector } from './detector.js';
import type { DetectorKind } from '../scenario/types.js';
import { CanaryEgressHttpDetector } from './canaryEgressHttp.js';
import { CanaryFileReadDetector } from './canaryFileRead.js';
import { CanaryCommandDetector } from './canaryCommand.js';
import { CanaryMcpToolDetector } from './canaryMcpTool.js';
import { FsDiffDetector } from './fsDiff.js';

export { CanaryEgressHttpDetector } from './canaryEgressHttp.js';
export { CanaryFileReadDetector } from './canaryFileRead.js';
export { CanaryCommandDetector } from './canaryCommand.js';
export { CanaryMcpToolDetector } from './canaryMcpTool.js';
export { FsDiffDetector, DEFAULT_WATCHED_PATHS } from './fsDiff.js';

/** Factories keyed by DetectorKind. A kind present here is implemented in 0.1. */
const registry: Partial<Record<DetectorKind, () => Detector>> = {
  canary_egress_http: () => new CanaryEgressHttpDetector(),
  canary_file_read: () => new CanaryFileReadDetector(),
  canary_command: () => new CanaryCommandDetector(),
  canary_mcp_tool: () => new CanaryMcpToolDetector(),
  fs_diff: () => new FsDiffDetector(),
};

/** Kinds with a working control sensor in this build. */
export const IMPLEMENTED_DETECTORS = Object.keys(registry) as DetectorKind[];

/** Construct the detector for a kind. Throws for a kind not implemented in 0.1. */
export function getDetector(kind: DetectorKind): Detector {
  const make = registry[kind];
  if (!make) {
    throw new Error(
      `detector "${kind}" is not implemented in 0.1 (implemented: ${IMPLEMENTED_DETECTORS.join(', ')})`,
    );
  }
  return make();
}
