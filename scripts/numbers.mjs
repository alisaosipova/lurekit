#!/usr/bin/env node
// ADR-0023 amendment: every number the hand-written docs quote is computed here from the tree,
// never retyped. The facts come from the built CLI and library in dist/ (the same plan logic,
// cost basis and reporter a user runs), the scenario corpus, the published bundles under
// reports/ and `vitest list --json` (the test count). `--check` verifies README.md,
// docs/guide/getting-started.md and docs/guide/cli-reference.md against them:
//
//   <!-- n:KEY -->VALUE<!-- /n -->     inline: VALUE must equal the emitted value of KEY exactly
//   <!-- n-line:K1,K2 -->              block: the next fenced code block must contain each line
//                                      lines.K1, lines.K2 (compared with surrounding spaces trimmed)
//
// KEY is a dotted path into the emitted JSON (e.g. scenarios.total, plan.codex-cli.kept). An
// unknown key, a value that differs, a line that is missing, or a checked file without any
// marker fails the check. examples/run-live.sh must read the pinned Claude Code version from
// dist (PUBLISHED_CLAUDE_VERSION) and type no x.y.z version itself.
//
// Test count: the number of test cases `vitest list --json` collects (it() calls after loops
// and each() expand), i.e. the "Tests" total of `npx vitest run`; not the number of it( call
// sites in the source. Collecting takes a few seconds; --skip-tests leaves `tests` null and
// skips its markers (the vitest test of this script uses it so it does not re-collect itself).
//
// Usage (from the repository root, after `npm run build`; npm run docs:check builds first):
//   node scripts/numbers.mjs                 print the JSON (npm run docs:numbers)
//   node scripts/numbers.mjs --check         verify the docs, exit 1 on any drift
//   node scripts/numbers.mjs --check --skip-tests
// Scratch: the replay and the refused live-run preview write only under .aab-runs/_numbers
// (git-ignored), removed afterwards; nothing touches the system temp dir. Offline: no agent,
// no network.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKED_DOCS = ['README.md', 'docs/guide/getting-started.md', 'docs/guide/cli-reference.md'];
const SCRATCH = path.join(ROOT, '.aab-runs', '_numbers');
const REPLAY = 'test/fixtures/recordings/claude-sample';

/** Fail when a src/*.ts file is newer than its dist/*.js (the facts would come from old code). */
function assertDistFresh() {
  const stale = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        const js = path.join(ROOT, 'dist', path.relative(path.join(ROOT, 'src'), p)).replace(/\.ts$/, '.js');
        if (!existsSync(js) || statSync(js).mtimeMs < statSync(p).mtimeMs) stale.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  if (stale.length > 0) {
    throw new Error(`dist/ is stale or missing for ${stale.length} file(s) (e.g. ${stale[0]}): run npm run build first`);
  }
}

const dist = (rel) => import(pathToFileURL(path.join(ROOT, 'dist', rel)).href);

/** Run the real CLI main() offline with captured output; any adapter use is an error. */
async function cli(main, args) {
  const out = [];
  const err = [];
  const deps = {
    now: () => '2026-11-03T00:00:00.000Z',
    newRunId: () => 'aab-numbers',
    // The live-run preview builds its adapter before it asks; any use of it is an error.
    adapterFor: () => new Proxy({}, {
      get: (_t, k) => {
        if (k === 'then') return undefined;
        throw new Error(`numbers.mjs must not launch an agent (adapter.${String(k)} was used)`);
      },
    }),
    cwd: () => ROOT,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  };
  const code = await main(args, deps);
  return { code, out: out.join(''), err: err.join('') };
}

const lineOf = (text, re, what) => {
  const l = text.split('\n').find((x) => re.test(x));
  if (l === undefined) throw new Error(`numbers.mjs: no ${what} line in the CLI output`);
  return l;
};

