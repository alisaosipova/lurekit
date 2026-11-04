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

### Scenario directory resolution

`run`, `plan`, `validate`, `list` and `doctor` take an optional `[dir]` and resolve the corpus
the same way (ADR-0022 amendment): the `[dir]` argument when given; else `./scenarios` when the
current directory has one; else the corpus shipped with the package (so `npx lurekit plan
--model sonnet` works from an empty directory). `plan` and `run` print the result first, e.g.
`corpus: <installed package>/scenarios (shipped with the package)`, or
`(./scenarios in the current directory)` / `(given on the command line)`.

### Refusals name the next command

Every refusal ends with a `next:` (or `Next:`) line holding one command that moves you forward,
for example `next: lurekit run --model sonnet` for a missing `--model`, or, for an unknown
command within edit distance 2 of a real one, `next: lurekit plan   (did you mean "plan"?)`.
A thrown error without its own next command gets `next: lurekit --help`.

Only `run` launches a real agent (cost / auth), and only unless it is given `--replay`.
Everything else is fully offline: no agent, no network, no spend. `doctor` only asks the local agent binary for
its version and login status (no session, no spend).

### run

```
lurekit run [dir] --model <id> [options]
```

Run the benchmark against a live agent, write a run directory and a manifest, and print a
report. `[dir]` is the scenario directory (see [Scenario directory resolution](#scenario-directory-resolution)).
`--model` is required.
With `--replay <dir>` it re-drives a recorded Claude Code run offline instead of launching an
agent. Accepts all profile, config, output and replay flags below.

Without `--mode` a run is smoke (`k=1`). Before a live run (no `--replay`) launches anything it
prints its plan to stderr (ADR-0022):

<!-- n-line:run_plan,run_cost -->
```
corpus: <installed package>/scenarios (shipped with the package)
plan: 25 scenario(s) will run, 27 skipped; k=1 (smoke), 25 launch(es) of claude-code (model=sonnet)
estimated cost: about 1.52 USD (25 scenario(s) x k=1 x 0.061 USD) on sonnet, from a published run; other models differ
budget cap: none (add --budget <usd> to stop before a repetition that could exceed it)
ok    binary      claude-code: /path/to/claude (via PATH "claude"), version <x.y.z> (Claude Code)
ok    auth        logged in (claude auth status: authMethod=claude.ai); ...
Launch? [y/N]
```

Only `y` or `yes` launches. `--yes` launches without the prompt. When stdin is not a terminal and
`--yes` is absent the run is refused (exit 1) with a message naming `--yes`, so CI never launches
a live agent by accident. `--mode full` (k=3) asks the same way; `--replay` never asks (zero
cost). The estimate comes from the published run shipped as the demo (claude-code on sonnet
only); other agents print "no published run yet, no estimate". A binary that cannot be found is
refused before the prompt with the install or `AAB_*_BIN` fix.

Pre-spend validation (ADR-0022 amendment): before the plan, the prompt and any agent spawn,
`run` checks `--format` (json, markdown or sarif), that the directory of `--output` exists and is
writable (and that `--output` is not a directory), that `--results` can be created and written,
and that `--budget`, when given, is a number greater than 0. A failure exits 1 with
`refusing to run: ...` and a `next:` command; nothing is launched or spent. `--replay` runs are
checked the same way.

While it runs, `run` prints `[i/N] <scenario id> <name>` per scenario. After the report it prints
a `what went wrong:` block for repetitions that did not measure anything (binary, auth, network,
model, budget, adapter), each with the recorded warning, the evidence path and the next command.
A run that measured something ends with:

```
Next: lurekit report .aab-runs/<benchmark_run_id> --format markdown|json|sarif
      lurekit publish .aab-runs/<benchmark_run_id> --redact-home
```

Exit 0 on completion; 1 if `[dir]` is missing, holds no scenarios or a scenario fails to load,
if `--results` cannot be written or another pre-spend check fails, if the launch is declined or refused, if nothing was measured
because of a setup failure (binary, auth, network, model, adapter), or if a flag/value is
invalid.

### validate

```
lurekit validate [dir]
```

Schema-validate every scenario in `[dir]` (resolved as in [Scenario directory resolution](#scenario-directory-resolution)). Prints `OK <id> <name>`
per valid scenario and `FAIL <file> <message>` per error. Exit 0 when all valid, 1 on any
error. Offline.

### list

```
lurekit list [dir]
```

List scenarios as `<id> runnable=<yes|no> detector=<detector> applies=<csv|all> <name>`
(`[dir]` resolved as in [Scenario directory resolution](#scenario-directory-resolution)).
Exit 0, or 1 if some scenario files failed to load. Offline.

### plan

```
lurekit plan [dir] --model <id> [profile/config options]
```

Show which scenarios would run for a profile, without launching an agent. Prints `KEEP <id>
<detector> <name>` and `SKIP <id> <reason>: <detail>`, then a summary line, after a first
`corpus: <path> (...)` line naming the resolved scenario directory. `--model` is required.
Exit 0. Offline.

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
`--output <file>` or stdout. Exit 0, or 1 if `<runDir>` is missing or has no `manifest.json`;
then the run directories found under `--results` (default `.aab-runs`) are listed, newest first,
up to 10, with `next: lurekit report <newest> --format markdown`. In Markdown, the "What to
change" re-measure command reuses the run's agent, model, version, mode, k and vulnerable_if, the
scenario directory a bare `lurekit run` would resolve from your cwd, and `--budget` (the run's
own cap, else the published-run estimate for the same scenarios and k), and reminds you to add
your own `--settings`/`--mcp`/`--hooks`/`--skill` flags (ADR-0021 amendment). Offline.

### publish

```
lurekit publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <id>]... [--exclude <id>]... [--redact-home] [--scenarios <dir>]
```

Run the redaction gate and write a shareable bundle (manifest, each scenario's
`evidence.json`, `report.md`/`.json`/`.sarif`, `index.md`); no raw transcripts. `<runDir>` is
required and must contain a `manifest.json` (when it does not, the run directories under
`--results` are listed as for `report`). Default output is `<results>/<benchmark_run_id>/bundle`
(`--results` defaults to `.aab-runs`), next to the run and never in the cwd; `--out <dir>`
overrides it. The run's own files are untouched.
Exit 0 on a clean gate + successful write; 1 if the manifest is missing, a `--withhold` or
`--exclude` value is not a scenario id, an id is given to both flags, the gate fails, or the write fails (nothing is written on any failure).
Offline.

### doctor

```
lurekit doctor [dir] [--agent <id>] [--model <id>] [--format text|json]
```

Check a host before the first live run (ADR-0022). One line per check, `ok` / `warn` / `fail`,
and a `fix:` command under each warn/fail line:

- `node`: Node >= <!-- n:versions.node_min -->20.19<!-- /n -->.
- `binary`: the agent binary as the adapter resolves it (`AAB_*_BIN`, else PATH), its real path
  and `--version`.
- `update`: whether the install updates itself in place (Claude Code npm-global: warn, with the
  pinned `npm install --prefix` recipe).
- `auth`: no-spend checks only. claude-code: `claude auth status --json` (only `loggedIn` and
  `authMethod` are kept; asked only when `--version` reports Claude Code >= <!-- n:versions.claude_auth_status_min -->2.1.317<!-- /n -->, else
  `not checked`); cursor-cli: `CURSOR_API_KEY` present, else `agent status --format json`;
  codex-cli: `CODEX_API_KEY` present (the run-scoped `CODEX_HOME` hides `codex login`);
  openhands: `LLM_API_KEY` present. Key values are never read. claude-code logged out while
  `ANTHROPIC_API_KEY` is set is a `warn` ("UNVERIFIED whether -p honours it on this version"),
  not a `fail`.
- `model`: what the agent does with `--model` (no adapter validates it offline).
- `permission` (openhands only): headless needs `--permission-mode always-approve`.
- `isolation`: `--isolation` is an evidence label in the manifest; no container runtime is
  started, required or checked.
- `corpus`: `[dir]` (resolved as in [Scenario directory resolution](#scenario-directory-resolution))
  validates, and how many scenarios would run for the agent; `selftest`: every detector's
  positive/negative control passes.
- `cost`: "about X USD for smoke (k=1), about Y USD for full (k=3) on sonnet, from a published
  run; other models differ" for claude-code; "no published run yet, no estimate" otherwise.

The last line is `Next: lurekit run <corpus> --agent <agent> --model <model> (asks before it
spends).` with the resolved corpus, `--agent` and `--model` filled in; only a value doctor cannot
know (no `--model` given, a missing directory) stays as `<id>` / `<dir>`. The `fix:` lines of the
`model` and `corpus` checks are built the same way.

`--format json` prints `{agent, model, checks: [{id, status, summary, fix?}], estimate, fail,
warn}`. Exit 0 when no line is `fail`, 1 otherwise. Starts no agent session and spends nothing.

### demo

```
lurekit demo [--format <fmt>] [--output <file>]
```

Print a published run that ships with the package (`demo/<run id>/`, run <!-- n:demo.run_id -->aab-20261103071018-88a78d8f<!-- /n -->:
`manifest.json` and `report.json`, byte-identical to the bundle under `reports/`), rendered by
the same reporter as `report`, so you can see a real report with no agent, no auth and no spend
(ADR-0021). `--format` defaults to `markdown`; the Markdown output starts with a banner naming
the agent, version, model and date of that run and how to measure your own setup. For `json` and
`sarif` the banner goes to stderr so stdout stays machine-readable (`--format json` prints the
published `report.json` exactly). Evidence files are not shipped, so the per-scenario detector
and tool-call lines are absent. Accepts only `--format` and `--output`; any other flag or a
positional argument is an error (exit 1). If the shipped demo files are missing from the
install, it exits 1 with a message naming the reinstall command. Exit 0. Offline.

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
| `--budget <usd>` | number | *(none)* | a number greater than 0 (`run` refuses 0 or less before launching) |
| `--results <dir>` | string | `.aab-runs` | a path; `report`/`publish` also read it to list run directories, and `publish` writes its default bundle under it |
| `--yes` | boolean | off | `run` only: launch a live run without the `Launch? [y/N]` prompt (required when stdin is not a terminal) |

### Output flags (run, report, demo)

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
| `--out <dir>` | string | `<runDir>/bundle` (`<results>/<benchmark_run_id>/bundle`) | bundle destination |
| `--allow-host <host>` | string (repeatable) | *(none)* | allow every URL, host reference, email and git remote on a host; otherwise only exact scenario source URLs and loopback pass |
| `--withhold <scenario-id>` | string (repeatable) | *(none)* | leave a scenario out of the bundle; totals recomputed |
| `--exclude <scenario-id>` | string (repeatable) | *(none)* | leave out a scenario whose result is not a measurement (own `index.md` note, manifest `excluded`); same handling as `--withhold`; an id may not be given to both |
| `--redact-home` | boolean | off | replace your home dir with `<HOME>` in the published copies (run dir untouched) |
| `--scenarios <dir>` | string | the shipped corpus | the run's scenario corpus: its source URLs pass the gate; with `--withhold`/`--exclude` the published `corpus_digest` is recomputed from it |

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
  next: pass the value as the next argument (--model <value>); lurekit --help lists every flag
  ```
- **A numeric flag (`--k`, `--budget`) with a non-number value is rejected:**
  ```
  error: --k expects a number
  next: pass a number, e.g. --k 3
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
| `1` | A handled failure or a thrown error: a `doctor` fail line; a live `run` declined at the prompt, refused without `--yes` off a terminal, refused by the preflight (binary, results dir, openhands permission), or one that measured nothing because of a setup failure; invalid scenarios (`validate`, or `run` refusing to start), a failed detector self-test, a missing `manifest.json` (`report`, `publish`), a publish gate or write failure, a bad `--withhold` or `--exclude`, or any parsing/validation error (unknown flag, `--flag=value`, whitespace token, missing value, missing `--model`, a bad enum value, an agent-flag mismatch, `--replay` on a non-claude agent). |
| `2` | Unknown command (a `next:` line with the closest command name, edit distance <= 2, or `lurekit --help`; then usage, on stderr). |

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
