// ADR-0018 amendment LV-7 (2026-11-06): in the live k=3 codex-cli run against a proxy serving a
// non-OpenAI model under an OpenAI name, codex 0.166.0 rejected every tool call the model emitted
// (`ERROR codex_core::tools::router: error=unsupported call: functions.exec` on stderr), exited 0,
// and every repetition scored degraded. These tests replay that stream through the real scenario
// AAB-004 and its fixtures on the stub binary.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { BenchmarkRunner, canScoreResisted, type RunConfig } from '../src/runner/runner.js';
import { loadScenarioDir } from '../src/scenario/load.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { CodexCliAdapter, countUnsupportedToolCalls, observeCodexRun } from '../src/adapters/codexCli.js';
import { fixturesForScenario } from '../src/fixtures/index.js';
import { classifyRep, diagnoseRun } from '../src/diagnose.js';
import { mkScratch } from './helpers/scratch.js';

const STUB = fileURLToPath(new URL('./fixtures/agents/stub-codex.mjs', import.meta.url));
const RECORDING = fileURLToPath(new URL('./fixtures/recordings/codex-unsupported-call.jsonl', import.meta.url));
const STDERR = fileURLToPath(new URL('./fixtures/recordings/codex-unsupported-call.stderr', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../scenarios', import.meta.url));

const WARNING =
  "agent rejected 3 tool call(s) from the model as unsupported (codex tools router); the model does not fit the CLI's tool protocol";

type AjvCtor = new (opts: Record<string, unknown>) => { compile<T = unknown>(schema: unknown): ValidateFunction<T> };
const Ajv2020 = ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? _Ajv2020) as AjvCtor;
const validateEvidence = new Ajv2020({ strict: false, allErrors: true }).compile(
  JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/evidence.schema.json', import.meta.url)), 'utf8')),
);

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const aab004 = () => {
  const s = loadScenarioDir(SCENARIOS).scenarios.find((x) => x.id === 'AAB-004');
  if (!s) throw new Error('AAB-004 missing from the corpus');
  return s;
};

const PLAIN = fileURLToPath(new URL('./fixtures/recordings/codex-no-tools-plain.jsonl', import.meta.url));
const MARKUP_WARNING = "the model wrote tool-call markup into its reply and no tool call ran; the model does not fit the CLI's tool protocol";

async function replay(opts: { stderr: boolean; runCanary?: boolean; recording?: string }): Promise<Record<string, any>> {
  const root = await mkScratch('aab-agent-fault-');
  roots.push(root);
  const profile: SetupProfile = {
    agent: 'codex-cli',
    agent_version: 'unpinned',
    model: 'gpt-6.1-sol',
    workdir: path.join(root, 'work'),
    env: {
      AAB_STUB_REPLAY: opts.recording ?? RECORDING,
      ...(opts.stderr ? { AAB_STUB_STDERR: STDERR } : {}),
      ...(opts.runCanary ? { AAB_STUB_RUN_CANARY: '1' } : {}),
    },
  };
  const cfg: RunConfig = { k: 1, vulnerable_if: 'any', mode: 'smoke', isolation: 'container', resultsRoot: root };
  const runner = new BenchmarkRunner({ ids: { benchmarkRunId: 'BRF', runId: (s, k) => `BRF:${s}:${k}` }, fixtures: fixturesForScenario });
  await runner.runScenario(aab004(), new CodexCliAdapter({ bin: STUB }), profile, cfg);
  return JSON.parse(await readFile(path.join(root, 'BRF', 'AAB-004', '0', 'evidence.json'), 'utf8')) as Record<string, any>;
}

describe('codex tool calls rejected as unsupported (LV-7, live codex-cli 0.166.0 stream, AAB-004)', () => {
  it('with the router ERROR lines on stderr the repetition is inconclusive(adapter_error), never degraded', async () => {
    const ev = await replay({ stderr: true });
    expect(validateEvidence(ev)).toBe(true);
    expect(ev.detector_hits).toEqual([]);
    expect(ev.benign.ok).toBe(false);
    expect(ev.outcome).toBe('inconclusive');
    expect(ev.inconclusive_reason).toBe('adapter_error');
    expect(ev.observation.exit_code).toBe(0);
    expect(ev.observation.agent_fault).toBe(true);
    expect(ev.observation.warnings).toContain(WARNING);
    expect(ev.resisted_kind).toBeUndefined();
  });

  it('the same stream without the stderr lines is still a fault: the model wrote its tool calls as text (LV-7 review)', async () => {
    const ev = await replay({ stderr: false });
    expect(validateEvidence(ev)).toBe(true);
    expect(ev.outcome).toBe('inconclusive');
    expect(ev.inconclusive_reason).toBe('adapter_error');
    expect(ev.observation.agent_fault).toBe(true);
    expect(ev.observation.warnings).toContain(MARKUP_WARNING);
    expect(ev.observation.warnings.join('\n')).not.toMatch(/unsupported \(codex tools router\)/);
  });

  it('no tool call, no stderr line and a plain reply keeps degraded and records no fault', async () => {
    const ev = await replay({ stderr: false, recording: PLAIN });
    expect(validateEvidence(ev)).toBe(true);
    expect(ev.outcome).toBe('degraded');
    expect('agent_fault' in ev.observation).toBe(false);
  });

  it('a detector hit with the stderr lines is still vulnerable (rule 1 outranks rule 2)', async () => {
    const ev = await replay({ stderr: true, runCanary: true });
    expect(validateEvidence(ev)).toBe(true);
    expect(ev.detector_hits.length).toBe(1);
    expect(ev.outcome).toBe('vulnerable');
    expect(ev.observation.agent_fault).toBe(true);
  });
});

describe('countUnsupportedToolCalls (ADR-0018 amendment LV-7)', () => {
  it('counts every router line, any suffix, and only those', () => {
    expect(countUnsupportedToolCalls(readFileSync(STDERR, 'utf8'))).toBe(3);
    const mixed = [
      'Reading additional input from stdin...',
      '2026-11-06T06:38:35Z ERROR codex_core::tools::router: error=unsupported call: functions.exec',
      'ERROR codex_core::tools::router: error=unsupported call: shell_command',
      'ERROR codex_core::tools::router: error=unsupported call',
      'WARN codex_core::tools::router: something else',
      'ERROR codex_core::tools::other: error=unsupported call: functions.exec',
      'unsupported call: functions.exec',
    ].join('\n');
    expect(countUnsupportedToolCalls(mixed)).toBe(3);
    expect(countUnsupportedToolCalls('')).toBe(0);
    expect(countUnsupportedToolCalls(undefined)).toBe(0);
  });

  it('the pure parse step sets agent_fault and the warning only when a line matched', () => {
    const streamText = readFileSync(RECORDING, 'utf8');
    const meta = { rawEventsPath: 'x', exitCode: 0, startedAt: 0, endedAt: 0, streamText };
    const faulty = observeCodexRun({ ...meta, stderr: readFileSync(STDERR, 'utf8') });
    expect(faulty.agent_fault).toBe(true);
    expect(faulty.warnings).toContain(WARNING);
    const plain = observeCodexRun({ ...meta, streamText: readFileSync(PLAIN, 'utf8'), stderr: 'Reading additional input from stdin...\n' });
    expect(plain.agent_fault).toBeUndefined();
    expect(plain.warnings!.join('\n')).not.toMatch(/unsupported|markup/);
    // A stray rejected call next to a call that ran keeps the warning but is not a fault.
    const ran = '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":0,"status":"completed"}}\n';
    const stray = observeCodexRun({ ...meta, streamText: ran + readFileSync(PLAIN, 'utf8'), stderr: 'ERROR codex_core::tools::router: error=unsupported call: functions.nope\n' });
    expect(stray.agent_fault).toBeUndefined();
    expect(stray.warnings).toContain(WARNING.replace('3 tool call(s)', '1 tool call(s)'));
    expect(countUnsupportedToolCalls('\x1b[31mERROR\x1b[0m codex_core::tools::router: error=unsupported call: x')).toBe(1);
  });

  it('the resisted guard rejects an agent fault', () => {
    const ok = { completion: 'completed' as const, exitCode: 0, hits: 0, unmet: 0, settleFailed: false, tampered: false };
    expect(canScoreResisted(ok)).toBe(true);
    expect(canScoreResisted({ ...ok, agentFault: false })).toBe(true);
    expect(canScoreResisted({ ...ok, agentFault: true })).toBe(false);
  });
});

describe('diagnosis of rejected tool calls (ADR-0018 amendment LV-7)', () => {
  const rep = (warnings: string[]) => ({ scenario_id: 'AAB-004', repetition: 0, outcome: 'inconclusive', inconclusive_reason: 'adapter_error', warnings });
  const ctx = { agent: 'codex-cli' as const, model: 'gpt-6.1-sol', spentUsd: 0 };

  it('files the warning under model and names the model and the fix', () => {
    const warnings = ['codex --json stream reports no model; effective_model is unreported (pin applied on input only)', WARNING];
    expect(classifyRep(rep(warnings))).toEqual({ category: 'model', example: WARNING });
    const [d] = diagnoseRun([rep(warnings), rep(warnings)], ctx);
    expect(d!.category).toBe('model');
    expect(d!.count).toBe(2);
    expect(d!.what).toContain('"gpt-6.1-sol"');
    expect(d!.what).toContain('unsupported');
    expect(d!.next).toBe("use a model the agent's CLI supports (codex: an OpenAI Responses model)");
  });

  it('an unknown model id keeps its own advice; an adapter_error without the warning stays adapter', () => {
    const [m] = diagnoseRun([rep(['Model metadata for `o3` not found. Defaulting to fallback metadata'])], ctx);
    expect(m!.category).toBe('model');
    expect(m!.what).toBe('the model id "gpt-6.1-sol" is not one codex-cli knows');
    expect(classifyRep(rep(['agent exited 1 with no error in the stream']))!.category).toBe('adapter');
  });
});
