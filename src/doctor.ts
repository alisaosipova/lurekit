// `lurekit doctor` and the newcomer preflight shared with `run` (ADR-0022).
//
// Everything here is offline except probing LOCAL agent binaries with commands that do not
// launch a model turn: `<bin> --version`, `claude auth status --json`, `agent status --format
// json` (NOTES, "Verified on the installed binary"). No check reads a credential value: an
// API-key variable is tested for presence only, and of the agents' own status JSON only the
// boolean "logged in" field and the auth method are kept (the rest, e.g. an account email, is
// discarded unread).
//
// Process access goes through the injectable AgentProbe so the checks are testable offline.

import { spawnSync } from 'node:child_process';
import { agentChildEnv, harnessChildEnv } from './adapters/childEnv.js';

import type { AgentId } from './scenario/types.js';
import { resolveAgentBinary, CLAUDE_BIN_ENV } from './adapters/claudeCode.js';
import { CURSOR_BIN_ENV } from './adapters/cursorCli.js';
import { CODEX_BIN_ENV } from './adapters/codexCli.js';
import { OPENHANDS_BIN_ENV } from './adapters/openhands.js';
import { getDetector, IMPLEMENTED_DETECTORS } from './detectors/index.js';
import type { DetectorKind } from './scenario/types.js';
import type { RunManifest } from './runner/types.js';
import { estimatedRunUsd } from './runner/runner.js';
import { PUBLISHED_CLAUDE_VERSION } from './report/guidance.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One doctor line: a status, what was found, and (for warn/fail) one command that fixes it. */
export interface Check {
  id: string;
  status: CheckStatus;
  summary: string;
  fix?: string;
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started (e.g. ENOENT) or timed out. */
  error?: string;
}

/** Host access used by the checks. The bin wires the real one; tests pass a fake. */
export interface AgentProbe {
  env: Record<string, string | undefined>;
  nodeVersion: string; // process.versions.node, e.g. "26.13.0"
  platform: NodeJS.Platform;
  resolveBinary(spec: string): string | undefined;
  /** `agent` selects the child env (ADR-0008 B11a: the agent's allow-listed env, as a run). */
  exec(bin: string, args: string[], timeoutMs: number, agent?: AgentId): ExecResult;
}

export function defaultAgentProbe(): AgentProbe {
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    platform: process.platform,
    resolveBinary: (spec) => resolveAgentBinary(spec),
    exec: (bin, args, timeoutMs, agent) => {
      // A .js/.mjs/.cjs entry point (codex is codex.js) runs under the current node, as the
      // adapters do, so it also works where shebangs do not (Windows).
      const isScript = /\.(mjs|cjs|js)$/i.test(bin);
      const cmd = isScript ? process.execPath : bin;
      const argv = isScript ? [bin, ...args] : args;
      const r = spawnSync(cmd, argv, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: agent ? agentChildEnv(agent, undefined) : harnessChildEnv(),
      });
      const err = r.error as NodeJS.ErrnoException | undefined;
      return {
        status: r.status,
        stdout: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : '',
        ...(err ? { error: err.code ?? err.message } : {}),
      };
    },
  };
}

/** Upper bound for every probe, so a blocking binary cannot hang doctor. */
export const PROBE_TIMEOUT_MS = 15_000;

/** Node floor from package.json "engines" (ADR-0001). */
export const NODE_MIN: readonly [number, number] = [20, 19];

export interface AgentInfo {
  id: AgentId;
  envVar: string;
  defaultBin: string;
  /** One command that installs the agent (source: NOTES-verified-facts.md). */
  install: string;
  /** The agent's own login command. */
  login: string;
}

/** The claude-code version of the published run that ships as the demo (ADR-0021); used as
 *  the concrete version in the pinned-install recipe when the installed one is unknown. The
 *  single constant lives in src/report/guidance.ts (ADR-0023 amendment). */
