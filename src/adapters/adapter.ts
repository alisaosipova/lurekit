// Agent adapter interface. One implementation per agent (brief §3.1).
// The adapter launches the agent headless under a given SetupProfile, injects the
// task, and returns the observable record. It never approves trust prompts and never
// relaxes the profile; the profile IS the variable under test.

import type { AgentId } from '../scenario/types.js';

export interface SetupProfile {
  agent: AgentId;
  agent_version: string;      // pinned, e.g. "@anthropic-ai/claude-code@2.1.309"
  model: string;              // pinned full model id
  workdir: string;            // the provisioned (possibly poisoned) working directory
  env?: Record<string, string>;
  // Config under test, copied verbatim into the workdir / home by the runner:
  settings?: unknown;         // settings file(s)
  hooks?: unknown;            // hooks config
  mcp?: unknown;              // MCP server config
  skills?: string[];          // skill directories
  permission_mode?: string;   // agent-specific; recorded, never overridden to be looser
}

export type ObservationSource = 'stream' | 'hook' | 'proxy';

export interface ToolCall {
  id?: string;                // tool_use_id / call_id where the agent provides one
  name: string;
  input?: unknown;
  at: number;                 // monotonic ms since run start
  source: ObservationSource;  // primary layer (back-compat); sources[0] by priority
  // Every layer that saw this call. A call merged from both stream and hook carries
  // ['stream','hook'] (evidence-spec §4.2). `source` stays populated for back-compat.
  sources?: ObservationSource[];
}

export interface RunObservation {
  transcript_path?: string;
  raw_events_path: string;    // captured stdout JSON/JSONL, stored verbatim
  tool_calls: ToolCall[];
  exit_code: number;
  cost_usd?: number;          // client-side estimate where the agent reports one
  started_at: number;
  ended_at: number;
  // Recorded observation metadata (evidence-spec §4.3/§4.4). Optional so other adapters
  // need not populate them; the Claude Code adapter fills them from system/init and argv.
  effective_model?: string;           // model reported by the system/init stream event
  effective_permission_mode?: string; // permission mode reported by system/init
  mcp_servers?: unknown;               // mcp_servers list from system/init
  used_bare?: boolean;                 // §4.3: whether --bare was passed (default false)
  agent_version_reported?: string;     // version string from `<bin> --version`
  warnings?: string[];                 // non-fatal issues (e.g. version mismatch)
}

// Per-run options the runner passes alongside the profile. `runDir` is where the adapter
// writes raw evidence (stream + hook logs); it aligns with the detectors' ctx.runDir so a
// detector reads evidence from the same directory the adapter wrote it to.
export interface RunOptions {
  runDir?: string;
  bare?: boolean;   // §4.3: pass --bare (skip project config). Default false (NOT used).
}

export interface Adapter {
  readonly id: AgentId;
  // How this agent is driven headless and observed; filled from landscape §4.
  capabilities(): { headless: boolean; observes: ObservationSource[]; can_pin_version: boolean; can_pin_model: boolean; };
  // `options` is additive (optional) so existing callers keep compiling; the Claude Code
  // adapter needs options.runDir and may also take it via its constructor.
  run(profile: SetupProfile, task: string, signal: AbortSignal, options?: RunOptions): Promise<RunObservation>;
}
