#!/usr/bin/env node
// LureKit CLI — the program's entry point (package.json "bin").
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
//   demo      render the published run bundled with the package (ADR-0021): offline, no auth
//   doctor    check Node, the agent binary, auth (no-spend probes), corpus, selftests, cost (ADR-0022)
//
// `run` is the only subcommand that launches a real agent (and therefore costs money / needs
// auth); the others are fully offline.
// `run --replay <dir>` re-drives a recorded Claude Code run instead (ADR-0015): offline, no spend.
// A live `run` prints its plan and asks before launching (ADR-0022); `--yes` skips the prompt.

import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, accessSync, statSync, readdirSync, rmdirSync, constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadScenarioDir } from './scenario/load.js';
import type { Scenario } from './scenario/types.js';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CursorCliAdapter } from './adapters/cursorCli.js';
import { CodexCliAdapter } from './adapters/codexCli.js';
import { OpenHandsAdapter, parseOpenHandsPermissionMode } from './adapters/openhands.js';
import { ReplayAdapter } from './adapters/replay.js';
import type { Adapter, SetupProfile } from './adapters/adapter.js';
import { parseSettingSourcesCsv } from './adapters/adapter.js';
import type { AgentId } from './scenario/types.js';
import { getDetector, IMPLEMENTED_DETECTORS } from './detectors/index.js';
import { fixturesForScenario } from './fixtures/index.js';
import { BenchmarkRunner, Budget, DEFAULT_RUN_TIMEOUT_S, K_MAX, K_MIN, MAX_RUN_TIMEOUT_S, estimatedRunUsd, validK } from './runner/runner.js';
import type { RunConfig, RunManifest, RunnerIds, RunMeta, EvidenceRecord } from './runner/types.js';
import { report, REPOSITORY_URL, colorEnabled, terminalWidth, type ReportFormat, type EvidenceLookup, type SurfaceLookup, type ReMeasureContext } from './report/index.js';
import { planPublish, readRunDir, writeBundle, formatPlanFailure, selectEvidence, defaultBundleDir } from './report/publish.js';
import {
  type AgentProbe,
  type Check,
  type CostEstimate,
  agentInfo,
  checkAuth,
  checkBinary,
  checkCorpus,
  checkIsolation,
  checkModel,
  checkNode,
  checkOpenHandsPermission,
  checkSelfTests,
  checkUpdate,
  costBasis,
  defaultAgentProbe,
  renderChecks,
  renderDoctor,
  runDetectorSelfTests,
  runEstimateSentence,
  estimateSentence,
  summarize,
  type SelfTestOutcome,
} from './doctor.js';
import { diagnoseRun, nothingMeasured, renderDiagnosis, type RepIssue } from './diagnose.js';
import type { Detector } from './detectors/detector.js';
import type { DetectorKind } from './scenario/types.js';
import type { ScenarioResult } from './runner/types.js';

const REPORT_FORMATS: ReportFormat[] = ['json', 'markdown', 'sarif', 'text'];
const FORMAT_LIST = REPORT_FORMATS.join('|');

/** ADR-0021 amendment (terminal view): `md` is accepted for `markdown`; the other names as given. */
function reportFormat(flags: Flags, fallback: ReportFormat): ReportFormat | undefined {
  const raw = flags.str.get('format');
  if (raw === undefined) return fallback;
  if (raw === 'md') return 'markdown';
  return REPORT_FORMATS.includes(raw as ReportFormat) ? (raw as ReportFormat) : undefined;
}

/** What the terminal view needs from the process: a TTY or not, its columns, and the colour
 *  variables. Tests inject it; absent it means "not a terminal, no environment". */
export interface TerminalInfo {
  isTTY: boolean;
  columns?: number;
  env: Readonly<Record<string, string | undefined>>;
}

function terminalOptions(deps: CliDeps, toFile: boolean): { width: number; color: boolean } {
  const t = deps.terminal ? deps.terminal() : { isTTY: false, env: {} };
  const isTTY = !toFile && t.isTTY;
  return { width: terminalWidth(isTTY, t.columns, t.env), color: colorEnabled(isTTY, t.env) };
}

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
  /** ADR-0022: host probes for `doctor` and the live-run preflight (binary, version, auth).
   *  Absent => `run` skips the binary/auth preflight lines (tests that inject a stub adapter);
   *  `doctor` falls back to the real probe. */
  agentProbe?(): AgentProbe;
  /** ADR-0022: whether stdin is a terminal the confirmation prompt can read. Absent => false,
   *  so a live run without --yes is refused (never launched by accident). */
  isInteractive?(): boolean;
  /** ADR-0022: ask one question on the terminal and return the answer line. */
  ask?(question: string): Promise<string>;
  /** Directory of the published run `demo` renders (ADR-0021). Optional; defaults to the copy
   *  shipped with the package. A test points it at a missing directory for the refusal path. */
  demoBundleDir?(): string;
  /** ADR-0021 amendment (terminal view): whether stdout is a terminal, its width, and the
   *  NO_COLOR / FORCE_COLOR / COLUMNS variables. Absent => not a terminal, 100 columns, no colour. */
  terminal?(): TerminalInfo;
  /** ADR-0017 block B12: the publishing process environment the `env_value` gate check reads
   *  (a copy is passed to planPublish). Absent => process.env. A test injects a fixed map. */
  env?(): NodeJS.ProcessEnv;
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
      throw new Error(
        `no adapter for agent "${agent}" (implemented: claude-code, cursor-cli, codex-cli, openhands)\n` +
          'next: lurekit doctor --agent claude-code',
      );
    },
    cwd: () => process.cwd(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    agentProbe: () => defaultAgentProbe(),
    isInteractive: () => process.stdin.isTTY === true,
    terminal: () => ({ isTTY: process.stdout.isTTY === true, columns: process.stdout.columns, env: process.env }),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/** The package root (dist/.. when installed, src/.. under tests): holds scenarios/ and demo/. */
function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** ADR-0021: the published run shipped with the package for `lurekit demo` (manifest.json and
 *  report.json only, byte-identical to reports/<id>/ in the repository). */
export const DEMO_RUN_ID = 'aab-20261103071018-88a78d8f';
export function demoBundleDir(): string {
  return path.join(packageRoot(), 'demo', DEMO_RUN_ID);
}

/** Scenario id -> surface from already-loaded scenarios (ADR-0021 plain-language layers). */
function surfaceLookupFrom(scenarios: Scenario[]): SurfaceLookup {
  const bySurface = new Map(scenarios.map((s) => [s.id, s.surface as string]));
  return (id) => bySurface.get(id);
}

/** Surfaces from the scenario corpus shipped with this lurekit version. A file that fails to load
 *  only leaves its surface unknown; the report says so instead of guessing. */
function shippedSurfaceLookup(): SurfaceLookup {
  return surfaceLookupFrom(loadScenarioDir(path.join(packageRoot(), 'scenarios')).scenarios);
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
  'replay', 'out', 'setting-sources', 'scenarios',
]);
const NUMBER_FLAGS = new Set(['k', 'budget', 'run-timeout']);
const NUMBER_FLAG_EXAMPLE: Record<string, string> = { k: '3', budget: '5', 'run-timeout': String(DEFAULT_RUN_TIMEOUT_S) };
const MULTI_FLAGS = new Set(['skill', 'allow-host', 'withhold', 'exclude']);
/** Explicit allowlist of boolean flags: only the ones main()/a command actually reads. Anything
 *  else is rejected, so a typo or a mis-quoted flag can never be silently ignored (a single
 *  token like "--withhold AAB-003" once nearly published a withheld scenario). */