function testCount() {
  const bin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const json = execFileSync(process.execPath, [bin, 'list', '--json'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const list = JSON.parse(json.slice(json.indexOf('[')));
  if (!Array.isArray(list)) throw new Error('vitest list --json did not return an array');
  return list.length;
}

export async function collect({ skipTests = false } = {}) {
  assertDistFresh();
  const { main, DEMO_RUN_ID, demoBundleDir } = await dist('cli.js');
  const { loadScenarioDir } = await dist('scenario/load.js');
  const doctor = await dist('doctor.js');
  const { IMPLEMENTED_DETECTORS } = await dist('detectors/index.js');
  const { IMPLEMENTED_FIXTURES } = await dist('fixtures/index.js');
  const guidance = await dist('report/guidance.js');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'schemas', 'scenario.schema.json'), 'utf8'));

  // Scenarios: the loader, then the CLI's own plan per agent.
  const { scenarios, errors } = loadScenarioDir(path.join(ROOT, 'scenarios'));
  if (errors.length > 0) throw new Error(`${errors.length} scenario file(s) fail to load: run lurekit validate`);
  const runnable = scenarios.filter((s) => s.runnable !== false).length;
  const plan = {};
  const lines = {};
  for (const agent of doctor.SUPPORTED_AGENTS) {
    const model = agent === 'codex-cli' ? 'gpt-5-codex' : agent === 'claude-code' ? 'claude-opus-4-1' : 'm';
    const r = await cli(main, ['plan', '--model', model, '--agent', agent]);
    const l = lineOf(r.out, /^plan: \d+ would run, \d+ skipped/, `plan (${agent})`);
    const m = /^plan: (\d+) would run, (\d+) skipped/.exec(l);
    plan[agent] = { kept: Number(m[1]), skipped: Number(m[2]) };
    if (agent === 'claude-code') lines.plan_claude = l;
    if (agent === 'codex-cli') lines.plan_codex = l;
  }

  // Offline command summaries, exactly as printed from the repository root.
  lines.validate = lineOf((await cli(main, ['validate'])).out, /^\d+ valid, \d+ errors in /, 'validate summary');
  lines.list = lineOf((await cli(main, ['list'])).out, /^\d+ scenario\(s\) in /, 'list summary');

  // Demo bundle: spend and the costs derived from it (doctor's own cost basis and wording).
  const demo = JSON.parse(readFileSync(path.join(demoBundleDir(), 'manifest.json'), 'utf8'));
  const demoReport = JSON.parse(readFileSync(path.join(demoBundleDir(), 'report.json'), 'utf8'));
  const basis = doctor.costBasis('claude-code', demo);
  const kept = plan['claude-code'].kept;
  lines.pin_recipe = doctor.pinnedClaudeRecipe(guidance.PUBLISHED_CLAUDE_VERSION);
  lines.doctor_cost = doctor.renderChecks([{ id: 'cost', status: 'ok', summary: doctor.estimateSentence('claude-code', kept, basis) }]).replace(/\n$/, '');

  // Live-run preview: refused before any launch (no terminal, no --yes), the plan is printed.
  rmSync(SCRATCH, { recursive: true, force: true });
  let sarifVersion;
  try {
    const live = await cli(main, ['run', '--model', 'sonnet', '--results', path.relative(ROOT, SCRATCH)]);
    if (live.code !== 1 || !/refusing to launch/.test(live.err)) throw new Error('the live-run preview was not refused');
    lines.run_plan = lineOf(live.err, /^plan: \d+ scenario\(s\) will run/, 'run plan');
    lines.run_cost = lineOf(live.err, /^estimated cost: /, 'run estimated cost');
    const rep = await cli(main, ['run', '--model', 'claude-sonnet-4-5', '--replay', REPLAY, '--results', path.relative(ROOT, SCRATCH), '--output', path.relative(ROOT, path.join(SCRATCH, 'replay.md'))]);
    if (rep.code !== 0) throw new Error(`the replay run exited ${rep.code}`);
    lines.replay_header = lineOf(rep.err, /^replaying recording /, 'replay header');
    lines.replay_running = lineOf(rep.err, /^running \d+ scenario\(s\) against /, 'replay running');
    lines.progress_first = lineOf(rep.err, /^\[1\/\d+\] /, 'first progress');
    // SARIF header of a fresh run (the driver version is the tool that made the run).
    const sarif = JSON.parse((await cli(main, ['report', path.relative(ROOT, path.join(SCRATCH, 'aab-numbers')), '--format', 'sarif'])).out);
    lines.sarif_schema = `"$schema": ${JSON.stringify(sarif.$schema)},`;
    lines.sarif_version = `"version": ${JSON.stringify(sarif.version)},`;
    lines.sarif_tool_version = `"version": ${JSON.stringify(sarif.runs[0].tool.driver.version)},`;
    sarifVersion = sarif.version;
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
  }

  // Demo report: the headline lines, from the real render.
  const md = (await cli(main, ['demo'])).out;
  lines.demo_title = lineOf(md, /^# LureKit report: /, 'demo title');
  lines.demo_headline = lineOf(md, /^\*\*Vulnerable to /, 'demo headline');
  lines.demo_resisted = lineOf(md, /^Resisted: /, 'demo resisted');

  // Published bundles and the hardening evidence they back.
  const reportsDir = path.join(ROOT, 'reports');
  const bundles = readdirSync(reportsDir).filter((d) => existsSync(path.join(reportsDir, d, 'manifest.json')));
  // Every arm the hardening knob cites, read from its bundle's report.json (not from the knob).
  const arms = {};
  for (const knob of Object.values(guidance.HARDENING_KNOBS)) {
    for (const e of [...knob.hardened, ...knob.bare]) {
      const h = JSON.parse(readFileSync(path.join(reportsDir, e.benchmark_run_id, 'report.json'), 'utf8')).score.headline;
      arms[e.arm.replace(/[^a-z]+/g, '_')] = { run_id: e.benchmark_run_id, vulnerable: h.vulnerable, of: h.of, inconclusive: h.inconclusive };
    }
  }

  const deferred = schema.properties.forbidden_effect.properties.detector.enum.filter((d) => !IMPLEMENTED_DETECTORS.includes(d));
  return {
    scenarios: {
      total: scenarios.length,
      runnable,
      not_runnable: scenarios.length - runnable,
      runnable_other_agents: runnable - kept,
    },
    plan,
    tests: skipTests ? null : testCount(),
    adapters: { count: doctor.SUPPORTED_AGENTS.length, agents: [...doctor.SUPPORTED_AGENTS] },
    detectors: { count: IMPLEMENTED_DETECTORS.length, implemented: [...IMPLEMENTED_DETECTORS], deferred },
    fixtures: { count: IMPLEMENTED_FIXTURES.length, kinds: [...IMPLEMENTED_FIXTURES] },
    versions: {
      tool: pkg.version,
      claude_published: guidance.PUBLISHED_CLAUDE_VERSION,
      claude_auth_status_min: doctor.CLAUDE_AUTH_STATUS_MIN,
      node_min: doctor.NODE_MIN.join('.'),
      sarif: sarifVersion,
    },
    demo: {
      run_id: DEMO_RUN_ID,
      model: demo.profile.model,
      k: demo.config.k,
      scenarios: demo.results.length,
      vulnerable: demoReport.score.headline.vulnerable,
      of: demoReport.score.headline.of,
      spend_usd: demo.totals.spend_usd.toFixed(2),
      per_rep_usd: basis.perRepUsd.toFixed(3),
      claude_smoke_usd: doctor.usd(kept * basis.perRepUsd),
      claude_full_usd: doctor.usd(kept * 3 * basis.perRepUsd),
    },
    arms,
    // The largest inconclusive count of any cited arm: 0 backs "0 inconclusive in each".
    arms_max_inconclusive: Math.max(...Object.values(arms).map((a) => a.inconclusive)),
    bundles: bundles.length,
    lines,
  };
}

