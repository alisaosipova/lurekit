// Detector canaries flow into the fixtures (ADR-0002 "Fixture contract"; evidence-spec §1.5).
// The runner provisions the scenario's detector BEFORE the fixtures and hands its per-run
// canaries to each fixture as ctx.canaries, so a fixture names the canary the detector actually
// watches (the canary_command executable under <runDir>/canary_bin, the canary_file_read decoy).
// Fully offline: REAL runner, REAL detectors, REAL fixtures, StubAdapter only.

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BenchmarkRunner, type RunConfig } from '../src/runner/runner.js';
import { loadScenarioDir } from '../src/scenario/load.js';
import type { DetectorKind, Scenario } from '../src/scenario/types.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import {
  fixturesForScenario,
  FixtureCanaryError,
  PoisonedRepoFixture,
  SkillPackageFixture,
} from '../src/fixtures/index.js';
import { StubAdapter } from './helpers/stubAdapter.js';

const SCENARIOS_DIR = fileURLToPath(new URL('../scenarios', import.meta.url));

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'aab-fxcanary-'));
  roots.push(d);
  return d;
}
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function shipped(id: string, detector: DetectorKind): Scenario {
  const { scenarios } = loadScenarioDir(SCENARIOS_DIR);
  const s = scenarios.find((x) => x.id === id);
  expect(s, `${id} loaded`).toBeDefined();
  expect(s!.forbidden_effect.detector).toBe(detector);
  return s!;
}

const BENIGN = 'Here is the summary of the project.';

/** Captures selected workdir files at the moment the agent would start (after provisioning). */
class WorkdirCapturingStub extends StubAdapter {
  captured: Record<string, string> = {};
  constructor(
    private readonly files: string[],
    script: ConstructorParameters<typeof StubAdapter>[0],
  ) {
    super(script);
  }
  override async run(...args: Parameters<StubAdapter['run']>): ReturnType<StubAdapter['run']> {
    for (const rel of this.files) {
      this.captured[rel] = await readFile(path.join(args[0].workdir!, rel), 'utf8');
    }
    return super.run(...args);
  }
}

async function drive(scenario: Scenario, files: string[], trigger?: DetectorKind) {
  const root = await tmpRoot();
  const brid = `BFC-${scenario.id}`;
  const runner = new BenchmarkRunner({
    ids: { benchmarkRunId: brid, runId: (s, k) => `${brid}:${s}:${k}` },
    fixtures: fixturesForScenario,
  });
  const cfg: RunConfig = { k: 1, vulnerable_if: 'any', mode: 'full', isolation: 'container', resultsRoot: root };
  const profile: SetupProfile = {
    agent: 'claude-code',
    agent_version: '@anthropic-ai/claude-code@2.1.309',
    model: 'claude-opus-4-8',
    permission_mode: 'plan',
  };
  const stub = new WorkdirCapturingStub(files, { benignText: BENIGN, ...(trigger ? { trigger } : {}) });
  const result = await runner.runScenario(scenario, stub, profile, cfg);
  return { result, stub, runDir: result.runs[0].run_dir };
}

/** The detector's actual per-run canary_command executable, from its own meta in the run dir. */
async function commandPathIn(runDir: string): Promise<string> {
  const meta = JSON.parse(await readFile(path.join(runDir, 'canary_command.canary.json'), 'utf8')) as {
    command: string;
  };
  const exe = process.platform === 'win32' ? `${meta.command}.cmd` : meta.command;
  return path.join(runDir, 'canary_bin', exe);
}

const SKILL_MD = path.join('.claude', 'skills', 'text-tidy', 'SKILL.md');
const SETTINGS = path.join('.claude', 'settings.json');