export const PINNED_CLAUDE_FALLBACK = PUBLISHED_CLAUDE_VERSION;

/** NOTES "Second auto-update": a separate `npm install --prefix <dir>` (not -g) is the verified
 *  way to keep a batch on one version. The prefix lives under .aab-runs (never the temp dir). */
export function pinnedClaudeRecipe(version: string): string {
  const dir = `.aab-runs/_bin/claude-${version}`;
  return (
    `npm install --prefix ${dir} @anthropic-ai/claude-code@${version} && ` +
    `export ${CLAUDE_BIN_ENV}="$PWD/${dir}/node_modules/.bin/claude"`
  );
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  'claude-code': {
    id: 'claude-code',
    envVar: CLAUDE_BIN_ENV,
    defaultBin: 'claude',
    install: pinnedClaudeRecipe(PINNED_CLAUDE_FALLBACK),
    login: 'claude auth login',
  },
  'cursor-cli': {
    id: 'cursor-cli',
    envVar: CURSOR_BIN_ENV,
    defaultBin: 'agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'agent login',
  },
  'codex-cli': {
    id: 'codex-cli',
    envVar: CODEX_BIN_ENV,
    defaultBin: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'export CODEX_API_KEY=<your key>',
  },
  openhands: {
    id: 'openhands',
    envVar: OPENHANDS_BIN_ENV,
    defaultBin: 'openhands',
    install: 'uv tool install openhands==1.16.0 --python 3.12',
    login: 'export LLM_API_KEY=<your key>',
  },
} as Record<AgentId, AgentInfo>;

export const SUPPORTED_AGENTS: readonly AgentId[] = ['claude-code', 'cursor-cli', 'codex-cli', 'openhands'] as AgentId[];

export function agentInfo(agent: string): AgentInfo {
  const info = (AGENTS as Record<string, AgentInfo | undefined>)[agent];
  if (!info) {
    throw new Error(`unknown agent "${agent}" (supported: ${SUPPORTED_AGENTS.join(', ')})\nnext: lurekit doctor --agent ${SUPPORTED_AGENTS[0]}`);
  }
  return info;
}

// --- individual checks --------------------------------------------------------------------

export function checkNode(nodeVersion: string): Check {
  const [maj, min] = nodeVersion.split('.').map((n) => Number.parseInt(n, 10));
  const ok = maj > NODE_MIN[0] || (maj === NODE_MIN[0] && (min ?? 0) >= NODE_MIN[1]);
  return ok
    ? { id: 'node', status: 'ok', summary: `Node ${nodeVersion} (lurekit needs >= ${NODE_MIN.join('.')})` }
    : {
        id: 'node',
        status: 'fail',
        summary: `Node ${nodeVersion} is too old (lurekit needs >= ${NODE_MIN.join('.')})`,
        fix: 'nvm install 22 && nvm use 22   (or any Node >= 20.19 from nodejs.org)',
      };
}

export interface BinaryFinding {
  check: Check;
  /** Absolute real path when resolvable. */
  path?: string;
  version?: string;
}

