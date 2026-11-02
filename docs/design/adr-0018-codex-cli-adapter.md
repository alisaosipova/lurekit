# ADR-0018: Codex CLI adapter

Status: proposed, implemented for the stream layer (2026-11-02); awaiting maintainer approval.
Authorises `src/adapters/codexCli.ts`, `test/fixtures/agents/stub-codex.mjs`,
`test/codex-adapter.test.ts` and the `codex-cli` branch of `CliDeps.adapterFor` in
`src/cli.ts`. Facts and URLs: `NOTES-verified-facts.md` § Codex CLI (checked 2026-11-02, no
local `codex` binary; docs, `openai/codex` source at `18c6dbe5` and the releases API).
Builds on evidence-spec §4.1 (adapter invariants), §4.3 (agent_flags), §4.5 (determinism),
ADR-0015 and ADR-0016 (the Cursor adapter, whose structure this mirrors).

## Context
`codex exec` is the documented headless mode. With `--json` it prints JSONL events
(`thread.started`, `turn.started`, `turn.completed` with `usage`, `turn.failed`,
`item.started|updated|completed`, `error`). Tool use appears as typed items:
`command_execution`, `file_change` (completed only, paths and kinds), `mcp_tool_call`,
`web_search`; `collab_tool_call` exists only in source. The stream has no model field and no
USD cost. exec defaults to a read-only sandbox with approvals set to never, and exits 1 outside
a git repository unless `--skip-git-repo-check` or `--yolo` is passed. `CODEX_HOME` holds user
config, auth, hook trust and history. UNVERIFIED: exact `--version` output, background
self-update, exec behaviour for a project with no trust entry, whether trust gates AGENTS.md,
whether hooks fire under exec, `item.id == tool_use_id`, rollout file path/format.
`SetupProfile` has one `permission_mode` string; Codex has several permission flags.

## Options
1. **Stream + hook adapter now.** Rejected: hooks under exec are UNVERIFIED, and installing a
   trusted hook needs either `--dangerously-bypass-hook-trust` (which also un-gates
   fixture-planted hooks and so changes what is measured) or a trust record of unverified format.
2. **Stream-only adapter, permission flags as a token grammar in `permission_mode`** (as
   ADR-0016). No `SetupProfile` change.
3. **Typed Codex fields on `SetupProfile`.** Widens the shared interface for one agent.

## Decision
Option 2.

1. Argv: `codex exec --json -C <workdir> -m <model> [permission flags] <task>`, cwd = workdir.
   `permission_mode` tokens (comma/whitespace separated), one flag each:
   `sandbox=read-only|workspace-write|danger-full-access` -> `--sandbox`;
   `approve-for-me` -> `--approve-for-me`;
   `yolo` | `dangerously-bypass-approvals-and-sandbox` ->
   `--dangerously-bypass-approvals-and-sandbox`; `skip-git-repo-check` ->
   `--skip-git-repo-check`; `bypass-hook-trust` -> `--dangerously-bypass-hook-trust`. Unknown
   tokens, bad values and conflicts throw before spawning: `approve-for-me` with `sandbox=` or
   `yolo` (documented conflict), and `yolo` with `sandbox=` (ambiguous). There is no `approval=`
   token: `--ask-for-approval` is declared only in the TUI parser and exec does not inherit it
   (NOTES, source at `18c6dbe5`), so it is refused rather than emitted. The adapter
   adds none of these itself, so an unset `permission_mode` runs exec's documented default
   (read-only sandbox). The retired `--full-auto` is not accepted. The prompt is positional and
   `-` means stdin, so a task starting with `-` throws; `--` is not relied on (undocumented for
   exec). A task equal to an exec subcommand name (`resume`, `fork`, `review`) also throws, since
   it would select the subcommand. stdin is not piped (`ignore`), so no `<stdin>` block is
   appended to the prompt.
2. `capabilities()` = `{headless:true, observes:['stream'], can_pin_version:false,
   can_pin_model:true}`. Versioned releases exist, but the adapter installs nothing and
   background self-update is UNVERIFIED, so it does not claim a version pin; `--version` is
   probed before and after the run (15 s bound each), recorded raw, and a mismatch with a
   non-`unpinned` `agent_version` or drift between probes is a warning.
