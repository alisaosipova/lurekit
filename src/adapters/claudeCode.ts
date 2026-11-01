// Claude Code adapter (evidence-spec §4). Pure plumbing: launch `claude -p` headless under
// a SetupProfile, observe the run on two layers, and return a RunObservation. It carries no
// attack content — the task string and the fixtures carry the scenario, not the adapter.
//
// Two invariants (§4.1): (1) never loosen the profile — permission_mode is passed through
// verbatim via --permission-mode and never substituted for a looser one; (2) observe, do not
// steer — the installed PreToolUse/PostToolUse hooks only append their stdin to a log and
// exit 0, never blocking a call.
//
// Observation layers merged by tool_use_id (§4.2):
//   stream  — `--output-format stream-json --verbose`; assistant.tool_use blocks + result cost.
//   hook    — a PreToolUse/PostToolUse hook the adapter installs into the profile's
//             .claude/settings.json; the hook appends its stdin JSON to <runDir>/claude-hooks.jsonl.
//
// Determinism (§4.5): given the same profile, task and recorded stream, the adapter produces
// the same RunObservation. Tests drive a stub agent binary; no live agent, network or spend.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import type {
  Adapter,
  ObservationSource,
  RunObservation,
  RunOptions,
  SetupProfile,
  ToolCall,
} from './adapter.js';
import type { AgentId } from '../scenario/types.js';

const STREAM_FILE = 'claude-stream.jsonl';
const HOOKS_FILE = 'claude-hooks.jsonl';
const HOOK_SCRIPT = 'aab-hook.cjs';

/** Env var that overrides the `claude` binary path (so tests point at a stub). */
export const CLAUDE_BIN_ENV = 'AAB_CLAUDE_BIN';

export interface ClaudeCodeAdapterOptions {
  bin?: string;      // explicit binary path; else env override; else 'claude' on PATH
  runDir?: string;   // default run dir if run() is not given one
}

