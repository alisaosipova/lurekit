#!/usr/bin/env node
// agent-attack-bench CLI — the program's entry point (package.json "bin").
//
// This is the front door that turns the library into a runnable tool: it wires scenarios
// (src/scenario) -> a per-agent adapter (src/adapters) -> the benchmark runner (src/runner)
// -> the reporters (src/report). The runner stays deterministic (no clock, no randomness);
// this CLI is the I/O boundary that injects the clock and the run ids (ADR-0004/0005).
//
// Subcommands:
//   run       execute the benchmark against a live agent, write a manifest, print a report
//   validate  schema-validate every scenario in a directory (exit 1 on any error)
//   list      list scenarios (id, detector, runnable, applies_to)
//   plan      show which scenarios would run for a profile WITHOUT invoking the agent (offline)
//   selftest  run every implemented detector's positive/negative self-test (offline)
//   report    render a report (json|markdown|sarif) from a completed run directory
//   publish   gate (evidence-spec §5) and write a shareable bundle of a run (ADR-0017)
//
// `run` is the only subcommand that launches a real agent (and therefore costs money / needs
// auth); the others are fully offline.
// `run --replay <dir>` re-drives a recorded Claude Code run instead (ADR-0015): offline, no spend.

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadScenarioDir } from './scenario/load.js';
import type { Scenario } from './scenario/types.js';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CursorCliAdapter } from './adapters/cursorCli.js';
import { CodexCliAdapter } from './adapters/codexCli.js';
import { OpenHandsAdapter } from './adapters/openhands.js';
import { ReplayAdapter } from './adapters/replay.js';
import type { Adapter, SetupProfile } from './adapters/adapter.js';
import { parseSettingSourcesCsv } from './adapters/adapter.js';
import type { AgentId } from './scenario/types.js';
import { getDetector, IMPLEMENTED_DETECTORS } from './detectors/index.js';
import { fixturesForScenario } from './fixtures/index.js';
import { BenchmarkRunner } from './runner/runner.js';
import type { RunConfig, RunManifest, RunnerIds, RunMeta, EvidenceRecord } from './runner/types.js';
import { report, type ReportFormat, type EvidenceLookup } from './report/index.js';
import { planPublish, readRunDir, writeBundle, formatPlanFailure, selectEvidence } from './report/publish.js';

const REPORT_FORMATS: ReportFormat[] = ['json', 'markdown', 'sarif'];

/** Injected dependencies, so the command logic is testable offline without a live agent. The
 *  bin wires the real implementations; a test can pass a stub adapter and a fixed clock. */
export interface CliDeps {
  now(): string; // ISO timestamp (the only clock in the whole run)
  newRunId(): string; // unique benchmark-run id
  adapterFor(agent: AgentId): Adapter;
  cwd(): string;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Home directory for the publish redaction gate (ADR-0017). Optional; defaults to os.homedir(). */
  homeDir?(): string;
}

