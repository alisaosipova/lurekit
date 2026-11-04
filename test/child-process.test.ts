// ADR-0024 D5 child-process helper tests (test plan T4, T4w, T7). Real processes: a stub agent
// (node -e) that spawns a sleeping grandchild which inherits the agent's stdout pipe. The tests
// prove that one abort kills BOTH pids (process-group kill) and that the adapter's wait returns
// even while a grandchild still holds the pipe (the `close`-only regression). Offline, no
// network, no spend; every child is killed in afterEach.

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  KILL_GRACE_MS,
  STDIO_DRAIN_MS,
  VERSION_PROBE_TIMEOUT_MS,
  killTree,
  probeVersionCapped,
  resetTrackedChildren,
  spawnAgent,
  trackedChildren,
  waitExit,
} from '../src/adapters/childProcess.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';
import type { SetupProfile } from '../src/adapters/adapter.js';
import { mkScratch, rmScratch } from './helpers/scratch.js';
import { pollUntil, READY_DEADLINE_MS } from './helpers/deadline.js';

const POSIX_ONLY = 'process groups and kill(-pid) are POSIX; Windows uses taskkill /T, covered by T4w';
const WIN_ONLY = 'taskkill /T is the Windows tree kill; POSIX is covered by T4';
const isWin = process.platform === 'win32';

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await mkScratch('aab-childproc-');
  dirs.push(d);
  return d;
}
afterEach(async () => {
  resetTrackedChildren();
  while (dirs.length > 0) await rmScratch(dirs.pop()!);
});

/** A stub agent: spawns a sleeping grandchild that INHERITS this process's stdout/stderr pipes,
 *  writes `<own pid> <grandchild pid>` to the ready file, then sleeps (or exits when told). */
function agentScript(readyFile: string, parentExits: boolean): string {
  return [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, process.pid + ' ' + g.pid);`,
    "process.stdout.write('agent up\\n');",
    parentExits ? 'setTimeout(() => process.exit(0), 50);' : 'setInterval(() => {}, 1e9);',
  ].join('\n');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readPids(readyFile: string): Promise<{ agent: number; grandchild: number }> {
  await pollUntil(() => readFile(readyFile, 'utf8'), `stub agent never wrote ${readyFile}`);
  const [a, g] = (await readFile(readyFile, 'utf8')).trim().split(' ').map(Number);
  return { agent: a, grandchild: g };
}

describe('T4 process-group kill (POSIX)', () => {
  it.skipIf(isWin)(`killTree kills the agent AND its grandchild, and waitExit returns although the grandchild held stdout (${POSIX_ONLY})`, async () => {
    const dir = await scratch();
    const ready = path.join(dir, 'ready');
    const child = spawnAgent(process.execPath, ['-e', agentScript(ready, false)], { cwd: dir, env: { PATH: process.env.PATH ?? '' } });
    expect(trackedChildren()).toBe(1);
    let out = '';
    child.stdout!.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr!.on('data', () => {});
    const exitP = waitExit(child);
    const pids = await readPids(ready);
    expect(alive(pids.agent)).toBe(true);
    expect(alive(pids.grandchild)).toBe(true);

    const t0 = Date.now();
    await killTree(child);
    const exit = await exitP;
    // SIGTERM is honoured by a node child at once (128 + 15); on a heavily loaded host the
    // grace can run out first and SIGKILL (128 + 9) follows. Either way it died by signal.
    expect(['SIGTERM', 'SIGKILL']).toContain(exit.signal);
    expect([143, 137]).toContain(exit.exitCode);
    expect(Date.now() - t0).toBeLessThan(KILL_GRACE_MS + STDIO_DRAIN_MS + 2_000);
    expect(out).toContain('agent up');
    await pollUntil(async () => {
      if (alive(pids.grandchild)) throw new Error('grandchild still alive');
    }, `grandchild ${pids.grandchild} survived the group kill`, READY_DEADLINE_MS);
    expect(alive(pids.agent)).toBe(false);
    expect(trackedChildren()).toBe(0);
  });

  it.skipIf(isWin)(`a grandchild that outlives a normally exiting agent cannot block waitExit (${POSIX_ONLY})`, async () => {
    const dir = await scratch();
    const ready = path.join(dir, 'ready');
    const child = spawnAgent(process.execPath, ['-e', agentScript(ready, true)], { cwd: dir, env: { PATH: process.env.PATH ?? '' } });
    child.stdout!.on('data', () => {});
    child.stderr!.on('data', () => {});
    const t0 = Date.now();
    const exit = await waitExit(child, { drainMs: 300 });
    const pids = await readPids(ready);
    expect(exit.exitCode).toBe(0);
    expect(exit.drainTimedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The grandchild is still there (its parent exited normally; nothing killed the group)...
    expect(alive(pids.grandchild)).toBe(true);
    // ...until the tree is killed explicitly (what an adapter's abort path does).
    process.kill(-pids.agent, 'SIGKILL');
    await pollUntil(async () => {
      if (alive(pids.grandchild)) throw new Error('grandchild still alive');
    }, `grandchild ${pids.grandchild} survived`, READY_DEADLINE_MS);
  });

  it.skipIf(isWin)(`SIGKILL follows when SIGTERM is ignored (${POSIX_ONLY})`, async () => {
    const dir = await scratch();
    const script = "process.on('SIGTERM', () => {}); process.stdout.write('up\\n'); setInterval(() => {}, 1e9);";
    const child = spawnAgent(process.execPath, ['-e', script], { cwd: dir, env: { PATH: process.env.PATH ?? '' } });
    let out = '';
    child.stdout!.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr!.on('data', () => {});
    await pollUntil(async () => {
      if (!out.includes('up')) throw new Error('not up');
    }, 'stub never started');
    const exitP = waitExit(child);
    const t0 = Date.now();
    await killTree(child, { graceMs: 200 });
    const exit = await exitP;
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.exitCode).toBe(137);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe('T4w process-tree kill (Windows)', () => {
  it.skipIf(!isWin)(`killTree invokes taskkill /PID <pid> /T /F and the grandchild is gone (${WIN_ONLY})`, async () => {
    const dir = await scratch();
    const ready = path.join(dir, 'ready');
    const child = spawnAgent(process.execPath, ['-e', agentScript(ready, false)], { cwd: dir, env: process.env });
    child.stdout!.on('data', () => {});
    child.stderr!.on('data', () => {});
    const exitP = waitExit(child);
    const pids = await readPids(ready);
    const calls: number[] = [];
    await killTree(child, {
      taskkill: (pid) => {
        calls.push(pid);
        const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return { status: r.status, ...(r.error ? { error: r.error } : {}) };
      },
    });
    await exitP;
    expect(calls).toEqual([pids.agent]);
    await pollUntil(async () => {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pids.grandchild}`], { encoding: 'utf8', windowsHide: true });
      if (r.stdout.includes(String(pids.grandchild))) throw new Error('grandchild still listed');
    }, `grandchild ${pids.grandchild} survived taskkill /T`, READY_DEADLINE_MS);
  });
});

