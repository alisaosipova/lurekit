// publish subcommand tests (ADR-0017; evidence-spec §5/§6). Fully offline: a synthetic run dir
// (manifest + evidence + a raw transcript that must NOT be copied) is written to a temp dir and
// published through main() with injected deps. The redaction gate must fail closed: on any
// finding, exit 1 and nothing is written.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { main, type CliDeps } from '../src/cli.js';
import type { EvidenceRecord, ProfileSummary, RunManifest } from '../src/runner/types.js';
import { redactHomeDir } from '../src/report/publish.js';

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

  // --redact-home (ADR-0017 "Operator home redaction"). The sample mirrors a real live run: the
  // agent listed the memory dir Claude Code itself announced, once after an escaped newline.
  describe('--redact-home', () => {
    const MEMORY_DIR = `${FAKE_HOME}/.claude/projects/-srv-aab-fake-home-maintainer-work/memory/`;
    const sample = { command: `ls\n${MEMORY_DIR}`, cwd: FAKE_HOME };

    /** sha256 of every file under the run dir, keyed by relative path. */
    function hashTree(dir: string, base = dir, acc = new Map<string, string>()): Map<string, string> {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) hashTree(p, base, acc);
        else acc.set(path.relative(base, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
      }
      return acc;
    }

    function publishedTexts(dir: string): Map<string, string> {
      const m = new Map<string, string>();
      for (const rel of hashTree(dir).keys()) m.set(rel, readFileSync(path.join(dir, rel), 'utf8'));
      return m;
    }

    it('the sample fails without the flag and passes with it; source untouched', async () => {
      const runDir = writeRun(sample);
      const before = hashTree(runDir);

      expect(await main(['publish', path.join('.aab-runs', RUN_ID)], deps())).toBe(1);
      expect(err.join('')).toContain(`home_path: absolute home path "${FAKE_HOME}"`);
      expect(err.join('')).toContain('--redact-home');
      expect(existsSync(path.join(tmp, 'reports'))).toBe(false);

      const code = await main(['publish', path.join('.aab-runs', RUN_ID), '--redact-home'], deps());
      expect(err.join('')).toBe('');
      expect(code).toBe(0);
      expect(out.join('')).toContain('redaction applied: home directory -> <HOME> (2 replacements)');

      const texts = publishedTexts(defaultOut());
      for (const [rel, text] of texts) expect(text, rel).not.toContain(FAKE_HOME);
      const ev = JSON.parse(texts.get(path.join('AAB-002', '1', 'evidence.json')) as string) as EvidenceRecord;
      expect(ev.observation?.tool_calls[0].input).toEqual({
        command: 'ls\n<HOME>/.claude/projects/-srv-aab-fake-home-maintainer-work/memory/',
        cwd: '<HOME>',
      });
      // Untouched evidence stays byte-identical to the source.
      expect(texts.get(path.join('AAB-001', '0', 'evidence.json'))).toBe(
        readFileSync(path.join(runDir, 'AAB-001', '0', 'evidence.json'), 'utf8'),
      );

      // Source run artefacts are never modified (every file, including raw transcripts).
      expect(hashTree(runDir)).toEqual(before);
      expect(readFileSync(path.join(runDir, 'AAB-002', '1', 'evidence.json'), 'utf8')).toContain(MEMORY_DIR);
    });

    it('index.md records the redaction and its count', async () => {
      writeRun(sample);
      expect(await main(['publish', path.join('.aab-runs', RUN_ID), '--redact-home'], deps())).toBe(0);
      const index = readFileSync(path.join(defaultOut(), 'index.md'), 'utf8');
      expect(index).toContain('redaction applied: home directory -> <HOME> (2 replacements)');
    });

    it('without the flag index.md carries no redaction note', async () => {
      writeRun();
      expect(await main(['publish', path.join('.aab-runs', RUN_ID)], deps())).toBe(0);
      expect(readFileSync(path.join(defaultOut(), 'index.md'), 'utf8')).not.toContain('redaction applied');
    });

    it('a clean run with the flag publishes with 0 replacements', async () => {
      writeRun();
      expect(await main(['publish', path.join('.aab-runs', RUN_ID), '--redact-home'], deps())).toBe(0);
      expect(readFileSync(path.join(defaultOut(), 'index.md'), 'utf8')).toContain('(0 replacements)');
    });

    it.each([
      ['another user\'s /home', '/home/someone/notes.txt', 'home_path: absolute home path "/home/someone"'],
      ['a macOS home', '/Users/carol/Desktop', 'home_path: absolute home path "/Users/carol"'],
      ['a Windows home', 'C:\\Users\\dave\\x', 'home_path: absolute home path "C:\\\\Users\\\\dave"'],
    ])('%s still fails even with the flag', async (_k, foreign, msg) => {
      const runDir = writeRun({ ...sample, other: foreign });
      const before = hashTree(runDir);
      expect(await main(['publish', path.join('.aab-runs', RUN_ID), '--redact-home'], deps())).toBe(1);
      expect(err.join('')).toContain(msg);
      expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
      expect(hashTree(runDir)).toEqual(before);
    });

    it('tokens and URLs still fail with the flag', async () => {
      const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
      writeRun({ ...sample, env: secret, url: 'https://attacker.example.net/collect' });
      expect(await main(['publish', path.join('.aab-runs', RUN_ID), '--redact-home'], deps())).toBe(1);
      const e = err.join('');
      expect(e).toContain('token: GitHub token');
      expect(e).toContain('url: non-allowlisted host "attacker.example.net"');
      expect(e).not.toContain(secret);
      expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
    });

    it.each(['/home/op@old/x', '/home/op+bak/x', '/home/op\u00fc/x', '/home/op~/x', '/home/op,x/y'])(
      'a sibling of the operator home (%s) is not masked and still fails the gate',
      async (sibling) => {
        const runDir = writeRun({ cwd: '/home/op', other: sibling });
        const before = hashTree(runDir);
        const d = { ...deps(), homeDir: () => '/home/op' };
        expect(await main(['publish', path.join('.aab-runs', RUN_ID), '--redact-home'], d)).toBe(1);
        expect(err.join('')).toContain('home_path: absolute home path "/home/op');
        expect(existsSync(path.join(tmp, 'reports'))).toBe(false);
        expect(hashTree(runDir)).toEqual(before);
      },
    );

    it('redactHomeDir: boundaries, JSON-escaped Windows spelling, root-ish home', () => {
      expect(redactHomeDir('a /home/u/x /home/u2 /home/u.bak "/home/u"', '/home/u/')).toEqual({
        text: 'a <HOME>/x /home/u2 /home/u.bak "<HOME>"',
        count: 2,
      });
      // Only a segment terminator ends the home: siblings and trailing punctuation stay (fail closed).
      expect(redactHomeDir('/home/u@o /home/u+b /home/u\u00fc /home/u~ (/home/u) /home/u `/home/u`', '/home/u')).toEqual({
        text: '/home/u@o /home/u+b /home/u\u00fc /home/u~ (/home/u) <HOME> `<HOME>`',
        count: 2,
      });
      expect(redactHomeDir('{"p":"C:\\\\Users\\\\bob\\\\x","q":"C:/Users/bob"}', 'C:\\Users\\bob')).toEqual({
        text: '{"p":"<HOME>\\\\x","q":"<HOME>"}',
        count: 2,
      });
      expect(redactHomeDir('/x', '/')).toEqual({ text: '/x', count: 0 });
    });
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
