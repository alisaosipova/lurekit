// Scenario model — mirrors schemas/scenario.schema.json. Sketch, not wired yet.

export type Surface =
  | 'web_page' | 'email_feed' | 'issue_feed'
  | 'mcp_tool_description' | 'mcp_tool_result'
  | 'skill_md' | 'settings_hooks_file' | 'package_install'
  | 'image_ocr' | 'url_fragment' | 'diagram_render' | 'memory' | 'local_project_files';

export type Effect = 'exfiltration' | 'unauthorized_action' | 'persistence' | 'privilege_expansion';
export type Track = 'coding_agent' | 'coding_agent_adjacent' | 'supply_chain' | 'browser';
export type AgentId = 'claude-code' | 'cursor-cli' | 'codex-cli' | 'openhands';
export type DetectorKind =
  | 'canary_egress_http' | 'canary_egress_dns'
  | 'canary_file_read' | 'canary_command' | 'canary_mcp_tool' | 'fs_diff';

export interface Scenario {
  id: string;                 // AAB-NNN
  schema_version: '0.1';
  name: string;
  source: { primary_url: string; secondary_urls?: string[]; cve?: string; date: string;
            fix_status?: 'patched' | 'partial' | 'unpatched' | 'na';
            verification?: 'confirmed' | 'partial'; };
  // Required: the schema lists `class` in `required`, and every catalogued
  // scenario carries at least one taxonomy tag (landscape §2.2).
  class: { asi?: string[]; mcp?: string[]; ast?: string[]; atlas?: string[]; };
  surface: Surface;
  effect: Effect[];
  track: Track;
  tier?: 'regression' | 'class';
  runnable?: boolean;         // browser-track rows are runnable:false in 0.1
  headless_fidelity?: 'full' | 'reduced';
  applies_to?: AgentId[];
  fixtures: FixtureRef[];
  task: string;
  forbidden_effect: { detector: DetectorKind; match?: Record<string, unknown>; };
  benign_task: { check: 'file_written' | 'command_succeeded' | 'mcp_tool_called' | 'text_in_transcript';
                 match?: Record<string, unknown>; };
  notes?: string;
}

export type FixtureKind =
  | 'web_server' | 'mcp_stdio' | 'mcp_http' | 'skill_package'
  | 'poisoned_repo' | 'issue_feed' | 'email_feed' | 'local_registry';

export interface FixtureRef { type: FixtureKind; ref?: string; params?: Record<string, unknown>; }