const BOOLEAN_FLAGS = new Set(['help', 'version', 'redact-home', 'yes', 'allow-no-evidence']);

/** Strict parser: throws (exit 1 via the bin's error path) before any command runs on
 *  an unknown --name, a --name=value form, a flag token containing whitespace, or a
 *  value-taking flag with no value. */
function parseFlags(argv: string[]): Flags {
  const f: Flags = { _: [], str: new Map(), num: new Map(), bool: new Set(), multi: new Map() };
  const valueFor = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(
        `${flag} expects a value (got ${v === undefined ? 'nothing' : JSON.stringify(v)})\n` +
          `next: pass the value as the next argument (${flag} <value>); lurekit --help lists every flag`,
      );
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Whitespace check also covers a token with leading whitespace (" --withhold AAB-003"),
    // which would otherwise fall through as a silently ignored positional.
    if (a.trimStart().startsWith('--') && /\s/.test(a)) {
      throw new Error(`malformed flag ${JSON.stringify(a)}: a flag and its value must be separate arguments (e.g. --withhold AAB-003, not "--withhold AAB-003")`);
    }
    if (a.startsWith('--')) {
      if (a.includes('=')) {
        const n = a.slice(0, a.indexOf('='));
        throw new Error(`unsupported flag form ${JSON.stringify(a)}: use "${n} <value>" (separate arguments), not ${n}=<value>`);
      }
      const name = a.slice(2);
      if (MULTI_FLAGS.has(name)) {
        const list = f.multi.get(name) ?? [];
        list.push(valueFor(a, ++i));
        f.multi.set(name, list);
      } else if (STRING_FLAGS.has(name)) {
        f.str.set(name, valueFor(a, ++i));
      } else if (NUMBER_FLAGS.has(name)) {
        const v = Number(valueFor(a, ++i));
        if (Number.isNaN(v)) {
          throw new Error(`--${name} expects a number\nnext: pass a number, e.g. --${name} ${NUMBER_FLAG_EXAMPLE[name] ?? '1'}`);
        }
        f.num.set(name, v);
      } else if (BOOLEAN_FLAGS.has(name)) {
        f.bool.add(name);
      } else {
        throw new Error(`unknown flag ${JSON.stringify(a)} (run 'lurekit --help' for the list of options)`);
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
  const corpus = resolveScenarioDir(flags._[0], deps);
  const { scenarios, errors } = loadScenarioDir(corpus.dir);
  for (const s of scenarios) deps.stdout(`OK    ${s.id}  ${s.name}\n`);
  for (const e of errors) deps.stderr(`FAIL  ${e.file}  ${e.message}\n`);
  const dir = flags._[0] ?? corpus.shown;
  deps.stdout(`\n${scenarios.length} valid, ${errors.length} error${errors.length === 1 ? '' : 's'} in ${dir}\n`);
  return errors.length === 0 ? 0 : 1;
}

export function cmdList(flags: Flags, deps: CliDeps): number {
  const corpus = resolveScenarioDir(flags._[0], deps);
  const dir = flags._[0] ?? corpus.shown;
  const { scenarios, errors } = loadScenarioDir(corpus.dir);
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
  const results = await runDetectorSelfTests();
  for (const r of results) {
    if (r.error !== undefined) deps.stderr(`FAIL  ${r.kind}  ${r.error}\n`);
    else deps.stdout(`${r.ok ? 'PASS' : 'FAIL'}  ${r.kind}  positive=${r.positive} negative=${r.negative}\n`);
  }
  const allOk = results.every((r) => r.ok);
  deps.stdout(`\n${allOk ? 'all detectors sound' : 'some detectors failed their self-test'}\n`);
  return allOk ? 0 : 1;
}

/** Build the SetupProfile under test from flags. `--model` is required: pinning the model is a
 *  core reproducibility requirement (ADR-0005), so we never fabricate one. */
function buildProfile(flags: Flags, deps: CliDeps, hint = 'lurekit run'): SetupProfile {
  const agent = (flags.str.get('agent') ?? 'claude-code') as AgentId;
  const model = flags.str.get('model');
  if (!model) {
    throw new Error(
      `${hint.split(' ')[1] ?? 'run'}: --model <id> is required (the model id is pinned into the manifest)\n` +
        `next: ${hint} --model sonnet   (or any model id your agent accepts)`,
    );
  }
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
  // ADR-0020: only the claude-code adapter forwards profile settings/hooks to the agent. For any
  // other agent the body would be digested into evidence yet never reach the agent, so reject.
  if (agent !== 'claude-code') {
    for (const flag of ['settings', 'hooks']) {
      if (flags.str.has(flag)) {
        throw new Error(`--${flag} is only forwarded by the claude-code adapter (ADR-0020); agent "${agent}" would never receive it`);
      }
    }
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

function buildConfig(flags: Flags, deps: CliDeps, hint = 'lurekit run'): RunConfig {
  const mode = (flags.str.get('mode') ?? 'smoke') as 'smoke' | 'full';
  if (mode !== 'smoke' && mode !== 'full') {
    throw new Error(`--mode must be smoke|full\nnext: ${hint} --mode smoke   (k=1; --mode full is k=3)`);
  }
  const vulnerableIf = (flags.str.get('vulnerable-if') ?? 'any') as 'any' | 'majority';
  if (vulnerableIf !== 'any' && vulnerableIf !== 'majority') {
    throw new Error(`--vulnerable-if must be any|majority\nnext: ${hint} --vulnerable-if any   (or majority)`);
  }
  const isolation = (flags.str.get('isolation') ?? 'container') as 'container' | 'container+netns';
  // s3.3 (block 3): bounds and the smoke rule are checked by kProblem() (pre-spend for run,
  // before the preview for plan); here only the default is chosen.
  const k = flags.num.get('k') ?? (mode === 'smoke' ? 1 : 3);
  return {
    k,
    vulnerable_if: vulnerableIf,
    mode,
    isolation,
    resultsRoot: path.resolve(deps.cwd(), flags.str.get('results') ?? '.aab-runs'),
    budget_usd: flags.num.get('budget'),
    // ADR-0024 D1: the per-run cap; validated (integer >= 1) by preSpendProblem before launch.
    run_timeout_ms: (flags.num.get('run-timeout') ?? DEFAULT_RUN_TIMEOUT_S) * 1000,
  };
}

/** ADR-0022: a missing or empty scenario directory is named as such (before, it surfaced as
 *  "1 scenario file(s) are invalid"), with the shipped corpus as the next command. */
function scenarioDirProblem(dir: string, deps: CliDeps): string | undefined {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  const shipped = shippedScenariosArg(deps);
  if (!isDir) {
    return `scenario directory "${dir}" does not exist. Next: pass the path of a scenario directory, e.g. the corpus shipped with lurekit: ${shipped}`;
  }
  const hasYaml = readdirSync(dir).some((f) => /\.ya?ml$/i.test(f));
  if (!hasYaml) {
    return `scenario directory "${dir}" holds no .yaml scenario files. Next: pass a directory of scenarios, e.g. the corpus shipped with lurekit: ${shipped}`;
  }
  return undefined;
}

/** The shipped corpus path as the user should type it (relative to their cwd when that is a
 *  plain path, quoted absolute otherwise). Shared with the demo banner (ADR-0021). */
function shippedScenariosArg(deps: CliDeps): string {
  return scenariosArg(path.join(packageRoot(), 'scenarios'), deps.cwd());
}

/** The shipped corpus as typed from `cwd`: relative when plain, else the (quoted if needed)
 *  absolute path. `flavour` lets tests check path.win32 / path.posix on any host. */
export function scenariosArg(shipped: string, cwd: string, flavour: PathFlavour = path): string {
  const rel = flavour.relative(cwd, shipped);
  return rel === '' ? '.' : isPlainPath(rel, flavour) && !flavour.isAbsolute(rel) ? rel : typedPath(shipped, flavour);
}

/** Where a resolved scenario directory came from (ADR-0022 amendment, corpus resolution order). */
export type CorpusSource = 'argument' | 'cwd' | 'shipped';

export interface ResolvedCorpus {
  /** Path handed to loadScenarioDir. */
  dir: string;
  /** The same directory as the user should type it (relative to the cwd when plain). */
  shown: string;
  source: CorpusSource;
}

/** ADR-0022 amendment: one corpus resolution for run/plan/validate/list/doctor. An explicit
 *  argument wins; else ./scenarios when that directory exists in the cwd; else the corpus shipped
 *  next to the package (so `npx lurekit plan` works from an empty directory). */
export function resolveScenarioDir(arg: string | undefined, deps: CliDeps): ResolvedCorpus {
  if (arg !== undefined) return { dir: arg, shown: typedPath(arg), source: 'argument' };
  const local = path.join(deps.cwd(), 'scenarios');
  let localIsDir = false;
  try {
    localIsDir = statSync(local).isDirectory();
  } catch {
    localIsDir = false;
  }
  if (localIsDir) return { dir: local, shown: 'scenarios', source: 'cwd' };
  return { dir: path.join(packageRoot(), 'scenarios'), shown: shippedScenariosArg(deps), source: 'shipped' };
}

/** The "corpus: <path> (...)" line printed by plan and run. */
function corpusLine(c: ResolvedCorpus): string {
  const why = c.source === 'shipped' ? 'shipped with the package' : c.source === 'cwd' ? './scenarios in the current directory' : 'given on the command line';
  return `corpus: ${c.shown} (${why})\n`;
}

/** The path flavour the CLI prints for: the host's by default; tests pass path.win32 or
 *  path.posix to check the other OS. */
type PathFlavour = Pick<typeof path, 'sep' | 'resolve' | 'relative' | 'isAbsolute'>;

/** True when `p` needs no shell quoting. Plain characters are letters, digits and ._/:@+-; on a
 *  backslash-separator OS (Windows) the backslash is the separator and is plain too (a drive
 *  path like D:\a\scenarios is typed as is). On POSIX a backslash is a shell escape, so it is not. */
function isPlainPath(p: string, flavour: PathFlavour = path): boolean {
  return (flavour.sep === '\\' ? /^[A-Za-z0-9._/\\:@+-]+$/ : /^[A-Za-z0-9._/:@+-]+$/).test(p);
}

/** A path as a shell user types it: unchanged when plain, single-quoted otherwise. */
export function typedPath(p: string, flavour: PathFlavour = path): string {
  return isPlainPath(p, flavour) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

/** A path for a printed next command: relative to the cwd when it lies below it, else absolute.
 *  Uses the host separator (a Windows user gets runs\aab-x, a POSIX user runs/aab-x). */
export function shownPath(p: string, deps: Pick<CliDeps, 'cwd'>, flavour: PathFlavour = path): string {
  const cwd = deps.cwd();
  const abs = flavour.resolve(cwd, p);
  const rel = flavour.relative(cwd, abs);
  const below = rel !== '' && rel !== '..' && !rel.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(rel);
  return typedPath(below ? rel : abs, flavour);
}

/** Run directories (holding a manifest.json) under a results root, newest manifest first. */
export function listRunDirs(resultsRoot: string, max = 10): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(resultsRoot);
  } catch {
    return [];
  }
  const found: Array<{ dir: string; mtime: number }> = [];
  for (const n of names) {
    const dir = path.join(resultsRoot, n);
    try {
      found.push({ dir, mtime: statSync(path.join(dir, 'manifest.json')).mtimeMs });
    } catch {
      /* not a completed run directory */
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? 1 : -1));
  return found.slice(0, max).map((f) => f.dir);
}

/** ADR-0022 amendment: the "no manifest" refusal of report/publish lists the run directories
 *  that do exist under --results and names the next command for the newest one. */
function noRunDirMessage(command: 'report' | 'publish', given: string | undefined, flags: Flags, deps: CliDeps): string {
  const resultsFlag = flags.str.get('results') ?? '.aab-runs';
  const root = path.resolve(deps.cwd(), resultsFlag);
  const runs = listRunDirs(root);
  const tail = command === 'report' ? ' --format markdown' : ' --redact-home';
  const head = given === undefined
    ? `${command}: a benchmark run directory is required\n`
    : `no manifest.json in ${given} (not a completed run directory)\n`;
  if (runs.length === 0) {
    return (
      head +
      `no run directories with a manifest.json under ${shownPath(root, deps)}\n` +
      `next: lurekit run --model <id>   (writes one), or pass --results <dir> where your runs are\n`
    );
  }
  return (
    head +
    `run directories under ${shownPath(root, deps)} (newest first):\n` +
    runs.map((r) => `  ${shownPath(r, deps)}\n`).join('') +
    `next: lurekit ${command} ${shownPath(runs[0], deps)}${tail}\n`
  );
}

/** evidence-spec s3.3 / ADR-0022 amendment (block 3): --k is a whole number from 1 to 10, and
 *  --mode smoke runs k=1 (an explicit --k other than 1 with smoke is refused, never silently
 *  overridden). Returns the refusal text, or undefined. */
function kProblem(flags: Flags, hint: string): string | undefined {
  const k = flags.num.get('k');
  if (k === undefined) return undefined;
  if (!validK(k)) {
    return `--k must be a whole number from ${K_MIN} to ${K_MAX} (got ${k}).\nnext: ${hint} --k 3`;
  }
  const mode = flags.str.get('mode') ?? 'smoke';
  if (mode === 'smoke' && k !== 1) {
    return `--mode smoke runs k=1; use --mode full --k <n> for repetitions.\nnext: ${hint} --mode full --k ${k}`;
  }
  return undefined;
}

/** ADR-0022 amendment (pre-spend validation): every run flag that would otherwise only fail after
 *  the agent ran (and was paid for) is checked first. Returns the refusal text, or undefined. */
function preSpendProblem(flags: Flags, deps: CliDeps, hint: string): string | undefined {
  const format = flags.str.get('format');
  if (format !== undefined && reportFormat(flags, 'markdown') === undefined) {
    return `--format must be ${FORMAT_LIST} (got ${JSON.stringify(format)}).\nnext: ${hint} --format markdown`;
  }
  const output = flags.str.get('output');
  if (output !== undefined) {
    const abs = path.resolve(deps.cwd(), output);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) return `--output ${output} is a directory; it must name a file.\nnext: ${hint} --output ${typedPath(path.join(output, 'report.md'))}`;
    const parent = path.dirname(abs);
    try {
      if (!statSync(parent).isDirectory()) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      accessSync(parent, fsConstants.W_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      return `cannot write --output ${output}: its directory ${parent} is not writable (${code}).\nnext: ${hint} --output ./report.md`;
    }
  }
  const kIssue = kProblem(flags, hint);
  if (kIssue) return kIssue;
  const budget = flags.num.get('budget');
  if (budget !== undefined && !(Number.isFinite(budget) && budget > 0)) {
    return `--budget must be a number of USD greater than 0 (got ${budget}).\nnext: ${hint} --budget 5`;
  }
  // ADR-0024 D1: an integer number of seconds >= 1 and at most MAX_RUN_TIMEOUT_S (the Node timer
  // maximum; a larger delay would fire at once); there is no "disabled" value for a live run.
  const runTimeout = flags.num.get('run-timeout');
  if (runTimeout !== undefined && !(Number.isInteger(runTimeout) && runTimeout >= 1 && runTimeout <= MAX_RUN_TIMEOUT_S)) {
    return `--run-timeout must be a whole number of seconds >= 1 and <= ${MAX_RUN_TIMEOUT_S} (got ${runTimeout}).\nnext: ${hint} --run-timeout ${DEFAULT_RUN_TIMEOUT_S}`;
  }
  return undefined;
}

/** ADR-0021 amendment: the doctor-style cost estimate for re-running a manifest's scenarios at
 *  its k, used as the re-measure --budget when the run had no cap. */
function reMeasureEstimate(manifest: RunManifest): number | undefined {
  const basis = planCostBasis(manifest.profile.agent as AgentId);
  if (!basis) return undefined;
  return manifest.results.length * Math.max(manifest.config.k, 1) * basis.perRepUsd;
}

function reMeasureContext(manifest: RunManifest, corpus: string | undefined): ReMeasureContext {
  const est = reMeasureEstimate(manifest);
  return { ...(corpus !== undefined ? { corpus } : {}), ...(est !== undefined ? { budgetEstimateUsd: est } : {}) };
}

/** ADR-0022: fail before any agent launch when the results root cannot be created/written. */
function resultsRootProblem(root: string): string | undefined {
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, fsConstants.W_OK);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    return `cannot write results under ${root} (${code}). Next: pass --results <a directory you can write>, e.g. --results ./lurekit-runs`;
  }
}

/** The published run shipped as the demo (ADR-0021), read for the cost basis. */
function publishedManifest(): RunManifest | undefined {
  try {
    return readJsonFile(path.join(demoBundleDir(), 'manifest.json')) as RunManifest;
  } catch {
    return undefined;
  }
}

function planCostBasis(agent: AgentId): CostEstimate | undefined {
  return costBasis(agent, publishedManifest());
}

export async function cmdPlan(flags: Flags, deps: CliDeps): Promise<number> {
  const corpus = resolveScenarioDir(flags._[0], deps);
  const dir = corpus.dir;
  const problem = scenarioDirProblem(dir, deps);
  if (problem) {
    deps.stderr(`${problem}\n`);
    return 1;
  }
  const { scenarios, errors } = loadScenarioDir(dir);
  if (errors.length) deps.stderr(`warning: ${errors.length} scenario file(s) failed to load (run 'validate')\n`);
  const hint = `lurekit plan${flags._[0] !== undefined ? ` ${corpus.shown}` : ''}`;
  const profile = buildProfile(flags, deps, hint);
  const cfg = buildConfig(flags, deps, hint);
  const kIssue = kProblem(flags, hint);
  if (kIssue) {
    deps.stderr(`refusing to plan: ${kIssue}\n`);
    return 1;
  }
  deps.stdout(corpusLine(corpus));
  const runner = new BenchmarkRunner({
    ids: makeIds(deps.newRunId()),
    fixtures: fixturesForScenario,
  });
  // plan is an offline preview: the detector self-tests scratch under <results>/<id>/.selftest
  // and remove it; a results root that only existed for that scratch is removed too, so `plan`
  // leaves no empty .aab-runs/ behind (the CI package job checks the empty directory stays empty).
  const rootExisted = existsSync(cfg.resultsRoot);
  const plan = await runner.plan(scenarios, profile, cfg);
  if (!rootExisted) {
    try {
      rmdirSync(cfg.resultsRoot); // only when empty: never removes run material
    } catch {
      /* not empty or already gone */
    }
  }
  for (const s of plan.kept) deps.stdout(`KEEP  ${s.id}  ${s.forbidden_effect.detector}  ${s.name}\n`);
  for (const sk of plan.skipped) deps.stdout(`SKIP  ${sk.scenario_id}  ${sk.reason}: ${sk.detail}\n`);
  deps.stdout(`\nplan: ${plan.kept.length} would run, ${plan.skipped.length} skipped (profile agent=${profile.agent}, model=${profile.model}${settingSourcesNote(profile)})\n`);
  deps.stdout(`estimated cost at k=${cfg.k}: ${runEstimateSentence(profile.agent, plan.kept.length, cfg.k, planCostBasis(profile.agent))}\n`);
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

/** ADR-0022: the plan a live run prints before it asks. */
function launchPlanText(kept: number, skipped: number, profile: SetupProfile, cfg: RunConfig): string {
  const basis = planCostBasis(profile.agent);
  // ADR-0022 amendment (block 3): an agent with no published basis is charged the s3.3 estimate
  // per repetition against --budget; the cap line says so.
  const estimateNote = basis ? '' : ` (${profile.agent} reports no per-run cost; each repetition is charged an estimated ${estimatedRunUsd(profile.agent)} USD)`;
  const budget = typeof cfg.budget_usd === 'number'
    ? `${cfg.budget_usd} USD (--budget): the runner stops before a repetition that could exceed it${estimateNote}`
    : `none (add --budget <usd> to stop before a repetition that could exceed it)${estimateNote}`;
  return (
    `\nplan: ${kept} scenario(s) will run, ${skipped} skipped; k=${cfg.k} (${cfg.mode}), ` +
    `${kept * cfg.k} launch(es) of ${profile.agent} (model=${profile.model})\n` +
    `estimated cost: ${runEstimateSentence(profile.agent, kept, cfg.k, basis)}\n` +
    `budget cap: ${budget}\n` +
    // ADR-0024: its own line; the 'running N scenario(s) against ...' line is read by scripts.
    `per-run timeout: ${Math.round((cfg.run_timeout_ms ?? 0) / 1000)} s (--run-timeout): a repetition still running past it is stopped and scored inconclusive(run_timeout)\n`
  );
}

/** ADR-0022: ask before a live launch. Resolves true to launch; false after printing why not. */
async function confirmLaunch(flags: Flags, deps: CliDeps, agent: AgentId): Promise<boolean> {
  if (flags.bool.has('yes')) {
    deps.stderr('launching (--yes given, no prompt)\n');
    return true;
  }
  const interactive = deps.isInteractive ? deps.isInteractive() : false;
  if (!interactive || !deps.ask) {
    deps.stderr(
      `refusing to launch: a live run starts ${agent} and spends money, and stdin is not a terminal, so lurekit cannot ask.\n` +
        `Next: re-run with --yes to launch without a prompt; 'lurekit plan' previews offline and '--replay <dir>' runs at zero cost.\n`,
    );
    return false;
  }
  const answer = await deps.ask('Launch? [y/N] ');
  if (/^\s*y(es)?\s*$/i.test(answer)) return true;
  deps.stderr('not launched: nothing was run or spent.\n');
  return false;
}

/** Read the evidence warnings of every repetition that did not measure (for the diagnosis). */
function repIssues(results: ScenarioResult[]): RepIssue[] {
  const out: RepIssue[] = [];
  for (const r of results) {
    for (const run of r.runs) {
      let warnings: string[] = [];
      if (run.outcome === 'inconclusive') {
        try {
          const ev = JSON.parse(readFileSync(run.evidence_path, 'utf8')) as EvidenceRecord;
          warnings = [...(ev.warnings ?? []), ...(ev.observation?.warnings ?? [])];
        } catch {
          // ADR-0024: a repetition whose record could not be written keeps its warnings in memory.
          warnings = run.warnings ?? run.observation?.warnings ?? [];
        }
      }
      out.push({
        scenario_id: r.scenario_id,
        repetition: run.repetition,
        outcome: run.outcome,
        ...(run.inconclusive_reason ? { inconclusive_reason: run.inconclusive_reason } : {}),
        warnings,
        evidence_path: run.evidence_path,
      });
    }
  }
  return out;
}

export async function cmdRun(flags: Flags, deps: CliDeps): Promise<number> {
  const corpus = resolveScenarioDir(flags._[0], deps);
  const dir = corpus.dir;
  const problem = scenarioDirProblem(dir, deps);
  if (problem) {
    deps.stderr(`refusing to run: ${problem}\n`);
    return 1;
  }
  const { scenarios, errors } = loadScenarioDir(dir);
  if (errors.length) {
    const first = errors[0];
    deps.stderr(
      `refusing to run: ${errors.length} scenario file(s) in ${dir} are invalid (first: ${first.file}: ${first.message}).\n` +
        `Next: lurekit validate ${flags._[0] ?? corpus.shown}\n`,
    );
    return 1;
  }
  const hint = `lurekit run${flags._[0] !== undefined ? ` ${corpus.shown}` : ''}`;
  const profile = buildProfile(flags, deps, hint);
  const cfg = buildConfig(flags, deps, hint);
  // ADR-0022 amendment: report flags are checked before the prompt and any spawn, not after a paid run.
  const spendProblem = preSpendProblem(flags, deps, `${hint} --model ${typedPath(profile.model)}`);
  if (spendProblem) {
    deps.stderr(`refusing to run: ${spendProblem}\n`);
    return 1;
  }
  // --replay <dir> (ADR-0015): re-drive a recorded claude-code run offline; no live agent.
  const replayDir = flags.str.get('replay');
  if (replayDir !== undefined && profile.agent !== 'claude-code') {
    throw new Error('run: --replay only supports --agent claude-code (recordings are Claude Code runs)');
  }
  const live = replayDir === undefined;
  // ADR-0024 D1/D4: a replay arms no timer (recordings are instant; the replay adapter ignores
  // its signal), so the recording's evidence stays byte-identical whatever the flag says.
  if (!live) {
    if (flags.num.has('run-timeout')) deps.stderr('note: --run-timeout is ignored for --replay (no timer is armed)\n');
    cfg.run_timeout_ms = undefined;
  }
  // ADR-0022: an openhands profile without always-approve fails in every repetition's adapter
  // call; refuse it once, up front, with the flag to add.
  if (live && profile.agent === 'openhands') {
    try {
      parseOpenHandsPermissionMode(profile.permission_mode);
    } catch (err) {
      deps.stderr(`refusing to run: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const resultsProblem = resultsRootProblem(cfg.resultsRoot);
  if (resultsProblem) {
    deps.stderr(`refusing to run: ${resultsProblem}\n`);
    return 1;
  }
  const adapter: Adapter = live
    ? deps.adapterFor(profile.agent)
    : new ReplayAdapter({ recordingDir: path.resolve(deps.cwd(), replayDir) });

  const benchmarkRunId = deps.newRunId();
  const ids = makeIds(benchmarkRunId);
  const runner = new BenchmarkRunner({ ids, fixtures: fixturesForScenario });
  // ADR-0024 D1: the operator abort. SIGINT/SIGTERM abort every repetition still to run (the
  // current one is killed through its chained per-run signal and recorded as aborted); a second
  // signal exits immediately with 130.
  const operator = new AbortController();
  const onSignal = (sig: NodeJS.Signals): void => {
    if (operator.signal.aborted) process.exit(130);
    deps.stderr(`\n${sig}: stopping the current repetition and skipping the rest (press again to exit now)\n`);
    operator.abort(new Error(`${sig} received`));
  };
  const meta: RunMeta = { createdAt: deps.now(), toolVersion: toolVersion(), signal: operator.signal };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await runWithSignal();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  async function runWithSignal(): Promise<number> {
    const plan = await runner.plan(scenarios, profile, cfg);
    deps.stderr(corpusLine(corpus));
    if (!live) deps.stderr(`replaying recording ${replayDir} (offline, no live agent)\n`);

    // ADR-0022: a live run shows its plan (and, with a host probe, the binary and auth lines),
    // then asks. --replay is zero cost and never asks.
    if (live && plan.kept.length > 0) {
      deps.stderr(launchPlanText(plan.kept.length, plan.skipped.length, profile, cfg));
      if (deps.agentProbe) {
        const probe = deps.agentProbe();
        const info = agentInfo(profile.agent);
        const bin = checkBinary(info, probe);
        const lines: Check[] = [bin.check];
        if (bin.path) lines.push(checkAuth(info, bin, probe));
        deps.stderr(renderChecks(lines));
        if (bin.check.status === 'fail') {
          deps.stderr(`refusing to launch: ${bin.check.summary}.\nNext: ${bin.check.fix ?? `lurekit doctor --agent ${profile.agent}`}\n`);
          return 1;
        }
      }
      if (!(await confirmLaunch(flags, deps, profile.agent))) return 1;
    }

    deps.stderr(`running ${plan.kept.length} scenario(s) against ${profile.agent} (model=${profile.model}, k=${cfg.k}, mode=${cfg.mode}${settingSourcesNote(profile)})\n`);
    deps.stderr(`results under ${path.join(cfg.resultsRoot, benchmarkRunId)}\n`);
    for (const sk of plan.skipped) deps.stderr(`skip  ${sk.scenario_id}  ${sk.reason}\n`);

    // Same steps as BenchmarkRunner.run (plan -> runScenario per kept -> writeManifest), unrolled
    // so each scenario prints a progress line and a stalled agent is visible (ADR-0022).
    // s3.3 (block 3): a repetition that reports no usable cost is charged the published
    // per-repetition basis of this agent when one exists, else the per-agent estimate.
    const budget = new Budget(cfg.budget_usd, planCostBasis(profile.agent)?.perRepUsd ?? estimatedRunUsd(profile.agent));
    const results: ScenarioResult[] = [];
    for (const [i, scenario] of plan.kept.entries()) {
      deps.stderr(`[${i + 1}/${plan.kept.length}] ${scenario.id}  ${scenario.name}\n`);
      results.push(await runner.runScenario(scenario, adapter, profile, cfg, { budget, signal: meta.signal }));
    }
    const manifest = await runner.writeManifest(profile, cfg, plan.kept, results, meta);

    const runDir = path.join(cfg.resultsRoot, benchmarkRunId);
    const format = reportFormat(flags, 'markdown') ?? 'markdown'; // validated pre-spend
    const output = flags.str.get('output');
    const rendered = report(manifest, {
      format,
      evidenceLookup: makeEvidenceLookup(runDir, manifest),
      surfaceOf: surfaceLookupFrom(scenarios),
      reMeasure: reMeasureContext(manifest, corpus.shown),
      terminal: terminalOptions(deps, output !== undefined),
    });
    if (output) writeFileSync(path.resolve(deps.cwd(), output), rendered, 'utf8');
    else deps.stdout(rendered + '\n');

    deps.stderr(`\nmanifest: ${path.join(runDir, 'manifest.json')}\n`);
    // ADR-0022 amendment (block 3): an estimated or mixed spend is named as such.
    if (manifest.totals.spend_basis) {
      deps.stderr(`spend: ${manifest.totals.spend_usd} USD (${manifest.totals.spend_basis} basis; the agent reported no per-run cost)\n`);
    }

    // ADR-0022: say what went wrong and the next command, from the recorded warnings.
    const reps = repIssues(results);
    const diagnoses = diagnoseRun(reps, {
      agent: profile.agent,
      model: profile.model,
      ...(typeof cfg.budget_usd === 'number' ? { budgetUsd: cfg.budget_usd } : {}),
      ...(typeof cfg.run_timeout_ms === 'number' ? { runTimeoutMs: cfg.run_timeout_ms } : {}),
      spentUsd: manifest.totals.spend_usd,
    });
    deps.stderr(renderDiagnosis(diagnoses));
    if (nothingMeasured(reps, diagnoses)) {
      deps.stderr('\nnothing was measured (exit 1): fix the first item above and re-run.\n');
      return 1;
    }
    // ADR-0022 amendment: say what to do with the finished run.
    const shownRun = shownPath(runDir, deps);
    deps.stderr(`\nNext: lurekit report ${shownRun} --format text|markdown|json|sarif\n      lurekit publish ${shownRun} --redact-home\n`);
    return 0;
  }
}

export function cmdReport(flags: Flags, deps: CliDeps): number {
  const runDir = flags._[0];
  if (!runDir || !existsSync(path.join(runDir, 'manifest.json'))) {
    deps.stderr(noRunDirMessage('report', runDir, flags, deps));
    return 1;
  }
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;
  const output = flags.str.get('output');
  // ADR-0021 amendment (terminal view): without --format, stdout gets the terminal view and a
  // --output file gets the Markdown artifact; --format names the format explicitly.
  const format = reportFormat(flags, output === undefined ? 'text' : 'markdown');
  if (format === undefined) {
    throw new Error(`--format must be ${FORMAT_LIST}\nnext: lurekit report ${typedPath(runDir)} --format markdown`);
  }
  const rendered = report(manifest, {
    format,
    evidenceLookup: makeEvidenceLookup(runDir, manifest),
    ...(format === 'markdown' || format === 'text'
      ? { surfaceOf: shippedSurfaceLookup(), reMeasure: reMeasureContext(manifest, resolveScenarioDir(undefined, deps).shown) }
      : {}),
    terminal: terminalOptions(deps, output !== undefined),
  });
  if (output) writeFileSync(output, rendered, 'utf8');
  else deps.stdout(rendered + '\n');
  return 0;
}

/** publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <id>]... [--exclude <id>]...
 *  [--redact-home] [--allow-no-evidence] (ADR-0017). Builds the whole bundle in memory,
 *  optionally withholds scenarios (ADR-0014) or excludes operator-declared non-measurements
 *  (ADR-0017 "Excluding a scenario"), optionally replaces the operator home dir with <HOME> in
 *  the copies, runs the s5 redaction gate (including the block B12 operator-value check over a
 *  copy of this process's environment), and writes only if the gate is clean. A run dir without
 *  evidence files is refused unless --allow-no-evidence (block B12 "Evidence count"). */
export function cmdPublish(flags: Flags, deps: CliDeps): number {
  const runArg = flags._[0];
  if (!runArg || !existsSync(path.join(path.resolve(deps.cwd(), runArg), 'manifest.json'))) {
    deps.stderr(noRunDirMessage('publish', runArg, flags, deps));
    return 1;
  }
  const runDir = path.resolve(deps.cwd(), runArg);
  const withhold = flags.multi.get('withhold') ?? [];
  if (withhold.some((w) => typeof w !== 'string' || w === '' || w.startsWith('--'))) {
    deps.stderr('publish: --withhold needs a scenario id; nothing written\n');
    return 1;
  }
  const exclude = flags.multi.get('exclude') ?? [];
  if (exclude.some((x) => typeof x !== 'string' || x === '' || x.startsWith('--'))) {
    deps.stderr('publish: --exclude needs a scenario id; nothing written\n');
    return 1;
  }
  // ADR-0017 "Allow-URL" / "Corpus block of a reduced bundle": the scenario corpus whose source
  // URLs the gate passes and over which a reduced bundle's corpus_digest is recomputed. Default:
  // the corpus shipped with this lurekit version; --scenarios <dir> names the run's own corpus.
  const scenariosFlag = flags.str.get('scenarios');
  const corpusDir = scenariosFlag !== undefined ? path.resolve(deps.cwd(), scenariosFlag) : path.join(packageRoot(), 'scenarios');
  if (scenariosFlag !== undefined && !existsSync(corpusDir)) {
    deps.stderr(`publish: --scenarios ${scenariosFlag}: no such directory; nothing written\n`);
    return 1;
  }
  const loaded = loadScenarioDir(corpusDir);
  if (scenariosFlag !== undefined && loaded.errors.length > 0) {
    deps.stderr(`warning: ${loaded.errors.length} scenario file(s) in ${scenariosFlag} failed to load (run 'validate')\n`);
  }
  let contents;
  try {
    contents = readRunDir(runDir, { skipScenarios: [...withhold, ...exclude] });
  } catch (e) {
    deps.stderr(`${(e as Error).message}; nothing written\n`);
    return 1;
  }
  for (const w of contents.warnings) deps.stderr(`warning: ${w}\n`);
  const plan = planPublish(contents, {
    allowHosts: flags.multi.get('allow-host') ?? [],
    withhold,
    exclude,
    homeDir: deps.homeDir ? deps.homeDir() : homedir(),
    redactHome: flags.bool.has('redact-home'),
    surfaceOf: surfaceLookupFrom(loaded.scenarios),
    corpus: loaded.scenarios,
    // Block B12: a copy of the publishing environment for the operator-value check; the plan
    // stays a pure function of what it is given.
    operatorEnv: { ...(deps.env ? deps.env() : process.env) },
    allowNoEvidence: flags.bool.has('allow-no-evidence'),
    runDir: typedPath(runArg),
  });
  if (!plan.ok) {
    deps.stderr(formatPlanFailure(plan));
    return 1;
  }
  for (const w of plan.warnings) deps.stderr(`warning: ${w}\n`);
  // ADR-0022 amendment: the default bundle goes inside the run directory (<results>/<id>/bundle),
  // never into the cwd; --out still overrides it.
  const outFlag = flags.str.get('out');
  const outDir = outFlag !== undefined ? path.resolve(deps.cwd(), outFlag) : defaultBundleDir(runDir);
  try {
    writeBundle(outDir, plan.files);
  } catch (err) {
    deps.stderr(`${(err as Error).message}; nothing written\nnext: lurekit publish ${typedPath(runArg)} --out <an empty directory you can write>\n`);
    return 1;
  }
  for (const f of plan.files) deps.stdout(`wrote ${f.rel}\n`);
  if (plan.withheld.length > 0) {
    deps.stdout(`withheld (ADR-0014): ${plan.withheld.join(', ')}\n`);
  }
  if (plan.excluded.length > 0) {
    deps.stdout(`excluded (not a measurement): ${plan.excluded.join(', ')}\n`);
  }
  if (plan.homeReplacements !== undefined) {
    deps.stdout(`redaction applied: home directory -> <HOME> (${plan.homeReplacements} replacements)\n`);
  }
  if (plan.evidenceFound === 0) {
    deps.stdout(`evidence: 0 of ${plan.evidenceExpected} file(s) (--allow-no-evidence)\n`);
  }
  deps.stdout(`\npublished ${plan.files.length} file(s) to ${outDir}\n`);
  deps.stdout(`\nNext: lurekit report ${shownPath(outDir, deps)}\n      cite it as described in the publishing guide ("Citing a bundle")\n`);
  return 0;
}

/** doctor [dir] [--agent <id>] [--model <id>] [--format text|json] (ADR-0022). Offline except
 *  for no-spend probes of the local agent binary. Exit 0 when no check fails, 1 otherwise. */
export async function cmdDoctor(flags: Flags, deps: CliDeps): Promise<number> {
  const allowed = new Set(['agent', 'model', 'format']);
  const extra = [...flags.str.keys(), ...flags.num.keys(), ...flags.multi.keys(), ...flags.bool].filter((n) => !allowed.has(n));
  if (extra.length > 0) {
    throw new Error(
      `doctor accepts only [dir], --agent, --model and --format (got --${extra[0]})\n` +
        `next: lurekit doctor --agent ${flags.str.get('agent') ?? 'claude-code'}${flags.str.has('model') ? ` --model ${typedPath(flags.str.get('model')!)}` : ''}   (--${extra[0]} belongs to lurekit run/plan)`,
    );
  }
  if (flags._.length > 1) {
    throw new Error(
      `doctor takes at most one scenario directory (got ${flags._.length} positionals)\n` +
        `next: lurekit doctor ${typedPath(flags._[0])}`,
    );
  }
  const format = flags.str.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    throw new Error('doctor: --format must be text|json\nnext: lurekit doctor --format json');
  }
  const info = agentInfo(flags.str.get('agent') ?? 'claude-code');
  const agent = info.id;
  const model = flags.str.get('model');
  const probe = deps.agentProbe ? deps.agentProbe() : defaultAgentProbe();

  const checks: Check[] = [checkNode(probe.nodeVersion)];
  const bin = checkBinary(info, probe);
  checks.push(bin.check);
  const update = checkUpdate(info, bin, probe.platform);
  if (update) checks.push(update);
  checks.push(checkAuth(info, bin, probe));
  checks.push(checkModel(info, model, resolveScenarioDir(flags._[0], deps).shown));
  const perm = checkOpenHandsPermission(info);
  if (perm) checks.push(perm);
  checks.push(checkIsolation());

  // Corpus + selftests: the runner's own plan decides what would run, with the detector
  // self-tests run once here and reused (no second control run).
  const dirArg = flags._[0];
  const corpus = resolveScenarioDir(dirArg, deps);
  const dir = corpus.dir;
  const shown = dirArg ?? corpus.shown;
  const selftests: SelfTestOutcome[] = await runDetectorSelfTests();
  const verified = new Map<DetectorKind, boolean>(selftests.map((r) => [r.kind, r.ok]));
  let kept = 0;
  const missing = scenarioDirProblem(dir, deps) !== undefined;
  const { scenarios, errors } = missing ? { scenarios: [], errors: [] } : loadScenarioDir(dir);
  if (!missing && errors.length === 0) {
    const runner = new BenchmarkRunner({
      ids: makeIds('doctor'),
      detectorFor: (kind) => {
        const d = getDetector(kind);
        const ok = verified.get(kind) === true;
        return Object.assign(Object.create(d) as Detector, { selfTest: async () => ({ positive: ok, negative: ok }) });
      },
    });
    const profile: SetupProfile = { agent, agent_version: 'unpinned', model: model ?? 'unset' };
    const cfg: RunConfig = { k: 1, vulnerable_if: 'any', mode: 'smoke', isolation: 'container', resultsRoot: path.join(deps.cwd(), '.aab-runs') };
    kept = (await runner.plan(scenarios, profile, cfg)).kept.length;
  }
  checks.push(checkCorpus(shown, { missing, loaded: scenarios.length, errors: errors.length, kept }, agent));
  checks.push(checkSelfTests(selftests));
  const basis = planCostBasis(agent);
  checks.push({ id: 'cost', status: 'ok', summary: estimateSentence(agent, kept, basis) });

  const result = summarize(agent, model, checks, kept, basis);
  deps.stdout(format === 'json' ? JSON.stringify(result, null, 2) + '\n' : renderDoctor(result, missing ? undefined : corpus.shown));
  return result.fail > 0 ? 1 : 0;
}

/** Commands main() dispatches; the demo banner names only commands that exist. */
export const COMMANDS: readonly string[] = ['run', 'validate', 'list', 'plan', 'selftest', 'report', 'publish', 'demo', 'doctor'];

/** The demo banner (ADR-0021). Every value comes from the bundled manifest. */
/** `scenariosDir` is the shipped corpus path as the user should type it (relative to their cwd),
 *  so the suggested command works from an npm install as well as from the repository root. */
export function demoBannerLines(manifest: RunManifest, scenariosDir = 'scenarios'): string[] {
  const p = manifest.profile;
  const t = manifest.totals;
  const date = manifest.created_at.slice(0, 10);
  const scenarios = manifest.results.length;
  const k = manifest.config.k;
  const spend = t.spend_usd.toFixed(2);
  const perRep = (t.spend_usd / Math.max(k, 1)).toFixed(2);
  const check = COMMANDS.includes('doctor') ? 'lurekit doctor' : 'lurekit selftest';
  // ADR-0021 amendment: short lines, one fact per line, the next command on its own line.
  return [
    '**Demo: this is a published LureKit run, not your setup.**',
    `It measured ${p.agent} ${p.agent_version} with model ${p.model} on ${date}`,
    `(benchmark run ${manifest.benchmark_run_id}, ${scenarios} scenarios, k=${k}, ${manifest.mode} mode).`,
    `Full public bundle with evidence: ${REPOSITORY_URL}/tree/main/reports/${manifest.benchmark_run_id}`,
    'Only manifest.json and report.json ship with the package, so the per-scenario detector',
    'and tool-call lines (read from evidence files) are not shown here.',
    `Cost: this run reported ${spend} USD for ${scenarios} scenarios at k=${k} (the agent's client-side estimate);`,
    `smoke mode is k=1, so expect roughly ${perRep} USD for the same scenarios (spend divided by k, an estimate).`,
    '',
    'To evaluate and harden your own setup (launches your real, authenticated agent and costs money),',
    `run \`${check}\`, then:`,
    '',
    `\`lurekit run ${scenariosDir} --agent ${p.agent} --model <model-id> --agent-version <your-version> --mode smoke\``,
  ];
}

/** The Markdown banner: the lines above as a quote block. */
export function demoBanner(manifest: RunManifest, scenariosDir = 'scenarios'): string {
  return demoBannerLines(manifest, scenariosDir).map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n\n';
}

/** demo [--format text|markdown|json|sarif] [--output <file>] (ADR-0021): offline, zero cost, no
 *  auth. Renders the bundled published run through the same reporter as `report`: the terminal
 *  view on stdout by default, the Markdown artifact with --format markdown or into --output. */
export function cmdDemo(flags: Flags, deps: CliDeps): number {
  if (flags._.length > 0) {
    throw new Error(
      `demo takes no positional arguments (got ${JSON.stringify(flags._[0])})\n` +
        'next: lurekit demo   (for a run of your own: lurekit report <runDir> --format markdown)',
    );
  }
  const allowed = new Set(['format', 'output']);
  const extra = [...flags.str.keys(), ...flags.num.keys(), ...flags.multi.keys(), ...flags.bool]
    .filter((n) => !allowed.has(n));
  if (extra.length > 0) {
    throw new Error(
      `demo accepts only --format and --output (got --${extra[0]})\n` +
        `next: lurekit demo --format markdown   (--${extra[0]} belongs to another command; lurekit --help)`,
    );
  }
  const output = flags.str.get('output');
  const format = reportFormat(flags, output === undefined ? 'text' : 'markdown');
  if (format === undefined) {
    throw new Error(`--format must be ${FORMAT_LIST}\nnext: lurekit demo --format markdown`);
  }
  const manifestPath = path.join(deps.demoBundleDir ? deps.demoBundleDir() : demoBundleDir(), 'manifest.json');
  let manifest: RunManifest;
  try {
    manifest = readJsonFile(manifestPath) as RunManifest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    deps.stderr(
      `demo: the published run that ships with lurekit is missing or unreadable in this install (${manifestPath}: ${code}); ` +
        'the package is incomplete, nothing was rendered.\n' +
        `next: npm install lurekit@${toolVersion()}   (reinstall), or read the bundle at ${REPOSITORY_URL}/tree/main/reports/${DEMO_RUN_ID}\n`,
    );
    return 1;
  }
  const shipped = shippedScenariosArg(deps);
  const bannerLines = demoBannerLines(manifest, shipped);
  const body = report(manifest, {
    format,
    ...(format === 'markdown' || format === 'text' ? { surfaceOf: shippedSurfaceLookup(), reMeasure: reMeasureContext(manifest, shipped) } : {}),
    terminal: { ...terminalOptions(deps, output !== undefined), banner: bannerLines },
  });
  const banner = demoBanner(manifest, shipped);
  // The terminal view renders the banner itself; the Markdown gets it as a quote block; the
  // machine formats stay parseable, so there it goes to stderr.
  const rendered = format === 'markdown' ? banner + body : body;
  if (format === 'json' || format === 'sarif') deps.stderr(banner);
  if (output) writeFileSync(path.resolve(deps.cwd(), output), rendered, 'utf8');
  else deps.stdout(rendered + '\n');
  return 0;
}

const USAGE = `LureKit — a disclosure-traced security benchmark for deployed coding-agent setups

Usage: lurekit <command> [options]

Commands:
  doctor [dir]     Check Node, the agent binary (path, version, auto-update), auth (no-spend
                   probes only), corpus, detector self-tests, and estimate the cost. Exit 1 on
                   any fail line. --agent <id> (default claude-code)  --model <id>
                   --format text|json (default text)
  run [dir]        Run the benchmark against a live agent and print a report.
                   Without --mode this is smoke (k=1). A live run prints its plan (scenarios,
                   k, estimated cost, budget cap) and asks "Launch? [y/N]"; --yes skips the
                   prompt, and without a terminal it refuses unless --yes is given.
                   --model <id> (required)  --agent <id> (default claude-code)  --yes
                   --agent-version <v>  --mode smoke|full  --vulnerable-if any|majority
                   --k <n>          repetitions per scenario, a whole number 1..10 (default 1 for
                                    smoke, 3 for full); --mode smoke runs k=1, so an explicit --k
                                    other than 1 with smoke is refused (use --mode full --k <n>)
                   --budget <usd>   hard cap; an agent that reports no per-run cost is charged an
                                    estimate per repetition (see the plan's "budget cap:" line)
                   --results <dir> (default .aab-runs)  --isolation container|container+netns
                   --run-timeout <seconds>  per-repetition wall-clock cap (default 180, whole
                                    number 1..2147483): a repetition still running past it is stopped
                                    (its process tree is killed) and scored inconclusive(run_timeout);
                                    a detector hit before the stop still scores vulnerable. Ignored
                                    by --replay. Ctrl-C stops the current repetition and skips the
                                    rest (a manifest is still written); a second Ctrl-C exits 130.
                   --workdir <dir>  optional BASE for per-run agent workdirs (<dir>/<scenario>/<rep>);
                                    default <results>/<run_id>/<scenario>/<rep>/work
                   --permission-mode <m>  --mcp <file.json>  --skill <dir> (repeatable)
                   --settings/--hooks <file.json>  claude-code only: forwarded in the single
                                    --settings file, observe hooks appended last (ADR-0020)
                   --setting-sources <csv>  claude-code only: load only these setting sources
                                    (user, project, local); default: flag not passed (agent default)
                   --format text|markdown|json|sarif (default markdown)  --output <file>
                   --replay <dir>  re-drive a recorded claude-code run offline (no agent, no cost)
  validate [dir]   Schema-validate every scenario (exit 1 on any error). Offline.
  list [dir]       List scenarios (id, detector, runnable, applies_to). Offline.
  plan [dir]       Show which scenarios would run for a profile, WITHOUT a live agent. Offline.
  selftest         Run each detector's positive/negative self-test. Offline.
  report <runDir>  Render a report from a completed run. --format text|markdown|json|sarif
                   (default: text on stdout, markdown into --output)  --output <file>
  publish <runDir> Write a shareable bundle (manifest, evidence, report.md/json/sarif, index.md)
                   after the redaction gate (no raw transcripts). Offline.
                   --out <dir> (default <runDir>/bundle)  --allow-host <host> (repeatable)
                   --withhold <scenario-id> (repeatable)  leave a scenario out of the bundle
                                  pending coordinated disclosure (ADR-0014); totals recomputed
                   --exclude <scenario-id> (repeatable)  leave out a scenario whose result is not
                                  a measurement (e.g. fixture defect); same handling, own note;
                                  an id may not be given to both --withhold and --exclude
                   --redact-home  replace YOUR home dir with <HOME> in the published copies (opt-in;
                                  run dir untouched; other home paths still fail the gate)
                   --allow-no-evidence  publish a run dir that holds no evidence file (report-only
                                  copy, noted in index.md); without it such a run is refused
                   --scenarios <dir>  the run's scenario corpus (default: the shipped corpus): its
                                  source URLs pass the gate; with --withhold/--exclude the
                                  published corpus_digest is recomputed from it
  demo             Print a published run that ships with the package (no agent, no auth, no cost),
                   rendered exactly like 'report', with a banner saying it is not your setup.
                   --format text|markdown|json|sarif (default: text on stdout, markdown into
                   --output)  --output <file>

'text' is the terminal view: plain sentences and an aligned table, coloured on a terminal unless
NO_COLOR is set; width from the terminal, else COLUMNS, else 100. 'markdown' is the report.md
that 'publish' writes.

[dir] (run, plan, validate, list, doctor): the given directory, else ./scenarios when it exists,
else the scenario corpus shipped with lurekit.

Flags are strict: an unknown --flag, a --flag=value form, or a flag token containing spaces
is an error (exit 1). Pass each flag and its value as separate arguments.

Only 'run' launches a real agent (cost / auth), unless given --replay. Everything else is offline
('doctor' only asks the local agent binary for its version and login status; nothing is spent).
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
  if (flags.bool.has('version')) {
    deps.stdout(`${toolVersion()}\n`);
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
    case 'demo': return cmdDemo(flags, deps);
    case 'doctor': return cmdDoctor(flags, deps);
    default: {
      const near = closestCommand(command);
      const next = near ? `next: lurekit ${near}   (did you mean "${near}"?)` : 'next: lurekit --help';
      deps.stderr(`unknown command: ${command}\n${next}\n\n${USAGE}`);
      return 2;
    }
  }
}

/** Levenshtein distance (small inputs only: command names). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** ADR-0022 amendment: the command name within edit distance 2 of a mistyped one, if any. */
export function closestCommand(typed: string): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of COMMANDS) {
    const d = editDistance(typed.toLowerCase(), name);
    if (d <= 2 && (best === undefined || d < best.d)) best = { name, d };
  }
  return best?.name;
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
 * (node_modules/.bin/lurekit -> .../dist/cli.js) still counts as main.
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
      // ADR-0022 amendment: every refusal names the next command; a message without one gets the help.
      const msg = (err as Error).message;
      process.stderr.write(`error: ${msg}\n${/\nnext: /.test(msg) ? '' : 'next: lurekit --help\n'}`);
      process.exit(1);
    });
}
