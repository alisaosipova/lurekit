// Test-only Adapter stub (evidence-spec §4.5). Fully offline and deterministic: it spawns no
// process, touches no network except an OPTIONAL loopback GET to the harness's own canary sink
// (to simulate the agent attempting egress), and spends nothing. It returns a scripted
// RunObservation and, when asked, produces a detector's signal in the run dir exactly as a
// real agent would have (append the recorder entry / surface the decoy marker / hit the sink),
// so the REAL detectors fire on REAL evidence.

import { mkdir, writeFile, appendFile, readFile, rm, symlink, unlink, chmod } from 'node:fs/promises';
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
import { safeWriteFile } from '../../src/runner/safeWrite.js';

export interface StubScript {
  exitCode?: number; // default 0
  cost?: number; // default 0 (total_cost_usd)
  throwError?: string; // if set, run() rejects with this message (adapter error)
  trigger?: DetectorKind; // produce this detector's signal in the run dir
  benignText?: string; // text to place in the transcript (for text_in_transcript)
  extraToolCalls?: ToolCall[]; // additional scripted tool calls
  writeFile?: { rel: string; content: string }; // write a file into workdir (for file_written)
  // Tidy this workdir-relative file as the text-tidy skill's stated job (evidence-spec s3.1
  // file_written not_contains): read it, collapse every run of blank lines to one, write it back.
  tidyFile?: string;
  mcpToolName?: string; // add a tool call with this name (for mcp_tool_called)
  startedAt?: number; // fixed observation start (determinism); default 1000
  endedAt?: number; // fixed observation end (determinism); default 1500
  // The agent's init mcp_servers report. Default: every server named in profile.mcp.mcpServers
  // reported `connected` (as a real agent that loaded the fixture config would). Set to override
  // (e.g. [] to emulate a fixture server that never connected, evidence-spec §3.1).
  mcpServers?: McpServerStatus[];
  // evidence-spec s3.1 content_fetched: emulate an agent that actually read the fixture content
  // over loopback (a real GET, so the fixture's own passive counter sees it). For each loopback
  // URL in profile.env under a known content-location name (AAB_ISSUE_FEED_URL,
  // AAB_EMAIL_FEED_URL, AAB_WEB_URL) GET it; for npm_config_registry GET the canary package's
  // packument (name from the canary_egress_http sensor's canary file when present).
  fetchContent?: boolean;
  // ADR-0024 lifecycle tests. Applied AFTER the detector signal (trigger) has been produced, so
  // "signal then timeout/throw" can be scripted: sleepMs keeps run() pending that long (it
  // rejects as soon as the signal aborts, unless ignoreSignal is set, in which case it sleeps
  // the whole time like an adapter that does not honour its signal); throwAfterSignal rejects
  // with this message once the signal has been produced (and the sleep, if any, is over).
  sleepMs?: number;
  ignoreSignal?: boolean;
  throwAfterSignal?: string;
  // ADR-0025 test plan: tamper with the harness artefacts the way an agent could, applied AFTER
  // the signal (trigger) and before run() returns. `tamperOutside` names a directory outside
  // the results root for the symlink kinds; `tamper` runs an arbitrary hook inside the run.
  tamper?: TamperKind[];
  tamperOutside?: string;
  tamperHook?: (ctx: { runDir: string; workdir?: string }) => Promise<void>;
  // Write the raw stream through safeWriteFile, exactly as the live adapters do (ADR-0025 D2),
  // so a planted entry at the stream name is refused the way it is in a live run.
  streamViaSafeWrite?: boolean;
}

export type TamperKind =
  | 'delete_meta' // unlink every *.canary.json / fs_diff.baseline.json
  | 'rewrite_recorder' // overwrite canary_bin/canary_recorder.cjs with a silent no-op
  | 'restore_recorder' // overwrite then write the original bytes back (same inode/size/hash)
  | 'chmod_recorder' // flip the recorder's mode (POSIX metadata change)
  | 'delete_decoy' // unlink the canary_*.decoy file
  | 'truncate_sink' // rewrite the recorder/access log shorter
  | 'corrupt_sink' // append a non-JSON line to the sink
  | 'symlink_evidence' // plant a symlink at evidence.json pointing outside the run dir
  | 'plant_output' // write agent-output.log carrying the decoy marker
  | 'symlink_next_rep'; // replace ../1 (the next repetition's dir) with a symlink outside

