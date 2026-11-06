// ADR-0028 D2/D3: the served model is recorded, a substitution blocks publish, and a model that
// writes tool-call markup instead of calling tools is an agent fault in Claude Code too.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { servedModelMatches, TOOL_MARKUP_WARNING } from '../src/adapters/adapter.js';
import { observeClaudeRun } from '../src/adapters/claudeCode.js';
import { readRunDir } from '../src/report/publish.js';
import { mkScratchSync } from './helpers/scratch.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const assistant = (model: string, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { model, content } });
const meta = { rawEventsPath: 'x', exitCode: 0, startedAt: 0, endedAt: 0, usedBare: false };

describe('served model (ADR-0028 D2)', () => {
  it('compares vendor-prefixed requests only, ignoring vendor, date and variant suffixes', () => {
    expect(servedModelMatches('anthropic/claude-sonnet-5.5', 'claude-sonnet-5.5-20261001')).toBe(true);
    expect(servedModelMatches('deepseek/deepseek-v4.1', 'deepseek/deepseek-v4.1:free')).toBe(true);
    expect(servedModelMatches('openai/gpt-6.1-sol', 'minimax/m3')).toBe(false);
    expect(servedModelMatches('sonnet', 'claude-sonnet-4-6')).toBeUndefined();
  });

  it('collects message.model of assistant events, sorted and unique', () => {
    const streamText = [assistant('z-model', [{ type: 'text', text: 'a' }]), assistant('a-model', []), assistant('z-model', [])].join('\n');
    expect(observeClaudeRun({ ...meta, streamText }).served_models).toEqual(['a-model', 'z-model']);
    expect(observeClaudeRun({ ...meta, streamText: '' }).served_models).toBeUndefined();
    expect(observeClaudeRun({ ...meta, streamText: assistant('<synthetic>', [{ type: 'text', text: 'API Error' }]) }).served_models).toBeUndefined();
  });

  it('publish refuses a run whose evidence records a substituted model', () => {
    const run = mkScratchSync('aab-provenance-');
    dirs.push(run);
    writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ benchmark_run_id: 'r', results: [{ scenario_id: 'AAB-900' }] }));
    mkdirSync(path.join(run, 'AAB-900', '0'), { recursive: true });
    writeFileSync(path.join(run, 'AAB-900', '0', 'evidence.json'), JSON.stringify({ observation: { warnings: ['served model minimax/m3 differs from the requested openai/gpt-6.1-sol'] } }));
    expect(() => readRunDir(run)).toThrow(/served model that differs from the requested one/);
  });
});

describe('agent fault in Claude Code (ADR-0028 D3)', () => {
  it('markup in the reply with no tool call is a fault; a real tool call is not', () => {
    const markup = assistant('m', [{ type: 'text', text: '<tool_call>exec ls</tool_call>' }]);
    const o = observeClaudeRun({ ...meta, streamText: markup });
    expect(o.agent_fault).toBe(true);
    expect(o.warnings).toContain(TOOL_MARKUP_WARNING);
    const withCall = [markup, assistant('m', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }])].join('\n');
    expect(observeClaudeRun({ ...meta, streamText: withCall }).agent_fault).toBeUndefined();
  });
});
