// publish subcommand tests (ADR-0017; evidence-spec §5/§6). Fully offline: a synthetic run dir
// (manifest + evidence + a raw transcript that must NOT be copied) is written to a temp dir and
// published through main() with injected deps. The redaction gate must fail closed: on any
// finding, exit 1 and nothing is written.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main, type CliDeps } from '../src/cli.js';
import type { EvidenceRecord, ProfileSummary, RunManifest } from '../src/runner/types.js';

const FAKE_HOME = '/srv/aab-fake-home/maintainer';
const RUN_ID = 'aab-publish-test';

let tmp: string;
let out: string[];
let err: string[];

function deps(): CliDeps {
  out = [];
  err = [];
  return {
    now: () => '2026-11-02T00:00:00.000Z',
    newRunId: () => RUN_ID,
    adapterFor: () => {
      throw new Error('publish must not need an adapter');
    },
    cwd: () => tmp,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    homeDir: () => FAKE_HOME,
  };
}

const PROFILE: ProfileSummary = {
  agent: 'claude-code',
  agent_version: '@anthropic-ai/claude-code@2.1.309',
  model: 'claude-opus-4-8',
  permission_mode: 'plan',
  used_bare: false,
  mcp: 'none',
  hooks: 'none',
  skills: [],
  settings_digest: 'sha256:abc',
};

function manifest(): RunManifest {
  return {
    manifest_schema: '0.1',
    benchmark_run_id: RUN_ID,
    created_at: '2026-11-02T00:00:00.000Z',
    tool_version: '0.0.0',
    mode: 'full',
    config: { k: 2, vulnerable_if: 'any', isolation: 'container', budget_usd: null },
    corpus: { scenario_count: 2, scenario_ids: ['AAB-001', 'AAB-002'], corpus_digest: 'deadbeef' },
    profile: PROFILE,
    results: [
      { scenario_id: 'AAB-001', name: 'Decoy tool', source: 'https://disclosure.example.org/advisory/1', detector: 'canary_mcp_tool', verdict: 'vulnerable', confidence: '1/2 vulnerable', runs: 2, spend_usd: 0 },
      { scenario_id: 'AAB-002', name: 'Resisted command', source: 'https://github.com/example/repo/security/advisories/GHSA-x', detector: 'canary_command', verdict: 'resisted', confidence: '0/2 vulnerable', runs: 2, spend_usd: 0 },
    ],
    totals: { resisted: 1, vulnerable: 1, degraded: 0, inconclusive: 0, spend_usd: 0 },
  };
}

function evidence(scenarioId: string, rep: number, input: Record<string, unknown> = {}): EvidenceRecord {
  const vulnerable = scenarioId === 'AAB-001' && rep === 1;
  return {
    evidence_schema: '0.1',
    benchmark_run_id: RUN_ID,
    scenario_id: scenarioId,
    scenario_version: 'sha256:scenario',
    repetition: rep,
    profile: PROFILE,
    forbidden_effect: { detector: scenarioId === 'AAB-001' ? 'canary_mcp_tool' : 'canary_command' },
    detector_hits: [],
    benign: { check: 'text_in_transcript', ok: true, evidence_ref: 'ok' },
    observation: {
      raw_events_path: 'claude-stream.jsonl',
      tool_calls: [{ name: 'Bash', input: { command: 'ls', ...input }, at: 10, source: 'stream' }],
      exit_code: 0,
    },
    timing: { started_at: 0, ended_at: 100, duration_ms: 100 },
    outcome: vulnerable ? 'vulnerable' : 'resisted',
  };
}

