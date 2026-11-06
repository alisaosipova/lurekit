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
config, auth, hook trust and history. UNVERIFIED (as of 2026-11-02; `--version` output was
verified 2026-11-03, see the amendment): exact `--version` output, background
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
   `turn.failed`, `error` events and `error` items become warnings verbatim, except transient
   `Reconnecting... n/max (...)` error events, which are counted into one warning (amendment
   2026-11-03); exit 0 without `turn.completed` is a warning. stdout is decoded with a streaming UTF-8 decoder.
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
   no `.git` entry (exec exits 1 unless the git check is skipped; or, when an ancestor is a git
   repository, that the git check passes and the project root lies above the workdir) and a present project
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

## Amendment 2026-11-03: checked against the installed binary
Checked on this host against `codex-cli 0.166.0` (`codex --version` prints `codex-cli 0.166.0`,
`codex exec --version` prints `codex-cli-exec 0.166.0`), its `codex --help` / `codex exec
--help` and runs without credentials. Facts in NOTES section Codex CLI ("Verified on the installed
binary").
- Every flag the adapter emits (`exec`, `--json`, `-C`, `-m`, `--sandbox
  read-only|workspace-write|danger-full-access`, `--approve-for-me`,
  `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`,
  `--dangerously-bypass-hook-trust`) is listed in `codex exec --help` with the same values.
  `-a, --ask-for-approval` is listed for the top-level (TUI) command only, not for `exec`,
  which confirms the refusal of an `approval=` token. No mismatch; the grammar is unchanged.
- `--` ends option parsing for exec (`codex exec "--bogus-flag"` -> `error: unexpected
  argument`; `codex exec -- "--bogus-flag"` starts a thread). The adapter still refuses a task
  starting with `-` (behaviour kept).
- `CODEX_HOME` must exist: a missing directory fails before any JSON with `Error finding codex
  home: CODEX_HOME points to "<path>", but that path does not exist` (exit 1). The adapter
  already creates `<runDir>/codex-home` before the spawn; the binary fills it (sqlite state,
  sessions, `installation_id`). It is under runDir and is never published (ADR-0017 copies
  evidence only).
- Without credentials the stream is `thread.started`, `turn.started`, four `error` events
  `Reconnecting... 2/5..5/5 (unexpected status 401 Unauthorized: Missing bearer or basic
  authentication in header, url: wss://...)`, an `error` item "Falling back from WebSockets to
  HTTPS transport...", five more `Reconnecting... 1/5..5/5` over https, a final `error` event
  and `turn.failed` with the same 401 text; exit 1 after about 27 to 55 s (a model id
  unknown to the local metadata, e.g. `o3`, adds one more `error` item before `turn.started`). Decision: the retry
  events are collapsed into one warning (count plus last message); any 401 adds the warning
  `agent authentication failed: the model API answered 401 Unauthorized (...)`; a non-zero exit
  with no failure in the stream adds a stderr excerpt (`agent exited N; stderr: ...`). The run
  is scored `inconclusive(adapter_error)` (evidence-spec s3.1 rule 2).
- The 401 messages name `api.openai.com`, so `lurekit publish` refuses such a run unless the
  operator passes `--allow-host api.openai.com` (the gate works as designed; the warning text is
  kept verbatim rather than rewritten).
- Git check: a workdir without `.git` nested inside a git repository (the default
  `<results>/<run>/...` layout inside a checkout) passes the git check without
  `--skip-git-repo-check`, because the root is found upward. The adapter now warns with the
  ancestor path instead of claiming exec will exit 1.
- The evidence record now carries `observation.agent_version_reported` (evidence-spec s4.4b).


## Amendment (2026-11-06, LV-4): `--settings` for codex-cli as `-c` config overrides

Context: the first live codex-cli run (0.166.0, 2026-11-06) went through an OpenAI-compatible
endpoint that has no Responses WebSocket. `OPENAI_BASE_URL` alone failed ("failed to connect to
Responses WebSocket", five reconnects); a custom provider (`model_provider`,
`model_providers.<id>.{name,base_url,env_key,wire_api="responses"}`) worked over HTTP. The
adapter offered no way to pass it, so the run had to share one operator `CODEX_HOME`
(`profile.env.CODEX_HOME`), which loses the run-scoped home (Decision 4). See
`docs/plan/live-validation-2026-11-06.md` LV-4.

Decision:

1. `--settings <file.json>` (and a profile's `settings`) is accepted for `codex-cli`. The body is
   a JSON object of Codex config keys. Nested objects are flattened to dotted keys
   (`{"model_providers":{"p":{"base_url":"…"}}}` -> `model_providers.p.base_url`). Each leaf
   becomes one `-c <dotted.key>=<value>` pair placed after `-m <model>` and before the
   permission flags; the value is rendered as TOML: a string as a JSON string (a valid TOML basic
   string), a finite number or a boolean as is, an array of strings/numbers/booleans as a TOML
   inline array. Keys are emitted in sorted order, so the argv is deterministic.
2. Refused before spawning (throw), so a settings file can never loosen the run or smuggle a
   secret: a key whose first segment is `approval_policy`, `sandbox_mode`,
   `sandbox_workspace_write`, `shell_environment_policy`, `hooks`, `mcp_servers`, `profile`,
   `profiles` or `notify` (permissions, sandbox, environment and code that runs go through
   `permission_mode`, `--mcp` or nowhere); a null, nested array or object array value; a key
   segment outside `[A-Za-z0-9_-]`; a string value that the publish gate's credential shapes
   would flag (a key is passed by name, e.g. `env_key = "CODEX_API_KEY"`, with the value in the
   environment via `--env`).
3. The run keeps its run-scoped `CODEX_HOME`. Evidence records the settings digest as for
   Claude Code (`profile.settings_digest`); `agent_flags` records `-c` without its value
   (`codexFlagNames`), and `observation.forwarded_settings` lists the dotted keys (no values).
4. `--hooks` stays claude-code only (ADR-0020); the CLI guard in `src/cli.ts` admits `settings`
   for `claude-code` and `codex-cli` only.

Consequences: a third-party or self-hosted OpenAI-compatible provider is a settings file plus
`--env <KEY_NAME>`; the provider's base URL is a published value of the run (it is in the
settings body and its digest), so `publish` applies its URL rule to it as for any evidence.

Test plan: argv for a nested provider file (sorted, flattened, TOML-rendered, before
`--sandbox`); each refused key class and value shape throws before spawn; `codexFlagNames`
drops the values; the CLI accepts `--settings` with `--agent codex-cli` and still refuses it
for cursor-cli and openhands; a stub run records `forwarded_settings` keys and keeps
`CODEX_HOME` run-scoped (no `profile.env sets CODEX_HOME` warning).

Review amendment (2026-11-06, same block): Decision 2's deny list was not enough. Codex 0.166.0
also loosens a run through `default_permissions = ":danger-full-access"`, `permissions.<name>`
and `approvals_reviewer` (verified live: the exec default `sandbox: read-only` became
`danger-full-access`, `approval: never` became `on-request`). Decision 2 is replaced by an
allow list of first segments: `model`, `model_provider`, `model_providers`,
`model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `model_context_window`,
`model_auto_compact_token_limit`, `request_max_retries`, `stream_max_retries`,
`stream_idle_timeout_ms` (`CODEX_ALLOWED_SETTINGS_ROOTS` in `src/adapters/codexCli.ts`); any
other first segment is refused. Also refused: `model_providers.<id>.http_headers`,
`.query_params` and `.experimental_bearer_token` (literal credentials; use `env_key` or
`env_http_headers`), a credential-shaped key segment, a string with DEL or a lone surrogate (no
TOML form), and an integer beyond 2^53.
