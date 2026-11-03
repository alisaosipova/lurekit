// CLI wiring tests (src/cli.ts). Fully offline: the live-agent path is exercised with an
// injected StubAdapter via CliDeps, so no `claude` process is spawned and nothing is spent.
// Proves the entry point wires scenarios -> adapter -> runner -> reporter and writes a manifest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, type CliDeps } from '../src/cli.js';
import type { AgentId } from '../src/scenario/types.js';
import type { RunManifest } from '../src/runner/types.js';
import { StubAdapter } from './helpers/stubAdapter.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const realScenarios = path.join(repoRoot, 'scenarios');
const validFixtures = path.join(repoRoot, 'test/fixtures/scenarios/valid');

let tmp: string;
let out: string[];
let err: string[];

function deps(adapterFor?: CliDeps['adapterFor']): CliDeps {
  out = [];
  err = [];
  return {
    now: () => '2026-11-02T00:00:00.000Z',
    newRunId: () => 'aab-test-run',
    adapterFor: adapterFor ?? (() => new StubAdapter({})),
    cwd: () => tmp,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aab-cli-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('cli offline commands', () => {
  it('--help returns 0 and prints usage', async () => {
    const code = await main(['--help'], deps());
    expect(code).toBe(0);
    expect(out.join('')).toContain('LureKit');
    expect(out.join('')).toContain('Usage: lurekit <command>');
  });

  it('validate returns 0 on a valid scenario dir', async () => {
    const code = await main(['validate', validFixtures], deps());
    expect(code).toBe(0);
  });

  it('selftest returns 0 (all detectors sound)', async () => {
    const code = await main(['selftest'], deps());
    expect(code, err.join('') + out.join('')).toBe(0);
    expect(out.join('')).toContain('all detectors sound');
  });

  it('plan returns 0 and keeps the real corpus for a claude-code profile', async () => {
    const code = await main(['plan', realScenarios, '--model', 'test-model'], deps());
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/would run/);
  });

  it('run requires --model', async () => {
    await expect(main(['run', realScenarios], deps())).rejects.toThrow(/--model/);
  });

  it('unknown command returns 2', async () => {
    const code = await main(['frobnicate'], deps());
    expect(code).toBe(2);
  });
});

describe('cli run (stub adapter, offline)', () => {
  it('runs one scenario end-to-end, writes a manifest, reports vulnerable 1 of 1', async () => {
    // One-scenario temp corpus: AAB-030 uses canary_command with a text_in_transcript benign.
    const scenDir = path.join(tmp, 'corpus');
    mkdirSync(scenDir, { recursive: true });
    copyFileSync(path.join(realScenarios, 'AAB-030.yaml'), path.join(scenDir, 'AAB-030.yaml'));
    const resultsRoot = path.join(tmp, 'runs');

    const stub = new StubAdapter({ trigger: 'canary_command', benignText: 'SUMMARY: here is a summary' });
    const d = deps(() => stub);
    const code = await main(
      ['run', scenDir, '--model', 'test-model', '--results', resultsRoot, '--format', 'markdown'],
      d,
    );

    expect(code).toBe(0);
    expect(stub.runCount).toBe(1);

    const manifestPath = path.join(resultsRoot, 'aab-test-run', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;
    expect(manifest.totals.vulnerable).toBe(1);
    expect(manifest.results[0].scenario_id).toBe('AAB-030');

    expect(out.join('')).toContain('Vulnerable to 1 of 1 scenarios');
  });

  it('reports vulnerable 0 when the agent resists (no trigger, benign satisfied)', async () => {
    const scenDir = path.join(tmp, 'corpus');
    mkdirSync(scenDir, { recursive: true });
    copyFileSync(path.join(realScenarios, 'AAB-030.yaml'), path.join(scenDir, 'AAB-030.yaml'));
    const resultsRoot = path.join(tmp, 'runs');

    const stub = new StubAdapter({ benignText: 'SUMMARY: here is a summary' });
    const code = await main(
      ['run', scenDir, '--model', 'test-model', '--results', resultsRoot],
      deps(() => stub),
    );
    expect(code).toBe(0);
    const manifest = JSON.parse(
      readFileSync(path.join(resultsRoot, 'aab-test-run', 'manifest.json'), 'utf8'),
    ) as RunManifest;
    expect(manifest.totals.vulnerable).toBe(0);
  });
});

describe('cli --setting-sources (§4.3 hardening knob)', () => {
  it('plan records the value in the profile summary line', async () => {
    const code = await main(['plan', realScenarios, '--model', 'test-model', '--setting-sources', 'user'], deps());
    expect(code).toBe(0);
    expect(out.join('')).toContain('setting_sources=user)');
  });

  it('plan without the flag prints no setting_sources (no default change)', async () => {
    await main(['plan', realScenarios, '--model', 'test-model'], deps());
    expect(out.join('')).not.toContain('setting_sources');
  });

  it('run passes the parsed list to the adapter profile and prints it in the run header', async () => {
    const scenDir = path.join(tmp, 'corpus');
    mkdirSync(scenDir, { recursive: true });
    copyFileSync(path.join(realScenarios, 'AAB-030.yaml'), path.join(scenDir, 'AAB-030.yaml'));
    const stub = new StubAdapter({ benignText: 'here is a summary' });
    const seen: unknown[] = [];
    const origRun = stub.run.bind(stub);
    stub.run = (profile, task, signal, options) => {
      seen.push(profile.setting_sources);
      return origRun(profile, task, signal, options);
    };
    const code = await main(
      ['run', scenDir, '--model', 'test-model', '--results', path.join(tmp, 'runs'), '--setting-sources', 'user, project'],
      deps(() => stub),
    );
    expect(code).toBe(0);
    expect(seen).toEqual([['user', 'project']]);
    expect(err.join('')).toContain('setting_sources=user,project)');
  });

  it.each(['user,managed', '', 'user,,local', 'user,user'])(
    'rejects --setting-sources %j before any run starts',
    async (bad) => {
      const stub = new StubAdapter({});
      await expect(
        main(['run', realScenarios, '--model', 'test-model', '--results', path.join(tmp, 'runs'), '--setting-sources', bad], deps(() => stub)),
      ).rejects.toThrow(/setting.sources/);
      expect(stub.runCount).toBe(0);
    },
  );

  it('rejects --setting-sources for an agent other than claude-code', async () => {
    await expect(
      main(['plan', realScenarios, '--model', 'm', '--agent', 'codex-cli', '--setting-sources', 'user'], deps()),
    ).rejects.toThrow(/claude-code flag/);
  });
});

describe('cli --settings/--hooks forwarding guard (ADR-0020)', () => {
  it.each([
    ['cursor-cli', 'settings'],
    ['codex-cli', 'settings'],
    ['openhands', 'settings'],
    ['cursor-cli', 'hooks'],
    ['codex-cli', 'hooks'],
    ['openhands', 'hooks'],
  ])('rejects for agent %s: --%s is never forwarded', async (agent, flag) => {
    const file = path.join(tmp, `${flag}.json`);
    writeFileSync(file, '{}', 'utf8');
    const stub = new StubAdapter({});
    await expect(
      main(['run', realScenarios, '--model', 'm', '--agent', agent, '--results', path.join(tmp, 'runs'), `--${flag}`, file], deps(() => stub)),
    ).rejects.toThrow(new RegExp(`--${flag} is only forwarded by the claude-code adapter.*"${agent}"`));
    expect(stub.runCount).toBe(0);
  });

  it('accepts --settings and --hooks for claude-code (plan exits 0)', async () => {
    const settingsFile = path.join(tmp, 'settings.json');
    const hooksFile = path.join(tmp, 'hooks.json');
    writeFileSync(settingsFile, JSON.stringify({ env: { A: '1' } }), 'utf8');
    writeFileSync(hooksFile, JSON.stringify({ PreToolUse: [] }), 'utf8');
    const code = await main(
      ['plan', realScenarios, '--model', 'm', '--settings', settingsFile, '--hooks', hooksFile],
      deps(),
    );
    expect(code).toBe(0);
  });
});

describe('cli strict flag parsing', () => {
  // Every case must throw from main() before any command runs: the stub adapter is never
  // invoked and nothing is written under the temp cwd.
  async function expectRejected(argv: string[], msg: RegExp): Promise<void> {
    const stub = new StubAdapter({});
    await expect(main(argv, deps(() => stub))).rejects.toThrow(msg);
    expect(stub.runCount).toBe(0);
    expect(out.join('')).toBe('');
  }

  it.each([['--dry-run'], ['--bare'], ['--frobnicate'], ['--']])('rejects unknown flag %j', async (flag) => {
    await expectRejected(['plan', realScenarios, '--model', 'm', flag], new RegExp(`unknown flag "${flag}"`));
  });

  it.each([['--setting-sources=user'], ['--model=m'], ['--redact-home=1'], ['--withhold=AAB-003']])(
    'rejects --name=value form %j',
    async (tok) => {
      await expectRejected(['plan', realScenarios, '--model', 'm', tok], /unsupported flag form/);
      await expectRejected(['plan', realScenarios, '--model', 'm', tok], new RegExp(JSON.stringify(tok).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    },
  );

  it.each([['--model test-model'], ['--redact-home '], ['--k\t3']])('rejects a flag token containing whitespace %j', async (tok) => {
    await expectRejected(['plan', realScenarios, tok], /malformed flag/);
  });

  it.each([['--model'], ['--k'], ['--setting-sources'], ['--withhold'], ['--skill']])(
    'rejects a value-taking flag %j given last with no value',
    async (flag) => {
      await expectRejected(['plan', realScenarios, flag], new RegExp(`${flag} expects a value`));
    },
  );

  it('rejects a value-taking flag whose value is another flag', async () => {
    await expectRejected(['plan', realScenarios, '--model', '--help'], /--model expects a value/);
  });

  it('still rejects a non-numeric --k', async () => {
    await expectRejected(['plan', realScenarios, '--model', 'm', '--k', 'three'], /--k expects a number/);
  });

  it('accepts allowlisted booleans: --help and --version after a command', async () => {
    expect(await main(['plan', '--help'], deps())).toBe(0);
    expect(out.join('')).toContain('Usage: lurekit <command>');
    expect(await main(['plan', '--version'], deps())).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('regression: --withhold must never be silently dropped', () => {
    it('"--withhold AAB-003" as ONE token fails before publish runs', async () => {
      await expectRejected(['publish', 'some-run', '--withhold AAB-003'], /malformed flag "--withhold AAB-003"/);
    });

    it.each([[' --withhold AAB-003'], ['\t--withhold AAB-003'], ['--withhold AAB-003 ']])(
      'a whitespace-padded joined token %j fails instead of becoming an ignored positional',
      async (tok) => {
        await expectRejected(['publish', 'some-run', tok], /malformed flag/);
      },
    );

    it('a value containing spaces is still accepted as a separate argument', async () => {
      const code = await main(['publish', 'some run dir', '--out', 'site/a b'], deps());
      expect(code).toBe(1);
      expect(err.join('')).toContain('no manifest.json in some run dir');
    });

    it('"--withhold", "AAB-003" as two tokens parses (publish proceeds to its own checks)', async () => {
      // No run dir here, so publish reaches its manifest check and returns 1 - proving the
      // parser accepted the flag rather than throwing.
      const code = await main(['publish', 'some-run', '--withhold', 'AAB-003'], deps());
      expect(code).toBe(1);
      expect(err.join('')).toContain('no manifest.json in some-run');
    });
  });
});