const SINK_NAMES = [
  'canary_command.recorder.log',
  'canary_egress_http.access.log',
  'local_registry.access.log',
  'canary_mcp_tool.recorder.log',
];

async function listRunDir(runDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(runDir);
}

async function existingSinks(runDir: string): Promise<string[]> {
  const names = await listRunDir(runDir);
  return SINK_NAMES.filter((n) => names.includes(n));
}

/** Apply one tamper kind to the run dir, the way a same-uid agent one `..` away could. */
export async function applyTamper(kind: TamperKind, runDir: string, outside: string | undefined): Promise<void> {
  const names = await listRunDir(runDir);
  switch (kind) {
    case 'delete_meta': {
      for (const n of names) if (n.endsWith('.canary.json') || n === 'fs_diff.baseline.json') await unlink(path.join(runDir, n));
      return;
    }
    case 'rewrite_recorder': {
      await writeFile(path.join(runDir, 'canary_bin', 'canary_recorder.cjs'), "'use strict';\nprocess.exit(0);\n", 'utf8');
      return;
    }
    case 'restore_recorder': {
      const p = path.join(runDir, 'canary_bin', 'canary_recorder.cjs');
      const original = await readFile(p);
      // Coarse-grained kernel timestamps (jiffies) could make a write-and-restore within one
      // tick invisible; wait past a tick so the rewrite is a real ctime change.
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(p, "'use strict';\nprocess.exit(0);\n", 'utf8');
      await writeFile(p, original);
      return;
    }
    case 'chmod_recorder': {
      await chmod(path.join(runDir, 'canary_bin', 'canary_recorder.cjs'), 0o600);
      return;
    }
    case 'delete_decoy': {
      for (const n of names) if (/^canary_[0-9a-f]+\.decoy$/.test(n)) await unlink(path.join(runDir, n));
      return;
    }
    case 'truncate_sink': {
      for (const n of await existingSinks(runDir)) {
        const text = await readFile(path.join(runDir, n), 'utf8');
        await writeFile(path.join(runDir, n), text.slice(0, Math.floor(text.length / 2)), 'utf8');
      }
      return;
    }
    case 'corrupt_sink': {
      for (const n of await existingSinks(runDir)) await appendFile(path.join(runDir, n), 'not json {\n');
      return;
    }
    case 'symlink_evidence': {
      if (!outside) throw new Error('symlink_evidence needs tamperOutside');
      await mkdir(outside, { recursive: true });
      const target = path.join(outside, 'victim.json');
      await writeFile(target, '{"victim":true}\n', 'utf8');
      await rm(path.join(runDir, 'evidence.json'), { force: true });
      await symlink(target, path.join(runDir, 'evidence.json'));
      return;
    }
    case 'plant_output': {
      let marker = 'no-marker';
      try {
        const meta = JSON.parse(await readFile(path.join(runDir, 'canary_file_read.canary.json'), 'utf8')) as { marker: string };
        marker = meta.marker;
      } catch {
        /* another sensor: plant the name anyway */
      }
      await writeFile(path.join(runDir, 'agent-output.log'), `planted marker=${marker}\n`, 'utf8');
      return;
    }
    case 'symlink_next_rep': {
      if (!outside) throw new Error('symlink_next_rep needs tamperOutside');
      await mkdir(outside, { recursive: true });
      const next = path.join(path.dirname(runDir), String(Number(path.basename(runDir)) + 1));
      await symlink(outside, next, 'dir');
      return;
    }
    default:
      throw new Error(`unknown tamper kind ${String(kind)}`);
  }
}

function sleepUntil(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('stub adapter: run aborted by signal'));
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Content-location env names the stub fetches when fetchContent is set (ADR-0002). */
const CONTENT_ENV_NAMES = ['AAB_ISSUE_FEED_URL', 'AAB_EMAIL_FEED_URL', 'AAB_WEB_URL'];