function lookup(facts, key) {
  let v = facts;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object' || !(part in v)) return undefined;
    v = v[part];
  }
  return v;
}

const INLINE = /<!-- n:([A-Za-z0-9_.-]+) -->([\s\S]*?)<!-- \/n -->/g;
const BLOCK = /<!-- n-line:([A-Za-z0-9_.,-]+) -->/g;

/** Check one document's text against the facts. Returns { markers, problems }. */
export function checkText(rel, text, facts) {
  const problems = [];
  let markers = 0;
  for (const m of text.matchAll(INLINE)) {
    markers += 1;
    const [, key, shown] = m;
    if (key === 'tests' && facts.tests === null) continue; // --skip-tests
    const v = lookup(facts, key);
    if (v === undefined || (typeof v === 'object' && v !== null)) problems.push(`${rel}: unknown number key "${key}"`);
    else if (String(v) !== shown) problems.push(`${rel}: ${key} is ${JSON.stringify(String(v))}, the doc says ${JSON.stringify(shown)}`);
  }
  for (const m of text.matchAll(BLOCK)) {
    markers += 1;
    const after = text.slice(m.index + m[0].length);
    const open = /^```[^\n]*\n/m.exec(after);
    const close = open ? after.indexOf('\n```', open.index + open[0].length - 1) : -1;
    if (!open || close < 0) { problems.push(`${rel}: n-line:${m[1]} has no fenced code block after it`); continue; }
    const block = after.slice(open.index + open[0].length, close).split('\n').map((l) => l.trim());
    for (const key of m[1].split(',')) {
      const want = facts.lines[key];
      if (typeof want !== 'string') problems.push(`${rel}: unknown line key "${key}"`);
      else if (!block.includes(want.trim())) problems.push(`${rel}: the block after n-line:${m[1]} lacks the current ${key} line: ${JSON.stringify(want.trim())}`);
    }
  }
  if (markers === 0) problems.push(`${rel}: no number markers (every quoted number must be marked)`);
  // A marker with a typo (e.g. "<!-- n: key -->") would be silently ignored: refuse look-alikes.
  for (const m of text.matchAll(/<!--\s*n(-line)?:[^>]*-->/g)) {
    if (!/^<!-- n(-line)?:[A-Za-z0-9_.,-]+ -->$/.test(m[0])) problems.push(`${rel}: malformed marker ${m[0]}`);
  }
  return { markers, problems };
}

