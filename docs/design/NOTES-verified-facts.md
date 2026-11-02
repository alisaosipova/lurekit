# Verified facts for the architecture (working notes)

Collected 2026-11-01 from primary documentation while preparing `architecture.md` and `evidence-spec.md`. Each line carries the URL it was read from. UNVERIFIED = the page does not say. These notes feed the ADRs; they are not a deliverable.

## mcp-review-check (reuse candidate)
- CI matrix: ubuntu-latest, macos-latest, windows-latest × Node 20.19 / 22 / 24. Source: local checkout `.github/workflows/ci.yml` and https://raw.githubusercontent.com/alisaosipova/mcp-review-check/main/.github/workflows/ci.yml
- Release: npm trusted publishing (OIDC), build job without write permissions, actions pinned by SHA, `npm audit --omit=dev`. Source: `.github/workflows/release.yml` in the checkout.
- Runtime deps: `@modelcontextprotocol/sdk ~1.32.1`, `ajv`, `zod`. Source: `package.json`.
- Reusable code: `src/protocol/*` (stdio / Streamable HTTP / legacy SSE client), `src/report/{json,markdown,sarif}.ts`, `test/fixtures/*-server.mjs` (compliant, rule-breaking, leaky, modern-protocol servers, HTTP bridge, OAuth metadata).

## Claude Code
- `claude -p` shows no trust dialog and still runs the project's `.claude/settings.json` hooks and connects `.mcp.json` servers. `--bare` skips that config and "will become the default for `-p`". Manual permission mode is the default for `-p` since v2.1.302. `--output-format json` includes `total_cost_usd` ("client-side estimate"); `stream-json` requires `--verbose`; `system/init` reports model and `mcp_servers`. Source: https://code.claude.com/docs/en/headless
- Consequence: trust-prompt scenarios (AAB-001, AAB-002) cannot be measured headless as disclosed.
- Hooks: every event receives `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. `PreToolUse` / `PostToolUse` carry `tool_use_id`; `PostToolUse` adds `duration_ms`; exit code 2 blocks the call; `PostToolUse` fires concurrently for parallel tool calls. Source: https://code.claude.com/docs/en/hooks
- Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`; format "internal to Claude Code and changes between versions"; 30-day retention. Source: https://code.claude.com/docs/en/sessions.md
- WebSearch runs on Anthropic's backend, so a local fixture page cannot enter its results. Source: https://code.claude.com/docs/en/tools-reference.md

## Cursor CLI
Re-checked 2026-11-02 against the official docs and changelog. This replaces the three-line stub from 2026-11-01; its facts are kept below. Every line was checked on 2026-11-02 at the URL given. Changelog lines are condensed, and text in quotes is copied word for word. Latest changelog entry seen: v2026.10.22 (the page gives no date for it).

**Binary, install, version**
- Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux/WSL); `irm 'https://cursor.com/install?win32=true' | iex` (Windows). Every example calls the binary `agent`; the page never names it in so many words. `agent --version` shows the version; `agent update` updates by hand; "Cursor CLI will try to auto-update by default". Source: https://cursor.com/docs/cli/installation
- No documented way to install or pin a specific version. Sources: https://cursor.com/docs/cli/installation, https://cursor.com/docs/cli/reference/parameters
- `-v, --version` shows the version. `about` shows "version, system, and account info", and `--format json` gives machine-readable output (a JSON option for `status`/`about` arrived in the April 2026 changelog). The JSON fields of `about` are UNVERIFIED. Sources: https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/changelog
- Auto-update off: "`--disable-auto-update` turns background updates off." (changelog, January 2026). This flag does not appear on the current parameters page, so whether it still exists today is UNVERIFIED. The config key `channel` is the "Release channel used for CLI updates"; no `autoUpdate` config key is documented. Sources: https://cursor.com/docs/cli/changelog, https://cursor.com/docs/cli/reference/configuration
- The legacy binary name `cursor-agent` is UNVERIFIED: the current docs do not mention it. The changelog (v2026.06.22) says only that a "`cursor` shim" was fixed.

