// Child env allow-list, bounded stderr and hashed task in *-argv.json (ADR-0008 amendment
// "Child env allow-list", "Bounded stderr"; evidence-spec s4.3 `env_forwarded`). Offline: every
// adapter is pointed at test/fixtures/agents/stub-env.mjs, which records the NAMES of the env it
// was started with. Values here are placeholders, never real credentials.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Adapter, SetupProfile } from '../src/adapters/adapter.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { CodexCliAdapter } from '../src/adapters/codexCli.js';
import { CursorCliAdapter } from '../src/adapters/cursorCli.js';
import { OpenHandsAdapter } from '../src/adapters/openhands.js';
import {
  AGENT_ENV_ALLOW,
  agentChildEnv,
  argvRecord,
  CappedStderr,
  harnessChildEnv,
  STDERR_FILE_MAX,
  stderrTruncationMarker,
} from '../src/adapters/childEnv.js';
import type { AgentId } from '../src/scenario/types.js';
import { mkScratch } from './helpers/scratch.js';

const STUB = fileURLToPath(new URL('./fixtures/agents/stub-env.mjs', import.meta.url));
const TASK = 'Summarise README.md in one sentence.';

/** Operator-environment variables that must never reach any child. */
const FOREIGN = ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'];
/** One auth variable per agent, set in the PARENT env (not in profile.env). */
const AUTH: Record<AgentId, string> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  'cursor-cli': 'CURSOR_API_KEY',
  'codex-cli': 'CODEX_API_KEY',
  openhands: 'LLM_API_KEY',
};
const PREFIXED: Partial<Record<AgentId, string>> = { 'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN', openhands: 'OPENHANDS_EXTRA_FLAG' };
const SET = [...FOREIGN, ...Object.values(AUTH), ...Object.values(PREFIXED)];

const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
beforeEach(() => {
  for (const k of SET) {
    saved.set(k, process.env[k]);
    process.env[k] = 'aab-test-placeholder';
  }
});
afterEach(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

function adapterFor(agent: AgentId): Adapter {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeAdapter({ bin: STUB });
    case 'cursor-cli':
      return new CursorCliAdapter({ bin: STUB });
    case 'codex-cli':
      return new CodexCliAdapter({ bin: STUB });
    case 'openhands':
      return new OpenHandsAdapter({ bin: STUB });
  }
}

async function runStub(agent: AgentId, extraEnv: Record<string, string> = {}) {
  const base = await mkScratch(`aab-child-env-${agent}-`);
  dirs.push(base);
  const runDir = path.join(base, 'run');
  const workdir = path.join(base, 'work');
  await mkdir(path.join(workdir, '.git'), { recursive: true });
  const namesOut = path.join(base, 'env-names.json');
  const profile: SetupProfile = {
    agent,
    agent_version: 'unpinned',
    model: 'stub-model',
    workdir,
    env: { AAB_STUB_ENV_NAMES_OUT: namesOut, OPERATOR_DECLARED: 'x', ...extraEnv },
    // openhands --headless is always-approve; the profile must say so (ADR-0019).
    ...(agent === 'openhands' ? { permission_mode: 'always-approve' } : {}),
  };
  const obs = await adapterFor(agent).run(profile, TASK, new AbortController().signal, { runDir });
  const seen = (JSON.parse(await readFile(namesOut, 'utf8')) as { names: string[] }).names;
  return { obs, seen, runDir };
}

const AGENTS: AgentId[] = ['claude-code', 'cursor-cli', 'codex-cli', 'openhands'];