/** examples/run-live.sh reads the version from dist and types none itself. */
export function checkRunLive(text) {
  const problems = [];
  if (!/PUBLISHED_CLAUDE_VERSION/.test(text)) problems.push('examples/run-live.sh: does not read PUBLISHED_CLAUDE_VERSION from dist');
  for (const [i, l] of text.split('\n').entries()) {
    if (/\b\d+\.\d+\.\d+\b/.test(l)) problems.push(`examples/run-live.sh:${i + 1}: types a version literal (${l.trim()})`);
  }
  return problems;
}

async function cliMain(argv) {
  const check = argv.includes('--check');
  const skipTests = argv.includes('--skip-tests');
  const unknown = argv.filter((a) => a !== '--check' && a !== '--skip-tests');
  if (unknown.length > 0) {
    console.error('usage: numbers.mjs [--check] [--skip-tests]');
    return 2;
  }
  const facts = await collect({ skipTests });
  if (!check) {
    process.stdout.write(JSON.stringify(facts, null, 2) + '\n');
    return 0;
  }
  const problems = [];
  let markers = 0;
  for (const rel of CHECKED_DOCS) {
    const r = checkText(rel, readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'), facts);
    markers += r.markers;
    problems.push(...r.problems);
  }
  problems.push(...checkRunLive(readFileSync(path.join(ROOT, 'examples', 'run-live.sh'), 'utf8')));
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`numbers: ${problems.length} problem(s); run npm run docs:numbers to see the current values`);
    return 1;
  }
  process.stdout.write(`numbers: ${markers} marker(s) in ${CHECKED_DOCS.length} docs match the tree${skipTests ? ' (test count skipped)' : ''}; examples/run-live.sh reads the pinned version\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
}
