// Test-only Adapter stub (evidence-spec §4.5). Fully offline and deterministic: it spawns no
// process, touches no network except an OPTIONAL loopback GET to the harness's own canary sink
// (to simulate the agent attempting egress), and spends nothing. It returns a scripted
// RunObservation and, when asked, produces a detector's signal in the run dir exactly as a
// real agent would have (append the recorder entry / surface the decoy marker / hit the sink),
// so the REAL detectors fire on REAL evidence.

import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import path from 'node:path';

import type {
  Adapter,
  McpServerStatus,
  ObservationSource,
  RunObservation,
  RunOptions,
  SetupProfile,
  ToolCall,
} from '../../src/adapters/adapter.js';
import type { AgentId, DetectorKind } from '../../src/scenario/types.js';

export interface StubScript {
  exitCode?: number; // default 0
  cost?: number; // default 0 (total_cost_usd)
  throwError?: string; // if set, run() rejects with this message (adapter error)
  trigger?: DetectorKind; // produce this detector's signal in the run dir
  benignText?: string; // text to place in the transcript (for text_in_transcript)
  extraToolCalls?: ToolCall[]; // additional scripted tool calls
  writeFile?: { rel: string; content: string }; // write a file into workdir (for file_written)
  mcpToolName?: string; // add a tool call with this name (for mcp_tool_called)
  startedAt?: number; // fixed observation start (determinism); default 1000
  endedAt?: number; // fixed observation end (determinism); default 1500
  // The agent's init mcp_servers report. Default: every server named in profile.mcp.mcpServers
  // reported `connected` (as a real agent that loaded the fixture config would). Set to override
  // (e.g. [] to emulate a fixture server that never connected, evidence-spec §3.1).
  mcpServers?: McpServerStatus[];
}

/** Server names in an `{ mcpServers: { <name>: … } }` config (the shape the fixtures emit). */
function configuredServers(mcp: unknown): McpServerStatus[] {
  const servers = (mcp as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers).map((name) => ({ name, status: 'connected', source: 'dynamic' }));
}

const STREAM_FILE = 'claude-stream.jsonl';

function tc(name: string, input: unknown): ToolCall {
  const sources: ObservationSource[] = ['stream'];
  return { name, input, at: 1, source: 'stream', sources };
}

export class StubAdapter implements Adapter {
  readonly id: AgentId = 'claude-code';
  runCount = 0;

  constructor(private readonly script: StubScript = {}) {}

  capabilities(): {
    headless: boolean;
    observes: ObservationSource[];
    can_pin_version: boolean;
    can_pin_model: boolean;
  } {
    return { headless: true, observes: ['stream', 'hook'], can_pin_version: true, can_pin_model: true };
  }

  async run(
    profile: SetupProfile,
    _task: string,
    _signal: AbortSignal,
    options: RunOptions = {},
  ): Promise<RunObservation> {
    this.runCount += 1;
    if (this.script.throwError) throw new Error(this.script.throwError);

    const runDir = options.runDir;
    if (!runDir) throw new Error('StubAdapter.run: a runDir is required');
    await mkdir(runDir, { recursive: true });

    const toolCalls: ToolCall[] = [...(this.script.extraToolCalls ?? [])];

    if (this.script.trigger) {
      await produceSignal(this.script.trigger, runDir, toolCalls);
    }
    if (this.script.mcpToolName) {
      toolCalls.push(tc(this.script.mcpToolName, {}));
    }
    if (this.script.writeFile) {
      await mkdir(profile.workdir, { recursive: true });
      const target = path.join(profile.workdir, this.script.writeFile.rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, this.script.writeFile.content, 'utf8');
      toolCalls.push(tc('Write', { file_path: target }));
    }

    const mcpServers = this.script.mcpServers ?? configuredServers(profile.mcp);

    // Raw events: a fixed system/init, an optional benign-text assistant message, a result.
    const lines: string[] = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: profile.model,
        permissionMode: profile.permission_mode ?? 'default',
        mcp_servers: mcpServers,
      }),
    ];
    if (this.script.benignText) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: this.script.benignText }] },
        }),
      );
    }
    lines.push(JSON.stringify({ type: 'result', total_cost_usd: this.script.cost ?? 0 }));
    const rawPath = path.join(runDir, STREAM_FILE);
    await writeFile(rawPath, lines.join('\n') + '\n', 'utf8');

    return {
      raw_events_path: rawPath,
      tool_calls: toolCalls,
      exit_code: this.script.exitCode ?? 0,
      cost_usd: this.script.cost ?? 0,
      started_at: this.script.startedAt ?? 1000,
      ended_at: this.script.endedAt ?? 1500,
      effective_model: profile.model,
      effective_permission_mode: profile.permission_mode ?? 'default',
      mcp_servers: mcpServers,
      used_bare: false,
    };
  }
}

// Detector file conventions (kept in lockstep with src/detectors/*). The stub writes the same
// raw evidence a real agent's forbidden action would have produced, so the real detector fires.
async function produceSignal(
  kind: DetectorKind,
  runDir: string,
  toolCalls: ToolCall[],
): Promise<void> {
  if (kind === 'canary_command') {
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_command.canary.json'), 'utf8'),
    ) as { command: string };
    const argv = ['--run'];
    await appendFile(
      path.join(runDir, 'canary_command.recorder.log'),
      JSON.stringify({ command: meta.command, argv, time: 0 }) + '\n',
    );
    toolCalls.push(tc('Bash', { command: `${meta.command} --run` }));
    return;
  }
  if (kind === 'canary_file_read') {
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_file_read.canary.json'), 'utf8'),
    ) as { fileName: string; marker: string };
    const decoy = await readFile(path.join(runDir, meta.fileName), 'utf8');
    await appendFile(path.join(runDir, 'agent-output.log'), decoy);
    toolCalls.push(tc('Read', { file: meta.fileName }));
    return;
  }
  if (kind === 'canary_egress_http') {
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_egress_http.canary.json'), 'utf8'),
    ) as { url: string };
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(meta.url, (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    toolCalls.push(tc('Bash', { command: `curl ${meta.url}` }));
    return;
  }
  if (kind === 'canary_mcp_tool') {
    // Simulate the agent invoking the decoy MCP tool by writing the same recorder entry the
    // inert server's handler would have written, and recording the tool call on the stream.
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_mcp_tool.canary.json'), 'utf8'),
    ) as { tool: string; token: string; recorderFile: string };
    const args = { note: 'ack', token: meta.token };
    await appendFile(
      path.join(runDir, meta.recorderFile),
      JSON.stringify({ tool: meta.tool, args, time: 0 }) + '\n',
    );
    toolCalls.push(tc(meta.tool, args));
    return;
  }
  throw new Error(`StubAdapter cannot produce a signal for detector "${kind}"`);
}
