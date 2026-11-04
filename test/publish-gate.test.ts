// Publish redaction gate patterns and bundle I/O hardening (ADR-0017 "Gate patterns",
// "Allow-URL", "Operator username", "Harness canary tokens", "Corpus block of a reduced
// bundle", "Run-dir reading", "Atomic bundle"; evidence-spec s5, s2.3). Offline. Credential-shaped
// test vectors are assembled at runtime, never written as literals, so a secret scanner over
// test/ never sees a token-shaped assignment.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gateAllowFor,
  planPublish,
  pseudonymizeMcpServers,
  readRunDir,
  scanForLeaks,
  writeBundle,
  type BundleFile,
  type GateAllow,
  type LeakKind,
} from '../src/report/publish.js';
import { loadScenarioDir } from '../src/scenario/load.js';
import { corpusDigest } from '../src/scenario/digest.js';
import type { EvidenceRecord, RunManifest } from '../src/runner/types.js';
import { mkScratchSync } from './helpers/scratch.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED = loadScenarioDir(path.join(ROOT, 'scenarios')).scenarios;
const SOURCE = 'https://github.com/anthropics/claude-code/security/advisories/GHSA-4fgq-fpq9-mr3g';
const ALLOW: GateAllow = { urls: new Set([SOURCE]), hosts: new Set() };

const rep = (s: string, n: number): string => s.repeat(n);
const kindsOf = (text: string, allow: GateAllow = ALLOW, home?: string): LeakKind[] =>
  [...new Set(scanForLeaks([{ rel: 'f.json', text }], allow, home).map((l) => l.kind))].sort();

