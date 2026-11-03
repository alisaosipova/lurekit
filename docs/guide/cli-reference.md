# LureKit CLI reference

Complete reference for the `lurekit` command: every subcommand, every flag, the strict
parsing rules, exit codes, environment variables, the run-directory layout, and the
permission_mode tokens each adapter accepts.

For a task-oriented walkthrough (install, first run, record/replay, profiles), start with
[Getting started](getting-started.md).

Invoke as `lurekit <command> [options]` (global install or `npx lurekit`), or
`node dist/cli.js <command> [options]` from a checkout. The two are equivalent; this reference
writes `lurekit`.

```
lurekit --help         # print usage and exit 0
lurekit --version      # print the tool version and exit 0
lurekit                # no args: same as --help
```

`--help` / `-h` / `help` and `--version` / `-v` are recognised both as the first argument and
as a flag after a command (`lurekit run --help`).

## Subcommands

Only `run` launches a real agent (cost / auth), and only unless it is given `--replay`.
Everything else is fully offline: no agent, no network, no spend.

### run

```
lurekit run [dir] --model <id> [options]
```

Run the benchmark against a live agent, write a run directory and a manifest, and print a
report. `[dir]` is the scenario directory (default `./scenarios`). `--model` is required.
With `--replay <dir>` it re-drives a recorded Claude Code run offline instead of launching an
agent. Accepts all profile, config, output and replay flags below. Exit 0 on completion; 1 if
any scenario in `[dir]` fails to load (the run is refused) or a flag/value is invalid.

### validate

```
lurekit validate [dir]
```

Schema-validate every scenario in `[dir]` (default `./scenarios`). Prints `OK <id> <name>`
per valid scenario and `FAIL <file> <message>` per error. Exit 0 when all valid, 1 on any
error. Offline.

### list

```
lurekit list [dir]
```

List scenarios as `<id> runnable=<yes|no> detector=<detector> applies=<csv|all> <name>`.
Exit 0, or 1 if some scenario files failed to load. Offline.

### plan

```
lurekit plan [dir] --model <id> [profile/config options]
```

Show which scenarios would run for a profile, without launching an agent. Prints `KEEP <id>
<detector> <name>` and `SKIP <id> <reason>: <detail>`, then a summary line. `--model` is
required. Exit 0. Offline.

### selftest

```
lurekit selftest
```