describe('agent child env is allow-listed (ADR-0008 amendment)', () => {
  it.each(AGENTS)('%s: foreign secrets do not reach the child; its own auth and profile.env do', async (agent) => {
    const { obs, seen } = await runStub(agent);
    const upper = seen.map((n) => n.toUpperCase());
    for (const f of FOREIGN) expect(upper, `${agent} must not see ${f}`).not.toContain(f);
    expect(upper).toContain(AUTH[agent]);
    if (PREFIXED[agent]) expect(upper).toContain(PREFIXED[agent]);
    for (const other of AGENTS.filter((a) => a !== agent)) {
      if (AUTH[other] !== AUTH[agent]) expect(upper, `${agent} must not see ${AUTH[other]}`).not.toContain(AUTH[other]);
    }
    expect(seen).toContain('OPERATOR_DECLARED'); // profile.env always passes
    expect(seen).toContain('AAB_STUB_ENV_NAMES_OUT');
    expect(upper).toContain('PATH');
    // observation.env_forwarded: names only, sorted, and exactly what the child was given.
    expect(obs.env_forwarded).toBeDefined();
    expect(obs.env_forwarded).toEqual([...(obs.env_forwarded ?? [])].sort());
    for (const n of obs.env_forwarded ?? []) expect(seen, `${n} recorded but not seen`).toContain(n);
    for (const f of FOREIGN) expect(obs.env_forwarded).not.toContain(f);
    expect(JSON.stringify(obs.env_forwarded)).not.toContain('aab-test-placeholder');
  });

  it('agentChildEnv / harnessChildEnv: pure allow-list, case-insensitive names, profile.env wins', () => {
    const base = { Path: '/bin', HOME: '/h', LC_ALL: 'C', AAB_X: '1', GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', NODE_AUTH_TOKEN: 'n' };
    const claude = agentChildEnv('claude-code', { HOME: '/override', EXTRA: 'e' }, base);
    expect(Object.keys(claude).sort()).toEqual(['AAB_X', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'EXTRA', 'HOME', 'LC_ALL', 'Path']);
    expect(claude.HOME).toBe('/override');
    expect(Object.keys(agentChildEnv('codex-cli', undefined, base)).sort()).toEqual(['AAB_X', 'HOME', 'LC_ALL', 'Path']);
    const harness = harnessChildEnv({ AAB_TOKEN: 'v' }, base);
    expect(Object.keys(harness).sort()).toEqual(['AAB_TOKEN', 'AAB_X', 'HOME', 'LC_ALL', 'Path']);
    for (const a of Object.values(AGENT_ENV_ALLOW)) {
      for (const n of a.names ?? []) expect(harnessChildEnv({}, { [n]: 'v' }), `${n} must not reach a harness child`).toEqual({});
    }
  });
});

describe('bounded stderr and hashed task (ADR-0008 amendment "Bounded stderr")', () => {
  it('CappedStderr keeps the first max bytes and appends a marker', () => {
    const c = new CappedStderr(10);
    c.push(Buffer.from('12345678'));
    c.push(Buffer.from('abcdef'));
    c.push(Buffer.from('zz'));
    expect(c.head().toString()).toBe('12345678ab');
    expect(c.truncatedBytes).toBe(6);
    expect(c.fileContent().toString()).toBe(`12345678ab\n${stderrTruncationMarker(10, 6)}\n`);
    const small = new CappedStderr(10);
    small.push(Buffer.from('ok'));
    expect(small.fileContent().toString()).toBe('ok');
  });

  it.each([
    ['codex-cli', 'codex-stderr.log'],
    ['cursor-cli', 'cursor-stderr.log'],
    ['openhands', 'openhands-stderr.log'],
  ] as const)('%s: a stderr flood is capped at 1 MiB in %s', async (agent, file) => {
    const { runDir } = await runStub(agent, { AAB_STUB_STDERR_BYTES: String(STDERR_FILE_MAX + 4096) });
    const p = path.join(runDir, file);
    const text = await readFile(p, 'utf8');
    const marker = stderrTruncationMarker(STDERR_FILE_MAX, 4096);
    expect(text.endsWith(`\n${marker}\n`)).toBe(true);
    expect((await stat(p)).size).toBe(STDERR_FILE_MAX + marker.length + 2);
  }, 30_000);

  it.each([
    ['codex-cli', 'codex-argv.json'],
    ['cursor-cli', 'cursor-argv.json'],
    ['openhands', 'openhands-argv.json'],
  ] as const)('%s: %s stores the task as its sha256', async (agent, file) => {
    const { runDir } = await runStub(agent);
    const text = await readFile(path.join(runDir, file), 'utf8');
    expect(text).not.toContain(TASK);
    expect(text).toContain(`<task sha256:${createHash('sha256').update(TASK, 'utf8').digest('hex')}>`);
  });

  it('argvRecord replaces the task element and an embedded task', () => {
    const h = createHash('sha256').update('do x', 'utf8').digest('hex');
    expect(argvRecord('/b', ['-p', 'do x', '--task=do x'], 'do x')).toEqual(['/b', '-p', `<task sha256:${h}>`, `--task=<task sha256:${h}>`]);
  });
});