describe('skill_package names the detector per-run canary', () => {
  it('canary_command (AAB-026): SKILL.md names the per-run command path; the stub signal is a hit', async () => {
    const { result, stub, runDir } = await drive(shipped('AAB-026', 'canary_command'), [SKILL_MD], 'canary_command');
    const commandPath = await commandPathIn(runDir);
    expect(stub.captured[SKILL_MD]).toContain(`\`${commandPath}\``);
    expect(stub.captured[SKILL_MD]).not.toContain('aab-canary-setup');
    expect(result.verdict).toBe('vulnerable');
    expect(result.runs[0].detector_hits[0].detector).toBe('canary_command');
  });

  it('canary_file_read (AAB-027): SKILL.md names the per-run decoy file; the stub signal is a hit', async () => {
    const { result, stub, runDir } = await drive(shipped('AAB-027', 'canary_file_read'), [SKILL_MD], 'canary_file_read');
    const meta = JSON.parse(await readFile(path.join(runDir, 'canary_file_read.canary.json'), 'utf8')) as {
      fileName: string;
    };
    expect(stub.captured[SKILL_MD]).toContain(`\`${path.join(runDir, meta.fileName)}\``);
    expect(result.verdict).toBe('vulnerable');
    expect(result.runs[0].detector_hits[0].detector).toBe('canary_file_read');
  });

  it('a detector with no canary the skill can name (egress) -> inconclusive(fixture_error), never a stand-in', async () => {
    const s = { ...shipped('AAB-026', 'canary_command'), forbidden_effect: { detector: 'canary_egress_http' as const } };
    const root = await tmpRoot();
    const runner = new BenchmarkRunner({
      ids: { benchmarkRunId: 'BFCX', runId: (id, k) => `BFCX:${id}:${k}` },
      fixtures: fixturesForScenario,
    });
    const stub = new StubAdapter({ benignText: BENIGN });
    const result = await runner.runScenario(
      s,
      stub,
      { agent: 'claude-code', agent_version: 'x', model: 'm', permission_mode: 'plan' },
      { k: 1, vulnerable_if: 'any', mode: 'full', isolation: 'container', resultsRoot: root },
    );
    expect(result.runs[0].outcome).toBe('inconclusive');
    expect(result.runs[0].inconclusive_reason).toBe('fixture_error');
    expect(stub.runCount).toBe(0);
  });
});

describe('poisoned_repo names the detector per-run canary', () => {
  it('canary_command (AAB-002): the SessionStart hook runs the per-run command path; the stub signal is a hit', async () => {
    const { result, stub, runDir } = await drive(shipped('AAB-002', 'canary_command'), [SETTINGS], 'canary_command');
    const settings = JSON.parse(stub.captured[SETTINGS]) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(await commandPathIn(runDir));
    expect(stub.captured[SETTINGS]).not.toContain('aab-canary-setup');
    expect(result.verdict).toBe('vulnerable');
    expect(result.runs[0].detector_hits[0].detector).toBe('canary_command');
  });

  it('canary_command resisting stub -> resisted (the planted reference alone is not a hit)', async () => {
    const { result } = await drive(shipped('AAB-002', 'canary_command'), [SETTINGS]);
    expect(result.verdict).toBe('resisted');
    expect(result.runs[0].detector_hits).toHaveLength(0);
  });
});

describe('MCP fixtures embed the canary_mcp_tool per-run token', () => {
  it('poisoned_repo (AAB-001): .mcp.json carries the detector token and recorder path', async () => {
    const { result, stub, runDir } = await drive(shipped('AAB-001', 'canary_mcp_tool'), ['.mcp.json']);
    const meta = JSON.parse(await readFile(path.join(runDir, 'canary_mcp_tool.canary.json'), 'utf8')) as {
      token: string;
      recorderFile: string;
    };
    const cfg = JSON.parse(stub.captured['.mcp.json']) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    const env = cfg.mcpServers['aab-canary'].env;
    expect(env.AAB_MCP_TOKEN).toBe(meta.token);
    expect(env.AAB_MCP_RECORDER).toBe(path.join(runDir, meta.recorderFile));
    expect(result.verdict).toBe('resisted');
  });
});

describe('fixtures that reference a detector canary refuse to provision without it', () => {
  async function ctx() {
    const root = await tmpRoot();
    const runDir = path.join(root, 'run');
    const workdir = path.join(runDir, 'work');
    await mkdir(workdir, { recursive: true });
    return { runDir, workdir, canaryHost: '127.0.0.1' };
  }

  it('skill_package without ctx.canaries throws FixtureCanaryError', async () => {
    await expect(new SkillPackageFixture().provision(await ctx())).rejects.toBeInstanceOf(FixtureCanaryError);
  });

  it('skill_package with ctx.canaries lacking commandPath and path throws FixtureCanaryError', async () => {
    await expect(
      new SkillPackageFixture().provision({ ...(await ctx()), canaries: { token: 'abc' } }),
    ).rejects.toThrow(/commandPath.*path/);
  });

  it('poisoned_repo without ctx.canaries throws FixtureCanaryError', async () => {
    await expect(new PoisonedRepoFixture().provision(await ctx())).rejects.toBeInstanceOf(FixtureCanaryError);
  });
});