Run every implemented detector's positive/negative self-test. Prints `PASS|FAIL <detector>
positive=<bool> negative=<bool>`. Exit 0 if all detectors are sound, 1 otherwise. Takes no
flags. Offline.

### report

```
lurekit report <runDir> [--format <fmt>] [--output <file>]
```

Render a report from a completed run directory. `<runDir>` is required and must contain a
`manifest.json`. `--format` defaults to `json` (note: `run` defaults to `markdown`). Writes to
`--output <file>` or stdout. Exit 0, or 1 if `<runDir>` has no `manifest.json`. Offline.

### publish

```
lurekit publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <id>]... [--exclude <id>]... [--redact-home]
```

Run the redaction gate and write a shareable bundle (manifest, each scenario's
`evidence.json`, `report.md`/`.json`/`.sarif`, `index.md`); no raw transcripts. `<runDir>` is
required and must contain a `manifest.json`. Default output is `reports/<benchmark_run_id>`.
Exit 0 on a clean gate + successful write; 1 if the manifest is missing, a `--withhold` or
`--exclude` value is not a scenario id, an id is given to both flags, the gate fails, or the write fails (nothing is written on any failure).
Offline.

## Flags

### Profile flags (run, plan)

| Flag | Type | Default | Allowed values | Agents |
|------|------|---------|----------------|--------|
| `--model <id>` | string | *required* | any model id | all |
| `--agent <id>` | string | `claude-code` | `claude-code`, `cursor-cli`, `codex-cli`, `openhands` | all |
| `--agent-version <v>` | string | `unpinned` | any version string | all |
| `--permission-mode <m>` | string | *(agent default)* | per-agent tokens (see table) | all |
| `--workdir <dir>` | string | *(per-run under results)* | a path; relocates workdirs to `<dir>/<scenario>/<rep>` (must be absent/empty) | all |
| `--skill <dir>` | string (repeatable) | *(none)* | a skill directory path | all |
| `--mcp <file.json>` | string | *(none)* | path to an MCP config JSON | all (parsed); written to `--mcp-config` by the claude-code adapter |
| `--settings <file.json>` | string | *(none)* | path to a Claude Code settings JSON | **claude-code only** |
| `--hooks <file.json>` | string | *(none)* | path to a hooks JSON (event map or `{ "hooks": {...} }`) | **claude-code only** |
| `--setting-sources <csv>` | string | *(flag not passed)* | comma-separated subset of `user`, `project`, `local` (no empties, no duplicates) | **claude-code only** |

`--settings`, `--hooks` and `--setting-sources` are rejected for any agent other than
`claude-code`, because only the claude-code adapter forwards them (ADR-0020); for another agent
the body would be digested into evidence yet never reach the agent.

### Config flags (run, plan)

| Flag | Type | Default | Allowed values |
|------|------|---------|----------------|
| `--mode <m>` | string | `smoke` | `smoke`, `full` |
| `--k <n>` | number | `1` (smoke) / `3` (full) | positive integer |
| `--vulnerable-if <v>` | string | `any` | `any`, `majority` |
| `--isolation <m>` | string | `container` | `container`, `container+netns` |
| `--budget <usd>` | number | *(none)* | a number |
| `--results <dir>` | string | `.aab-runs` | a path |

### Output flags (run, report)

| Flag | Type | Default | Allowed values |
|------|------|---------|----------------|
| `--format <fmt>` | string | `markdown` (run) / `json` (report) | `json`, `markdown`, `sarif` |
| `--output <file>` | string | stdout | a path |

### Replay flag (run only)

| Flag | Type | Default | Notes |
|------|------|---------|-------|
| `--replay <dir>` | string | *(none)* | re-drive a recorded run offline; **requires `--agent claude-code`** |

### Publish flags (publish only)

| Flag | Type | Default | Notes |
|------|------|---------|-------|
| `--out <dir>` | string | `reports/<benchmark_run_id>` | bundle destination |
| `--allow-host <host>` | string (repeatable) | *(none)* | whitelist a host for the gate |
| `--withhold <scenario-id>` | string (repeatable) | *(none)* | leave a scenario out of the bundle; totals recomputed |
| `--exclude <scenario-id>` | string (repeatable) | *(none)* | leave out a scenario whose result is not a measurement (own `index.md` note, manifest `excluded`); same handling as `--withhold`; an id may not be given to both |
| `--redact-home` | boolean | off | replace your home dir with `<HOME>` in the published copies (run dir untouched) |

### Global flags

| Flag | Type | Notes |
|------|------|-------|
| `--help`, `-h` | boolean | print usage, exit 0 |
| `--version`, `-v` | boolean | print tool version, exit 0 |

## Strict parsing rules

The flag parser is strict and fails (exit 1) before any command runs. Each rule exists so a
typo or a mis-quoted flag can never be silently ignored or run the agent looser than intended.

- **Unknown flag.** An unrecognised `--name` is an error:
  ```
  error: unknown flag "--bogus" (run 'lurekit --help' for the list of options)
  ```
- **`--flag=value` form is rejected.** Pass the flag and value as separate arguments:
  ```
  error: unsupported flag form "--model=foo": use "--model <value>" (separate arguments), not --model=<value>
  ```
- **A flag token containing whitespace is rejected** (a quoting mistake such as
  `"--model foo"` as one argument):
  ```
  error: malformed flag "--model foo": a flag and its value must be separate arguments (e.g. --withhold AAB-003, not "--withhold AAB-003")
  ```
- **A value-taking flag with no value is rejected** (end of argv, or the next token is
  another `--flag`):
  ```
  error: --model expects a value (got nothing)
  ```
- **A numeric flag (`--k`, `--budget`) with a non-number value is rejected:**
  ```
  error: --k expects a number
  ```
- **Positionals** (anything not starting with `--`) are collected in order. The first
  positional is `[dir]` for `run`/`validate`/`list`/`plan` and `<runDir>` for
  `report`/`publish`.

Other validations run just after parsing and also exit 1, for example a missing `--model`
(`run: --model <id> is required ...`), an out-of-range `--mode`/`--vulnerable-if`/`--format`
value, an invalid `--setting-sources` value, `--settings`/`--hooks`/`--setting-sources` for a
non-claude agent, and `--replay` with a non-claude agent.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. For `validate`/`list`/`selftest` this also means no errors/failures. |
| `1` | A handled failure or a thrown error: invalid scenarios (`validate`, or `run` refusing to start), a failed detector self-test, a missing `manifest.json` (`report`, `publish`), a publish gate or write failure, a bad `--withhold` or `--exclude`, or any parsing/validation error (unknown flag, `--flag=value`, whitespace token, missing value, missing `--model`, a bad enum value, an agent-flag mismatch, `--replay` on a non-claude agent). |
| `2` | Unknown command (usage is printed to stderr). |

## Environment variables

LureKit reads no credentials. The variables it consults are the per-agent binary overrides;
the rest are read by the agent process LureKit spawns, not by LureKit itself.

| Variable | Read by | Purpose |
|----------|---------|---------|
| `AAB_CLAUDE_BIN` | claude-code adapter | override the `claude` binary path |
| `AAB_CURSOR_BIN` | cursor-cli adapter | override the `agent` binary path |
| `AAB_CODEX_BIN` | codex-cli adapter | override the `codex` binary path |
| `AAB_OPENHANDS_BIN` | openhands adapter | override the `openhands` binary path |

Agent-side variables (set by you, forwarded to the spawned agent; names only are ever recorded
in warnings, never values):

- `ANTHROPIC_API_KEY` -- Claude Code auth, when not using a stored login.
- `CODEX_API_KEY`, `CODEX_HOME` -- Codex auth/home. The codex adapter points `CODEX_HOME` at a
  run-scoped `<runDir>/codex-home` by default (so stored CLI auth is not visible unless
  `CODEX_API_KEY` is set); a `CODEX_HOME` set in the profile env wins and is warned.
- `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` -- OpenHands LLM config. The openhands adapter
  sets `LLM_MODEL` from `--model` and isolates `HOME`, `OPENHANDS_PERSISTENCE_DIR` and
  `OPENHANDS_CONVERSATIONS_DIR` into a run-scoped home by default.

## Run directory layout

All run material lives under `--results` (default `.aab-runs`); nothing is written under the
system temp dir.

```
<results>/<benchmark_run_id>/
  manifest.json                     # one per benchmark run
  .selftest/                        # transient detector self-test scratch; removed when empty
  <scenario_id>/
    <rep>/                          # one dir per repetition (0-based)
      evidence.json                 # the evidence record
      work/                         # this repetition's own fresh agent workdir
      claude-stream.jsonl           # raw agent stdout, verbatim (raw_events_path)
      claude-hooks.jsonl            # observe-only hook capture
      mcp.json, aab-hook.cjs,       # adapter-written config for this run; claude-settings.json
      claude-settings.json          #   carries the observe hook (--settings), never the workdir
      <detector>.*                  # detector raw artefacts (access log, argv recorder, ...)