interface HookEntry {
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  transcript_path?: string;
  aab_hook_at?: number;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly id: AgentId = 'claude-code';
  private readonly binOverride?: string;
  private readonly defaultRunDir?: string;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binOverride = opts.bin;
    this.defaultRunDir = opts.runDir;
  }

  capabilities(): {
    headless: boolean;
    observes: ObservationSource[];
    can_pin_version: boolean;
    can_pin_model: boolean;
  } {
    // §4.4.
    return {
      headless: true,
      observes: ['stream', 'hook'],
      can_pin_version: true,
      can_pin_model: true,
    };
  }

  /** Resolve the binary: constructor arg > env override > 'claude' on PATH. */
  private bin(): string {
    return this.binOverride ?? process.env[CLAUDE_BIN_ENV] ?? 'claude';
  }

  async run(
    profile: SetupProfile,
    task: string,
    signal: AbortSignal,
    options: RunOptions = {},
  ): Promise<RunObservation> {
    const runDir = options.runDir ?? this.defaultRunDir;
    if (!runDir) {
      throw new Error('ClaudeCodeAdapter.run: a runDir is required (pass options.runDir or construct with { runDir })');
    }
    const usedBare = options.bare === true; // §4.3: default NOT used.
    await mkdir(runDir, { recursive: true });

    const warnings: string[] = [];
    const bin = this.bin();

    // Version assertion (§4.4): record the running version, warn (non-fatal) on mismatch.
    const agentVersionReported = this.probeVersion(bin);
    if (agentVersionReported && !versionMatches(profile.agent_version, agentVersionReported)) {
      warnings.push(
        `agent version mismatch: profile pins ${profile.agent_version}, binary reports ${agentVersionReported}`,
      );
    } else if (!agentVersionReported) {
      warnings.push('could not read agent version from `--version`');
    }

    // Install the observation hook into the profile's .claude/settings.json BEFORE launch.
    const hooksJsonlPath = path.join(runDir, HOOKS_FILE);
    const hookScriptPath = path.join(runDir, HOOK_SCRIPT);
    await writeFile(hookScriptPath, hookScriptSource(hooksJsonlPath), 'utf8');
    await this.installHook(profile.workdir, hookScriptPath);

    // Build headless argv (§4.2/§4.3). permission_mode passed verbatim; never loosened.
    const argv = ['-p', task, '--output-format', 'stream-json', '--verbose', '--model', profile.model];
    if (profile.permission_mode !== undefined) {
      // §4.1 invariant 1: pass the profile's mode through as-is. Only ever reach for the
      // --dangerously-skip-permissions flag when the profile's mode literally asks for it.
      if (profile.permission_mode === 'dangerously-skip-permissions') {
        argv.push('--dangerously-skip-permissions');
      } else {
        argv.push('--permission-mode', profile.permission_mode);
      }
    }
    if (usedBare) argv.push('--bare');

    const env = { ...process.env, ...(profile.env ?? {}) };

    const startedAt = Date.now();
    const perfStart = performance.now();

    const streamCalls: ToolCall[] = [];
    let effectiveModel: string | undefined;
    let effectivePermissionMode: string | undefined;
    let mcpServers: unknown;
    let costUsd: number | undefined;
    const stdoutChunks: Buffer[] = [];
    let lineBuffer = '';

    const handleLine = (line: string): void => {
      const text = line.trim();
      if (!text) return;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return; // not JSON — keep raw in the file, skip for parsing
      }
      const at = performance.now() - perfStart;
      const type = evt.type;
      if (type === 'system' && evt.subtype === 'init') {
        effectiveModel = typeof evt.model === 'string' ? evt.model : effectiveModel;
        // system/init uses permissionMode (camelCase); accept snake_case defensively.
        const pm = (evt.permissionMode ?? evt.permission_mode) as unknown;
        if (typeof pm === 'string') effectivePermissionMode = pm;
        if ('mcp_servers' in evt) mcpServers = evt.mcp_servers;
      } else if (type === 'assistant') {
        const msg = evt.message as { content?: unknown } | undefined;
        const content = Array.isArray(msg?.content) ? msg!.content : [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block && block.type === 'tool_use') {
            streamCalls.push({
              id: typeof block.id === 'string' ? block.id : undefined,
              name: typeof block.name === 'string' ? block.name : 'unknown',
              input: block.input,
              at,
              source: 'stream',
              sources: ['stream'],
            });
          }
        }
      } else if (type === 'result') {
        if (typeof evt.total_cost_usd === 'number') costUsd = evt.total_cost_usd;
      }
    };

    const isNodeScript = /\.(mjs|cjs|js)$/i.test(bin);
    const cmd = isNodeScript ? process.execPath : bin;
    const spawnArgs = isNodeScript ? [bin, ...argv] : argv;

    const child = spawn(cmd, spawnArgs, {
      cwd: profile.workdir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = (): void => {
      // Honour the AbortSignal: kill the child (observe, never hang).
      child.kill('SIGKILL');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const exitCode: number = await new Promise<number>((resolve) => {
      child.stdout.on('data', (buf: Buffer) => {
        stdoutChunks.push(buf);
        lineBuffer += buf.toString('utf8');
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, idx);
          lineBuffer = lineBuffer.slice(idx + 1);
          handleLine(line);
        }
      });
      // Drain stderr so the pipe never blocks; contents are not evidence.
      child.stderr.on('data', () => {});
      child.on('error', () => {
        warnings.push(`failed to spawn agent binary "${bin}"`);
        resolve(-1);
      });
      child.on('close', (code, sig) => {
        if (lineBuffer.length > 0) handleLine(lineBuffer);
        if (code !== null) resolve(code);
        else if (sig) resolve(128 + (signalNumber(sig) ?? 0));
        else resolve(-1);
      });
    });

    signal.removeEventListener('abort', onAbort);

    const endedAt = Date.now();

    // Persist stdout verbatim (raw_events_path).
    const rawPath = path.join(runDir, STREAM_FILE);
    await writeFile(rawPath, Buffer.concat(stdoutChunks));

    // Read the hook log and merge stream + hook by tool_use_id.
    const hookEntries = await readJsonl<HookEntry>(hooksJsonlPath);
    let transcriptPath: string | undefined;
    const hookCalls: ToolCall[] = [];
    for (const entry of hookEntries) {
      if (!transcriptPath && typeof entry.transcript_path === 'string') {
        transcriptPath = entry.transcript_path;
      }
      const at =
        typeof entry.aab_hook_at === 'number' ? Math.max(0, entry.aab_hook_at - startedAt) : 0;
      hookCalls.push({
        id: typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined,
        name: typeof entry.tool_name === 'string' ? entry.tool_name : 'unknown',
        input: entry.tool_input,
        at,
        source: 'hook',
        sources: ['hook'],
      });
    }

    const toolCalls = mergeById(streamCalls, hookCalls);

    const obs: RunObservation = {
      transcript_path: transcriptPath,
      raw_events_path: rawPath,
      tool_calls: toolCalls,
      exit_code: exitCode,
      cost_usd: costUsd,
      started_at: startedAt,
      ended_at: endedAt,
      effective_model: effectiveModel,
      effective_permission_mode: effectivePermissionMode,
      mcp_servers: mcpServers,
      used_bare: usedBare,
      agent_version_reported: agentVersionReported,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
    return obs;
  }

  /** Run `<bin> --version` synchronously; return the reported version string or undefined. */
  private probeVersion(bin: string): string | undefined {
    const isNodeScript = /\.(mjs|cjs|js)$/i.test(bin);
    const cmd = isNodeScript ? process.execPath : bin;
    const args = isNodeScript ? [bin, '--version'] : ['--version'];
    try {
      const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
      if (res.error || typeof res.stdout !== 'string') return undefined;
      const out = res.stdout.trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }

  /** Install the observation hook into <workdir>/.claude/settings.json, preserving any
   *  hooks the profile already carries (the profile's config is the variable under test).
   *  The hook command only appends its stdin JSON and exits 0 (§4.1 invariant 2). */
  private async installHook(workdir: string, hookScriptPath: string): Promise<void> {
    const settingsDir = path.join(workdir, '.claude');
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, 'settings.json');

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
    const hooks = (settings.hooks && typeof settings.hooks === 'object'
      ? settings.hooks
      : {}) as Record<string, unknown>;

    // Quote both node and the script path so spaces in paths survive the shell.
    const command = `"${process.execPath}" "${hookScriptPath}"`;
    const observe = { matcher: '*', hooks: [{ type: 'command', command }] };

    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      hooks[event] = [...existing, observe];
    }
    settings.hooks = hooks;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }
}