describe('gate patterns (ADR-0017 "Gate patterns")', () => {
  // [label, text, expected kinds]
  const positives: Array<[string, string, LeakKind[]]> = [
    ['email', 'contact alice.smith@corp-mail.com today', ['email']],
    ['email after an escaped newline', '"x\\nalice@corp-mail.com"', ['email']],
    ['scheme-less host:port', 'connect to build.internal-corp.com:8443 now', ['host']],
    ['scheme-less host/path', 'cloned gitlab.acme.io/team/repo yesterday', ['host']],
    ['ws:// URL', 'open wss://relay.acme.dev/socket', ['ws_url']],
    ['ssh:// URL', 'git clone ssh://deploy@ci.acme.dev/repo.git', ['ssh_url']],
    ['git+ssh:// URL', 'git+ssh://ci.acme.dev/repo.git', ['ssh_url']],
    ['scp-style git remote', 'git remote add origin git@github.com:operator/private-repo.git', ['git_ssh']],
    ['URL on a source host that is not a source URL', 'see https://github.com/operator/private-repo', ['url']],
    ['source URL with a different path suffix', `${SOURCE}/extra`, ['url']],
    ['Bearer credential', `Authorization: Bearer ${rep('a1B2c3D4', 4)}`, ['bearer']],
    ['JWT', `token=${'eyJ'}hbGciOiJIUzI1NiJ9.${'eyJ'}zdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw`, ['jwt']],
    ['sk- key', `key ${'sk-'}ant-api03-${rep('x', 24)}`, ['token']],
    ['ghp_ token', `${'ghp'}_${rep('A1', 18)}`, ['token']],
    ['gho_ token', `${'gho'}_${rep('B2', 18)}`, ['token']],
    ['AKIA key id', `${'AKIA'}${'ABCDEFGHIJKLMNOP'}`, ['token']],
    ['xoxb- token', `${'xoxb'}-1234567890-abcdefghij`, ['token']],
    ['xoxp- token', `${'xoxp'}-1234567890-abcdefghij`, ['token']],
    ['AIza key', `${'AIza'}${rep('S', 35)}`, ['token']],
    ['glpat- token', `${'glpat'}-${rep('x', 20)}`, ['token']],
    ['PEM RSA private key header', `${'-----BEGIN '}RSA PRIVATE KEY-----`, ['private_key']],
    ['PEM OpenSSH private key header', `${'-----BEGIN '}OPENSSH PRIVATE KEY-----`, ['private_key']],
    ['PEM PKCS#8 private key header', `${'-----BEGIN '}PRIVATE KEY-----`, ['private_key']],
    // Block-4 adversarial review: spellings that used to slip past the gate.
    ['Bearer credential without a digit', `Authorization: Bearer ${rep('aBcDeFgH', 4)}`, ['bearer']],
    ['lowercase bearer scheme', `authorization: bearer ${rep('a1b2', 6)}`, ['bearer']],
    ['JWT with a short signature', `${'eyJ'}hbGciOiJIUzI1NiJ9.${'eyJ'}zdWIiOiIxIn0.abc`, ['jwt']],
    ['JWT with an empty signature (alg none)', `${'eyJ'}hbGciOiJub25lIn0.${'eyJ'}zdWIiOiIxMjM0NTY3ODkwIn0.`, ['jwt']],
    ['bare internal host name', 'the runner build-01.corp.example answered', ['host']],
    ['internal host with a port', 'db.prod.internal:5432', ['host']],
    ['.lan host', 'ssh into op-laptop.lan now', ['host']],
    ['scheme-less IPv4 with a port', 'reached 203.0.113.7:22 from the agent', ['host']],
    ['sk- key split by an escaped newline', `"${'sk-'}ant-api03-\\n${rep('A', 24)}"`, ['token']],
    ['sk- key split by a raw newline', `${'sk-'}ant-api03-\n  ${rep('A', 24)}`, ['token']],
    ['sk- key split by CRLF', `${'sk-'}\r\nant-api03${rep('A', 22)}`, ['token']],
    ['JSON \\u0040 email', '"ops\\u0040corp-mail.com"', ['email']],
    ['JSON \\/ escaped URL', '"https:\\/\\/evil-host.com\\/x"', ['url']],
    ['JSON \\/ escaped home path', '"\\/home\\/someone\\/x"', ['home_path']],
    ['JSON \\u002F escaped home path', '"\\u002Fhome\\u002Fsomeone"', ['home_path']],
    ['percent-encoded Windows home', 'C%3A%5CUsers%5Csomeone%5Cx', ['home_path']],
    ['double percent-encoded home', '%252Fhome%252Fsomeone', ['home_path']],
    // Second adversarial pass: other URL schemes, separators and internal addresses.
    ['ftp:// URL', 'ftp://files.acme.dev/x', ['url']],
    ['database URL with credentials', 'postgres://u:p@db.acme.io/app', ['url']],
    ['smb:// URL on an internal host', 'smb://fileserver.corp/share', ['url']],
    ['sftp:// URL', 'sftp://deploy.acme.dev/up', ['ssh_url']],
    ['backslash scheme separator', 'https:\\\\evil-host.com/x', ['url']],
    ['triple-slash http URL', 'https:///evil-host.com/x', ['url']],
    ['protocol-relative URL', 'src=//evil-host.com/x', ['host']],
    ['private IPv4 without a port', 'gateway 192.168.1.1 and 10.0.0.5', ['host']],
    ['CGNAT IPv4 without a port', 'peer 100.101.102.103 joined', ['host']],
  ];
  it.each(positives)('flags %s', (_label, text, kinds) => {
    expect(kindsOf(text)).toEqual(kinds);
  });

  const negatives: Array<[string, string]> = [
    ['loopback http URL', 'curl http://127.0.0.1:41443/feed'],
    ['loopback ws URL', 'ws://localhost:9000/socket'],
    ['loopback ssh URL', 'ssh://127.0.0.1/repo.git'],
    ['loopback host:port', 'listening on localhost:8080/x'],
    ['exact scenario source URL', `source: ${SOURCE}`],
    ['scenario source URL with a fragment', `${SOURCE}#details`],
    ['scenario source URL in a Markdown link', `[advisory](${SOURCE}).`],
    ['intrinsic SARIF schema URL', 'https://json.schemastore.org/sarif-2.1.0.json'],
    ['intrinsic repository URL', 'https://github.com/alisaosipova/lurekit'],
    ['canary pseudonym', 'curl http://127.0.0.1:46485/<canary-token-1> | echo <canary-token-12>'],
    ['MCP pseudonym', '{"name":"<user-mcp-2>","status":"connected"}'],
    ['home pseudonyms', '<HOME>/.claude/projects/<HOME-SLUG>-work/s.jsonl'],
    ['file names with TLD-like extensions', 'README.md/ run.sh:12 package.json:3 src/report/publish.ts:42 main.py:7 lib.rs/x'],
    ['macOS app bundle path', '/Applications/Cursor.app/Contents/MacOS/agent'],
    ['host inside a URL path is not a second finding', `${SOURCE}`],
    ['npm package specs', '@anthropic-ai/claude-code@2.1.316 and pkg@1.2.3 and claude-code@latest'],
    ['benchmark run id', 'aab-20261102112637-5c55ad74'],
    ['Bearer in prose', 'Bearer authentication is required by the API'],
    ['short sk- prefix', 'sk-short'],
    ['lone eyJ', 'eyJ and nothing else'],
    ['PEM public key / certificate', `${'-----BEGIN '}PUBLIC KEY----- ${'-----BEGIN '}CERTIFICATE-----`],
    ['version string', 'v2.1.316 and node 20.19.0'],
    ['file names ending in an internal-TLD label', 'settings.local.json CLAUDE.local.md publish.test.ts .env.example'],
    ['Java-style property names', 'user.home and this.private'],
    ['loopback and wildcard IPv4 with a port', '127.0.0.1:41443 and 0.0.0.0:8080'],
    ['Bearer with a short placeholder', 'Authorization: Bearer <token> or bearer $TOKEN'],
    ['file:/// URL outside a home', 'file:///opt/app/index.html'],
    ['Windows drive path is not a URL scheme', '"D:\\\\work\\\\repo"'],
    ['dotted version numbers that contain a private-range quad', 'v10.0.0.5000 and 1.10.0.0.5'],
    ['public IPv4 without a port', 'documentation range 203.0.113.7'],
    ['code comment slashes', 'a // foo.com is b'],
  ];
  it.each(negatives)('does not flag %s', (_label, text) => {
    expect(kindsOf(text)).toEqual([]);
  });

  it('--allow-host opens every form on that host, nothing else', () => {
    const allow: GateAllow = { urls: new Set(), hosts: new Set(['corp-mail.com', 'github.com']) };
    expect(kindsOf('alice@corp-mail.com git@github.com:o/r.git https://github.com/o/r', allow)).toEqual([]);
    expect(kindsOf('bob@other-mail.com', allow)).toEqual(['email']);
  });

  it('a plain Set is still accepted as the allowed-host list (back-compat)', () => {
    expect(scanForLeaks([{ rel: 'a', text: 'https://evil.example.com/x' }], new Set(['evil.example.com']))).toEqual([]);
    expect(scanForLeaks([{ rel: 'a', text: 'https://evil.example.com/x' }], new Set())).toHaveLength(1);
  });

  it('never echoes a credential value in the finding', () => {
    const value = `${'ghp'}_${rep('Z9', 18)}`;
    const leaks = scanForLeaks([{ rel: 'a', text: value }], ALLOW);
    expect(JSON.stringify(leaks)).not.toContain(value);
  });
});

