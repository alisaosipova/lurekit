// Replay adapter (ADR-0015). Re-drives a recorded Claude Code run offline through the SAME
// parse/merge code the live adapter uses (observeClaudeRun, evidence-spec §4.2/§4.5). It spawns
// no process and touches no network: run() copies the recording into the run dir and parses it.
//
// Recording layout (a directory):
//   claude-stream.jsonl  required  verbatim `--output-format stream-json --verbose` stdout
//   claude-hooks.jsonl   optional  the observation hook's log from the same run
//   recording.json       optional  { exit_code?, started_at?, ended_at?, agent_version_reported?,
//                                    fixtures? }
// `fixtures` (optional, evidence-spec s3.1 `content_fetched`) is the fixture content-delivery
// facts of the recorded run: [{ type, content_fetched, content_requests?, request_count? }].
// When present the runner evaluates a fixture's content_fetched precondition against it; when
// absent the precondition is not evaluable on a replay (no agent fetched anything) and the run
// carries a "precondition not evaluated" note next to REPLAY_WARNING instead of a verdict change.

import { mkdir, readFile } from 'node:fs/promises';
import { safeWriteFile } from '../runner/safeWrite.js';
import path from 'node:path';

import type {
  Adapter,
  FixtureDeliverySource,
  RecordedFixtureDelivery,
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
  fixtures?: unknown;
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
    let streamBytes: Buffer;
    try {
      streamBytes = await readFile(srcStream);
    } catch {
      throw new Error(`ReplayAdapter: recording has no ${REPLAY_STREAM_FILE} in ${this.recordingDir}`);
    }
    const streamText = streamBytes.toString('utf8');
    // ADR-0025 D1/D2: the copies are declared outputs (names only; nothing is verified on a
    // replay) and written symlink-safe, byte for byte.
    if (options.artefacts) {
      await options.artefacts.register({ path: REPLAY_STREAM_FILE, kind: 'output' });
      await options.artefacts.register({ path: REPLAY_HOOKS_FILE, kind: 'output' });
    }
    const rawPath = path.join(runDir, REPLAY_STREAM_FILE);
    await safeWriteFile(runDir, rawPath, streamBytes);

    let hooksText: string | undefined;
    const srcHooks = path.join(this.recordingDir, REPLAY_HOOKS_FILE);
    try {
      const hooksBytes = await readFile(srcHooks);
      hooksText = hooksBytes.toString('utf8');
      await safeWriteFile(runDir, REPLAY_HOOKS_FILE, hooksBytes);
    } catch {
      hooksText = undefined; // optional
    }

    const meta = await readMeta(path.join(this.recordingDir, REPLAY_META_FILE));
    const observation = observeClaudeRun({
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
    observation.fixture_delivery = fixtureDelivery(meta.fixtures);
    return observation;
  }
}

/** The recording's fixture-delivery facts (s3.1), validated; `not_observable` when absent. A
 *  malformed `fixtures` value is a broken recording and throws (adapter_error). */
export function fixtureDelivery(raw: unknown): FixtureDeliverySource {
  if (raw === undefined) return { source: 'not_observable' };
  if (!Array.isArray(raw)) throw new Error(`ReplayAdapter: ${REPLAY_META_FILE} fixtures is not an array`);
  const fixtures: RecordedFixtureDelivery[] = raw.map((e, i) => {
    const o = e as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.type !== 'string' || typeof o.content_fetched !== 'boolean') {
      throw new Error(
        `ReplayAdapter: ${REPLAY_META_FILE} fixtures[${i}] needs a string type and a boolean content_fetched`,
      );
    }
    const out: RecordedFixtureDelivery = { type: o.type, content_fetched: o.content_fetched };
    for (const k of ['content_requests', 'request_count'] as const) {
      const v = o[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error(`ReplayAdapter: ${REPLAY_META_FILE} fixtures[${i}].${k} is not a non-negative integer`);
      }
      out[k] = v;
    }
    return out;
  });
  return { source: 'recording', fixtures };
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
