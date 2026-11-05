// Child-process environment allow-list (ADR-0008 amendment "Child env allow-list";
// evidence-spec s4.3 `env_forwarded`). Agents, MCP fixture servers and detector children never
// inherit the whole operator environment: only the names below pass from process.env, plus the
// variables the operator declared in profile.env (values of those are the operator's choice).
// The forwarded NAMES are recorded per repetition, never the values.

import { createHash } from 'node:crypto';

import type { AgentId } from '../scenario/types.js';

/** A set of environment variable names: exact names and name prefixes. Matching ignores case, so
 *  Windows spellings (`Path`, `SystemRoot`, `ComSpec`) match too. */
export interface EnvAllow {
  names?: readonly string[];
  prefixes?: readonly string[];
}

/** What every child gets from the parent environment: the process basics (search path, home,
 *  temp dirs, locale, terminal, shell, user name for keychain-backed logins), the Windows process
 *  basics, the Node.js runtime knobs a node-based child (agent CLI, test stub) needs, and the
 *  harness's own AAB_* variables. Nothing credential-shaped. */
export const BASE_ENV_ALLOW: EnvAllow = {
  names: [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'USERNAME',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_NO_WARNINGS',
  ],
  prefixes: ['LC_', 'AAB_'],
};

/** Each agent's own auth/config variables (ADR-0008 amendment; NOTES): forwarded to that agent
 *  only. */
export const AGENT_ENV_ALLOW: Readonly<Record<AgentId, EnvAllow>> = {
  'claude-code': { names: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'DISABLE_AUTOUPDATER'], prefixes: ['CLAUDE_'] },
  'cursor-cli': { names: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT'] },
  'codex-cli': { names: ['CODEX_API_KEY', 'CODEX_HOME'] },
  openhands: { names: ['LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL'], prefixes: ['OPENHANDS_'] },
};

/** Forwarded names whose values are published facts or infrastructure addresses, not secrets
 *  (ADR-0017 block B12 amendment "Operator values"): the publish gate's operator-value check
 *  (`env_value`) skips them. URLs and paths among them are judged by the url/host/home rules
 *  instead. Maintained next to the allow-lists above: a name added to BASE_ENV_ALLOW is a
 *  process basic and is skipped by the check without being listed here. */
export const ENV_VALUE_EXEMPT: readonly string[] = [
  'ANTHROPIC_BASE_URL', 'LLM_BASE_URL', 'LLM_MODEL', 'CURSOR_API_ENDPOINT', 'CODEX_HOME', 'DISABLE_AUTOUPDATER',
];

/** Whether `name` is a process basic (BASE_ENV_ALLOW name or prefix; case-insensitive). */
export function isBasicEnvName(name: string): boolean {
  return allowed(name, [BASE_ENV_ALLOW]);
}

function allowed(name: string, allow: readonly EnvAllow[]): boolean {
  const up = name.toUpperCase();
  return allow.some((a) => (a.names ?? []).includes(up) || (a.prefixes ?? []).some((p) => up.startsWith(p)));
}

/** The env for a child: the allowed names from `base`, then every `declared` entry (profile.env,
 *  operator-declared, always wins). Pure. */
export function filterEnv(
  base: NodeJS.ProcessEnv,
  allow: readonly EnvAllow[],
  declared: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && allowed(k, allow)) env[k] = v;
  }
  for (const [k, v] of Object.entries(declared)) env[k] = v;
  return env;
}

/** The agent child env: BASE_ENV_ALLOW + the agent's own AGENT_ENV_ALLOW names from `base`
 *  (default process.env), plus profile.env. Pure. */
export function agentChildEnv(
  agent: AgentId,
  profileEnv: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return filterEnv(base, [BASE_ENV_ALLOW, AGENT_ENV_ALLOW[agent]], profileEnv ?? {});
}

/** A harness child env (MCP fixture server, detector child): BASE_ENV_ALLOW from `base` plus
 *  the harness's own `extra` values. No agent credential ever reaches these. Pure. */
export function harnessChildEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return filterEnv(base, [BASE_ENV_ALLOW], extra);
}

/** The names a child env carries, sorted (observation.env_forwarded). Never the values. */
export function envNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => env[k] !== undefined).sort();
}

/** Bytes of a child's stderr kept in a run-dir file (ADR-0008 amendment "Bounded stderr"). */
export const STDERR_FILE_MAX = 1024 * 1024;

/** Collects a child's stderr up to `max` bytes; past that only the count is kept. */
export class CappedStderr {
  private chunks: Buffer[] = [];
  private kept = 0;
  private dropped = 0;
  constructor(private readonly max: number = STDERR_FILE_MAX) {}
  push(buf: Buffer): void {
    const room = this.max - this.kept;
    if (room > 0) {
      const part = buf.length <= room ? buf : buf.subarray(0, room);
      this.chunks.push(part);
      this.kept += part.length;
    }
    if (buf.length > room) this.dropped += buf.length - Math.max(room, 0);
  }
  /** The kept bytes (no marker): what stderr excerpts are taken from. */
  head(): Buffer {
    return Buffer.concat(this.chunks);
  }
  /** The file content: the kept bytes, plus a truncation marker line when anything was dropped. */
  fileContent(): Buffer {
    const head = this.head();
    if (this.dropped === 0) return head;
    return Buffer.concat([head, Buffer.from(`\n${stderrTruncationMarker(this.max, this.dropped)}\n`, 'utf8')]);
  }
  get truncatedBytes(): number {
    return this.dropped;
  }
}

/** The marker line appended to a capped stderr file. */
export function stderrTruncationMarker(max: number, dropped: number): string {
  return `[lurekit: stderr truncated at ${max} bytes; ${dropped} more bytes dropped]`;
}

/** The *-argv.json record: the argv with the task text replaced by its digest
 *  (`<task sha256:HEX>`, the same value as evidence.json `task_sha256`), so the run dir does not
 *  keep a second verbatim copy of the task next to the evidence. Pure. */
export function argvRecord(bin: string, argv: readonly string[], task: string): string[] {
  const marker = `<task sha256:${createHash('sha256').update(task, 'utf8').digest('hex')}>`;
  return [bin, ...argv.map((a) => (a === task ? marker : a.includes(task) && task.length > 0 ? a.split(task).join(marker) : a))];
}
