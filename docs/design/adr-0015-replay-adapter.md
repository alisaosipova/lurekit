# ADR-0015: Replay adapter (record once, replay offline)

Status: accepted (2026-11-02). Authorises `src/adapters/replay.ts`, the exported
`observeClaudeRun` parse/merge function in `src/adapters/claudeCode.ts`, and the CLI
`run --replay <dir>` flag. Builds on evidence-spec §4.2 (merge by `tool_use_id`) and §4.5
(determinism of the adapter, not the agent).

## Context
A live Claude Code run costs money and needs the agent's own auth. The maintainer cannot
afford repeated live runs, yet the observation path (stream-json parsing, hook-log parsing,
merge by `tool_use_id`, cost and `system/init` metadata) is the part of the harness most
likely to regress silently. The existing stub binary (`test/fixtures/agents/stub-claude.mjs`)
exercises process plumbing, but its stream is hand-written and minimal. We want one manual
recording of a real run to be re-driven deterministically in tests and CI, through the same
code that parses a live run.

## Options
1. **Replay through the stub binary.** Teach the stub to cat a recorded file. Keeps the spawn
   path but still forks a process per run and couples the recording to the stub's argv shape.
2. **Separate replay parser.** A second implementation of the parse/merge logic. Cheap, but two
   parsers drift; a replay test would no longer prove anything about the live path.
3. **Replay adapter over a shared pure function.** Extract the parse/merge step of
   `ClaudeCodeAdapter` into an exported pure function; a `ReplayAdapter` feeds it the recorded
   files. No process, no network; the live adapter and replay share one parser.

## Decision
Option 3.

- `observeClaudeRun(input)` in `src/adapters/claudeCode.ts` is the pure step: given the raw
  stream text, the hook-log text, timestamps, exit code and paths, it returns the
  `RunObservation`. The live adapter keeps incremental per-line parsing (for wall-clock `at`
  offsets) through the same exported line parser and merge function; behaviour is unchanged.
- `ReplayAdapter({ recordingDir })` implements `Adapter` with id `claude-code` (the recording is
  a Claude Code run; the profile's agent stays `claude-code`). `run()` copies the recording into
  `options.runDir` and returns `observeClaudeRun(...)` over the recorded text.
  Every replayed observation carries the warning `replayed from a recording (ADR-0015): no
  live agent ran; not a benchmark result`, which the runner writes to `evidence.json`
  (`observation.warnings`), so a replay is identifiable from its artefacts alone.
- Recording layout (a directory):
  - `claude-stream.jsonl` (required): verbatim `--output-format stream-json --verbose` stdout.
  - `claude-hooks.jsonl` (optional): the observation hook's log from the same run.
  - `recording.json` (optional): `{ exit_code?, started_at?, ended_at?, agent_version_reported? }`.
    Defaults: `exit_code` 0, `started_at`/`ended_at` 0. Timestamps are fixed, never the clock.
    Block 8 amendment (2026-11-05): optional `skills_loaded?: string[]`, the names of the skills
    the recorded run invoked through the `Skill` tool or whose SKILL.md it read, declared by the
    maintainer who sanitised the recording (the per-run marker of a replayed fixture can never
    appear in an old stream, so the fact must be declared, as `fixtures` is for
    `content_fetched`). Present: the s3.1 `skill_loaded` precondition is evaluated against it
    (`source: recording`); absent: not evaluated (`source: not_observable`, verdict unchanged,
    warning), so the shipped recordings and the CI replay assertions are unchanged. A value that
    is not an array of strings is a broken recording (`adapter_error`).
- Replay fixes `used_bare: false` and stream `at` offsets to 0 (no wall clock is replayed).
  Hook `at` is `aab_hook_at - started_at`, clamped at 0, as in the live path.
- CLI: `run --replay <dir>` bypasses `CliDeps.adapterFor` and uses a `ReplayAdapter`; `--model`
  stays required because the model id is pinned into the manifest (ADR-0005).
  `--replay` accepts only `--agent claude-code` (the default); any other agent is an error.

## Consequences
- One recording gives a deterministic regression test of the real observation code; CI needs
  no auth and spends nothing.
- A replayed run does not re-drive fixtures or the agent: detectors that rely on side effects
  in the run dir (recorder logs, sink hits) see only what the recording copied. Replay
  therefore validates observation and reporting, not an agent's resistance; reports from a
  replay are not benchmark results and should not be published as such.
- Recordings must be inert: benign tool names and inputs, no secrets, no real hosts. Strip
  credentials and absolute home paths before committing one.
- If the stream-json event shapes change (NOTES-verified-facts.md), re-record; the shared
  parser means the live path and replay update together.

## Recordings in the repo
- `test/fixtures/recordings/claude-sample`: hand-sanitised, benign `Read`; its `system/init`
  reports no MCP servers, so MCP scenarios end `precondition_failed` under replay (by design).
- `test/fixtures/recordings/claude-mcp-sample` (added 2026-11-02): derived from a live run
  (`2.1.316 (Claude Code)`, AAB-018 with `--strict-mcp-config --mcp-config`) and redacted:
  paths become `<WORK>` / `<RUN>` / `<HOME>`, session/request/message ids and uuids are fixed
  fakes, tool_use_ids stay consistent between stream and hook log, operator/user-scope config is
  dropped, the reply is an ASCII English paraphrase ending with a `SUMMARY:` line, and the file is
  pure ASCII. `system/init` lists only the observed `aab-canary` entry (`connected`, `source:
  "dynamic"`); no placeholder servers are added, so AAB-019/022/023 (other server names) stay
  `precondition_failed` against it. Its README lists what is verified vs redacted. CI runs the
  whole corpus against `claude-sample`, then AAB-018 alone against `claude-mcp-sample` and asserts
  zero inconclusive results and `resisted`.