describe('spawn failure and probe cap', () => {
  it('a binary that does not exist: waitExit resolves with -1 and the error, nothing stays tracked', async () => {
    const dir = await scratch();
    const child = spawnAgent(path.join(dir, 'no-such-agent'), [], { cwd: dir, env: {} });
    const exit = await waitExit(child, { drainMs: 200 });
    expect(exit.exitCode).toBe(-1);
    expect(exit.error?.code).toBe('ENOENT');
    expect(trackedChildren()).toBe(0);
  });

  it('probeVersionCapped kills a probe that sleeps past the cap (default cap is 15 s)', () => {
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(15_000);
    const t0 = Date.now();
    const res = probeVersionCapped(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { PATH: process.env.PATH ?? '' }, 300);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((res.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
    expect(res.status).toBeNull();
  });
});

describe('T7 Claude Code --version probe is capped', () => {
  it('a binary that blocks on --version yields "no version reported" within the cap instead of hanging', async () => {
    const dir = await scratch();
    const bin = path.join(dir, 'blocking-claude.mjs');
    // Blocks on --version; otherwise emits a minimal stream and exits 0.
    await writeFile(
      bin,
      [
        "if (process.argv.includes('--version')) { setInterval(() => {}, 1e9); }",
        "else { process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'plan', mcp_servers: [] }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0 }) + '\\n'); }",
      ].join('\n'),
      'utf8',
    );
    const runDir = path.join(dir, 'run');
    const workdir = path.join(dir, 'work');
    await mkdir(workdir, { recursive: true });
    const profile: SetupProfile = { agent: 'claude-code', agent_version: '@anthropic-ai/claude-code@2.1.309', model: 'm', workdir, permission_mode: 'plan' };
    const adapter = new ClaudeCodeAdapter({ bin, versionProbeTimeoutMs: 300, retryDelaysMs: [], sleep: async () => {} });
    const t0 = Date.now();
    const obs = await adapter.run(profile, 'hello', new AbortController().signal, { runDir });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(obs.exit_code).toBe(0);
    expect(obs.agent_version_reported).toBeUndefined();
    expect(obs.warnings).toContain('could not read agent version from `--version`');
    await rm(runDir, { recursive: true, force: true });
  });
});