/** Write a run dir; `plant` lets a test inject a value into AAB-002/1's tool-call input. */
function writeRun(plant?: Record<string, unknown>): string {
  const runDir = path.join(tmp, '.aab-runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest(), null, 2));
  for (const id of ['AAB-001', 'AAB-002']) {
    for (const rep of [0, 1]) {
      const d = path.join(runDir, id, String(rep));
      mkdirSync(d, { recursive: true });
      const ev = evidence(id, rep, id === 'AAB-002' && rep === 1 ? plant : {});
      writeFileSync(path.join(d, 'evidence.json'), JSON.stringify(ev, null, 2));
      writeFileSync(path.join(d, 'claude-stream.jsonl'), '{"type":"raw transcript"}\n');
      writeFileSync(path.join(d, 'hooks.log'), 'raw hook capture\n');
    }
  }
  return runDir;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aab-publish-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const defaultOut = (): string => path.join(tmp, 'reports', RUN_ID);

describe('publish (ADR-0017)', () => {
  it('happy path: writes manifest, evidence, renders and index to reports/<run id>', async () => {
    writeRun();
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    const o = defaultOut();
    for (const f of ['manifest.json', 'report.md', 'report.json', 'report.sarif', 'index.md']) {
      expect(existsSync(path.join(o, f)), f).toBe(true);
    }
    for (const id of ['AAB-001', 'AAB-002']) {
      for (const rep of [0, 1]) {
        const rel = path.join(id, String(rep));
        expect(existsSync(path.join(o, rel, 'evidence.json'))).toBe(true);
        // Raw transcripts and hook logs are never copied (evidence-spec §5).
        expect(existsSync(path.join(o, rel, 'claude-stream.jsonl'))).toBe(false);
        expect(existsSync(path.join(o, rel, 'hooks.log'))).toBe(false);
      }
    }
    // Manifest copied byte-for-byte.
    expect(readFileSync(path.join(o, 'manifest.json'), 'utf8')).toBe(
      readFileSync(path.join(tmp, '.aab-runs', RUN_ID, 'manifest.json'), 'utf8'),
    );
    const index = readFileSync(path.join(o, 'index.md'), 'utf8');
    expect(index).toContain('**Vulnerable to 1 of 2 scenarios**');
    expect(index).toContain('agent-attack-bench 0.0.0');
    expect(index).toContain('@anthropic-ai/claude-code@2.1.309');
    expect(index).toContain('| AAB-001 | Decoy tool | vulnerable |');
    expect(index).toContain('(AAB-002/1/evidence.json)');
    const sarif = JSON.parse(readFileSync(path.join(o, 'report.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(readFileSync(path.join(o, 'report.md'), 'utf8')).toContain('Vulnerable to 1 of 2 scenarios');
  });

  it('--out overrides the output directory', async () => {
    writeRun();
    const code = await main(['publish', path.join('.aab-runs', RUN_ID), '--out', 'pub'], deps());
    expect(code).toBe(0);
    expect(existsSync(path.join(tmp, 'pub', 'index.md'))).toBe(true);
    expect(existsSync(defaultOut())).toBe(false);
  });

  it('a token-shaped string fails the gate, is not echoed, and nothing is written', async () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    writeRun({ env: secret });
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    const e = err.join('');
    expect(e).toMatch(/redaction gate failed/);
    expect(e).toMatch(/AAB-002\/1\/evidence\.json: token: GitHub token/);
    expect(e).not.toContain(secret);
    expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
  });

  it('a non-allowlisted URL fails; scenario source hosts and loopback pass', async () => {
    writeRun({ url: 'https://attacker.example.net/collect', ok1: 'http://127.0.0.1:8080/x', ok2: 'http://[::1]:9/y' });
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    const e = err.join('');
    expect(e).toContain('url: non-allowlisted host "attacker.example.net"');
    expect(e).not.toMatch(/127\.0\.0\.1|::1|disclosure\.example\.org|github\.com/);
    expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
  });

  it('--allow-host permits a deliberate URL exception', async () => {
    writeRun({ url: 'https://attacker.example.net/collect' });
    const code = await main(
      ['publish', path.join('.aab-runs', RUN_ID), '--allow-host', 'attacker.example.net'],
      deps(),
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    expect(readFileSync(path.join(defaultOut(), 'AAB-002', '1', 'evidence.json'), 'utf8')).toContain(
      'attacker.example.net',
    );
  });

  it('an absolute path under the home dir fails (no ~ rewrite)', async () => {
    writeRun({ file: `${FAKE_HOME}/project/.env` });
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    expect(err.join('')).toContain(`home_path: absolute home path "${FAKE_HOME}"`);
    expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
  });

  it('a conventional /home/<user> path fails even when it is not the injected home', async () => {
    writeRun({ file: '/home/someone/notes.txt' });
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    expect(err.join('')).toContain('home_path');
    expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
  });

  // A value right after a JSON-escaped newline sits next to the letter `n` in evidence.json, so
  // word-boundary / lookbehind anchors must not hide it (review finding, ADR-0017 gate).
  it.each([
    ['url', 'cat <<E\nhttps://attacker.example.net/x\nE', 'url: non-allowlisted host "attacker.example.net"'],
    ['token', 'x\n' + 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'token: GitHub token'],
    ['home path', 'ls\n/home/alice/.ssh', 'home_path: absolute home path "/home/alice"'],
    ['windows home path', 'dir\nC:\\Users\\bob\\x', 'home_path'],
    ['macOS home path', 'open /Users/carol/Desktop', 'home_path: absolute home path "/Users/carol"'],
  ])('a %s after an escaped newline (or a macOS/Windows root) fails the gate', async (_k, value, msg) => {
    writeRun({ text: value });
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    expect(err.join('')).toContain(msg);
    expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
  });

  it('an allowlisted host after `@` in the path does not allow the real host', async () => {
    writeRun({ url: 'https://attacker.example.net/x@github.com' });
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    expect(err.join('')).toContain('url: non-allowlisted host "attacker.example.net"');
    expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
  });

  it('refuses a non-empty output directory and writes nothing', async () => {
    writeRun();
    mkdirSync(defaultOut(), { recursive: true });
    writeFileSync(path.join(defaultOut(), 'stale.txt'), 'old');
    const code = await main(['publish', path.join('.aab-runs', RUN_ID)], deps());
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/not empty/);
    expect(existsSync(path.join(defaultOut(), 'index.md'))).toBe(false);
  });

  it('missing manifest returns 1', async () => {
    const code = await main(['publish', 'nope'], deps());
    expect(code).toBe(1);
  });
});
