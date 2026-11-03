// ADR-0022: the live-run confirmation and the newcomer error paths of `lurekit run`, driven
// through main() with CliDeps injection. Offline: agents are the test stubs (the StubAdapter or
// the stub binaries under test/fixtures/agents), no real agent is launched, nothing is spent.
// Scratch lives under the repository's ignored .aab-test-work/ (never os.tmpdir()).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, closestCommand, defaultDeps, type CliDeps } from '../src/cli.js';
import type { AgentId } from '../src/scenario/types.js';
import type { AgentProbe, ExecResult } from '../src/doctor.js';
import type { Adapter } from '../src/adapters/adapter.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { CursorCliAdapter } from '../src/adapters/cursorCli.js';
import { CodexCliAdapter } from '../src/adapters/codexCli.js';
import { StubAdapter } from './helpers/stubAdapter.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const realScenarios = path.join(repoRoot, 'scenarios');
const RECORDING = path.join(repoRoot, 'test/fixtures/recordings/claude-sample');
const CLAUDE_STUB = path.join(repoRoot, 'test/fixtures/agents/stub-claude.mjs');
const CURSOR_STUB = path.join(repoRoot, 'test/fixtures/agents/stub-cursor.mjs');
const CODEX_STUB = path.join(repoRoot, 'test/fixtures/agents/stub-codex.mjs');

let work: string;
let out: string[];
let err: string[];
let asked: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  const base = path.join(repoRoot, '.aab-test-work');
  mkdirSync(base, { recursive: true });
  work = mkdtempSync(path.join(base, 'newcomer-'));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  try {
    chmodSync(path.join(work, 'ro'), 0o755);
  } catch {
    /* not created */
  }
  rmSync(work, { recursive: true, force: true });
});

interface DepOpts {
  adapter?: () => Adapter;
  interactive?: boolean;
  answer?: string;
  probe?: AgentProbe;
}

function deps(o: DepOpts = {}): CliDeps {
  out = [];
  err = [];
  asked = [];
  return {
    now: () => '2026-11-03T00:00:00.000Z',
    newRunId: () => 'aab-test-newcomer',
    adapterFor: o.adapter ?? (() => new StubAdapter({})),
    cwd: () => work,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    ...(o.interactive !== undefined ? { isInteractive: () => o.interactive! } : {}),
    ...(o.answer !== undefined
      ? {
          ask: async (q: string) => {
            asked.push(q);
            return o.answer!;
          },
        }
      : {}),
    ...(o.probe ? { agentProbe: () => o.probe! } : {}),
  };
}