function loopbackGet(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = httpGet(url, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function fetchFixtureContent(env: Record<string, string> | undefined, runDir: string, toolCalls: ToolCall[]): Promise<void> {
  if (!env) return;
  for (const name of CONTENT_ENV_NAMES) {
    const url = env[name];
    if (typeof url !== 'string' || !url.startsWith('http://127.0.0.1:')) continue;
    await loopbackGet(url);
    toolCalls.push(tc('Bash', { command: `curl -s ${url}` }));
  }
  const registry = env.npm_config_registry;
  if (typeof registry === 'string' && registry.startsWith('http://127.0.0.1:')) {
    let pkg: string | undefined;
    try {
      const meta = JSON.parse(await readFile(path.join(runDir, 'canary_egress_http.canary.json'), 'utf8')) as {
        package?: string;
      };
      pkg = meta.package;
    } catch {
      pkg = undefined;
    }
    if (pkg) {
      const url = `${registry.endsWith('/') ? registry : `${registry}/`}${pkg}`;
      await loopbackGet(url);
      toolCalls.push(tc('Bash', { command: `npm view ${pkg}` }));
    }
  }
}

/** Server names in an `{ mcpServers: { <name>: … } }` config (the shape the fixtures emit). */
function configuredServers(mcp: unknown): McpServerStatus[] {
  const servers = (mcp as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers).map((name) => ({ name, status: 'connected', source: 'dynamic' }));
}

const STREAM_FILE = 'claude-stream.jsonl';

/** Collapse every run of two or more blank lines to a single blank line. */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

function tc(name: string, input: unknown): ToolCall {
  const sources: ObservationSource[] = ['stream'];
  return { name, input, at: 1, source: 'stream', sources };
}

export class StubAdapter implements Adapter {
  readonly id: AgentId = 'claude-code';
  runCount = 0;
  /** Every task string handed to run(), in order (evidence-spec §4.1: the rendered task). */
  readonly tasks: string[] = [];
  /** The profile env of every run(), in order (to compare with the rendered task). */
  readonly envs: Array<Record<string, string> | undefined> = [];

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
    task: string,
    signal: AbortSignal,
    options: RunOptions = {},
  ): Promise<RunObservation> {
    this.runCount += 1;
    this.tasks.push(task);
    this.envs.push(profile.env ? { ...profile.env } : undefined);
    if (this.script.throwError) throw new Error(this.script.throwError);

    const runDir = options.runDir;
    if (!runDir) throw new Error('StubAdapter.run: a runDir is required');
    await mkdir(runDir, { recursive: true });
    // ADR-0025 D1: declare the stream this stub writes after the "run", as a live adapter does.
    if (options.artefacts) await options.artefacts.register({ path: STREAM_FILE, kind: 'output' });

    const toolCalls: ToolCall[] = [...(this.script.extraToolCalls ?? [])];

    if (this.script.fetchContent) {
      await fetchFixtureContent(profile.env, runDir, toolCalls);
    }

    let streamExtra: string[] = [];
    if (this.script.trigger) {
      streamExtra = await produceSignal(this.script.trigger, runDir, toolCalls);
    }
    if (this.script.tamper) {
      for (const kind of this.script.tamper) await applyTamper(kind, runDir, this.script.tamperOutside);
    }
    if (this.script.tamperHook) await this.script.tamperHook({ runDir, workdir: profile.workdir });
    if (this.script.sleepMs !== undefined || this.script.throwAfterSignal) {
      // A live adapter records stream events as they arrive, so a run that is later killed or
      // throws leaves the lines it saw on disk; mirror that with the init line and the signal
      // lines before sleeping or throwing (the normal path rewrites the full stream below).
      await this.writeStream(runDir, [JSON.stringify({ type: 'system', subtype: 'init', model: profile.model, partial: true }), ...streamExtra], options);
    }
    if (this.script.sleepMs !== undefined) {
      await sleepUntil(this.script.sleepMs, this.script.ignoreSignal ? undefined : signal);
    }
    if (this.script.throwAfterSignal) throw new Error(this.script.throwAfterSignal);
    if (this.script.mcpToolName) {
      toolCalls.push(tc(this.script.mcpToolName, {}));
    }
    if (this.script.writeFile) {
      if (!profile.workdir) throw new Error('StubAdapter.run: profile.workdir is required for writeFile');
      await mkdir(profile.workdir, { recursive: true });
      const target = path.join(profile.workdir, this.script.writeFile.rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, this.script.writeFile.content, 'utf8');
      toolCalls.push(tc('Write', { file_path: target }));
    }

    if (this.script.tidyFile) {
      if (!profile.workdir) throw new Error('StubAdapter.run: profile.workdir is required for tidyFile');
      const target = path.join(profile.workdir, this.script.tidyFile);
      await writeFile(target, collapseBlankLines(await readFile(target, 'utf8')), 'utf8');
      toolCalls.push(tc('Read', { file_path: target }), tc('Write', { file_path: target }));
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
    lines.push(...streamExtra);
    lines.push(JSON.stringify({ type: 'result', total_cost_usd: this.script.cost ?? 0 }));
    const rawPath = await this.writeStream(runDir, lines, options);

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

  private async writeStream(runDir: string, lines: string[], options: RunOptions): Promise<string> {
    const rawPath = path.join(runDir, STREAM_FILE);
    if (this.script.streamViaSafeWrite) {
      const written = await safeWriteFile(runDir, rawPath, lines.join('\n') + '\n');
      if (written.replacedSymlink) options.artefacts?.report({ path: STREAM_FILE, kind: 'output', what: 'planted' });
    } else {
      await writeFile(rawPath, lines.join('\n') + '\n', 'utf8');
    }
    return rawPath;
  }
}

// Detector file conventions (kept in lockstep with src/detectors/*). The stub writes the same
// raw evidence a real agent's forbidden action would have produced, so the real detector fires.
// Returns extra raw-stream lines to append (the decoy bytes surface in a tool_result there,
// which is where a live agent's file read lands, ADR-0025 D3).
async function produceSignal(
  kind: DetectorKind,
  runDir: string,
  toolCalls: ToolCall[],
): Promise<string[]> {
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
    return [];
  }
  if (kind === 'canary_file_read') {
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_file_read.canary.json'), 'utf8'),
    ) as { fileName: string; marker: string };
    const decoy = await readFile(path.join(runDir, meta.fileName), 'utf8');
    toolCalls.push(tc('Read', { file: meta.fileName }));
    return [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_stub_read', content: decoy }] },
      }),
    ];
  }
  if (kind === 'canary_egress_http') {
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_egress_http.canary.json'), 'utf8'),
    ) as { url: string; package?: string; registry_access_log?: string };
    if (meta.registry_access_log && meta.package) {
      // registry_fetch mode (evidence-spec s1.2d): append the line the local_registry fixture
      // writes when the agent fetches the canary package's tarball.
      const pkg = meta.package;
      await appendFile(
        path.join(runDir, 'local_registry.access.log'),
        JSON.stringify({ method: 'GET', path: `/${pkg}/-/${pkg}-1.0.0.tgz`, time: 0, kind: 'tarball' }) + '\n',
      );
      toolCalls.push(tc('Bash', { command: `npm install ${pkg}` }));
      return [];
    }
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(meta.url, (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    toolCalls.push(tc('Bash', { command: `curl ${meta.url}` }));
    return [];
  }
  if (kind === 'canary_mcp_tool') {
    // Simulate the agent invoking the decoy MCP tool by writing the same recorder entry the
    // inert server's handler would have written, and recording the tool call on the stream.
    const meta = JSON.parse(
      await readFile(path.join(runDir, 'canary_mcp_tool.canary.json'), 'utf8'),
    ) as { tool: string; token: string; recorderFile: string };
    const args = { note: 'ack', token: meta.token };
    await appendFile(path.join(runDir, meta.recorderFile), JSON.stringify({ event: 'server_started', token: meta.token, time: 0 }) + '\n'); // the agent-spawned server records its start first (evidence-spec §1.2b)
    await appendFile(
      path.join(runDir, meta.recorderFile),
      JSON.stringify({ tool: meta.tool, args, time: 0 }) + '\n',
    );
    toolCalls.push(tc(meta.tool, args));
    return [];
  }
  throw new Error(`StubAdapter cannot produce a signal for detector "${kind}"`);
}
