# ADR-0019: OpenHands CLI adapter

Status: proposed, implemented for the stream layer with a transcript cross-check (2026-11-02);
awaiting maintainer approval. Authorises `src/adapters/openhands.ts`,
`test/fixtures/agents/stub-openhands.mjs`, `test/openhands-adapter.test.ts` and the `openhands`
branch of `CliDeps.adapterFor` in `src/cli.ts`. Facts and URLs: `NOTES-verified-facts.md`
§ OpenHands (checked 2026-11-02; no local `openhands` binary; docs, `OpenHands/OpenHands-CLI` at
`283c6ac3`, `software-agent-sdk` at `v1.28.1`). Builds on evidence-spec §4.1 (adapter
invariants), §4.3 (agent_flags), §4.5 (determinism), ADR-0015, ADR-0016 and ADR-0018 (the Codex
adapter, whose structure this mirrors).

## Context
The only documented one-shot headless entry point is the legacy `openhands` CLI (latest 1.16.0),
which upstream now marks "no longer actively maintained". `openhands --headless -t <task>` runs
the agent; `--json` streams one JSON object per SDK event to stdout, tagged by a `kind` field equal
to the class name, interleaved with Rich text lines ("✓ Agent initialized with model: ...",
"Conversation ID: ..."). Headless always runs in `always-approve` mode (`NeverConfirm`), which
cannot be changed, and tools run on the host as the invoking user (`LocalWorkspace`, no sandbox).
The LLM comes from `<persistence>/agent_settings.json` or, with `--override-with-envs`, from
`LLM_MODEL` / `LLM_API_KEY` / `LLM_BASE_URL` (both of the first two required when no settings
file exists). State paths: `OPENHANDS_PERSISTENCE_DIR` (default `~/.openhands`),
`OPENHANDS_CONVERSATIONS_DIR` (default `<persistence>/conversations`), `OPENHANDS_WORK_DIR`
(default cwd); hooks, user skills and the skills cache use `Path.home()` directly. Each
conversation is persisted as `<conversations>/<id-hex>/base_state.json` plus
`events/event-NNNNN-<id>.json`. UNVERIFIED: how `tool_name` is formed (including for MCP tools),
the exit code when settings are missing, mapping of agent-side task failure to exit 1, whether
Textual headless suppresses any Rich prints, non-zero `accumulated_cost` for local models, the
pinned install form, self-update behaviour of `version_check.py`, the GUI-to-env mapping of the
local-model settings, and public-skills fetch failure behaviour offline.

## Options
1. **Stream adapter on the legacy CLI, approval acknowledged by the profile.** Chosen.
2. **Agent Canvas / Agent Server HTTP adapter.** Out of scope: no one-shot headless mode is
   documented for it; it would be a separate adapter and ADR.
3. **Install an adapter hook into the run-scoped `~/.openhands/hooks.json`.** Rejected: a
   fixture-planted `<workdir>/.openhands/hooks.json` replaces the user file entirely (first match
   wins), so the adapter hook would vanish exactly in hook-planting scenarios.

## Decision
Option 1.

1. Argv: `openhands --headless --json --override-with-envs -t <task>`; process cwd and
   `OPENHANDS_WORK_DIR` are both the per-run workdir (the adapter's value wins over a
   `profile.env` entry, which is warned). A task starting with `-` throws before spawning (argparse
   would read it as an option). No other flag is ever added.
2. Approval: `--headless` itself forces `always-approve` and there is no sandbox. The adapter
   therefore refuses to run unless `permission_mode` contains the token `always-approve`, which
   records that the profile knowingly runs under the only mode headless offers. The token adds no
   flag (`--always-approve` is redundant under headless). `llm-approve`, `confirm`/`always-confirm`
   and any unknown token throw: headless cannot honour them, and silently ignoring them would run
   the agent looser than the profile states (§4.1 invariant 1). Every run carries a warning that
   approval is `always-approve (forced)` and `sandbox: none`, so the run must sit inside the
   bench's own container/VM boundary.
3. `capabilities()` = `{headless:true, observes:['stream'], can_pin_version:false,
   can_pin_model:true}`. The adapter installs nothing, the pinned install form is UNVERIFIED as
   documented usage and self-update is UNVERIFIED, so no version pin is claimed; `--version`
   (format `OpenHands CLI <version>` from source) is probed before and after the run with a 15 s
   bound, recorded raw, and mismatch or drift is a warning. The transcript layer is not an
   `ObservationSource`; it is read as a cross-check only (Decision 7).
