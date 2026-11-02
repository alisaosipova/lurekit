# ADR-0016: Cursor CLI adapter

Status: proposed, implemented for the stream layer (2026-11-02); awaiting maintainer approval.
Authorises `src/adapters/cursorCli.ts`, `test/fixtures/agents/stub-cursor.mjs`,
`test/cursor-adapter.test.ts` and the `cursor-cli` branch of `CliDeps.adapterFor` in
`src/cli.ts`. Facts and URLs: `NOTES-verified-facts.md` § Cursor CLI (checked 2026-11-02).
Builds on evidence-spec §4.1 (adapter invariants), §4.5 (determinism) and ADR-0015.

## Context
Cursor CLI (`agent`) has a documented print mode (`-p`) with NDJSON `stream-json` output,
`tool_call` started/completed events correlated by `call_id`, and a hooks system whose
`preToolUse`/`postToolUse` inputs carry `tool_use_id` (NOTES § Cursor CLI, "Headless",
"Output formats", "Hooks"). Gaps in the primary sources: no versioned install, auto-update on
by default, `--disable-auto-update` only in the changelog, the model reported only as a display
name in `system/init`, shell/MCP tool-call shapes and token-field names undocumented, and no
primary statement that hooks fire under `-p`. Cursor also reads and merges Claude Code
`settings.json` hooks (changelog). Cursor has several permission flags (`--mode`, `--force`,
`--sandbox`, `--trust`, `--approve-mcps`), while `SetupProfile` has one `permission_mode` string.

## Options
1. **Stream + hook adapter now.** Install a Cursor `hooks.json` observer as for Claude Code.
   Rejected for now: hooks under `-p` are UNVERIFIED, and `tool_use_id == call_id` is UNVERIFIED,
   so a merge would rest on assumptions.
2. **Stream-only adapter, permission flags as a token grammar in `permission_mode`.** Works
   through the existing `--permission-mode` CLI flag; no `SetupProfile` change.
3. **Stream-only adapter, new Cursor-specific `SetupProfile` fields.** Typed, but widens the shared
   interface and the CLI for one agent.

## Decision
Option 2.

1. Argv: `agent -p <task> --output-format stream-json --workspace <workdir> --model <id>`, run
   with cwd = workdir. `permission_mode` is a comma/whitespace-separated token list, each token
   mapping to exactly one flag: `plan`|`ask`|`mode=plan`|`mode=ask` -> `--mode`; `force` ->
   `--force`; `sandbox=enabled|disabled` -> `--sandbox`; `trust` -> `--trust`; `approve-mcps` ->
   `--approve-mcps`. Unknown or conflicting tokens throw before spawning (dropping one could run
   looser than the profile intends). The adapter adds none of these flags itself (§4.1 inv. 1).
   `-p` is a boolean flag and the prompt is positional (NOTES), so a task starting with `-`
   would be read as an option (for example `--force`); the adapter throws on such a task
   instead of relying on `--`, whose handling is UNVERIFIED.
2. `capabilities()` = `{headless:true, observes:['stream'], can_pin_version:false,
   can_pin_model:true}`.
3. Version: `<bin> --version` before and after the run, each probe bounded by a 15 s timeout. A mismatch with a non-`unpinned`
   `agent_version`, and drift between the two probes, are non-fatal warnings.
   `--disable-auto-update` is passed only when the adapter is constructed with
   `disableAutoUpdate: true` (to be set after confirming it in the live `--help`); otherwise a
   warning records that auto-update was not disabled.
4. Model: the pin is applied on input; `effective_model` is the `system/init` `model` verbatim;
   a value different from the requested id is a warning (display name; exact echo UNVERIFIED).
5. Stream parsing: `tool_call` started/completed merge into one `ToolCall` per `call_id`
   (first sighting's time). Name/input: `tool_call.function.name`/`arguments` when present;
   else the first `<x>ToolCall` key and its `args` (covers the documented `readToolCall` and
   `writeToolCall`); else name `unknown` with the whole payload as input (never dropped).
   stdout is decoded with a streaming UTF-8 decoder so a character split across chunks is
   not mangled. Unknown events and fields are ignored for parsing. `cost_usd` stays undefined (no documented
   cost/token fields). `effective_permission_mode` and `mcp_servers` come from `system/init`.
6. Evidence in runDir: `cursor-stream.jsonl` (stdout verbatim, `raw_events_path`),
   `cursor-stderr.log` (stderr verbatim; failures are reported there), `cursor-argv.json`.
7. Observe, do not steer: the adapter writes nothing into the workdir. If the workdir already
   holds `.claude/settings.json` hooks, a warning records that Cursor may execute them.
8. Binary: constructor `bin` > env `AAB_CURSOR_BIN` > `agent` on PATH. Tests use an offline stub
   that emits only the documented shapes (its `permissionMode` values are placeholders, since
   the flag-to-value mapping is UNVERIFIED). `--bare` (Claude-only) is ignored with a warning.
9. `observeCursorRun` is exported as the pure parse step for a future Cursor replay (ADR-0015).

## Consequences
- Verdicts still come from the fixtures' effect sensors; the stream is attribution evidence.
- Shell and MCP calls appear only if Cursor uses the `function` or `<x>ToolCall` shape; any other
  shape is kept under `unknown`. A recording is needed to type them.
- No cost accounting for Cursor runs; `--budget` cannot be enforced from adapter data.
- Every run without `disableAutoUpdate` carries one auto-update warning (by design).
- Open (DECISION NEEDED): one maintainer recording of a real `agent -p` run to settle shell/MCP
  shapes, token fields, hooks under `-p` and `tool_use_id == call_id`; then a follow-up ADR may
  add the `hook` layer. Whether `--replay` should accept Cursor recordings is also open.
- `BOOTSTRAP.md` and `architecture.md` ADR index should list ADR-0016 (not edited here).