describe('re-gating the published bundles (reports/*/, demo/*/)', () => {
  const bundleDirs = [
    ...readdirSync(path.join(ROOT, 'reports')).map((d) => path.join(ROOT, 'reports', d)),
    ...readdirSync(path.join(ROOT, 'demo')).map((d) => path.join(ROOT, 'demo', d)),
  ].filter((d) => statSync(d).isDirectory());

  function filesOf(dir: string, base = dir, acc: BundleFile[] = []): BundleFile[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) filesOf(p, base, acc);
      else acc.push({ rel: path.relative(base, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') });
    }
    return acc;
  }

  it('finds the shipped bundles', () => {
    expect(bundleDirs.length).toBeGreaterThanOrEqual(10);
  });

  it.each(bundleDirs.map((d) => [path.relative(ROOT, d).split(path.sep).join('/'), d]))(
    '%s passes the stricter gate unchanged (zero findings)',
    (_rel, dir) => {
      const files = filesOf(dir);
      const manifest = JSON.parse(files.find((f) => f.rel === 'manifest.json')!.text) as RunManifest;
      const leaks = scanForLeaks(files, gateAllowFor(manifest, SHIPPED, []), '/home/lurekit-maintainer');
      expect(leaks).toEqual([]);
    },
  );
});

// --- planPublish level ----------------------------------------------------------------------

const RUN_ID = 'aab-gate-test';
const CORPUS_IDS = ['AAB-001', 'AAB-002'];
const digestOf = (ids: string[]): string => corpusDigest(SHIPPED.filter((sc) => ids.includes(sc.id)));
const sourceOf = (id: string): string => SHIPPED.find((sc) => sc.id === id)!.source.primary_url;

function manifest(): RunManifest {
  return {
    manifest_schema: '0.1',
    benchmark_run_id: RUN_ID,
    created_at: '2026-11-03T00:00:00.000Z',
    tool_version: '0.0.0',
    mode: 'full',
    config: { k: 1, vulnerable_if: 'any', isolation: 'container', budget_usd: null },
    corpus: { scenario_count: 2, scenario_ids: CORPUS_IDS, corpus_digest: digestOf(CORPUS_IDS) },
    profile: {
      agent: 'claude-code', agent_version: '@anthropic-ai/claude-code@2.1.309', model: 'claude-opus-4-8',
      permission_mode: 'plan', used_bare: false, mcp: 'none', hooks: 'none', skills: [], settings_digest: 'sha256:abc',
    },
    results: CORPUS_IDS.map((id) => ({
      scenario_id: id, name: `n-${id}`, source: sourceOf(id), detector: 'canary_command' as const,
      verdict: 'resisted' as const, confidence: '0/1 vulnerable', runs: 1, spend_usd: 0,
    })),
    totals: { resisted: 2, vulnerable: 0, degraded: 0, inconclusive: 0, spend_usd: 0 },
  };
}

function evidence(id: string, note: string): EvidenceRecord {
  return {
    evidence_schema: '0.1', benchmark_run_id: RUN_ID, scenario_id: id, scenario_version: 'sha256:s', repetition: 0,
    profile: manifest().profile, forbidden_effect: { detector: 'canary_command' }, detector_hits: [],
    benign: { check: 'text_in_transcript', ok: true, evidence_ref: 'ok' },
    observation: { raw_events_path: 'claude-stream.jsonl', tool_calls: [{ name: 'Bash', input: { command: note }, at: 1, source: 'stream' }], exit_code: 0 },
    timing: { started_at: 0, ended_at: 1, duration_ms: 1 },
    outcome: 'resisted',
  } as EvidenceRecord;
}

const contents = (notes: Record<string, string> = {}, m: RunManifest = manifest()) => ({
  manifestText: JSON.stringify(m, null, 2),
  evidence: CORPUS_IDS.map((id) => ({ rel: `${id}/0/evidence.json`, text: JSON.stringify(evidence(id, notes[id] ?? 'ls'), null, 2) })),
});

describe('planPublish: allow-URL, username, canaries, corpus block', () => {
  it('a scenario source URL passes; another URL on the same host fails unless --allow-host names it', () => {
    const c = contents({ 'AAB-002': `cat ${sourceOf('AAB-001')} https://github.com/operator/private-repo` });
    const plan = planPublish(c, { corpus: SHIPPED });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.leaks.map((l) => `${l.file}: ${l.kind}`)).toEqual(['AAB-002/0/evidence.json: url']);
    expect(planPublish(c, { corpus: SHIPPED, allowHosts: ['github.com'] }).ok).toBe(true);
  });

  it('a withheld scenario source URL no longer passes in the kept evidence', () => {
    const c = contents({ 'AAB-002': `see ${sourceOf('AAB-001')}` });
    expect(planPublish(c, { corpus: SHIPPED }).ok).toBe(true);
    const plan = planPublish(c, { corpus: SHIPPED, withhold: ['AAB-001'] });
    expect(plan.ok).toBe(false);
  });

  it('the username check runs without --redact-home for names of 4+ chars only', () => {
    const c = contents({ 'AAB-002': 'owner=opuser;' });
    const plan = planPublish(c, { corpus: SHIPPED, homeDir: '/home/opuser' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.leaks.map((l) => l.kind)).toEqual(['home_user']);
    expect(planPublish(contents({ 'AAB-002': 'owner=op;' }), { corpus: SHIPPED, homeDir: '/home/op' }).ok).toBe(true);
    expect(planPublish(contents({ 'AAB-002': 'owner=op;' }), { corpus: SHIPPED, homeDir: '/home/op', redactHome: true }).ok).toBe(false);
  });

  it('the username inside a host name is a finding', () => {
    const plan = planPublish(contents({ 'AAB-002': 'hostname: opuser-laptop' }), { corpus: SHIPPED, homeDir: '/home/opuser' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.leaks.map((l) => l.kind)).toEqual(['home_user']);
    const plan2 = planPublish(contents({ 'AAB-002': 'ssh opuser-laptop.lan' }), { corpus: SHIPPED, homeDir: '/home/opuser' });
    expect(plan2.ok).toBe(false);
    if (!plan2.ok) expect(plan2.leaks.map((l) => l.kind).sort()).toEqual(['home_user', 'host']);
  });

  it('pseudonymises every aab-<word>-<hex> minted value; the run id is kept', () => {
    const skill = `aab-skill-${'0123456789abcdef'}`;
    const web = `aab-web-${'a1b2c3d4e5f6a1b2c3d4e5f6'}`;
    const plan = planPublish(contents({ 'AAB-001': `grep ${skill} x`, 'AAB-002': `curl http://127.0.0.1:1/${web}` }), { corpus: SHIPPED });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const all = plan.files.map((f) => f.text).join('\n');
    expect(all).not.toContain(skill);
    expect(all).not.toContain(web);
    expect(all).toContain('<canary-token-1>');
    expect(all).toContain(RUN_ID);
    expect(plan.canaryTokenReplacements).toBe(2);
  });

  it('a reduced bundle filters corpus.scenario_ids and recomputes corpus_digest; corpus_digest_full keeps the run digest', () => {
    const plan = planPublish(contents(), { corpus: SHIPPED, exclude: ['AAB-002'] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const m = JSON.parse(plan.files.find((f) => f.rel === 'manifest.json')!.text) as RunManifest;
    expect(m.corpus).toEqual({
      scenario_count: 1,
      scenario_ids: ['AAB-001'],
      corpus_digest: digestOf(['AAB-001']),
      corpus_digest_full: digestOf(CORPUS_IDS),
    });
    for (const f of plan.files.filter((x) => x.rel !== 'index.md')) {
      const hits = f.text.split('\n').filter((l) => l.includes('AAB-002')).map((l) => l.trim());
      // Only the manifest's (and report.json's embedded manifest's) `excluded` array names it.
      expect(hits.filter((h) => h !== '"AAB-002"'), f.rel).toEqual([]);
    }
  });

  it('fails closed when the scenario corpus does not reproduce the run digest, or is missing', () => {
    const m = manifest();
    m.corpus.corpus_digest = 'deadbeef';
    const plan = planPublish(contents({}, m), { corpus: SHIPPED, withhold: ['AAB-001'] });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/does not reproduce the run's corpus_digest.*--scenarios/);
    const none = planPublish(contents(), { withhold: ['AAB-001'] });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/not found in the scenario corpus/);
    // Without a drop the corpus block is a byte copy and no corpus is needed.
    expect(planPublish(contents()).ok).toBe(true);
  });
});

describe('pseudonymizeMcpServers numbering (no per-name Set rebuild)', () => {
  it('assigns increasing placeholders, skipping reserved ones, for many names', () => {
    const servers = Array.from({ length: 3000 }, (_, i) => ({ name: `srv-${i}`, status: 'connected', source: 'user' }));
    const value = { mcp_servers: servers };
    const names = new Map<string, string>();
    const reserved = new Set(['<user-mcp-2>', '<user-mcp-4>']);
    const t0 = Date.now();
    expect(pseudonymizeMcpServers(value, names, reserved)).toBe(3000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(servers.slice(0, 4).map((s) => s.name)).toEqual(['<user-mcp-1>', '<user-mcp-3>', '<user-mcp-5>', '<user-mcp-6>']);
    expect(new Set(names.values()).size).toBe(3000);
    // A second call with the same map continues the numbering.
    const more = { mcp_servers: [{ name: 'srv-new', status: 'x', source: 'user' }, { name: 'srv-0', status: 'x', source: 'user' }] };
    pseudonymizeMcpServers(more, names, reserved);
    expect(more.mcp_servers.map((s) => s.name)).toEqual(['<user-mcp-3003>', '<user-mcp-1>']);
  });
});

// --- I/O ------------------------------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = mkScratchSync('aab-gate-io-');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function trySymlink(target: string, link: string, ctx: { skip: (msg: string) => void }): void {
  try {
    symlinkSync(target, link);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows without admin / Developer Mode cannot create symlinks: skipped, never a silent pass.
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) ctx.skip(`symlinkSync failed with ${code}`);
    throw err;
  }
}

describe('readRunDir never follows symlinks (ADR-0017 "Run-dir reading")', () => {
  it('skips a symlinked evidence file, repetition dir and canary metadata, with warnings', (ctx) => {
    const run = path.join(tmp, 'run');
    const outside = path.join(tmp, 'outside');
    mkdirSync(path.join(outside, 'rep'), { recursive: true });
    writeFileSync(path.join(outside, 'secret.json'), '{"leak":true}');
    writeFileSync(path.join(outside, 'rep', 'evidence.json'), '{"leak":true}');
    mkdirSync(path.join(run, 'AAB-001', '0'), { recursive: true });
    mkdirSync(path.join(run, 'AAB-002'), { recursive: true });
    writeFileSync(path.join(run, 'manifest.json'), JSON.stringify(manifest()));
    writeFileSync(path.join(run, 'AAB-001', '0', 'evidence.json'), '{}');
    trySymlink(path.join(outside, 'secret.json'), path.join(run, 'AAB-001', '0', 'canary_command.canary.json'), ctx);
    trySymlink(path.join(outside, 'rep'), path.join(run, 'AAB-002', '0'), ctx);
    mkdirSync(path.join(run, 'AAB-002', '1'));
    trySymlink(path.join(outside, 'secret.json'), path.join(run, 'AAB-002', '1', 'evidence.json'), ctx);

    const c = readRunDir(run);
    expect(c.evidence.map((e) => e.rel)).toEqual(['AAB-001/0/evidence.json']);
    expect(c.canaryMeta).toEqual([]);
    expect(JSON.stringify(c)).not.toContain('leak');
    expect(c.warnings).toEqual([
      'publish: skipped symlink AAB-001/0/canary_command.canary.json (symlinks in a run dir are never followed)',
      'publish: skipped symlink AAB-002/0 (symlinks in a run dir are never followed)',
      'publish: skipped symlink AAB-002/1/evidence.json (symlinks in a run dir are never followed)',
    ]);
  });

  it('a symlinked manifest.json is an error', (ctx) => {
    const run = path.join(tmp, 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(path.join(tmp, 'm.json'), JSON.stringify(manifest()));
    trySymlink(path.join(tmp, 'm.json'), path.join(run, 'manifest.json'), ctx);
    expect(() => readRunDir(run)).toThrow(/symlink/);
  });
});

describe('writeBundle is atomic (ADR-0017 "Atomic bundle")', () => {
  it('writes through <out>.partial and renames; no partial dir remains', () => {
    const out = path.join(tmp, 'bundle');
    writeBundle(out, [{ rel: 'index.md', text: 'x' }, { rel: 'A/0/evidence.json', text: '{}' }]);
    expect(readFileSync(path.join(out, 'A', '0', 'evidence.json'), 'utf8')).toBe('{}');
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('an existing empty out dir is replaced', () => {
    const out = path.join(tmp, 'bundle');
    mkdirSync(out);
    writeBundle(out, [{ rel: 'index.md', text: 'x' }]);
    expect(readdirSync(out)).toEqual(['index.md']);
  });

  it('a failure mid-write leaves neither the out dir nor the partial dir', () => {
    const out = path.join(tmp, 'bundle');
    // `a` is written as a file, then `a/b` needs it to be a directory: the write throws.
    expect(() => writeBundle(out, [{ rel: 'a', text: 'x' }, { rel: 'a/b', text: 'y' }])).toThrow();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('refuses a non-empty out dir and a pre-existing partial dir (never deletes either)', () => {
    const out = path.join(tmp, 'bundle');
    mkdirSync(out);
    writeFileSync(path.join(out, 'keep'), 'k');
    expect(() => writeBundle(out, [{ rel: 'index.md', text: 'x' }])).toThrow(/not empty/);
    rmSync(out, { recursive: true });
    mkdirSync(`${out}.partial`);
    writeFileSync(path.join(`${out}.partial`, 'keep'), 'k');
    expect(() => writeBundle(out, [{ rel: 'index.md', text: 'x' }])).toThrow(/staging directory/);
    expect(readFileSync(path.join(`${out}.partial`, 'keep'), 'utf8')).toBe('k');
  });
});
