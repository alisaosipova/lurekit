// Control-sensor soundness tests (evidence-spec §1.3). For each detector we run its
// self-test (positive + negative control) and require both to pass — a sensor that could
// silently miss its own signal is exactly the failure mode these controls rule out. We
// also prove each evaluate() is genuinely evidence-driven (a "blinded" sensor that ignored
// its log/output would return 0 on a signal-bearing artefact, i.e. its positive control
// would be false). Everything stays on loopback / temp dirs and is cleaned up in afterEach.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ToolCall } from '../src/adapters/adapter.js';
import type { DetectorHit } from '../src/detectors/detector.js';
import {
  CanaryEgressHttpDetector,
  CanaryFileReadDetector,
  CanaryCommandDetector,
  CanaryMcpToolDetector,
  getDetector,
  IMPLEMENTED_DETECTORS,
} from '../src/detectors/index.js';

const tmpDirs: string[] = [];
async function runDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('detector self-tests (positive + negative controls)', () => {
  it('canary_egress_http is sound', async () => {
    expect(await new CanaryEgressHttpDetector().selfTest()).toEqual({ positive: true, negative: true });
  });

  it('canary_file_read is sound', async () => {
    expect(await new CanaryFileReadDetector().selfTest()).toEqual({ positive: true, negative: true });
  });

  it('canary_command is sound', async () => {
    expect(await new CanaryCommandDetector().selfTest()).toEqual({ positive: true, negative: true });
  });

  it('canary_mcp_tool is sound', async () => {
    expect(await new CanaryMcpToolDetector().selfTest()).toEqual({ positive: true, negative: true });
  });
});

// §1.3 is only meaningful if the self-test actually CATCHES a sensor that misses its
// signal. We prove that empirically: blind each detector by overriding evaluate() to
// always return [] (the canonical "silently misses its own signal" failure), then run
// its real selfTest(). The positive control MUST flip to false — a blinded sensor whose
// selfTest still reported positive:true would be unsound. The negative control stays
// true (0 hits on no signal is still correct), so the signal that catches the fault is
// specifically positive:false.
class BlindedEgress extends CanaryEgressHttpDetector {
  async evaluate(): Promise<DetectorHit[]> {
    return [];
  }
}
class BlindedFileRead extends CanaryFileReadDetector {
  async evaluate(): Promise<DetectorHit[]> {
    return [];
  }
}
class BlindedCommand extends CanaryCommandDetector {
  async evaluate(): Promise<DetectorHit[]> {
    return [];
  }
}
class BlindedMcpTool extends CanaryMcpToolDetector {
  async evaluate(): Promise<DetectorHit[]> {
    return [];
  }
}

describe('selfTest catches a blinded sensor (§1.3 soundness, proven empirically)', () => {
  it('canary_egress_http: blinded evaluate -> positive control fails', async () => {
    const result = await new BlindedEgress().selfTest();
    expect(result.positive).toBe(false);
    // and the sound detector passes the same positive control:
    expect((await new CanaryEgressHttpDetector().selfTest()).positive).toBe(true);
  });

  it('canary_file_read: blinded evaluate -> positive control fails', async () => {
    const result = await new BlindedFileRead().selfTest();
    expect(result.positive).toBe(false);
    expect((await new CanaryFileReadDetector().selfTest()).positive).toBe(true);
  });

  it('canary_command: blinded evaluate -> positive control fails', async () => {
    const result = await new BlindedCommand().selfTest();
    expect(result.positive).toBe(false);
    expect((await new CanaryCommandDetector().selfTest()).positive).toBe(true);
  });

  it('canary_mcp_tool: blinded evaluate -> positive control fails', async () => {
    const result = await new BlindedMcpTool().selfTest();
    expect(result.positive).toBe(false);
    expect((await new CanaryMcpToolDetector().selfTest()).positive).toBe(true);
  });
});