/** Merge stream and hook tool calls by tool_use_id into one ToolCall per id, recording every
 *  layer that saw it in `sources`. A call seen only on stream is still included (§4.2). Calls
 *  with no id are kept as-is (never collapsed together). Stream order is preserved; hook-only
 *  calls are appended. */
function mergeById(streamCalls: ToolCall[], hookCalls: ToolCall[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  const ordered: ToolCall[] = [];

  const add = (call: ToolCall): void => {
    const id = call.id;
    if (!id) {
      ordered.push(call);
      return;
    }
    const existing = byId.get(id);
    if (!existing) {
      const copy: ToolCall = { ...call, sources: [...(call.sources ?? [call.source])] };
      byId.set(id, copy);
      ordered.push(copy);
      return;
    }
    for (const s of call.sources ?? [call.source]) {
      if (!existing.sources!.includes(s)) existing.sources!.push(s);
    }
    // Fill fields the earlier sighting lacked (hook input/name is equally authoritative).
    if (existing.input === undefined && call.input !== undefined) existing.input = call.input;
    if (existing.name === 'unknown' && call.name !== 'unknown') existing.name = call.name;
  };

  for (const c of streamCalls) add(c);
  for (const c of hookCalls) add(c);

  // Normalise `source` to the strongest-ordered layer actually seen (back-compat field).
  const priority: ObservationSource[] = ['stream', 'hook', 'proxy'];
  for (const call of ordered) {
    const seen = call.sources ?? [call.source];
    call.source = priority.find((p) => seen.includes(p)) ?? call.source;
  }
  return ordered;
}

/** The hook script: reads stdin, appends the payload (plus a receive timestamp) to the run
 *  dir's hook log, and ALWAYS exits 0 — observation, never a block (§4.1 invariant 2). */
function hookScriptSource(hooksJsonlPath: string): string {
  return `#!/usr/bin/env node
'use strict';
// agent-attack-bench observation hook (evidence-spec §4.2). Appends the PreToolUse/PostToolUse
// stdin JSON to the run dir's hook log and exits 0. It never blocks a tool call.
const fs = require('node:fs');
const OUT = ${JSON.stringify(hooksJsonlPath)};
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const text = data.trim();
    let line;
    if (text) {
      try {
        const obj = JSON.parse(text);
        obj.aab_hook_at = Date.now();
        line = JSON.stringify(obj);
      } catch (_e) {
        line = text; // not JSON — append verbatim
      }
      fs.appendFileSync(OUT, line + '\\n');
    }
  } catch (_e) { /* swallow: the hook must never fail the call */ }
  process.exit(0);
});
`;
}

/** Parse a newline-delimited JSON file, tolerating a missing file and skipping blank/corrupt
 *  lines. Inlined (not imported from detectors) so the adapter has no dependency on them. */
async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text) as T);
    } catch {
      // corrupt line — skip
    }
  }
  return out;
}

/** True when the version the binary reports is consistent with the profile's pinned version.
 *  Compares the dotted semver found in each string; a profile like
 *  "@anthropic-ai/claude-code@2.1.309" matches a report of "2.1.309 (Claude Code)". */
function versionMatches(pinned: string, reported: string): boolean {
  const a = semverOf(pinned);
  const b = semverOf(reported);
  if (!a || !b) return false;
  return a === b;
}

function semverOf(s: string): string | undefined {
  const m = s.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : undefined;
}

/** Map a signal name to its number for a 128+n exit-code convention. */
function signalNumber(sig: NodeJS.Signals): number | undefined {
  const n = (osConstants.signals as Record<string, number>)[sig];
  return typeof n === 'number' ? n : undefined;
}
