// ADR-0022: `lurekit doctor` checks, the cost estimate and the post-run diagnosis. Fully offline:
// every host access goes through a fake AgentProbe, so no agent binary is spawned and nothing
// is spent. Scratch lives under the repository's ignored .aab-test-work/ (never os.tmpdir()).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, type CliDeps, DEMO_RUN_ID } from '../src/cli.js';
import {
  type AgentProbe,
  type ExecResult,
  AGENTS,
  CLAUDE_AUTH_STATUS_MIN,
  checkAuth,
  claudeAuthStatusVerified,
  checkBinary,
  checkModel,
  checkNode,
  checkUpdate,
  costBasis,
  estimateSentence,
  pinnedClaudeRecipe,
  renderChecks,
  runEstimateSentence,
} from '../src/doctor.js';
import { classifyRep, diagnoseRun, nothingMeasured, renderDiagnosis, type RepIssue } from '../src/diagnose.js';
import type { RunManifest } from '../src/runner/types.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const demoManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'demo', DEMO_RUN_ID, 'manifest.json'), 'utf8'),
) as RunManifest;

const GLOBAL_CLAUDE = '/home/u/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const PREFIX_CLAUDE = '/home/u/proj/.aab-runs/_bin/claude-2.1.317/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

interface FakeOpts {
  env?: Record<string, string | undefined>;
  node?: string;
  platform?: NodeJS.Platform;
  bins?: Record<string, string>; // spec -> resolved real path
  exec?: Record<string, ExecResult>; // "<bin> <args>" -> result
}

function fakeProbe(o: FakeOpts = {}): AgentProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: o.env ?? {},
    nodeVersion: o.node ?? '22.12.0',
    platform: o.platform ?? 'linux',
    resolveBinary: (spec) => o.bins?.[spec],
    exec: (bin, args) => {
      const key = `${bin} ${args.join(' ')}`;
      calls.push(key);
      return o.exec?.[key] ?? { status: null, stdout: '', stderr: '', error: 'ENOENT' };
    },
  };
}

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: '' });