/** Last non-empty line of a `--version` output (OpenHands prints a banner before it, NOTES). */
export function versionFromOutput(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

export function checkBinary(info: AgentInfo, probe: AgentProbe): BinaryFinding {
  const override = probe.env[info.envVar];
  const spec = override !== undefined && override !== '' ? override : info.defaultBin;
  const via = override ? `via ${info.envVar}` : `via PATH "${info.defaultBin}"`;
  const resolved = probe.resolveBinary(spec);
  if (!resolved) {
    return {
      check: override
        ? {
            id: 'binary',
            status: 'fail',
            summary: `${info.envVar}=${override} does not point to an executable file`,
            fix: `fix the path (it must be the absolute path of the ${info.id} binary) or run: unset ${info.envVar}`,
          }
        : {
            id: 'binary',
            status: 'fail',
            summary: `${info.id} binary "${info.defaultBin}" not found on PATH (and ${info.envVar} is not set)`,
            fix: info.id === 'claude-code' ? info.install : `${info.install}   (or export ${info.envVar}=<absolute path>)`,
          },
    };
  }
  const r = probe.exec(resolved, ['--version'], PROBE_TIMEOUT_MS, info.id);
  const version = r.status === 0 && !r.error ? versionFromOutput(r.stdout) : undefined;
  if (!version) {
    return {
      path: resolved,
      check: {
        id: 'binary',
        status: 'warn',
        summary: `${info.id}: ${resolved} (${via}) did not answer --version (${r.error ?? `exit ${r.status}`})`,
        fix: `${resolved} --version`,
      },
    };
  }
  return {
    path: resolved,
    version,
    check: { id: 'binary', status: 'ok', summary: `${info.id}: ${resolved} (${via}), version ${version}` },
  };
}

const NPM_GLOBAL_CLAUDE = /[\\/]lib[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/;
const NPM_GLOBAL_CLAUDE_WIN = /[\\/]npm[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/i;
const NPM_ANY_CLAUDE = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/;

/** Whether the resolved binary is replaced in place by an update (NOTES: two live batches
 *  broke when the npm-global Claude Code updated itself mid-run). */
export function checkUpdate(info: AgentInfo, bin: BinaryFinding, platform: NodeJS.Platform): Check | undefined {
  if (!bin.path) return undefined;
  const semver = bin.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? PINNED_CLAUDE_FALLBACK;
  if (info.id === 'claude-code') {
    const global = NPM_GLOBAL_CLAUDE.test(bin.path) || (platform === 'win32' && NPM_GLOBAL_CLAUDE_WIN.test(bin.path));
    if (global) {
      return {
        id: 'update',
        status: 'warn',
        summary:
          'npm-global install: Claude Code auto-updates it in place, which broke two live batches on ' +
          '2026-11-03 (spawns failed while the file was replaced; NOTES). Pin a separate install for a batch',
        fix: pinnedClaudeRecipe(semver),
      };
    }
    if (NPM_ANY_CLAUDE.test(bin.path)) {
      return {
        id: 'update',
        status: 'ok',
        summary: 'separate npm --prefix install (the pinned-install recipe NOTES verified; not the npm-global copy)',
      };
    }
    return {
      id: 'update',
      status: 'warn',
      summary: 'not an npm install; whether this install type updates itself in place is not checked',
      fix: pinnedClaudeRecipe(semver),
    };
  }
  if (info.id === 'cursor-cli') {
    return {
      id: 'update',
      status: 'warn',
      summary: 'Cursor CLI auto-updates by default and has no versioned install (NOTES); the adapter records version drift per run',
      fix: 'agent --version   (before and after a batch; compare with the agent_version_reported in evidence)',
    };
  }
  return {
    id: 'update',
    status: 'ok',
    summary: `background self-update of ${info.id} is UNVERIFIED (NOTES); the adapter records version drift per run`,
  };
}

function hasEnv(probe: AgentProbe, name: string): boolean {
  const v = probe.env[name];
  return typeof v === 'string' && v.length > 0;
}

/** Parse a JSON status output and keep ONLY the named boolean/strings (never the rest). */
function pickStatus(stdout: string, boolKey: string, methodKey?: string): { loggedIn?: boolean; method?: string } {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const out: { loggedIn?: boolean; method?: string } = {};
    if (typeof j[boolKey] === 'boolean') out.loggedIn = j[boolKey] as boolean;
    if (methodKey && typeof j[methodKey] === 'string') out.method = j[methodKey] as string;
    return out;
  } catch {
    return {};
  }
}

/** Lowest Claude Code version on which `claude auth --help` was checked to list `status`
 *  (2.1.317 and 2.1.318 on 2026-11-03, NOTES). */
export const CLAUDE_AUTH_STATUS_MIN = '2.1.317';

function semverAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((n) => Number.parseInt(n, 10));
  const b = min.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** True only for a `--version` answer of the form "<x.y.z> (Claude Code)" at or above the minimum. */
export function claudeAuthStatusVerified(version: string | undefined): boolean {
  const m = version?.match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
  return m !== null && m !== undefined && semverAtLeast(m[1], CLAUDE_AUTH_STATUS_MIN);
}

/** Authentication, without spending: each agent's own status command where one is verified
 *  (NOTES), else the presence of the API-key variable the adapter's run environment uses. */
export function checkAuth(info: AgentInfo, bin: BinaryFinding, probe: AgentProbe): Check {
  const notChecked = (cmd: string, why: string): Check => ({
    id: 'auth',
    status: 'warn',
    summary: `not checked: ${why}`,
    fix: cmd,
  });
  switch (info.id) {
    case 'claude-code': {
      if (!bin.path) return notChecked('claude auth status --text', 'no claude binary to ask');
      // Only ask a binary that reported a Claude Code version on which `auth status` is verified
      // (CLAUDE_AUTH_STATUS_MIN and later). An unknown or older binary might not have the
      // subcommand and could read "auth status" as a prompt, so it is never asked.
      if (!claudeAuthStatusVerified(bin.version)) {
        return notChecked(
          'claude auth status --text   (if `claude auth --help` lists status)',
          `${bin.path} reported ${bin.version ? `version "${bin.version}"` : 'no version'}; \`auth status\` is verified only on Claude Code >= ${CLAUDE_AUTH_STATUS_MIN}, so it was not run`,
        );
      }
      // `claude auth status --json` (2.1.318 help: "Show authentication status"): verified to
      // answer offline in well under a second, exit 0 + loggedIn:true when logged in, exit 1 +
      // loggedIn:false when not (NOTES). It starts no session and no model turn.
      const r = probe.exec(bin.path, ['auth', 'status', '--json'], PROBE_TIMEOUT_MS, 'claude-code');
      const s = pickStatus(r.stdout, 'loggedIn', 'authMethod');
      if (s.loggedIn === true) {
        return {
          id: 'auth',
          status: 'ok',
          summary: `logged in (claude auth status: authMethod=${s.method ?? 'unknown'}); a login does not prove the account can pay for -p runs`,
        };
      }
      if (s.loggedIn === false && hasEnv(probe, 'ANTHROPIC_API_KEY')) {
        // NOTES "Auth status without a session": with ANTHROPIC_API_KEY set, `auth status`
        // answered loggedIn:true (authMethod api_key) on 2.1.318; whether a `-p` run honours the
        // variable when the status says logged out is not verified, so this is a warn, not a fail.
        return {
          id: 'auth',
          status: 'warn',
          summary: 'not logged in; ANTHROPIC_API_KEY is set (UNVERIFIED whether -p honours it on this version)',
          fix: 'claude auth login   (or keep the key: only a one-scenario live smoke run shows whether it reaches -p)',
        };
      }
      if (s.loggedIn === false) {
        return {
          id: 'auth',
          status: 'fail',
          summary: 'not logged in (claude auth status: loggedIn=false)',
          fix: 'claude auth login   (or export ANTHROPIC_API_KEY=<your key>)',
        };
      }
      return notChecked('claude auth status --text', `"${bin.path} auth status --json" gave no readable answer (${r.error ?? `exit ${r.status}`}); run it yourself`);
    }
    case 'cursor-cli': {
      if (hasEnv(probe, 'CURSOR_API_KEY')) {
        return { id: 'auth', status: 'ok', summary: 'CURSOR_API_KEY is set (value not read; not validated offline)' };
      }
      if (!bin.path) return notChecked('agent status', 'no agent binary to ask');
      // `agent status --format json` (2026.10.22): {"isAuthenticated": false, ...} with no
      // login; answers offline (NOTES). It reports the login only, not CURSOR_API_KEY.
      const r = probe.exec(bin.path, ['status', '--format', 'json'], PROBE_TIMEOUT_MS, 'cursor-cli');
      const s = pickStatus(r.stdout, 'isAuthenticated');
      if (s.loggedIn === true) return { id: 'auth', status: 'ok', summary: 'logged in (agent status: isAuthenticated=true)' };
      if (s.loggedIn === false) {
        return {
          id: 'auth',
          status: 'fail',
          summary: 'not logged in (agent status: isAuthenticated=false) and CURSOR_API_KEY is not set',
          fix: 'agent login   (or export CURSOR_API_KEY=<your key>)',
        };
      }
      return notChecked('agent status', `"${bin.path} status --format json" gave no readable answer (${r.error ?? `exit ${r.status}`}); run it yourself`);
    }
    case 'codex-cli': {
      // The adapter gives every run its own CODEX_HOME, so a `codex login` session is not visible
      // to it; only CODEX_API_KEY reaches the agent (src/adapters/codexCli.ts, NOTES).
      if (hasEnv(probe, 'CODEX_API_KEY')) {
        return { id: 'auth', status: 'ok', summary: 'CODEX_API_KEY is set (value not read; not validated offline)' };
      }
      return {
        id: 'auth',
        status: 'fail',
        summary:
          'CODEX_API_KEY is not set; lurekit runs codex with a run-scoped CODEX_HOME, so a `codex login` session is not visible to the run (every run would end in 401 Unauthorized)',
        fix: 'export CODEX_API_KEY=<your key>',
      };
    }
    case 'openhands': {
      if (hasEnv(probe, 'LLM_API_KEY')) {
        return { id: 'auth', status: 'ok', summary: 'LLM_API_KEY is set (value not read; not validated offline)' };
      }
      return {
        id: 'auth',
        status: 'fail',
        summary: 'LLM_API_KEY is not set; openhands --override-with-envs stops with "Missing required environment variable(s): LLM_API_KEY" (NOTES)',
        fix: 'export LLM_API_KEY=<your key>   (for a local Ollama model any placeholder, plus LLM_BASE_URL=http://127.0.0.1:11434/v1)',
      };
    }
    default:
      return notChecked('-', `no auth check for ${info.id}`);
  }
}

/** The documented alias examples from `claude --help` (2.1.318): "Provide an alias for the latest
 *  model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name." */
export const CLAUDE_MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet'];

/** What happens to the model id. No adapter can validate it offline (NOTES). */
export function checkModel(info: AgentInfo, model: string | undefined, corpus?: string): Check {
  if (model === undefined) {
    return {
      id: 'model',
      status: 'ok',
      summary: 'no --model given; lurekit run needs one (it is pinned into the manifest)',
    };
  }
  switch (info.id) {
    case 'claude-code':
      if (CLAUDE_MODEL_ALIASES.includes(model) || /^claude-/.test(model)) {
        return { id: 'model', status: 'ok', summary: `"${model}" looks like a Claude alias or full model name (not validated offline)` };
      }
      return {
        id: 'model',
        status: 'warn',
        summary: `"${model}" is neither a documented alias (${CLAUDE_MODEL_ALIASES.join(', ')}) nor a claude-* name; what claude does with an unknown id is not verified offline (a rejected id ends each run inconclusive)`,
        fix: `lurekit run ${corpus ?? '<dir>'} --agent claude-code --model sonnet`,
      };
    case 'cursor-cli':
      return {
        id: 'model',
        status: 'ok',
        summary: `"${model}" is passed to --model unvalidated; the auth check runs first, so a bad id only shows once logged in`,
      };
    case 'codex-cli':
      return {
        id: 'model',
        status: 'ok',
        summary: `"${model}" is passed to -m unvalidated; an id unknown to codex prints "Model metadata for ... not found. Defaulting to fallback metadata" and still calls the API (NOTES)`,
      };
    case 'openhands':
      return {
        id: 'model',
        status: 'ok',
        summary: `"${model}" becomes LLM_MODEL (a LiteLLM name such as openai/<served-model>); not validated offline`,
      };
    default:
      return { id: 'model', status: 'ok', summary: `"${model}" not validated offline` };
  }
}

/** Verified by reading src/: --isolation is only copied into manifest.config.isolation
 *  (src/cli.ts buildConfig -> src/runner/runner.ts writeManifest); nothing starts or probes a
 *  container runtime. */
export function checkIsolation(): Check {
  return {
    id: 'isolation',
    status: 'ok',
    summary:
      '--isolation container|container+netns is an evidence label written to the manifest; lurekit starts no container and needs no docker/podman (run it inside your own container or VM for that boundary)',
  };
}

export function checkOpenHandsPermission(info: AgentInfo): Check | undefined {
  if (info.id !== 'openhands') return undefined;
  return {
    id: 'permission',
    status: 'warn',
    summary: 'openhands headless always approves every tool call on the host (no sandbox); lurekit refuses the run unless you say so',
    fix: 'add --permission-mode always-approve to lurekit run (and run inside your own container or VM)',
  };
}

// --- corpus / selftest ---------------------------------------------------------------------

export interface SelfTestOutcome {
  kind: DetectorKind;
  ok: boolean;
  positive?: boolean;
  negative?: boolean;
  error?: string;
}

/** Each implemented detector's positive/negative control (evidence-spec 1.3). Shared by
 *  `selftest` and `doctor`. Scratch dirs follow the selftest default (never the temp dir). */
export async function runDetectorSelfTests(): Promise<SelfTestOutcome[]> {
  const out: SelfTestOutcome[] = [];
  for (const kind of IMPLEMENTED_DETECTORS) {
    try {
      const { positive, negative } = await getDetector(kind).selfTest();
      out.push({ kind, ok: positive && negative, positive, negative });
    } catch (err) {
      out.push({ kind, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

export function checkSelfTests(results: SelfTestOutcome[]): Check {
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) {
    return { id: 'selftest', status: 'ok', summary: `${results.length} detector self-tests pass (${results.map((r) => r.kind).join(', ')})` };
  }
  return {
    id: 'selftest',
    status: 'fail',
    summary: `${bad.length} detector self-test(s) failed: ${bad.map((r) => r.kind).join(', ')}; their scenarios would be skipped`,
    fix: 'lurekit selftest',
  };
}

export function checkCorpus(
  dir: string,
  r: { missing: boolean; loaded: number; errors: number; kept: number },
  agent: AgentId,
): Check {
  if (r.missing) {
    return {
      id: 'corpus',
      status: 'fail',
      summary: `scenario directory ${dir} does not exist or holds no .yaml scenarios`,
      fix: `lurekit doctor --agent ${agent}   (no directory argument: ./scenarios if it exists, else the corpus shipped with lurekit)`,
    };
  }
  if (r.errors > 0) {
    return { id: 'corpus', status: 'fail', summary: `${r.errors} scenario file(s) in ${dir} failed to load`, fix: `lurekit validate ${dir}` };
  }
  return { id: 'corpus', status: 'ok', summary: `${r.loaded} scenarios valid in ${dir}; ${r.kept} would run for ${agent}` };
}

// --- cost estimate -------------------------------------------------------------------------

export interface CostEstimate {
  /** USD per scenario per repetition in the published run (spend / repetitions). */
  perRepUsd: number;
  model: string;
  benchmarkRunId: string;
}

/** Per-repetition cost from a published run of the SAME agent (the demo bundle, ADR-0021).
 *  Undefined for any other agent: there is no published run to derive it from. */
export function costBasis(agent: AgentId, published: RunManifest | undefined): CostEstimate | undefined {
  if (!published || published.profile.agent !== agent) return undefined;
  const reps = published.results.reduce((n, r) => n + r.runs, 0);
  if (reps <= 0 || !(published.totals.spend_usd > 0)) return undefined;
  return { perRepUsd: published.totals.spend_usd / reps, model: published.profile.model, benchmarkRunId: published.benchmark_run_id };
}

export function usd(n: number): string {
  return n.toFixed(2);
}

/** "about X USD for smoke (k=1), about Y USD for full (k=3) on sonnet, from a published run;
 *  other models differ", or the no-estimate sentence. */
export function estimateSentence(agent: AgentId, kept: number, basis: CostEstimate | undefined): string {
  // ADR-0022 amendment (block 3): the s3.3 per-run estimate charged against --budget.
  if (!basis) return `no published run yet for ${agent}, no estimate; each repetition is charged an estimated ${estimatedRunUsd(agent)} USD against --budget`;
  return (
    `about ${usd(kept * basis.perRepUsd)} USD for smoke (k=1), about ${usd(kept * 3 * basis.perRepUsd)} USD for full (k=3) ` +
    `on ${basis.model}, from a published run; other models differ ` +
    `(${kept} scenario(s) x ${basis.perRepUsd.toFixed(3)} USD per scenario-repetition in ${basis.benchmarkRunId}, the agent's client-side estimate)`
  );
}

/** Estimate for one concrete run (scenarios x k), same basis. */
export function runEstimateSentence(agent: AgentId, kept: number, k: number, basis: CostEstimate | undefined): string {
  // ADR-0022 amendment (block 3): the s3.3 per-run estimate charged against --budget.
  if (!basis) return `unknown for ${agent} (no published run); each repetition is charged an estimated ${estimatedRunUsd(agent)} USD against --budget`;
  return (
    `about ${usd(kept * k * basis.perRepUsd)} USD (${kept} scenario(s) x k=${k} x ${basis.perRepUsd.toFixed(3)} USD) ` +
    `on ${basis.model}, from a published run; other models differ`
  );
}

// --- rendering -----------------------------------------------------------------------------

export interface DoctorReport {
  agent: AgentId;
  model: string | null;
  checks: Check[];
  estimate: { smoke_usd: number; full_usd: number; model: string; source: string; scenarios: number } | null;
  fail: number;
  warn: number;
}

export function summarize(agent: AgentId, model: string | undefined, checks: Check[], kept: number, basis: CostEstimate | undefined): DoctorReport {
  return {
    agent,
    model: model ?? null,
    checks,
    estimate: basis
      ? {
          smoke_usd: Number(usd(kept * basis.perRepUsd)),
          full_usd: Number(usd(kept * 3 * basis.perRepUsd)),
          model: basis.model,
          source: basis.benchmarkRunId,
          scenarios: kept,
        }
      : null,
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
  };
}

export function renderChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.status.padEnd(5)} ${c.id.padEnd(11)} ${c.summary}`);
    if (c.status !== 'ok' && c.fix) lines.push(`${' '.repeat(18)}fix: ${c.fix}`);
  }
  return lines.join('\n') + '\n';
}

/** `corpus` is the resolved scenario directory as the user should type it (ADR-0022 amendment):
 *  the Next line carries every known value; only a value doctor cannot know stays as <...>. */
export function renderDoctor(r: DoctorReport, corpus?: string): string {
  const head = `lurekit doctor: agent ${r.agent}${r.model ? `, model ${r.model}` : ''}\n\n`;
  const next = `lurekit run ${corpus ?? '<dir>'} --agent ${r.agent} --model ${r.model ?? '<id>'}`;
  const tail =
    `\n${r.fail} fail, ${r.warn} warn. ` +
    (r.fail > 0 ? `Fix the fail lines before a live run. Then: ${next}\n` : `Next: ${next} (asks before it spends).\n`);
  return head + renderChecks(r.checks) + tail;
}
