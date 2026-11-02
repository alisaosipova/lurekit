// Replay adapter (ADR-0015). Re-drives a recorded Claude Code run offline through the SAME
// parse/merge code the live adapter uses (observeClaudeRun, evidence-spec §4.2/§4.5). It spawns
// no process and touches no network: run() copies the recording into the run dir and parses it.
//
// Recording layout (a directory):
//   claude-stream.jsonl  required  verbatim `--output-format stream-json --verbose` stdout
//   claude-hooks.jsonl   optional  the observation hook's log from the same run
//   recording.json       optional  { exit_code?, started_at?, ended_at?, agent_version_reported? }

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  Adapter,
  ObservationSource,
  RunObservation,
  RunOptions,
  SetupProfile,
} from './adapter.js';
import type { AgentId } from '../scenario/types.js';
import { observeClaudeRun } from './claudeCode.js';

export const REPLAY_STREAM_FILE = 'claude-stream.jsonl';
export const REPLAY_HOOKS_FILE = 'claude-hooks.jsonl';
export const REPLAY_META_FILE = 'recording.json';
export const REPLAY_WARNING =
  'replayed from a recording (ADR-0015): no live agent ran; not a benchmark result';

export interface ReplayAdapterOptions {
  recordingDir: string;
}

interface RecordingMeta {
  exit_code?: number;
  started_at?: number;
  ended_at?: number;
  agent_version_reported?: string;
}

export class ReplayAdapter implements Adapter {
  readonly id: AgentId = 'claude-code';
  private readonly recordingDir: string;

  constructor(opts: ReplayAdapterOptions) {
    this.recordingDir = opts.recordingDir;
  }

  capabilities(): {
    headless: boolean;
    observes: ObservationSource[];
    can_pin_version: boolean;
    can_pin_model: boolean;
  } {
    // Same observation layers as the live run it was recorded from (§4.4).
    return { headless: true, observes: ['stream', 'hook'], can_pin_version: true, can_pin_model: true };
  }

  async run(
    _profile: SetupProfile,
    _task: string,
    _signal: AbortSignal,
    options: RunOptions = {},
  ): Promise<RunObservation> {
    const runDir = options.runDir;
    if (!runDir) throw new Error('ReplayAdapter.run: options.runDir is required');
    await mkdir(runDir, { recursive: true });

    const srcStream = path.join(this.recordingDir, REPLAY_STREAM_FILE);
    let streamText: string;
    try {
      streamText = await readFile(srcStream, 'utf8');
    } catch {
      throw new Error(`ReplayAdapter: recording has no ${REPLAY_STREAM_FILE} in ${this.recordingDir}`);
    }
    const rawPath = path.join(runDir, REPLAY_STREAM_FILE);
    await copyFile(srcStream, rawPath);

    let hooksText: string | undefined;
    const srcHooks = path.join(this.recordingDir, REPLAY_HOOKS_FILE);
    try {
      hooksText = await readFile(srcHooks, 'utf8');
      await copyFile(srcHooks, path.join(runDir, REPLAY_HOOKS_FILE));
    } catch {
      hooksText = undefined; // optional
    }

    const meta = await readMeta(path.join(this.recordingDir, REPLAY_META_FILE));
    return observeClaudeRun({
      streamText,
      hooksText,
      rawEventsPath: rawPath,
      exitCode: typeof meta.exit_code === 'number' ? meta.exit_code : 0,
      startedAt: typeof meta.started_at === 'number' ? meta.started_at : 0,
      endedAt: typeof meta.ended_at === 'number' ? meta.ended_at : 0,
      usedBare: false,
      agentVersionReported:
        typeof meta.agent_version_reported === 'string' ? meta.agent_version_reported : undefined,
      // Provenance marker (ADR-0015): lands in evidence.json observation.warnings so a replayed
      // run can never be mistaken for a live benchmark result.
      warnings: [REPLAY_WARNING],
    });
  }
}

async function readMeta(file: string): Promise<RecordingMeta> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error(`ReplayAdapter: ${file} is not a JSON object`);
  return parsed as RecordingMeta;
}