4. Model: `LLM_MODEL` is set to `profile.model` (a differing `profile.env.LLM_MODEL` is overridden
   and warned). `LLM_API_KEY` and `LLM_BASE_URL` are taken from the environment (`profile.env`
   over the operator's); a missing `LLM_API_KEY` is warned by name only, and an `LLM_BASE_URL`
   inherited from the operator's environment rather than the profile is warned. `effective_model`
   is the "Agent initialized with model:" line, else `agent.llm.model` from `base_state.json`;
   a mismatch with the pin is a warning, as is no echo at all.
5. Isolation: `HOME=<runDir>/openhands-home`, `OPENHANDS_PERSISTENCE_DIR=<home>/.openhands`,
   `OPENHANDS_CONVERSATIONS_DIR=<persistence>/conversations`, all created empty, so stored
   settings, the API key file, user hooks, user/installed skills, MCP config and history never
   leak in. The adapter writes no `agent_settings.json`. A `profile.env` value for any of the three
   wins and is warned; constructor `isolateHome: false` inherits the operator's and is warned (as
   is a pre-existing `agent_settings.json`, which env overrides only partly replace). Every run
   warns that public skills are fetched by git into the run-scoped cache (network; offline failure
   behaviour UNVERIFIED).
6. Stream parsing: non-JSON lines are skipped for parsing (kept verbatim in the raw file), except
   the model echo and the "Conversation ID:" line (matched after stripping ANSI escape
   sequences, in case Rich colours them). `ActionEvent` -> one `ToolCall` per
   `tool_call_id` (name = `tool_name`, else the action `kind`; input by action kind:
   `TerminalAction` {command}, `FileEditorAction` {command, path, file_text, old_str, new_str,
   insert_line, view_range} (defined fields only), `MCPToolAction` {tool_name, arguments=`data`};
   any other action kind keeps the raw action as input). `ObservationEvent`s are correlated by
   `tool_call_id` (terminal `exit_code` recorded in the parse state); an observation with no action
   is warned. `AgentErrorEvent` and `UserRejectObservation` become warnings verbatim;
   `HookExecutionEvent` with `blocked: true` is warned. Unknown `kind`s are kept raw in the parse
   state, never as tool calls. stdout is decoded with a streaming UTF-8 decoder.
7. Transcript: after the run the conversation dir is located by the "Conversation ID:" line or the
   single subdirectory of the conversations dir (that fallback only when the conversations dir is
   under runDir; otherwise the transcript is not read and a warning says so, so an operator's
   older conversation is never mistaken for this run's model or cost); `events/event-*.json` are read in name order and
   written as JSONL to `<runDir>/openhands-transcript.jsonl` (`transcript_path`); the per-event
   files stay in place. Action `tool_call_id`s present in the transcript but absent from the stream
   are warned (no merge: the transcript is not an `ObservationSource`). `cost_usd` is the sum of
   `accumulated_cost` under `usage_to_metrics` in `base_state.json` only when non-zero, else
   undefined.
8. Attempts: `[]`. Under `NeverConfirm` no permission gate refuses calls; `UserRejectObservation`
   is warned but its `rejection_source` semantics are UNVERIFIED, so it is not mapped to a denial.
9. Evidence in runDir: `openhands-stream.jsonl` (stdout verbatim, `raw_events_path`),
   `openhands-stderr.log`, `openhands-argv.json`, the transcript file and the run-scoped home.
   `agent_flags` lists option names in argv order without values. No `--strict-mcp-config`
   exists, so the runner records `isolation: "partial"`; the run-scoped persistence dir means the
   only MCP config the CLI reads (`<persistence>/mcp.json`) is absent unless provisioned.
10. Observe, do not steer: nothing is written into the workdir. A present
    `<workdir>/.openhands/hooks.json` is warned (loaded without a trust gate, replaces user hooks).
    `--bare` is ignored with a warning. A run that exits 0 with no `ActionEvent` is warned as
    inconclusive (weak or local models may not call tools).
11. Binary: constructor `bin` > env `AAB_OPENHANDS_BIN` > `openhands` on PATH. Tests use an offline
    stub emitting only the verified shapes. `observeOpenHandsRun` is the exported pure parse step.

## Free local-model path (documented configuration, not a default)
Serve a model with Ollama on loopback
(`OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=-1 ollama serve`;
the docs require a context of at least 22000). Then set `profile.model` to
`openai/<served-model-name>` (docs example `openai/qwen3.6:35b-a3b`) and `profile.env` to the
output of `openhandsLocalModelEnv()` (`LLM_BASE_URL=http://127.0.0.1:11434/v1`,
`LLM_API_KEY=local-llm`, a non-secret placeholder). The adapter warns on every run with a local
base URL that the GUI-field-to-env mapping is UNVERIFIED until a recorded run. Nothing selects this
path automatically.

## Consequences
- Verdicts still come from the fixtures' effect sensors; the stream is attribution evidence.
- Every OpenHands profile must name `always-approve`; a profile without it fails before spawning.
  A clean run carries exactly the posture warnings (approval/sandbox, unmaintained upstream,
  public-skills fetch).
- `effective_permission_mode` stays undefined: the CLI reports no mode; the forced mode is a
  warning, not an agent report.
- Open (DECISION NEEDED): one maintainer recording of a real `openhands --headless --json` run
  (ADR-0015) to settle `tool_name` values, Rich-print interleaving, the local-model env mapping,
  cost for local models and offline skills behaviour.
- `BOOTSTRAP.md` and the `architecture.md` ADR index should list ADR-0019 (not edited here).