describe('detector registry', () => {
  it('maps the four implemented kinds and builds the right classes', () => {
    expect(IMPLEMENTED_DETECTORS.sort()).toEqual(
      ['canary_command', 'canary_egress_http', 'canary_file_read', 'canary_mcp_tool'],
    );
    expect(getDetector('canary_egress_http')).toBeInstanceOf(CanaryEgressHttpDetector);
    expect(getDetector('canary_file_read')).toBeInstanceOf(CanaryFileReadDetector);
    expect(getDetector('canary_command')).toBeInstanceOf(CanaryCommandDetector);
    expect(getDetector('canary_mcp_tool')).toBeInstanceOf(CanaryMcpToolDetector);
  });

  it('throws a clear error for a kind not implemented in 0.1', () => {
    expect(() => getDetector('fs_diff')).toThrow(/not implemented/);
    expect(() => getDetector('canary_egress_dns')).toThrow(/not implemented/);
  });
});

describe('evaluate() is evidence-driven (blinded sensor would fail)', () => {
  it('canary_egress_http: empty log -> 0 hits; token in log -> 1 hit; untokened traffic ignored', async () => {
    const dir = await runDir('aab-egress-direct-');
    const det = new CanaryEgressHttpDetector();
    const { canaries, teardown } = await det.provision('direct', dir);
    await teardown(); // close the server but keep the provisioned evidence files

    // No request logged yet.
    expect(await det.evaluate({ runDir: dir, toolCalls: [] })).toHaveLength(0);

    // A request carrying the per-run token -> exactly one hit.
    const logPath = path.join(dir, 'canary_egress_http.access.log');
    await appendFile(
      logPath,
      `${JSON.stringify({ method: 'GET', url: `/c/${canaries.token}?x=1`, time: Date.now() })}\n`,
    );
    const hits = await det.evaluate({ runDir: dir, toolCalls: [] });
    expect(hits).toHaveLength(1);
    expect(hits[0].matched.token).toBe(canaries.token);
    expect(hits[0].evidence_ref).toContain('canary_egress_http.access.log');

    // Benign traffic without the token is not a hit (negative-control guard, §1.4).
    await appendFile(
      logPath,
      `${JSON.stringify({ method: 'GET', url: '/health', time: Date.now() })}\n`,
    );
    expect(await det.evaluate({ runDir: dir, toolCalls: [] })).toHaveLength(1);
  });

  it('canary_file_read: fires on marker in captured output and attributes the read', async () => {
    const dir = await runDir('aab-fileread-direct-');
    const det = new CanaryFileReadDetector();
    const { canaries, teardown } = await det.provision('direct', dir);

    // Nothing read the decoy yet.
    expect(await det.evaluate({ runDir: dir, toolCalls: [] })).toHaveLength(0);

    // The marker surfaces in captured output, as a real tool_result would carry it.
    await appendFile(path.join(dir, 'agent-output.log'), `tool output: marker=${canaries.marker}\n`);
    const toolCalls: ToolCall[] = [
      { name: 'Read', input: { file: canaries.path }, at: 3, source: 'stream' },
    ];
    const hits = await det.evaluate({ runDir: dir, toolCalls });
    expect(hits).toHaveLength(1);
    expect(hits[0].matched.via).toBe('captured_output');
    expect(hits[0].attributed_tool_call?.name).toBe('Read');

    await teardown();
  });

  it('canary_command: empty recorder -> 0 hits; a recorded invocation -> 1 hit attributed by argv', async () => {
    const dir = await runDir('aab-command-direct-');
    const det = new CanaryCommandDetector();
    const { canaries, teardown } = await det.provision('direct', dir);

    // Command provisioned but never invoked.
    expect(await det.evaluate({ runDir: dir, toolCalls: [] })).toHaveLength(0);

    // A recorded invocation -> one hit, attributed to the matching shell tool call.
    await appendFile(
      canaries.recorderPath,
      `${JSON.stringify({ command: canaries.command, argv: ['--flag', 'val'], time: Date.now() })}\n`,
    );
    const toolCalls: ToolCall[] = [
      { name: 'Bash', input: { command: `${canaries.command} --flag val` }, at: 7, source: 'stream' },
    ];
    const hits = await det.evaluate({ runDir: dir, toolCalls });
    expect(hits).toHaveLength(1);
    expect(hits[0].matched.command).toBe(canaries.command);
    expect(hits[0].attributed_tool_call?.name).toBe('Bash');

    await teardown();
  });
});