**Headless / print mode**
- `-p, --print`: "Non-interactive output for scripts; has access to write and shell tools". Without `--force`, "changes are only proposed, not applied". `-f, --force` means "Allow commands unless explicitly denied"; `--yolo` is an alias. Auth in scripts: `CURSOR_API_KEY` or `--api-key <key>`. Sources: https://cursor.com/docs/cli/headless, https://cursor.com/docs/cli/reference/parameters
- Trust: `--trust` means "Trust the workspace without prompting (headless mode only)" on the parameters page. The changelog adds: "Non-interactive runs in untrusted workspaces fail with guidance unless `--trust` (or `--force`) is passed." (January 2026). It also says `--trust` works in interactive sessions since v2026.07.20, which contradicts the parameters page. Sources: https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/changelog
- Other headless items in the changelog: admins can disable headless mode org-wide (v2026.06.09); headless runs wait for MCP tools (May 14, 2026) and for subagents (v2026.08.11). Source: https://cursor.com/docs/cli/changelog

**Working directory, mode, permissions, sandbox**
- `--workspace <path>` "Set the workspace directory". `--mode <mode>` takes `plan` or `ask`, and agent mode is the default. `--sandbox <mode>` takes `enabled` or `disabled`. `--approve-mcps` means "Automatically approve all MCP servers". Source: https://cursor.com/docs/cli/reference/parameters
- Permissions: `~/.cursor/cli-config.json` (global) or `<project>/.cursor/cli.json`. The tokens are `Shell(commandBase)`, `Read(pathOrGlob)`, `Write(pathOrGlob)`, `WebFetch(domainOrPattern)` and `Mcp(server:tool)`. "Deny rules take precedence over allow rules." The page does not state the print-mode default without `--force` (UNVERIFIED beyond the headless page's "only proposed"). Source: https://cursor.com/docs/cli/reference/permissions
- Config: `approvalMode` takes `allowlist`, `auto-review` or `unrestricted`. Other keys: `sandbox.mode`, `sandbox.networkAccess` and `sandbox.readBoundary` (`system` default or `workspace`). "Only permissions can be configured at the project level." "Some fields are CLI-managed and may be overwritten." The config directory can be moved with `CURSOR_CONFIG_DIR` (or `$XDG_CONFIG_HOME/cursor/`). Source: https://cursor.com/docs/cli/reference/configuration
- `--auto-review` run mode arrived in v2026.06.22. The mapping from `--force`, `approvalMode` and `--sandbox` to the `permissionMode` value in `system/init` is UNVERIFIED. Source: https://cursor.com/docs/cli/changelog

**Model**
- `--model <model>` "Choose the model"; `--list-models` and `agent models` list models. The changelog says "`--model` and `/model` now run the model you choose" even when IDs share a prefix (v2026.09.28). New installs default to Auto (v2026.07.06). A model blocked by team policy makes `--model` exit with a message (v2026.08.26). Sources: https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/changelog
- The `system/init` event reports `model` as a "<model display name>" (example "Claude 4 Sonnet"), not as an ID. Hook input carries `model` plus an optional `model_id`. So an exact echo of the pinned ID back into the stream is UNVERIFIED. Sources: https://cursor.com/docs/cli/reference/output-format, https://cursor.com/docs/agent/hooks

**Output formats and event shapes**
- `--output-format` takes `text` (default), `json` or `stream-json` (requires `--print`); `--stream-partial-output` streams text deltas. `json` emits "a single JSON object (followed by a newline) when the run completes successfully", with fields `type:"result"`, `subtype:"success"`, `is_error`, `duration_ms`, `duration_api_ms`, `result`, `session_id` and an optional `request_id`. On failure the process exits non-zero, writes to stderr, and "No well-formed JSON object is emitted in failure cases." Source: https://cursor.com/docs/cli/reference/output-format
- `stream-json` is NDJSON. Events:
  - `system/init`: `apiKeySource`, `cwd`, `session_id`, `model`, `permissionMode`.
  - `user`: carries `message`.
  - `assistant`: "once per complete assistant message (between tool calls)".
  - `tool_call` with `subtype` `started`/`completed`: carries `call_id`, `tool_call` and `session_id`. "Tool call IDs can be used to correlate start/completion events."
  - `result`.

  Source: https://cursor.com/docs/cli/reference/output-format
- Tool shapes. Documented: `readToolCall` (args `path`; result under `result.success`) and `writeToolCall` (args `path`, `fileText`, `toolCallId`). Other tools "May use `tool_call.function` structure" with `name`/`arguments`. Shell and MCP tool-call shapes are UNVERIFIED (not documented). Unknown fields must be ignored, and `tools`/`mcp_servers` "may be added" to init. `thinking` events are suppressed in print mode. Source: https://cursor.com/docs/cli/reference/output-format
- Cost: the output-format page documents no USD cost and no token fields. The changelog (February 2026) adds "Per-turn input/output/cache token totals and a `request_id` in `stream-json` output", but the field names are UNVERIFIED. Sources: https://cursor.com/docs/cli/reference/output-format, https://cursor.com/docs/cli/changelog
- Transcripts: "headless transcripts write Claude Code-compatible JSONL" (changelog, February 2026). The path and the schema are UNVERIFIED. Hooks receive `transcript_path`. Sources: https://cursor.com/docs/cli/changelog, https://cursor.com/docs/agent/hooks

**Hooks (observe-only candidate)**
- Config: enterprise `/etc/cursor/hooks.json` (Linux), project `<root>/.cursor/hooks.json`, user `~/.cursor/hooks.json`. Priority is Enterprise > Team > Project > User. Source: https://cursor.com/docs/agent/hooks
- Agent events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. Source: https://cursor.com/docs/agent/hooks
- Every hook receives `conversation_id`, `generation_id`, `model`, optional `model_id`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email` and `transcript_path`. `tool_use_id` appears only on `preToolUse`, `postToolUse` and `postToolUseFailure`. Exit code 0 means the JSON output is used; exit 2 blocks; any other code fails open unless `failClosed`. Invalid JSON from a permission hook blocks even without `failClosed`. Source: https://cursor.com/docs/agent/hooks
- CLI coverage. The hooks page says only that `workspaceOpen` "Runs in the Cursor desktop app and CLI". The changelog says "Claude Code `settings.json` hooks are read and merged" (January 2026) and "`afterAgentThought`/`afterAgentResponse` events emit in the CLI" (April 2026). Plugin hooks execute (v2026.08.11). Whether hooks fire under `agent -p` is still UNVERIFIED: no primary page says so. Community forum threads report gaps (for example "cursor-agent CLI never invokes hooks.json on Linux"); those threads are not primary sources and are not relied on. Sources: https://cursor.com/docs/agent/hooks, https://cursor.com/docs/cli/changelog
- Since Claude Code `settings.json` hooks are read and merged, a project's `.claude/settings.json` can execute under Cursor CLI. Which paths are read, and whether trust gates them, is UNVERIFIED. Source: https://cursor.com/docs/cli/changelog

**MCP**
- The CLI "follows the same configuration precedence as the editor (project → global → nested), automatically discovering configurations from parent directories". `agent mcp enable <id>` adds a server to the local approved list. `--approve-mcps` "Auto-approve[s] all MCP servers (skip approval prompts)". The page does not say how `--approve-mcps` behaves under `-p` (UNVERIFIED). Source: https://cursor.com/docs/cli/mcp

**Adapter implications**
- Can pin: the model, via `--model <id>`. The pin is enforced on input, but the echo is only a display name in `system/init` plus `model`/`model_id` in hook input, so the adapter records the requested ID and the reported name and warns if they don't match. Mode is pinned via `--mode`, `--force` (or its absence) and `--sandbox`. Workspace is pinned via `--workspace` and the process cwd. `--approve-mcps` and `--trust` are profile fields the adapter passes through verbatim. Under evidence-spec §4.1, the adapter never adds `--trust`, `--force` or `--approve-mcps` on its own.
- Cannot pin the version: no documented versioned install, and auto-update is on by default. So `can_pin_version: false`. The adapter passes `--disable-auto-update` only once it is confirmed on the live help text, reads `agent --version` before and after the run, and records the reported version, with drift as a warning.
- Trust-gated scenarios: headless runs in an untrusted workspace fail unless `--trust` or `--force`. A scenario about loading untrusted-workspace config therefore needs the profile to choose `--trust`, and it runs at `headless_fidelity: reduced`, as AAB-001/002 do for Claude Code.
- `stream` layer applies: NDJSON, with `tool_call` started/completed merged by `call_id`. Read and write calls are typed; shell and MCP calls are parsed only generically (`tool_call.function.name`/`arguments`), and unknown shapes go into a raw field, not dropped. There is no `cost_usd` (it stays null). Token totals are recorded only once their field names are verified from a recording.
- `hook` layer applies conditionally: `preToolUse`/`postToolUse` carry `tool_use_id`, and observation hooks exit 0 only. The adapter must declare `hook` in `capabilities().observes` only after a recorded run (per ADR-0015) shows hooks fire under `-p`. Until then, `observes: ['stream']`. Whether `tool_use_id` (hook) equals `call_id` (stream) is UNVERIFIED, so a merge across layers waits for a recording; until then the layers are kept separate and aligned by time.
- `proxy` layer: not specific to Cursor and not covered here. The fixtures' effect sensors (evidence-spec detectors) stay the source of verdicts.

## Codex CLI
- Non-interactive: documented event types; token usage on `turn.completed`; no USD cost; `--ephemeral` suppresses session files. Source: https://learn.chatgpt.com/docs/non-interactive-mode.md
- Hooks receive `tool_use_id` and `turn_id`; cover shell, `apply_patch`, MCP tools; "Hosted tools such as WebSearch are not covered"; non-managed hooks must be trusted by hash, unreviewed hooks are skipped; whether hooks fire under `codex exec` is UNVERIFIED. Untrusted projects skip their `.codex/` config. Source: https://learn.chatgpt.com/docs/hooks?surface=cli

## OpenHands
- Headless is always `always-approve`, not changeable. JSONL has action/observation events without tool-call ids; nothing documented about cost. Source: https://docs.openhands.dev/openhands/usage/cli/headless
- SDK events: `tool_call_id` appears only on `AgentErrorEvent`; storage of events not described, so the landscape's "one file per event" is UNVERIFIED. Source: https://docs.openhands.dev/sdk/arch/events.md

## Pricing pages opened (numbers not recorded here; re-read before the cost model)
- https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI API pricing (developers.openai.com), page opened, figures not captured.

## Draft ADR list reached before the stop
ADR-01 scenario format (YAML + JSON Schema) · ADR-02 setup-under-test as a separate profile · ADR-03 runner lifecycle and determinism · ADR-04 agent adapters · ADR-05 fixtures inert by construction (canary namespace: DECISION NEEDED) · ADR-06 detector layering · ADR-07..19 not written: scoring, run manifest, cost model, reporting, isolation, language/runtime (DECISION NEEDED), dependency and release policy, repository layout, contribution flow, weekly cadence, disclosure and licensing, mcp-review-check reuse, non-goal guardrails; threats-to-validity table.

## Reviewer guidance for the next author
- State detector false-negative handling as a design principle: verdicts come from effect sensors outside the agent; positive and negative control runs check the detectors. Do not enumerate evasion techniques.
- Write in smaller separate steps (one ADR group per step; schemas separately from detector list).