3. Model: pinned on input with `-m`. The stream echoes no model, so `effective_model` stays
   undefined and every run carries one warning saying so (by design, until the hook layer or a
   rollout file supplies the resolved model).
4. Isolation: `CODEX_HOME` is set to `<runDir>/codex-home` (created empty) so user config, hook
   trust, history and saved auth do not leak in. A `CODEX_HOME` in `profile.env` wins and is
   warned; constructor `isolateCodexHome: false` inherits the operator's home and is warned.
   With a run-scoped home and no `CODEX_API_KEY` in the environment, a warning names the
   variable (never its value). This writes only under runDir, never into the workdir.
5. Stream parsing: `item.*` events merge into one `ToolCall` per `item.id` (first sighting's
   time, latest input). Name/input: `command_execution` {command}; `file_change` {changes};
   `mcp_tool_call` name = `tool`, input {server, tool, arguments}; `web_search` {query}.
   `agent_message`, `reasoning`, `todo_list` and `error` items are not tool calls. Any other item
   type keeps the whole item as input under name `unknown` (never dropped). `turn.completed.usage`
   is summed in the parse state (five documented token fields); `cost_usd` stays undefined.
   `turn.failed`, `error` events and `error` items become warnings verbatim; exit 0 without
   `turn.completed` is a warning. stdout is decoded with a streaming UTF-8 decoder.
6. Hooks: not installed, `hook` not declared, until a recorded run (ADR-0015) shows hooks firing
   under exec and settles the trust path. A profile token `bypass-hook-trust` is passed through
   with a warning that it changes what is measured.
7. Attempts: `[]`. No permission-denial record is verified in the stream; a failed
   `command_execution` is not a gate denial.
8. Evidence in runDir: `codex-stream.jsonl` (stdout verbatim, `raw_events_path`),
   `codex-stderr.log` (stderr verbatim; exec writes progress there), `codex-argv.json`.
   `agent_flags` lists option names in argv order without values (§4.3); since Codex has no
   `--strict-mcp-config`, the runner records such runs as `isolation: "partial"`, which is
   accurate (a project `.codex/` layer may add MCP servers). The runner's accompanying warning
   text names the Claude Code flag and `strict_mcp_config:false`; for Codex read it as "no
   strict MCP isolation exists" (the runner is not edited here).
9. Observe, do not steer: nothing is written into the workdir. Warnings record a workdir with
   no `.git` entry (exec exits 1 unless the git check is skipped) and a present project
   `.codex/` layer (load behaviour without a trust entry is UNVERIFIED). `--bare` is ignored
   with a warning.
10. Binary: constructor `bin` > env `AAB_CODEX_BIN` > `codex` on PATH. Tests use an offline stub
    emitting only the verified shapes. `observeCodexRun` is the exported pure parse step for a
    future Codex replay.

## Consequences
- Verdicts still come from the fixtures' effect sensors; the stream is attribution evidence.
- Every Codex run carries the model-echo warning; a clean run carries only that one.
- No cost accounting; `--budget` cannot be enforced from adapter data. Token totals exist in
  the parse state but have no `RunObservation` field yet.
- Trust-gated scenarios (project `.codex/config.toml`, project hooks, possibly AGENTS.md) stay
  `headless_fidelity: reduced` until a recording settles exec's handling of untrusted projects.
- Open (DECISION NEEDED): one maintainer recording of a real `codex exec --json` run to settle
  `--version` format, hooks under exec, `item.id` vs `tool_use_id`, and the resolved model; then
  a follow-up ADR may add the `hook` layer and a token-usage field.
- `BOOTSTRAP.md` and the `architecture.md` ADR index should list ADR-0018 (not edited here).
- AAB-004's `codex_mcp_config` fixture plants only `.codex/config.toml`, with no `.git`. Under
  exec's git check, such a run exits 1 before any session unless the profile names
  `skip-git-repo-check`, and the adapter warns about it. Whether the fixture should create a
  git repo is a fixture decision (not edited here).
- The run-scoped `CODEX_HOME` is set in the process env. A fixture that instead plants a
  project `.env` naming `CODEX_HOME` (the CVE-2025-61260 path) may be masked by it, because
  whether the project `.env` overrides an already-set variable is UNVERIFIED. Such a scenario
  should run with `isolateCodexHome: false` or a recorded check.