describe('doctor checks (pure, fake probe)', () => {
  it('node: ok at the floor, fail below it with an install command', () => {
    expect(checkNode('20.19.0').status).toBe('ok');
    expect(checkNode('26.13.0').status).toBe('ok');
    const old = checkNode('20.18.1');
    expect(old.status).toBe('fail');
    expect(old.fix).toMatch(/nvm install 22/);
    expect(checkNode('18.20.0').status).toBe('fail');
  });

  it('binary: not on PATH -> fail with the install command; wrong override -> fail naming the variable', () => {
    const none = checkBinary(AGENTS['claude-code'], fakeProbe());
    expect(none.check.status).toBe('fail');
    expect(none.check.summary).toBe('claude-code binary "claude" not found on PATH (and AAB_CLAUDE_BIN is not set)');
    expect(none.check.fix).toBe(pinnedClaudeRecipe('2.1.317'));
    const wrong = checkBinary(AGENTS['claude-code'], fakeProbe({ env: { AAB_CLAUDE_BIN: '/opt/nope/claude' } }));
    expect(wrong.check.status).toBe('fail');
    expect(wrong.check.summary).toBe('AAB_CLAUDE_BIN=/opt/nope/claude does not point to an executable file');
    expect(wrong.check.fix).toMatch(/unset AAB_CLAUDE_BIN/);
    const cursor = checkBinary(AGENTS['cursor-cli'], fakeProbe());
    expect(cursor.check.fix).toBe('curl https://cursor.com/install -fsS | bash   (or export AAB_CURSOR_BIN=<absolute path>)');
  });

  it('binary: resolved + --version -> ok with the real path and version; no version -> warn', () => {
    const probe = fakeProbe({ bins: { claude: GLOBAL_CLAUDE }, exec: { [`${GLOBAL_CLAUDE} --version`]: ok('2.1.318 (Claude Code)\n') } });
    const b = checkBinary(AGENTS['claude-code'], probe);
    expect(b.check.status).toBe('ok');
    expect(b.check.summary).toBe(`claude-code: ${GLOBAL_CLAUDE} (via PATH "claude"), version 2.1.318 (Claude Code)`);
    // OpenHands prints a banner first; the last line is the version (NOTES).
    const oh = '/x/openhands';
    const ohb = checkBinary(
      AGENTS.openhands,
      fakeProbe({ bins: { openhands: oh }, exec: { [`${oh} --version`]: ok('+---+\n| banner |\n+---+\n\nOpenHands CLI 1.16.0\n') } }),
    );
    expect(ohb.version).toBe('OpenHands CLI 1.16.0');
    const silent = checkBinary(AGENTS['claude-code'], fakeProbe({ bins: { claude: GLOBAL_CLAUDE } }));
    expect(silent.check.status).toBe('warn');
    expect(silent.path).toBe(GLOBAL_CLAUDE);
  });

  it('update: npm-global Claude Code -> warn with the pinned --prefix recipe for the detected version', () => {
    const c = checkUpdate(AGENTS['claude-code'], { check: { id: 'binary', status: 'ok', summary: '' }, path: GLOBAL_CLAUDE, version: '2.1.318 (Claude Code)' }, 'linux')!;
    expect(c.status).toBe('warn');
    expect(c.fix).toBe(
      'npm install --prefix .aab-runs/_bin/claude-2.1.318 @anthropic-ai/claude-code@2.1.318 && export AAB_CLAUDE_BIN="$PWD/.aab-runs/_bin/claude-2.1.318/node_modules/.bin/claude"',
    );
    const pinned = checkUpdate(AGENTS['claude-code'], { check: { id: 'binary', status: 'ok', summary: '' }, path: PREFIX_CLAUDE, version: '2.1.317' }, 'linux')!;
    expect(pinned.status).toBe('ok');
    const win = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    expect(checkUpdate(AGENTS['claude-code'], { check: { id: 'binary', status: 'ok', summary: '' }, path: win }, 'win32')!.status).toBe('warn');
    expect(checkUpdate(AGENTS['cursor-cli'], { check: { id: 'binary', status: 'ok', summary: '' }, path: '/x/agent' }, 'linux')!.status).toBe('warn');
    expect(checkUpdate(AGENTS['claude-code'], { check: { id: 'binary', status: 'fail', summary: '' } }, 'linux')).toBeUndefined();
  });

  it('auth claude-code: uses `auth status --json`, keeps only loggedIn/authMethod, never echoes the rest', () => {
    const bin = { check: { id: 'binary', status: 'ok' as const, summary: '' }, path: GLOBAL_CLAUDE, version: '2.1.318 (Claude Code)' };
    const secretish = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.com', orgName: 'Org' });
    const probe = fakeProbe({ exec: { [`${GLOBAL_CLAUDE} auth status --json`]: ok(secretish) } });
    const c = checkAuth(AGENTS['claude-code'], bin, probe);
    expect(c.status).toBe('ok');
    expect(c.summary).toContain('authMethod=claude.ai');
    expect(JSON.stringify(c)).not.toContain('example.com');
    expect(JSON.stringify(c)).not.toContain('Org');
    expect(probe.calls).toEqual([`${GLOBAL_CLAUDE} auth status --json`]);

    const out = checkAuth(AGENTS['claude-code'], bin, fakeProbe({
      exec: { [`${GLOBAL_CLAUDE} auth status --json`]: { status: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '' } },
    }));
    expect(out.status).toBe('fail');
    expect(out.fix).toMatch(/^claude auth login/);

    // ADR-0022 amendment: logged out but ANTHROPIC_API_KEY set -> warn, not fail (NOTES: whether
    // -p honours the key in that state is UNVERIFIED). The key's value is never echoed.
    const keyed = checkAuth(AGENTS['claude-code'], bin, fakeProbe({
      env: { ANTHROPIC_API_KEY: 'sk-ant-placeholder-value' },
      exec: { [`${GLOBAL_CLAUDE} auth status --json`]: { status: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '' } },
    }));
    expect(keyed.status).toBe('warn');
    expect(keyed.summary).toBe('not logged in; ANTHROPIC_API_KEY is set (UNVERIFIED whether -p honours it on this version)');
    expect(JSON.stringify(keyed)).not.toContain('placeholder-value');

    // An older binary without the subcommand: say "not checked", never guess.
    const unknown = checkAuth(AGENTS['claude-code'], bin, fakeProbe({ exec: { [`${GLOBAL_CLAUDE} auth status --json`]: { status: 1, stdout: 'error: unknown command', stderr: '' } } }));
    expect(unknown.status).toBe('warn');
    expect(unknown.summary).toMatch(/^not checked: /);
    expect(unknown.fix).toMatch(/^claude auth status --text/);
  });

  it('auth claude-code: a binary below the verified version, without a version, or not Claude Code is never asked', () => {
    expect(claudeAuthStatusVerified('2.1.317 (Claude Code)')).toBe(true);
    expect(claudeAuthStatusVerified('2.2.0 (Claude Code)')).toBe(true);
    expect(claudeAuthStatusVerified('2.1.316 (Claude Code)')).toBe(false);
    expect(claudeAuthStatusVerified('2.1.318')).toBe(false);
    expect(claudeAuthStatusVerified(undefined)).toBe(false);
    for (const version of ['2.1.309 (Claude Code)', undefined, 'some-other-tool 9.9.9']) {
      const probe = fakeProbe({ exec: { [`${GLOBAL_CLAUDE} auth status --json`]: ok('{"loggedIn":true}') } });
      const c = checkAuth(AGENTS['claude-code'], { check: { id: 'binary', status: 'ok', summary: '' }, path: GLOBAL_CLAUDE, ...(version ? { version } : {}) }, probe);
      expect(c.status).toBe('warn');
      expect(c.summary).toMatch(new RegExp(`^not checked: .*verified only on Claude Code >= ${CLAUDE_AUTH_STATUS_MIN.replace(/\./g, '\\.')}, so it was not run$`));
      expect(probe.calls).toEqual([]);
    }
  });

  it('auth cursor/codex/openhands: status JSON or key presence only (values never read)', () => {
    const bin = { check: { id: 'binary', status: 'ok' as const, summary: '' }, path: '/x/agent' };
    const notLogged = fakeProbe({ exec: { '/x/agent status --format json': ok('{"status":"unauthenticated","isAuthenticated":false}') } });
    const c = checkAuth(AGENTS['cursor-cli'], bin, notLogged);
    expect(c.status).toBe('fail');
    expect(c.fix).toBe('agent login   (or export CURSOR_API_KEY=<your key>)');
    const keyed = fakeProbe({ env: { CURSOR_API_KEY: 'k-not-a-real-key' } });
    const ck = checkAuth(AGENTS['cursor-cli'], bin, keyed);
    expect(ck.status).toBe('ok');
    expect(JSON.stringify(ck)).not.toContain('k-not-a-real-key');
    expect(keyed.calls).toEqual([]); // no probe needed

    expect(checkAuth(AGENTS['codex-cli'], bin, fakeProbe()).status).toBe('fail');
    expect(checkAuth(AGENTS['codex-cli'], bin, fakeProbe()).fix).toBe('export CODEX_API_KEY=<your key>');
    expect(checkAuth(AGENTS['codex-cli'], bin, fakeProbe({ env: { CODEX_API_KEY: 'x' } })).status).toBe('ok');
    expect(checkAuth(AGENTS.openhands, bin, fakeProbe()).summary).toMatch(/LLM_API_KEY is not set/);
    expect(checkAuth(AGENTS.openhands, bin, fakeProbe({ env: { LLM_API_KEY: 'x' } })).status).toBe('ok');
  });

  it('model: documented claude aliases pass; an unknown id is a warn with a runnable fix', () => {
    expect(checkModel(AGENTS['claude-code'], 'sonnet').status).toBe('ok');
    expect(checkModel(AGENTS['claude-code'], 'claude-sonnet-4-5').status).toBe('ok');
    const w = checkModel(AGENTS['claude-code'], 'gpt-4o');
    expect(w.status).toBe('warn');
    expect(w.fix).toBe('lurekit run <dir> --agent claude-code --model sonnet');
    expect(checkModel(AGENTS['codex-cli'], 'o3').summary).toMatch(/Model metadata for/);
  });

  it('renderChecks prints one status line per check and a fix line only for warn/fail', () => {
    const text = renderChecks([
      { id: 'node', status: 'ok', summary: 'Node 22', fix: 'never shown' },
      { id: 'auth', status: 'fail', summary: 'not logged in', fix: 'agent login' },
    ]);
    expect(text).toBe('ok    node        Node 22\nfail  auth        not logged in\n                  fix: agent login\n');
  });
});