```

Each repetition's workdir is created fresh by the runner; fixtures provision into it and the
adapter runs in it, so no repetition sees another's files. `--workdir <base>` relocates only
the workdirs, to `<base>/<scenario_id>/<rep>` (the base must be absent or empty). The raw file
names above are the claude-code adapter's; other adapters write their own
(`cursor-stream.jsonl`, `codex-stream.jsonl`, `openhands-stream.jsonl`, plus argv/stderr
files). This mirrors evidence-spec section 2.1.

## permission_mode tokens per adapter

`--permission-mode` is a single string. Tokens are separated by commas and/or whitespace. The
`cursor-cli`, `codex-cli` and `openhands` adapters reject an unknown or conflicting token before
anything is spawned (openhands also *requires* a token); the `claude-code` adapter forwards the
token verbatim to `--permission-mode`, so `claude` itself rejects an unrecognised value at spawn.
The adapter never adds a permission flag the profile did not name.

| Agent | Token | Maps to | Notes |
|-------|-------|---------|-------|
| `claude-code` | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` | `--permission-mode <token>` (verbatim) | choices from `claude --help` (2.1.316); `manual` is the headless default |
| `claude-code` | `dangerously-skip-permissions` | `--dangerously-skip-permissions` | special-cased flag instead of `--permission-mode` |
| `cursor-cli` | `plan`, `ask`, `mode=plan`, `mode=ask` | `--mode <plan\|ask>` | conflicting modes rejected |
| `cursor-cli` | `force` | `--force` | |
| `cursor-cli` | `sandbox=enabled`, `sandbox=disabled` | `--sandbox <v>` | conflicting values rejected |
| `cursor-cli` | `trust` | `--trust` | |
| `cursor-cli` | `approve-mcps` | `--approve-mcps` | |
| `codex-cli` | `sandbox=read-only`, `sandbox=workspace-write`, `sandbox=danger-full-access` | `--sandbox <v>` | default (no token) keeps `codex exec` read-only |
| `codex-cli` | `approve-for-me` | `--approve-for-me` | conflicts with `sandbox=...` and `yolo` |
| `codex-cli` | `yolo`, `dangerously-bypass-approvals-and-sandbox` | `--dangerously-bypass-approvals-and-sandbox` | conflicts with `sandbox=...` |
| `codex-cli` | `skip-git-repo-check` | `--skip-git-repo-check` | |
| `codex-cli` | `bypass-hook-trust` | `--dangerously-bypass-hook-trust` | also un-gates workdir `.codex/` hooks |
| `openhands` | `always-approve`, `yolo` | *(no flag; required)* | headless forces always-approve; `llm-approve`/`confirm`/`always-confirm` are rejected (not available headless) |

`codex-cli` additionally rejects an `approval=...` token: `codex exec` has no
`--ask-for-approval` option (it is TUI-only), so emitting it would fail the run.

Only `claude-code` is live-validated. `cursor-cli`, `codex-cli` and `openhands` are tested
against offline stubs and carry UNVERIFIED notes (hooks under headless mode, version pinning,
model echo); their live verdicts are provisional.

## See also

- [Getting started](getting-started.md) -- install, first offline checks, first live run,
  record/replay, profiles, running other agents.
- [`../../profiles/README.md`](../../profiles/README.md) -- the reference Claude Code profiles.
- [`../design/evidence-spec.md`](../design/evidence-spec.md) -- the evidence and detector
  contract; the run-directory layout is section 2.1.