export function defaultDeps(): CliDeps {
  return {
    now: () => new Date().toISOString(),
    newRunId: () => `aab-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    adapterFor: (agent) => {
      if (agent === 'claude-code') return new ClaudeCodeAdapter();
      if (agent === 'cursor-cli') return new CursorCliAdapter(); // ADR-0016
      if (agent === 'codex-cli') return new CodexCliAdapter(); // ADR-0018
      if (agent === 'openhands') return new OpenHandsAdapter(); // ADR-0019
      throw new Error(`no adapter for agent "${agent}" in 0.1 (only claude-code, cursor-cli, codex-cli and openhands are implemented)`);
    },
    cwd: () => process.cwd(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
}

function toolVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// --- tiny flag parser (no dependency) ---------------------------------------
interface Flags {
  _: string[]; // positionals
  str: Map<string, string>;
  num: Map<string, number>;
  bool: Set<string>;
  multi: Map<string, string[]>;
}

const STRING_FLAGS = new Set([
  'model', 'agent', 'agent-version', 'mode', 'vulnerable-if', 'isolation',
  'results', 'workdir', 'format', 'output', 'permission-mode', 'settings', 'mcp', 'hooks',
  'replay', 'out', 'setting-sources',
]);
const NUMBER_FLAGS = new Set(['k', 'budget']);
const MULTI_FLAGS = new Set(['skill', 'allow-host', 'withhold']);

function parseFlags(argv: string[]): Flags {
  const f: Flags = { _: [], str: new Map(), num: new Map(), bool: new Set(), multi: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (MULTI_FLAGS.has(name)) {
        const list = f.multi.get(name) ?? [];
        list.push(argv[++i]);
        f.multi.set(name, list);
      } else if (STRING_FLAGS.has(name)) {
        f.str.set(name, argv[++i]);
      } else if (NUMBER_FLAGS.has(name)) {
        const v = Number(argv[++i]);
        if (Number.isNaN(v)) throw new Error(`--${name} expects a number`);
        f.num.set(name, v);
      } else {
        f.bool.add(name); // --help, --version, --dry-run, etc.
      }
    } else {
      f._.push(a);
    }
  }
  return f;
}

function readJsonFile(p: string): unknown {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// --- subcommands ------------------------------------------------------------

export function cmdValidate(flags: Flags, deps: CliDeps): number {
  const dir = flags._[0] ?? 'scenarios';
  const { scenarios, errors } = loadScenarioDir(dir);
  for (const s of scenarios) deps.stdout(`OK    ${s.id}  ${s.name}\n`);
  for (const e of errors) deps.stderr(`FAIL  ${e.file}  ${e.message}\n`);
  deps.stdout(`\n${scenarios.length} valid, ${errors.length} error${errors.length === 1 ? '' : 's'} in ${dir}\n`);
  return errors.length === 0 ? 0 : 1;
}

export function cmdList(flags: Flags, deps: CliDeps): number {
  const dir = flags._[0] ?? 'scenarios';
  const { scenarios, errors } = loadScenarioDir(dir);
  for (const s of scenarios) {
    const applies = s.applies_to?.join(',') ?? 'all';
    const runnable = s.runnable === false ? 'no ' : 'yes';
    deps.stdout(`${s.id}  runnable=${runnable}  detector=${s.forbidden_effect.detector}  applies=${applies}  ${s.name}\n`);
  }
  if (errors.length) deps.stderr(`\n${errors.length} scenario file(s) failed to load (run 'validate' for detail)\n`);
  deps.stdout(`\n${scenarios.length} scenario(s) in ${dir}\n`);
  return errors.length === 0 ? 0 : 1;
}

export async function cmdSelftest(_flags: Flags, deps: CliDeps): Promise<number> {
  let allOk = true;
  for (const kind of IMPLEMENTED_DETECTORS) {
    try {
      const d = getDetector(kind);
      const { positive, negative } = await d.selfTest();
      const ok = positive && negative;
      allOk = allOk && ok;
      deps.stdout(`${ok ? 'PASS' : 'FAIL'}  ${kind}  positive=${positive} negative=${negative}\n`);
    } catch (err) {
      allOk = false;
      deps.stderr(`FAIL  ${kind}  ${(err as Error).message}\n`);
    }
  }
  deps.stdout(`\n${allOk ? 'all detectors sound' : 'some detectors failed their self-test'}\n`);
  return allOk ? 0 : 1;
}

/** Build the SetupProfile under test from flags. `--model` is required: pinning the model is a
 *  core reproducibility requirement (ADR-0005), so we never fabricate one. */
function buildProfile(flags: Flags, deps: CliDeps): SetupProfile {
  const agent = (flags.str.get('agent') ?? 'claude-code') as AgentId;
  const model = flags.str.get('model');
  if (!model) throw new Error('run: --model <id> is required (the model id is pinned into the manifest)');
  // No default workdir (and never os.tmpdir()): the runner gives every repetition its own
  // fresh <results>/<benchmark_run_id>/<scenario_id>/<rep>/work. --workdir only sets a BASE
  // for those per-run dirs (<base>/<scenario_id>/<rep>), ADR-0002 / evidence-spec §2.1.
  const workdirFlag = flags.str.get('workdir');
  const workdir = workdirFlag ? path.resolve(deps.cwd(), workdirFlag) : undefined;
  const skills = flags.multi.get('skill');
  // §4.3 hardening knob: validated here so a bad value fails before any run starts.
  const settingSources = flags.str.has('setting-sources')
    ? parseSettingSourcesCsv(flags.str.get('setting-sources'))
    : undefined;
  if (settingSources && agent !== 'claude-code') {
    throw new Error(`--setting-sources is a claude-code flag; agent "${agent}" has no equivalent`);
  }
  return {
    agent,
    agent_version: flags.str.get('agent-version') ?? 'unpinned',
    model,
    workdir,
    permission_mode: flags.str.get('permission-mode'),
    settings: flags.str.has('settings') ? readJsonFile(flags.str.get('settings')!) : undefined,
    mcp: flags.str.has('mcp') ? readJsonFile(flags.str.get('mcp')!) : undefined,
    hooks: flags.str.has('hooks') ? readJsonFile(flags.str.get('hooks')!) : undefined,
    skills: skills && skills.length ? skills : undefined,
    ...(settingSources ? { setting_sources: settingSources } : {}),
  };
}

/** Profile-summary fragment for the run/plan header line: the setting sources when narrowed. */
function settingSourcesNote(profile: SetupProfile): string {
  return profile.setting_sources ? `, setting_sources=${profile.setting_sources.join(',')}` : '';
}

function buildConfig(flags: Flags, deps: CliDeps): RunConfig {
  const mode = (flags.str.get('mode') ?? 'smoke') as 'smoke' | 'full';
  if (mode !== 'smoke' && mode !== 'full') throw new Error(`--mode must be smoke|full`);
  const vulnerableIf = (flags.str.get('vulnerable-if') ?? 'any') as 'any' | 'majority';
  if (vulnerableIf !== 'any' && vulnerableIf !== 'majority') throw new Error(`--vulnerable-if must be any|majority`);
  const isolation = (flags.str.get('isolation') ?? 'container') as 'container' | 'container+netns';
  const k = flags.num.get('k') ?? (mode === 'smoke' ? 1 : 3);
  return {
    k,
    vulnerable_if: vulnerableIf,
    mode,
    isolation,
    resultsRoot: path.resolve(deps.cwd(), flags.str.get('results') ?? '.aab-runs'),
    budget_usd: flags.num.get('budget'),
  };
}

export async function cmdPlan(flags: Flags, deps: CliDeps): Promise<number> {
  const dir = flags._[0] ?? 'scenarios';
  const { scenarios, errors } = loadScenarioDir(dir);
  if (errors.length) deps.stderr(`warning: ${errors.length} scenario file(s) failed to load (run 'validate')\n`);
  const profile = buildProfile(flags, deps);
  const cfg = buildConfig(flags, deps);
  const runner = new BenchmarkRunner({
    ids: makeIds(deps.newRunId()),
    fixtures: fixturesForScenario,
  });
  const plan = await runner.plan(scenarios, profile, cfg);
  for (const s of plan.kept) deps.stdout(`KEEP  ${s.id}  ${s.forbidden_effect.detector}  ${s.name}\n`);
  for (const sk of plan.skipped) deps.stdout(`SKIP  ${sk.scenario_id}  ${sk.reason}: ${sk.detail}\n`);
  deps.stdout(`\nplan: ${plan.kept.length} would run, ${plan.skipped.length} skipped (profile agent=${profile.agent}, model=${profile.model}${settingSourcesNote(profile)})\n`);
  return 0;
}

function makeIds(benchmarkRunId: string): RunnerIds {
  return {
    benchmarkRunId,
    runId: (scenarioId, rep) => `${benchmarkRunId}-${scenarioId}-${rep}`,
  };
}

/** Build a 1-arg EvidenceLookup (report's contract) over a run dir, taking the repetition
 *  count per scenario from the manifest so it can find the vulnerable repetition's excerpt. */
function makeEvidenceLookup(runDir: string, manifest: RunManifest): EvidenceLookup {
  const runsById = new Map(manifest.results.map((r) => [r.scenario_id, r.runs]));
  return (scenarioId: string): EvidenceRecord | undefined => {
    const read = (rep: number): EvidenceRecord | undefined => {
      const p = path.join(runDir, scenarioId, String(rep), 'evidence.json');
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as EvidenceRecord;
      } catch {
        return undefined;
      }
    };
    return selectEvidence(runsById.get(scenarioId) ?? 1, read);
  };
}

export async function cmdRun(flags: Flags, deps: CliDeps): Promise<number> {
  const dir = flags._[0] ?? 'scenarios';
  const { scenarios, errors } = loadScenarioDir(dir);
  if (errors.length) {
    deps.stderr(`refusing to run: ${errors.length} scenario file(s) are invalid (run 'validate' first)\n`);
    return 1;
  }
  const profile = buildProfile(flags, deps);
  const cfg = buildConfig(flags, deps);
  // --replay <dir> (ADR-0015): re-drive a recorded claude-code run offline; no live agent.
  const replayDir = flags.str.get('replay');
  if (replayDir !== undefined && profile.agent !== 'claude-code') {
    throw new Error('run: --replay only supports --agent claude-code (recordings are Claude Code runs)');
  }
  const adapter: Adapter = replayDir !== undefined
    ? new ReplayAdapter({ recordingDir: path.resolve(deps.cwd(), replayDir) })
    : deps.adapterFor(profile.agent);

  const benchmarkRunId = deps.newRunId();
  const ids = makeIds(benchmarkRunId);
  const runner = new BenchmarkRunner({ ids, fixtures: fixturesForScenario });
  const meta: RunMeta = { createdAt: deps.now(), toolVersion: toolVersion() };

  if (replayDir !== undefined) deps.stderr(`replaying recording ${replayDir} (offline, no live agent)\n`);
  deps.stderr(`running ${scenarios.length} scenario(s) against ${profile.agent} (model=${profile.model}, k=${cfg.k}, mode=${cfg.mode}${settingSourcesNote(profile)})\n`);
  deps.stderr(`results under ${path.join(cfg.resultsRoot, benchmarkRunId)}\n`);

  const { plan, manifest } = await runner.run(scenarios, adapter, profile, cfg, meta);
  for (const sk of plan.skipped) deps.stderr(`skip  ${sk.scenario_id}  ${sk.reason}\n`);

  const runDir = path.join(cfg.resultsRoot, benchmarkRunId);
  const format = (flags.str.get('format') ?? 'markdown') as ReportFormat;
  if (!REPORT_FORMATS.includes(format)) throw new Error(`--format must be ${REPORT_FORMATS.join('|')}`);
  const rendered = report(manifest, { format, evidenceLookup: makeEvidenceLookup(runDir, manifest) });
  const output = flags.str.get('output');
  if (output) writeFileSync(output, rendered, 'utf8');
  else deps.stdout(rendered + '\n');

  deps.stderr(`\nmanifest: ${path.join(runDir, 'manifest.json')}\n`);
  return 0;
}

export function cmdReport(flags: Flags, deps: CliDeps): number {
  const runDir = flags._[0];
  if (!runDir) throw new Error('report: a benchmark run directory is required');
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    deps.stderr(`no manifest.json in ${runDir}\n`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;
  const format = (flags.str.get('format') ?? 'json') as ReportFormat;
  if (!REPORT_FORMATS.includes(format)) throw new Error(`--format must be ${REPORT_FORMATS.join('|')}`);
  const rendered = report(manifest, { format, evidenceLookup: makeEvidenceLookup(runDir, manifest) });
  const output = flags.str.get('output');
  if (output) writeFileSync(output, rendered, 'utf8');
  else deps.stdout(rendered + '\n');
  return 0;
}

/** publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <id>]... [--redact-home]
 *  (ADR-0017). Builds the whole bundle in memory, optionally withholds scenarios (ADR-0014),
 *  optionally replaces the operator home dir with <HOME> in the copies,
 *  runs the §5 redaction gate, and writes only if the gate is clean. */
export function cmdPublish(flags: Flags, deps: CliDeps): number {
  const runArg = flags._[0];
  if (!runArg) throw new Error('publish: a benchmark run directory is required');
  const runDir = path.resolve(deps.cwd(), runArg);
  if (!existsSync(path.join(runDir, 'manifest.json'))) {
    deps.stderr(`no manifest.json in ${runArg}\n`);
    return 1;
  }
  const withhold = flags.multi.get('withhold') ?? [];
  if (withhold.some((w) => typeof w !== 'string' || w === '' || w.startsWith('--'))) {
    deps.stderr('publish: --withhold needs a scenario id; nothing written\n');
    return 1;
  }
  const plan = planPublish(readRunDir(runDir), {
    allowHosts: flags.multi.get('allow-host') ?? [],
    withhold,
    homeDir: deps.homeDir ? deps.homeDir() : homedir(),
    redactHome: flags.bool.has('redact-home'),
  });
  if (!plan.ok) {
    deps.stderr(formatPlanFailure(plan));
    return 1;
  }
  const outDir = path.resolve(deps.cwd(), flags.str.get('out') ?? path.join('reports', plan.benchmarkRunId));
  try {
    writeBundle(outDir, plan.files);
  } catch (err) {
    deps.stderr(`${(err as Error).message}; nothing written\n`);
    return 1;
  }
  for (const f of plan.files) deps.stdout(`wrote ${f.rel}\n`);
  if (plan.withheld.length > 0) {
    deps.stdout(`withheld (ADR-0014): ${plan.withheld.join(', ')}\n`);
  }
  if (plan.homeReplacements !== undefined) {
    deps.stdout(`redaction applied: home directory -> <HOME> (${plan.homeReplacements} replacements)\n`);
  }
  deps.stdout(`\npublished ${plan.files.length} file(s) to ${outDir}\n`);
  return 0;
}

const USAGE = `agent-attack-bench — a disclosure-traced security benchmark for deployed coding-agent setups

Usage: agent-attack-bench <command> [options]

Commands:
  run [dir]        Run the benchmark against a live agent and print a report.
                   --model <id> (required)  --agent <id> (default claude-code)
                   --agent-version <v>  --k <n>  --mode smoke|full  --vulnerable-if any|majority
                   --budget <usd>  --results <dir> (default .aab-runs)  --isolation container|container+netns
                   --workdir <dir>  optional BASE for per-run agent workdirs (<dir>/<scenario>/<rep>);
                                    default <results>/<run_id>/<scenario>/<rep>/work
                   --permission-mode <m>  --settings/--mcp/--hooks <file.json>  --skill <dir> (repeatable)
                   --setting-sources <csv>  claude-code only: load only these setting sources
                                    (user, project, local); default: flag not passed (agent default)
                   --format json|markdown|sarif (default markdown)  --output <file>
                   --replay <dir>  re-drive a recorded claude-code run offline (no agent, no cost)
  validate [dir]   Schema-validate every scenario (exit 1 on any error). Offline.
  list [dir]       List scenarios (id, detector, runnable, applies_to). Offline.
  plan [dir]       Show which scenarios would run for a profile, WITHOUT a live agent. Offline.
  selftest         Run each detector's positive/negative self-test. Offline.
  report <runDir>  Render a report from a completed run. --format --output.
  publish <runDir> Write a shareable bundle (manifest, evidence, report.md/json/sarif, index.md)
                   after the redaction gate (no raw transcripts). Offline.
                   --out <dir> (default reports/<benchmark_run_id>)  --allow-host <host> (repeatable)
                   --withhold <scenario-id> (repeatable)  leave a scenario out of the bundle
                                  pending coordinated disclosure (ADR-0014); totals recomputed
                   --redact-home  replace YOUR home dir with <HOME> in the published copies (opt-in;
                                  run dir untouched; other home paths still fail the gate)

Only 'run' launches a real agent (cost / auth), unless given --replay. Everything else is offline.
All run material (agent workdirs, mcp.json, hook scripts, recordings, evidence, detector
self-test scratch) lives under --results; nothing is written to the system temp dir.
`;

export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    deps.stdout(USAGE);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    deps.stdout(`${toolVersion()}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (flags.bool.has('help')) {
    deps.stdout(USAGE);
    return 0;
  }
  switch (command) {
    case 'validate': return cmdValidate(flags, deps);
    case 'list': return cmdList(flags, deps);
    case 'plan': return cmdPlan(flags, deps);
    case 'selftest': return cmdSelftest(flags, deps);
    case 'run': return cmdRun(flags, deps);
    case 'report': return cmdReport(flags, deps);
    case 'publish': return cmdPublish(flags, deps);
    default:
      deps.stderr(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

/** Resolve a path to its real file, falling back to path.resolve when it does not exist. */
function realPathOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when `argv1` (process.argv[1]) names the same real file as `moduleUrl`
 * (import.meta.url). Both sides go through realpath, so an npm bin symlink
 * (node_modules/.bin/agent-attack-bench -> .../dist/cli.js) still counts as main.
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  return realPathOrResolved(argv1) === realPathOrResolved(fileURLToPath(moduleUrl));
}

// Only run when invoked as a program, not when imported by a test.
if (isMainModule(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