describe('cost estimate from the shipped published run', () => {
  it('derives per scenario-repetition cost from the demo bundle (3.84 USD / 21 scenarios / k=3)', () => {
    const basis = costBasis('claude-code', demoManifest)!;
    expect(demoManifest.totals.spend_usd).toBeCloseTo(3.838067, 6);
    expect(basis.perRepUsd).toBeCloseTo(3.838067 / 63, 9);
    expect(basis.model).toBe('sonnet');
    expect(estimateSentence('claude-code', 25, basis)).toMatch(
      /^about 1\.52 USD for smoke \(k=1\), about 4\.57 USD for full \(k=3\) on sonnet, from a published run; other models differ /,
    );
    expect(runEstimateSentence('claude-code', 2, 1, basis)).toBe(
      'about 0.12 USD (2 scenario(s) x k=1 x 0.061 USD) on sonnet, from a published run; other models differ',
    );
  });

  it('other agents have no published run, so no estimate', () => {
    for (const agent of ['cursor-cli', 'codex-cli', 'openhands'] as const) {
      expect(costBasis(agent, demoManifest)).toBeUndefined();
      expect(estimateSentence(agent, 7, undefined)).toBe(`no published run yet for ${agent}, no estimate`);
    }
  });
});

describe('lurekit doctor (main, fake probe)', () => {
  let out: string[];
  let err: string[];
  let work: string;
  beforeEach(() => {
    const base = path.join(repoRoot, '.aab-test-work');
    mkdirSync(base, { recursive: true });
    work = mkdtempSync(path.join(base, 'doctor-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  function deps(probe: AgentProbe): CliDeps {
    out = [];
    err = [];
    return {
      now: () => '2026-11-03T00:00:00.000Z',
      newRunId: () => 'aab-test-doctor',
      adapterFor: () => {
        throw new Error('doctor must not build an adapter');
      },
      cwd: () => repoRoot,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      agentProbe: () => probe,
    };
  }

  const healthyClaude = (): AgentProbe =>
    fakeProbe({
      bins: { claude: PREFIX_CLAUDE },
      exec: {
        [`${PREFIX_CLAUDE} --version`]: ok('2.1.317 (Claude Code)\n'),
        [`${PREFIX_CLAUDE} auth status --json`]: ok('{"loggedIn":true,"authMethod":"api_key"}'),
      },
    });

  it('a healthy claude-code host: exit 0, every line ok, the smoke/full estimate for the shipped corpus', async () => {
    const code = await main(['doctor', '--model', 'sonnet'], deps(healthyClaude()));
    const text = out.join('');
    expect(code, text + err.join('')).toBe(0);
    expect(text).toMatch(/^lurekit doctor: agent claude-code, model sonnet\n/);
    for (const id of ['node', 'binary', 'update', 'auth', 'model', 'isolation', 'corpus', 'selftest', 'cost']) {
      expect(text).toMatch(new RegExp(`^ok    ${id}`, 'm'));
    }
    expect(text).toMatch(/would run for claude-code/);
    expect(text).toMatch(/about \d+\.\d\d USD for smoke \(k=1\), about \d+\.\d\d USD for full \(k=3\) on sonnet, from a published run; other models differ/);
    expect(text).toMatch(/0 fail, 0 warn\./);
  });

  it('a fail line makes doctor exit 1; --format json is machine-readable', async () => {
    const code = await main(['doctor', '--agent', 'cursor-cli', '--format', 'json'], deps(fakeProbe()));
    expect(code).toBe(1);
    const j = JSON.parse(out.join('')) as { agent: string; fail: number; checks: Array<{ id: string; status: string; fix?: string }>; estimate: unknown };
    expect(j.agent).toBe('cursor-cli');
    expect(j.fail).toBeGreaterThan(0);
    expect(j.checks.find((c) => c.id === 'binary')!.status).toBe('fail');
    expect(j.checks.find((c) => c.id === 'cost')).toMatchObject({ status: 'ok' });
    expect(j.estimate).toBeNull();
  });

  it('a missing scenario directory is a corpus fail line', async () => {
    const code = await main(['doctor', path.join(work, 'nope')], deps(healthyClaude()));
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/^fail  corpus .*does not exist/m);
  });

  it('the Next line and the fix lines carry the resolved corpus, agent and model (ADR-0022 amendment)', async () => {
    expect(await main(['doctor', '--model', 'sonnet'], deps(healthyClaude()))).toBe(0);
    // cwd = repository root, which has ./scenarios: the resolved corpus is "scenarios".
    expect(out.join('')).toContain('Next: lurekit run scenarios --agent claude-code --model sonnet (asks before it spends).');
    expect(await main(['doctor'], deps(healthyClaude()))).toBe(0);
    expect(out.join('')).toContain('Next: lurekit run scenarios --agent claude-code --model <id> (asks before it spends).');
    await main(['doctor', '--model', 'gpt-4o'], deps(healthyClaude()));
    expect(out.join('')).toContain('fix: lurekit run scenarios --agent claude-code --model sonnet');
    expect(out.join('')).not.toContain('<dir>');
    const code = await main(['doctor', path.join(work, 'nope'), '--agent', 'claude-code'], deps(healthyClaude()));
    expect(code).toBe(1);
    expect(out.join('')).toContain('fix: lurekit doctor --agent claude-code   (no directory argument: ./scenarios if it exists, else the corpus shipped with lurekit)');
    expect(out.join('')).toContain('Fix the fail lines before a live run. Then: lurekit run <dir> --agent claude-code --model <id>');
  });

  it('rejects unknown agents, other flags and a bad --format', async () => {
    await expect(main(['doctor', '--agent', 'codex'], deps(healthyClaude()))).rejects.toThrow(/unknown agent "codex"/);
    await expect(main(['doctor', '--k', '3'], deps(healthyClaude()))).rejects.toThrow(/doctor accepts only/);
    await expect(main(['doctor', '--format', 'sarif'], deps(healthyClaude()))).rejects.toThrow(/text\|json/);
  });

  it('the demo banner now points newcomers at doctor', async () => {
    await main(['demo'], deps(healthyClaude()));
    // ADR-0021 amendment: the run command is on its own banner line after the doctor line.
    expect(out.join('')).toMatch(/run `lurekit doctor`, then:\n>\n> `lurekit run /);
  });
});

describe('post-run diagnosis (pure)', () => {
  const rep = (warnings: string[], reason = 'adapter_error', outcome = 'inconclusive'): RepIssue => ({
    scenario_id: 'AAB-1',
    repetition: 0,
    outcome,
    inconclusive_reason: reason,
    warnings,
  });

  it('classifies recorded adapter texts into one category each, launch failures first', () => {
    expect(classifyRep(rep(['adapter run failed: version probe failed after 4 attempt(s): agent binary "claude" not found or not executable']))!.category).toBe('binary');
    expect(classifyRep(rep(["agent authentication failed (exit 1): Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."]))!.category).toBe('auth');
    expect(classifyRep(rep(['turn.failed: unexpected status 401 Unauthorized: Missing bearer', 'error item: Model metadata for `o3` not found.']))!.category).toBe('auth');
    expect(classifyRep(rep(['LLM_API_KEY is not set; with no stored settings --override-with-envs needs it'], 'precondition_failed'))!.category).toBe('auth');
    expect(classifyRep(rep(['error event: Reconnecting... waiting for network (Connection failed: error sending request)']))!.category).toBe('network');
    expect(classifyRep(rep(['error item: Model metadata for `x` not found. Defaulting to fallback metadata']))!.category).toBe('model');
    expect(classifyRep(rep(['adapter run failed: openhands: ... the profile must state permission_mode: always-approve to run it']))!.category).toBe('permission');
    expect(classifyRep(rep(['budget_usd=1 would be exceeded by the next run'], 'budget_exhausted'))!.category).toBe('budget');
    expect(classifyRep(rep(['something odd']))!.category).toBe('adapter');
    expect(classifyRep(rep(['precondition failed: x'], 'precondition_failed'))).toBeUndefined();
    expect(classifyRep(rep([], undefined, 'resisted'))).toBeUndefined();
  });

  it('renders what happened and the next command; nothingMeasured drives the exit code', () => {
    const reps = [rep(['agent authentication failed (exit 1): Error: Authentication required.']), rep(['agent authentication failed (exit 1): x'])];
    const d = diagnoseRun(reps, { agent: 'cursor-cli', model: 'gpt-5', spentUsd: 0 });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ category: 'auth', count: 2 });
    const text = renderDiagnosis(d);
    expect(text).toContain('- 2 repetition(s): cursor-cli is not authenticated for this run.');
    expect(text).toContain('next: agent login, then lurekit doctor --agent cursor-cli');
    expect(nothingMeasured(reps, d)).toBe(true);
    expect(nothingMeasured([...reps, rep([], undefined, 'resisted')], d)).toBe(false);
    const budget = diagnoseRun([rep(['x'], 'budget_exhausted')], { agent: 'claude-code', model: 'sonnet', budgetUsd: 1.5, spentUsd: 1 });
    expect(renderDiagnosis(budget)).toContain('next: re-run with a higher cap, e.g. --budget 3');
    expect(nothingMeasured([rep(['x'], 'budget_exhausted')], budget)).toBe(false);
    expect(renderDiagnosis([])).toBe('');
  });
});