/** A one-scenario corpus copied from the shipped scenarios. */
function corpus(id: string): string {
  const dir = path.join(work, `c-${id}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(realScenarios, `${id}.yaml`), path.join(dir, `${id}.yaml`));
  return dir;
}

function probe(env: Record<string, string> = {}, bins: Record<string, string> = {}, exec: Record<string, ExecResult> = {}): AgentProbe {
  return {
    env,
    nodeVersion: '22.12.0',
    platform: 'linux',
    resolveBinary: (spec) => bins[spec],
    exec: (bin, args) => exec[`${bin} ${args.join(' ')}`] ?? { status: null, stdout: '', stderr: '', error: 'ENOENT' },
  };
}

const errText = (): string => err.join('');

describe('run: smoke by default, plan + confirmation before a live launch', () => {
  it('without --yes and without a terminal it refuses (exit 1), names --yes, launches nothing', async () => {
    const stub = new StubAdapter({});
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet'], deps({ adapter: () => stub }));
    expect(code).toBe(1);
    expect(stub.runCount).toBe(0);
    expect(errText()).toContain('refusing to launch: a live run starts claude-code and spends money, and stdin is not a terminal, so lurekit cannot ask.');
    expect(errText()).toContain('Next: re-run with --yes to launch without a prompt');
    // The plan came first: smoke (k=1), the estimate, the budget cap.
    expect(errText()).toMatch(/plan: 1 scenario\(s\) will run, 0 skipped; k=1 \(smoke\), 1 launch\(es\) of claude-code \(model=sonnet\)/);
    expect(errText()).toMatch(/estimated cost: about 0\.06 USD \(1 scenario\(s\) x k=1 x 0\.061 USD\) on sonnet, from a published run; other models differ/);
    expect(errText()).toContain('budget cap: none (add --budget <usd> to stop before a repetition that could exceed it)');
  });

  it('on a terminal it asks "Launch? [y/N] "; y launches, anything else does not', async () => {
    const yes = new StubAdapter({ benignText: 'SUMMARY: ok' });
    expect(await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--budget', '2'], deps({ adapter: () => yes, interactive: true, answer: 'y' }))).toBe(0);
    expect(asked).toEqual(['Launch? [y/N] ']);
    expect(yes.runCount).toBe(1);
    expect(errText()).toContain('budget cap: 2 USD (--budget)');
    expect(errText()).toContain('[1/1] AAB-003');

    const no = new StubAdapter({});
    expect(await main(['run', corpus('AAB-003'), '--model', 'sonnet'], deps({ adapter: () => no, interactive: true, answer: '' }))).toBe(1);
    expect(no.runCount).toBe(0);
    expect(errText()).toContain('not launched: nothing was run or spent.');
  });

  it('--mode full is k=3 and also confirms; --yes skips the prompt', async () => {
    const stub = new StubAdapter({});
    expect(await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--mode', 'full'], deps({ adapter: () => stub }))).toBe(1);
    expect(errText()).toMatch(/k=3 \(full\), 3 launch\(es\)/);
    expect(errText()).toMatch(/about 0\.18 USD \(1 scenario\(s\) x k=3/);
    const go = new StubAdapter({});
    expect(await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--mode', 'full', '--yes'], deps({ adapter: () => go, interactive: true, answer: 'n' }))).toBe(0);
    expect(asked).toEqual([]);
    expect(go.runCount).toBe(3);
    expect(errText()).toContain('launching (--yes given, no prompt)');
  });

  it('an agent without a published run says so instead of estimating', async () => {
    const stub = new StubAdapter({});
    await main(['run', corpus('AAB-005'), '--agent', 'cursor-cli', '--model', 'gpt-5'], deps({ adapter: () => stub }));
    expect(errText()).toContain('estimated cost: no published run yet for cursor-cli, no estimate');
  });

  it('--replay never asks and needs no --yes (zero cost)', async () => {
    const code = await main(
      ['run', corpus('AAB-030'), '--model', 'ci-replay', '--replay', RECORDING, '--results', path.join(work, 'runs'), '--format', 'json'],
      deps({ interactive: false }),
    );
    expect(code, errText()).toBe(0);
    expect(errText()).not.toMatch(/Launch\?|refusing to launch|estimated cost/);
  });
});

describe('run: newcomer error paths say what happened and the next command', () => {
  it('no agent binary: the preflight refuses before launching, with the install command', async () => {
    const stub = new StubAdapter({});
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes'], deps({ adapter: () => stub, probe: probe() }));
    expect(code).toBe(1);
    expect(stub.runCount).toBe(0);
    expect(errText()).toContain('refusing to launch: claude-code binary "claude" not found on PATH (and AAB_CLAUDE_BIN is not set).');
    expect(errText()).toContain('Next: npm install --prefix .aab-runs/_bin/claude-2.1.317 @anthropic-ai/claude-code@2.1.317');
  });

  it('wrong AAB_CLAUDE_BIN: the preflight names the variable and how to clear it', async () => {
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes'], deps({ probe: probe({ AAB_CLAUDE_BIN: '/opt/nope/claude' }) }));
    expect(code).toBe(1);
    expect(errText()).toContain('refusing to launch: AAB_CLAUDE_BIN=/opt/nope/claude does not point to an executable file.');
    expect(errText()).toContain('unset AAB_CLAUDE_BIN');
  });

  it('no agent binary without the preflight (adapter fails at launch): diagnosis + exit 1', async () => {
    const adapter = new ClaudeCodeAdapter({ bin: path.join(work, 'no-such-claude'), retryDelaysMs: [] });
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes', '--results', path.join(work, 'runs')], deps({ adapter: () => adapter }));
    expect(code).toBe(1);
    expect(errText()).toContain('- 1 repetition(s): the claude-code binary could not be launched.');
    expect(errText()).toContain('next: lurekit doctor --agent claude-code');
    expect(errText()).toContain('nothing was measured (exit 1)');
  });

  it('claude-code not authenticated (stub): the result error reaches the warnings and the diagnosis', async () => {
    process.env.AAB_STUB_FAIL = 'auth';
    const adapter = new ClaudeCodeAdapter({ bin: CLAUDE_STUB, retryDelaysMs: [] });
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes', '--results', path.join(work, 'runs')], deps({ adapter: () => adapter }));
    expect(code).toBe(1);
    expect(errText()).toContain('claude-code is not authenticated for this run');
    expect(errText()).toContain('recorded: result event reports is_error=true: Not logged in. Please run /login');
    expect(errText()).toContain('next: claude auth login, then lurekit doctor --agent claude-code');
  });

  it('network off (claude stub): the stderr excerpt is kept and classified as a network failure', async () => {
    process.env.AAB_STUB_FAIL = 'network';
    const adapter = new ClaudeCodeAdapter({ bin: CLAUDE_STUB, retryDelaysMs: [] });
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes', '--results', path.join(work, 'runs')], deps({ adapter: () => adapter }));
    expect(code).toBe(1);
    expect(errText()).toContain('claude-code could not reach its model API (network or DNS failure)');
    expect(errText()).toContain('agent exited 1; stderr: Error: getaddrinfo ENOTFOUND api.anthropic.com');
  });

  it('unknown model id (claude stub): classified as a model problem with a runnable fix', async () => {
    process.env.AAB_STUB_FAIL = 'model';
    const adapter = new ClaudeCodeAdapter({ bin: CLAUDE_STUB, retryDelaysMs: [] });
    const code = await main(['run', corpus('AAB-003'), '--model', 'no-such-model', '--yes', '--results', path.join(work, 'runs')], deps({ adapter: () => adapter }));
    expect(code).toBe(1);
    expect(errText()).toContain('the model id "no-such-model" is not one claude-code knows');
    expect(errText()).toContain('(e.g. --model sonnet)');
  });

  it('cursor-cli not authenticated (stub replaying the observed text): diagnosis names agent login', async () => {
    process.env.AAB_STUB_AUTH_FAIL = '1';
    const adapter = new CursorCliAdapter({ bin: CURSOR_STUB });
    const code = await main(['run', corpus('AAB-005'), '--agent', 'cursor-cli', '--model', 'gpt-5', '--yes', '--results', path.join(work, 'runs')], deps({ adapter: () => adapter }));
    expect(code).toBe(1);
    expect(errText()).toContain("recorded: agent authentication failed (exit 1): Error: Authentication required. Please run 'agent login' first");
    expect(errText()).toContain('next: agent login, then lurekit doctor --agent cursor-cli');
  });

  it('codex-cli without CODEX_API_KEY (stub replaying the observed 401 sequence): diagnosis names the key', async () => {
    delete process.env.CODEX_API_KEY;
    process.env.AAB_STUB_AUTH_FAIL = '1';
    const adapter = new CodexCliAdapter({ bin: CODEX_STUB });
    const code = await main(['run', corpus('AAB-004'), '--agent', 'codex-cli', '--model', 'o3', '--yes', '--results', path.join(work, 'runs')], deps({ adapter: () => adapter }));
    expect(code).toBe(1);
    expect(errText()).toContain('codex-cli is not authenticated for this run');
    expect(errText()).toContain('next: export CODEX_API_KEY=<your key>, then lurekit doctor --agent codex-cli');
  });

  it('openhands without --permission-mode always-approve: refused once, up front, naming the flag', async () => {
    const stub = new StubAdapter({});
    const code = await main(['run', corpus('AAB-014'), '--agent', 'openhands', '--model', 'openai/x', '--yes'], deps({ adapter: () => stub }));
    expect(code).toBe(1);
    expect(stub.runCount).toBe(0);
    expect(errText()).toContain('refusing to run: openhands: headless mode always runs always-approve with no sandbox;');
    expect(errText()).toContain('(pass --permission-mode always-approve)');
  });

  it('--budget reached mid-run: the remaining repetitions are named, with a higher cap to try (exit 0)', async () => {
    const stub = new StubAdapter({ cost: 1, benignText: 'SUMMARY: ok' });
    const code = await main(
      ['run', corpus('AAB-003'), '--model', 'sonnet', '--k', '3', '--budget', '1.5', '--yes', '--results', path.join(work, 'runs')],
      deps({ adapter: () => stub }),
    );
    expect(code).toBe(0);
    expect(stub.runCount).toBe(1);
    expect(errText()).toContain('- 2 repetition(s): not run: the next repetition could have exceeded --budget 1.5 USD (spent 1.00 USD so far)');
    expect(errText()).toContain('next: re-run with a higher cap, e.g. --budget 3');
  });

  it('scenario dir missing: named as missing, with the shipped corpus as the next path', async () => {
    const code = await main(['run', path.join(work, 'nope'), '--model', 'sonnet'], deps());
    expect(code).toBe(1);
    expect(errText()).toMatch(/^refusing to run: scenario directory ".*nope" does not exist\. Next: pass the path of a scenario directory, e\.g\. the corpus shipped with lurekit: /);
  });

  it('an invalid scenario file: the first error is shown with lurekit validate as the next command', async () => {
    const dir = path.join(work, 'bad');
    mkdirSync(dir);
    copyFileSync(path.join(realScenarios, 'AAB-003.yaml'), path.join(dir, 'AAB-999.yaml')); // id/file mismatch
    const code = await main(['run', dir, '--model', 'sonnet'], deps());
    expect(code).toBe(1);
    expect(errText()).toMatch(/refusing to run: 1 scenario file\(s\) in .* are invalid \(first: AAB-999\.yaml: /);
    expect(errText()).toContain(`Next: lurekit validate ${dir}`);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('results dir not writable: refused before any launch, with --results as the fix', async () => {
    const ro = path.join(work, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    const stub = new StubAdapter({});
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes', '--results', path.join(ro, 'sub')], deps({ adapter: () => stub }));
    expect(code).toBe(1);
    expect(stub.runCount).toBe(0);
    expect(errText()).toContain(`refusing to run: cannot write results under ${path.join(ro, 'sub')} (EACCES). Next: pass --results <a directory you can write>, e.g. --results ./lurekit-runs`);
  });
});

// --- ADR-0022 amendments (block 5): corpus resolution, pre-spend validation, next commands ---

describe('corpus resolution: argument -> ./scenarios -> the shipped corpus', () => {
  it('plan and list without an argument in an empty directory use the shipped corpus and say so', async () => {
    expect(await main(['plan', '--model', 'sonnet'], deps())).toBe(0);
    expect(out.join('')).toMatch(/^corpus: .*scenarios \(shipped with the package\)$/m);
    expect(out.join('')).toMatch(/plan: \d+ would run/);
    expect(await main(['list'], deps())).toBe(0);
    expect(out.join('')).toMatch(/\n\d+ scenario\(s\) in .*scenarios\n$/);
    expect(await main(['validate'], deps())).toBe(0);
  });

  it('./scenarios in the cwd wins over the shipped corpus; an argument wins over both', async () => {
    const local = path.join(work, 'scenarios');
    mkdirSync(local);
    copyFileSync(path.join(realScenarios, 'AAB-003.yaml'), path.join(local, 'AAB-003.yaml'));
    expect(await main(['plan', '--model', 'sonnet'], deps())).toBe(0);
    expect(out.join('')).toContain('corpus: scenarios (./scenarios in the current directory)');
    expect(out.join('')).toContain('plan: 1 would run');
    const given = corpus('AAB-005');
    expect(await main(['plan', given, '--model', 'sonnet'], deps())).toBe(0);
    expect(out.join('')).toContain(`corpus: ${given} (given on the command line)`);
  });

  it('run prints the corpus line before it asks', async () => {
    const stub = new StubAdapter({});
    expect(await main(['run', corpus('AAB-003'), '--model', 'sonnet'], deps({ adapter: () => stub }))).toBe(1);
    expect(errText()).toMatch(/corpus: .*c-AAB-003 \(given on the command line\)/);
  });
});

describe('run: pre-spend validation happens before the prompt and before any launch', () => {
  it.each([
    [['--format', 'html'], /refusing to run: --format must be json\|markdown\|sarif \(got "html"\)\.\nnext: lurekit run .* --model sonnet --format markdown/],
    [['--output', 'no-such-dir/report.md'], /refusing to run: cannot write --output no-such-dir\/report\.md: its directory .*no-such-dir is not writable \(ENOENT\)\.\nnext: /],
    [['--output', '.'], /refusing to run: --output \. is a directory; it must name a file\.\nnext: /],
    [['--budget', '0'], /refusing to run: --budget must be a number of USD greater than 0 \(got 0\)\.\nnext: .*--budget 5/],
    [['--budget', '-2'], /--budget must be a number of USD greater than 0 \(got -2\)/],
  ])('%j: exit 1, nothing asked, nothing launched', async (extra, msg) => {
    const stub = new StubAdapter({});
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', ...extra], deps({ adapter: () => stub, interactive: true, answer: 'y' }));
    expect(code).toBe(1);
    expect(stub.runCount).toBe(0);
    expect(asked).toEqual([]);
    expect(errText()).toMatch(msg);
    expect(errText()).not.toMatch(/Launch\?|plan: 1 scenario/);
  });

  it('--replay is validated the same way and otherwise still runs offline', async () => {
    const results = path.join(work, 'runs');
    const bad = await main(['run', corpus('AAB-030'), '--model', 'ci-replay', '--replay', RECORDING, '--results', results, '--format', 'xml'], deps());
    expect(bad).toBe(1);
    expect(errText()).toContain('refusing to run: --format must be');
    const okCode = await main(['run', corpus('AAB-030'), '--model', 'ci-replay', '--replay', RECORDING, '--results', results, '--format', 'json', '--output', 'r.json'], deps());
    expect(okCode, errText()).toBe(0);
  });

  it('a finished run names report and publish as the next commands', async () => {
    const stub = new StubAdapter({ benignText: 'SUMMARY: ok' });
    const code = await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes', '--results', 'runs'], deps({ adapter: () => stub }));
    expect(code, errText()).toBe(0);
    expect(errText()).toContain('Next: lurekit report runs/aab-test-newcomer --format markdown|json|sarif\n');
    expect(errText()).toContain('      lurekit publish runs/aab-test-newcomer --redact-home\n');
  });
});

describe('report/publish without a manifest list the run directories found under --results', () => {
  function fakeRun(name: string, mtimeSec: number): void {
    const d = path.join(work, '.aab-runs', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'manifest.json'), '{}');
    utimesSync(path.join(d, 'manifest.json'), mtimeSec, mtimeSec);
  }

  it('newest first, with the next command for the newest', async () => {
    fakeRun('aab-old', 1_000_000);
    fakeRun('aab-new', 2_000_000);
    mkdirSync(path.join(work, '.aab-runs', 'not-a-run'));
    expect(await main(['report', 'nope'], deps())).toBe(1);
    const e = errText();
    expect(e).toContain('no manifest.json in nope (not a completed run directory)');
    expect(e).toContain('run directories under .aab-runs (newest first):\n  .aab-runs/aab-new\n  .aab-runs/aab-old\n');
    expect(e).not.toContain('not-a-run');
    expect(e).toContain('next: lurekit report .aab-runs/aab-new --format markdown');
    expect(await main(['publish'], deps())).toBe(1);
    expect(errText()).toContain('publish: a benchmark run directory is required');
    expect(errText()).toContain('next: lurekit publish .aab-runs/aab-new --redact-home');
  });

  it('no runs at all: says so and names lurekit run and --results', async () => {
    expect(await main(['report', 'nope', '--results', 'elsewhere'], deps())).toBe(1);
    expect(errText()).toContain('no run directories with a manifest.json under elsewhere');
    expect(errText()).toContain('next: lurekit run --model <id>');
  });
});

describe('every refusal names the next command (ADR-0022 amendment)', () => {
  // [label, argv, deps options] - each must exit non-zero or reject, with "next:" in the message.
  const cases: Array<[string, () => string[], DepOpts?]> = [
    ['flag without a value (cli.ts valueFor)', () => ['plan', '--model']],
    ['non-numeric number flag', () => ['plan', '--model', 'm', '--k', 'three']],
    ['run without --model', () => ['run', corpus('AAB-003')]],
    ['plan without --model', () => ['plan', corpus('AAB-003')]],
    ['bad --mode', () => ['plan', corpus('AAB-003'), '--model', 'm', '--mode', 'fast']],
    ['bad --vulnerable-if', () => ['plan', corpus('AAB-003'), '--model', 'm', '--vulnerable-if', 'all']],
    ['report without a run dir', () => ['report']],
    ['report without a manifest', () => ['report', 'nope']],
    ['report with a bad --format', () => ['report', fakeManifestDir(), '--format', 'html']],
    ['publish without a run dir', () => ['publish']],
    ['publish without a manifest', () => ['publish', 'nope']],
    ['doctor with a run flag', () => ['doctor', '--k', '3'], { probe: probe() }],
    ['doctor with two directories', () => ['doctor', 'a', 'b'], { probe: probe() }],
    ['doctor with a bad --format', () => ['doctor', '--format', 'sarif'], { probe: probe() }],
    ['doctor with an unknown agent', () => ['doctor', '--agent', 'codex'], { probe: probe() }],
    ['demo with a positional', () => ['demo', 'reports']],
    ['demo with another command\'s flag', () => ['demo', '--k', '3']],
    ['demo with a bad --format', () => ['demo', '--format', 'html']],
    ['unknown command', () => ['frobnicate']],
    ['mistyped command', () => ['plna']],
  ];

  function fakeManifestDir(): string {
    const d = path.join(work, 'fake-run');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'manifest.json'), '{}');
    return d;
  }

  it.each(cases)('%s', async (_label, argv, o) => {
    let message = '';
    let code = 0;
    try {
      code = await main(argv(), deps(o ?? {}));
      message = errText();
    } catch (e) {
      code = 1;
      message = (e as Error).message;
    }
    expect(code).not.toBe(0);
    expect(message).toContain('next:');
  });

  it('a missing demo asset is a clear refusal (exit 1), not a stack trace', async () => {
    const d = { ...deps(), demoBundleDir: () => path.join(work, 'no-demo') };
    expect(await main(['demo'], d)).toBe(1);
    expect(errText()).toContain('demo: the published run that ships with lurekit is missing or unreadable in this install');
    expect(errText()).toMatch(/next: npm install lurekit@\d+\.\d+\.\d+/);
  });

  it('the adapter factory names the next command for an agent without an adapter', () => {
    expect(() => defaultDeps().adapterFor('nope' as AgentId)).toThrow(/^no adapter for agent "nope" \(implemented: [^)]*\)\nnext: lurekit doctor --agent claude-code$/);
  });

  it('a failed bundle write names the next command', async () => {
    const results = path.join(work, 'runs');
    const stub = new StubAdapter({ benignText: 'SUMMARY: ok' });
    expect(await main(['run', corpus('AAB-003'), '--model', 'sonnet', '--yes', '--results', results], deps({ adapter: () => stub }))).toBe(0);
    const outDir = path.join(work, 'full');
    mkdirSync(outDir);
    writeFileSync(path.join(outDir, 'stale.txt'), 'x');
    const d = { ...deps(), homeDir: () => path.join(work, 'no-such-home') };
    const code = await main(['publish', path.join(results, 'aab-test-newcomer'), '--out', outDir], d);
    expect(code, errText()).toBe(1);
    expect(errText()).toMatch(/is not empty; nothing written\nnext: lurekit publish .* --out <an empty directory you can write>/);
  });

  it('unknown commands suggest the closest command within edit distance 2', async () => {
    expect(closestCommand('plna')).toBe('plan');
    expect(closestCommand('reprot')).toBe('report');
    expect(closestCommand('doctr')).toBe('doctor');
    expect(closestCommand('frobnicate')).toBeUndefined();
    expect(await main(['raport'], deps())).toBe(2);
    expect(errText()).toMatch(/^unknown command: raport\nnext: lurekit report {3}\(did you mean "report"\?\)\n/);
    expect(await main(['frobnicate'], deps())).toBe(2);
    expect(errText()).toMatch(/^unknown command: frobnicate\nnext: lurekit --help\n/);
  });
});

describe('plan leaves no trace in the cwd', () => {
  it('an absent results root is not left behind as an empty directory', async () => {
    expect(await main(['plan', corpus('AAB-003'), '--model', 'sonnet'], deps())).toBe(0);
    expect(existsSync(path.join(work, '.aab-runs'))).toBe(false);
    mkdirSync(path.join(work, '.aab-runs'));
    expect(await main(['plan', corpus('AAB-003'), '--model', 'sonnet'], deps())).toBe(0);
    expect(existsSync(path.join(work, '.aab-runs'))).toBe(true); // an existing root is kept
  });
});
