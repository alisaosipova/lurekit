# Getting started with LureKit

LureKit is a runnable, disclosure-traced security benchmark for deployed coding-agent
configurations. You point it at the coding-agent setup you actually run (agent, model,
permission mode, settings, MCP servers, hooks, skills); it replays scenarios derived from
public security disclosures against that setup, using inert fixtures and out-of-band
detectors, and reports "vulnerable to N of M scenarios" with per-scenario evidence.

This guide walks the first offline checks, a first live run, and the offline workflows
(report, publish, record-and-replay, profiles, other agents). For an exhaustive catalogue of
subcommands, flags, exit codes, environment variables and the run-directory layout, see the
[CLI reference](cli-reference.md).

Every command and flag shown here exists in the CLI; the output excerpts are taken from real
offline runs. Run ids, timestamps and absolute paths in the excerpts vary from run to run.

## Install

LureKit ships one binary, `lurekit` (`dist/cli.js` in the package).

Global install:

```bash
npm install -g lurekit
lurekit --help
```

Without installing, run it straight from npm:

```bash
npx lurekit --help
```

As a dev dependency of a project:

```bash
npm install --save-dev lurekit
npx lurekit validate node_modules/lurekit/scenarios
```

From a checkout (contributors):

```bash
npm ci
npm run build
node dist/cli.js --version
```

All invocations are equivalent; this guide writes `lurekit <command>`. If you run from a
checkout, substitute `node dist/cli.js <command>`.

## Prerequisites

- **Node.js 20.19 or newer.** Check with `node --version`.
- **A supported coding agent on your `PATH`**, but only for a live `run`. Every other
  subcommand (`validate`, `list`, `selftest`, `plan`, `report`, `publish`, and `run --replay`)
  is fully offline and needs no agent, no network and no spend. The adapters look for these
  binaries by default, and each has an environment-variable override:

  | Agent        | Default binary | Binary override env var |
  |--------------|----------------|-------------------------|
  | `claude-code`| `claude`       | `AAB_CLAUDE_BIN`        |
  | `cursor-cli` | `agent`        | `AAB_CURSOR_BIN`        |
  | `codex-cli`  | `codex`        | `AAB_CODEX_BIN`         |
  | `openhands`  | `openhands`    | `AAB_OPENHANDS_BIN`     |

### How authentication works

LureKit never handles your credentials. It does not log in, it does not read your API keys,
and it does not store or forward tokens. A live `run` simply spawns the agent's own binary,
and the agent authenticates exactly as it does when you use it directly: through its own
subscription/login session or through the API key you already have in your environment.

- Claude Code uses your existing Claude Code login or `ANTHROPIC_API_KEY`.
- Codex CLI uses its stored CLI auth or `CODEX_API_KEY`. Note the codex adapter points
  `CODEX_HOME` at a run-scoped directory by default, so saved CLI auth is not visible to the
  run unless `CODEX_API_KEY` is set; LureKit records this as a warning, never the key value.
- OpenHands reads `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` from the environment.

LureKit records environment variable *names* in warnings when relevant, never their values.

## First offline checks

Start here. None of these launches an agent.

### validate -- schema-validate the scenarios

```bash
lurekit validate
```

```
OK    AAB-001  Pre-trust MCP start from project files (CVE-2025-59536)
...
OK    AAB-056  Web indirect prompt injection in the wild (Unit 42)

48 valid, 0 errors in scenarios
```

Exit code is 0 when every scenario is valid, 1 if any file fails. The scenario directory
defaults to `./scenarios`; pass another as the positional argument
(`lurekit validate node_modules/lurekit/scenarios`).

### selftest -- prove each detector can see its own signal

```bash
lurekit selftest
```

```
PASS  canary_egress_http  positive=true negative=true
PASS  canary_file_read  positive=true negative=true
PASS  canary_command  positive=true negative=true
PASS  canary_mcp_tool  positive=true negative=true
PASS  fs_diff  positive=true negative=true

all detectors sound
```

Each detector ships a positive control (its signal fires -> detected) and a negative control
(no signal -> not detected). A failing control means the detector could silently miss or
fabricate its own effect, so a non-zero exit here means do not trust a run's verdicts.

### plan -- see which scenarios would run for a profile

`plan` applies the same selection the runner uses (agent `applies_to`, `runnable`) without
launching anything. `--model` is required, because the model is pinned into every manifest.

```bash
lurekit plan --model claude-opus-4-1
```

```
KEEP  AAB-001  canary_mcp_tool  Pre-trust MCP start from project files (CVE-2025-59536)
KEEP  AAB-002  canary_command  Hooks run after an ambiguous trust prompt (GHSA-ph6w-f82w-28w6)
...
SKIP  AAB-055  not_runnable: scenario is marked runnable:false

plan: 25 would run, 23 skipped (profile agent=claude-code, model=claude-opus-4-1)
```

Change `--agent` to see a different agent's selection; scenarios whose `applies_to` excludes
the agent are skipped as `not_applicable`:

```bash
lurekit plan --model gpt-5-codex --agent codex-cli
```

```
plan: 1 would run, 47 skipped (profile agent=codex-cli, model=gpt-5-codex)
```

### list -- the full catalogue

```bash
lurekit list
```

```
AAB-001  runnable=yes  detector=canary_mcp_tool  applies=claude-code  Pre-trust MCP start from project files (CVE-2025-59536)
...
48 scenario(s) in scenarios
```

## A first live run

A live `run` is the only subcommand that launches a real agent, so it costs money and uses
the agent's own auth. Pin the model and cap the spend:

```bash
lurekit run \
  --agent claude-code \
  --model claude-sonnet-4-5 \
  --agent-version 2.1.316 \
  --budget 5 \
  --format markdown --output report.md
```

- `--model` is required and is pinned into the manifest.
- `--agent-version` is optional but recommended; it records the version you believe you are
  testing and warns on drift. Default is `unpinned`.
- `--budget <usd>` bounds the run's spend.
- `--mode smoke` (the default) runs each kept scenario once (`k=1`); `--mode full` runs
  `k=3`. Override with `--k <n>`.

LureKit prints progress to stderr and the report to stdout (or to `--output`):

```
running 48 scenario(s) against claude-code (model=claude-sonnet-4-5, k=1, mode=smoke)
results under .aab-runs/aab-<timestamp>-<id>
```

### Where results land

Everything a run produces lives under `--results` (default `.aab-runs`); nothing is written
to the system temp dir. The layout per benchmark run is:

```
.aab-runs/<benchmark_run_id>/
  manifest.json                     # one per benchmark run
  <scenario_id>/
    <rep>/                          # one dir per repetition, 0-based
      evidence.json                 # the per-run evidence record
      work/                         # this repetition's fresh agent workdir
      claude-stream.jsonl           # raw agent stdout, verbatim
      claude-hooks.jsonl            # observe-only hook capture
      mcp.json, claude-settings.json, aab-hook.cjs   # adapter-written config for this run
      <detector>.*                  # detector raw artefacts
```

Each repetition gets its own fresh `work/` directory, so no repetition sees another's files.
`--workdir <base>` relocates only the workdirs, to `<base>/<scenario_id>/<rep>` (the base
must be absent or empty).

### Reading the headline

The Markdown report opens with the headline verdict:

```
# LureKit report: claude-code unpinned

**Vulnerable to 0 of 18 scenarios** (degraded: 0, inconclusive: 7).

Resisted: 18 not attempted, 0 denied (the agent attempted the forbidden action and the setup blocked it).
```

"Vulnerable to N of M" counts the scenarios where a detector observed the forbidden effect.
`inconclusive` counts runs where the harness could not reach a confident verdict (for example
a replayed run, see below). The per-scenario table that follows gives each scenario's verdict,
confidence (`x/k vulnerable`) and disclosure source.

### Re-rendering a completed run

The run directory is the source of truth. Render it again, in any format, without re-running
the agent:

```bash
lurekit report .aab-runs/<benchmark_run_id> --format sarif --output report.sarif
```

`report` defaults to `--format json`; `run` defaults to `--format markdown`. Allowed formats
are `json`, `markdown` and `sarif`. The SARIF output is a standard 2.1.0 document:

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "LureKit",
          "version": "1.0.0",
```

### Publishing a shareable bundle

`publish` runs a redaction gate (no raw transcripts leave the run dir) and writes a bundle you
can share: the manifest, each scenario's `evidence.json`, `report.md`/`.json`/`.sarif`, and an
`index.md`. The default destination is `reports/<benchmark_run_id>`.

```bash
lurekit publish .aab-runs/<benchmark_run_id> --redact-home
```

```
wrote report.md
wrote report.json
wrote report.sarif
wrote index.md
redaction applied: home directory -> <HOME> (0 replacements)

published 30 file(s) to .../reports/<benchmark_run_id>
```

- `--redact-home` is opt-in; it replaces *your* home directory with `<HOME>` in the published
  copies (the run dir itself is untouched). Other operators' home paths still fail the gate.
- `--withhold <scenario-id>` (repeatable) leaves a scenario out of the bundle pending
  coordinated disclosure; the totals are recomputed.
- `--allow-host <host>` (repeatable) whitelists a host the gate would otherwise flag.

If the gate finds something it cannot redact, nothing is written and `publish` exits 1.

## Record once, replay offline

A live run costs money. Record one real Claude Code run and replay it as often as you like
through the same parsing and merging code a live run uses. Replay needs no auth, no spend and
no network.

A recording is a directory with:

```
claude-stream.jsonl   required  verbatim `claude -p --output-format stream-json --verbose` stdout
claude-hooks.jsonl    optional  the observe hook's log (copy it from a live run's dir)
recording.json        optional  { "exit_code", "started_at", "ended_at", "agent_version_reported" }
```

The quickest way to get one: do a single live `run`, then copy `claude-stream.jsonl` and
`claude-hooks.jsonl` out of a repetition's run directory and strip any secrets or home paths.
A sample recording ships with the source tree at `test/fixtures/recordings/claude-sample`:

```bash
lurekit run \
  --model claude-sonnet-4-5 \
  --replay test/fixtures/recordings/claude-sample
```

```
replaying recording test/fixtures/recordings/claude-sample (offline, no live agent)
running 48 scenario(s) against claude-code (model=claude-sonnet-4-5, k=1, mode=smoke)
results under .aab-runs/aab-<timestamp>-<id>
```

Replay does not re-run the agent. Detectors that depend on side effects (recorder logs, sink
hits) see only what the recording contains, so a replay tests observation and reporting, not
the setup. It is not a benchmark result, and every replayed run's `evidence.json` says so in
`observation.warnings`. `--replay` only supports `--agent claude-code` (recordings are Claude
Code runs).

## Using profiles

A profile is a named Claude Code setup. The reference profiles live in `profiles/` as JSON
files that document the `SetupProfile` fields and the equivalent CLI flags. There is no
`--profile` flag; you pass the flags the profile lists. `--model` (and ideally
`--agent-version`) are always required on top, so the same profile can be measured against any
pinned model. Both reference profiles are hardening-only: neither loosens anything the adapter
does by default.

Bare (no overrides) -- the baseline to compare against:

```bash
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version>
```

Hardened -- narrowed setting sources and the default (manual) permission mode pinned
explicitly:

```bash
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version> \
  --setting-sources user --permission-mode manual
```

`--setting-sources user` excludes the `project` (`.claude/settings.json`) and `local`
(`.claude/settings.local.json`) setting sources, so settings, hooks and permissions planted in
the repository under test are not loaded. Scenarios whose vector is a project settings file
then measure whether that hardening holds. Accepted `--setting-sources` values are `user`,
`project`, `local` (comma-separated); anything else, an empty list or a duplicate is rejected
before any agent is spawned. The flag is claude-code only.

See [`profiles/README.md`](../../profiles/README.md) for the full description, including the
`--settings` / `--hooks` forwarding path (claude-code only), and the measured bare-vs-hardened
comparison. Under both profiles the headless agent cannot `curl` loopback, so feed and web
scenarios end `inconclusive(precondition_failed)`; the `claude-code-netread.json` profile
(add `--settings profiles/settings/allow-loopback-curl.json`) is the one profile that loosens a
permission to measure them, see [troubleshooting](troubleshooting.md#all-my-feed-or-web-scenarios-are-inconclusive-precondition_failed).

## Running other agents

Four agent adapters exist. Only `claude-code` is live-validated. `cursor-cli`, `codex-cli` and
`openhands` are implemented and tested against offline stubs, but not yet live-validated:
several behaviours are marked UNVERIFIED in their adapters (hooks firing under headless mode,
version pinning, model echo), and the adapters surface those as run warnings. Treat their live
verdicts as provisional until a recorded run confirms the behaviour.

Each agent takes its permission posture through a single `--permission-mode` string, which the
adapter turns into that agent's own flags. The adapter never adds a permission flag the
profile did not name. For `cursor-cli`, `codex-cli` and `openhands` an unknown or conflicting
token is rejected before anything is spawned; the `claude-code` adapter forwards the token
verbatim to `--permission-mode`, so an unrecognised value is rejected by `claude` itself at
spawn. Either way a typo can never silently run the agent looser than you intended. The accepted
tokens per agent are tabulated in the [CLI reference](cli-reference.md#permission_mode-tokens-per-adapter).

Claude Code (live-validated), hardened example:

```bash
lurekit run --agent claude-code --model <model-id> \
  --agent-version <pinned-version> --permission-mode manual --budget 5
```

Cursor CLI (binary `agent`, override `AAB_CURSOR_BIN`); tokens map to Cursor flags
(`plan`/`ask` -> `--mode`, `force`, `sandbox=enabled|disabled`, `trust`, `approve-mcps`):

```bash
AAB_CURSOR_BIN=/path/to/agent \
lurekit run --agent cursor-cli --model <model-id> --permission-mode "ask,sandbox=enabled"
```

Codex CLI (binary `codex`, override `AAB_CODEX_BIN`); tokens map to `codex exec` flags
(`sandbox=read-only|workspace-write|danger-full-access`, `approve-for-me`, `yolo`,
`skip-git-repo-check`, `bypass-hook-trust`). The adapter keeps `codex exec`'s read-only sandbox
default unless a token loosens it, and it points `CODEX_HOME` at a run-scoped dir:

```bash
lurekit run --agent codex-cli --model <model-id> \
  --permission-mode "sandbox=workspace-write" --budget 5
```

OpenHands (binary `openhands`, override `AAB_OPENHANDS_BIN`); its CLI headless mode forces
always-approve with no sandbox, so the profile must name `always-approve` (alias `yolo`) or the
run is refused, and the run must sit inside the bench container/VM boundary:

```bash
lurekit run --agent openhands --model openai/<served-model> \
  --permission-mode always-approve
```

`--setting-sources`, `--settings` and `--hooks` are claude-code only; the CLI rejects them for
the other agents rather than digest a body the agent would never receive.

## Next steps

- [CLI reference](cli-reference.md) -- every subcommand, flag, exit code, environment variable,
  the run-directory layout, and the permission_mode token table.
- [`../../README.md`](../../README.md) -- project overview and status.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) -- adding a scenario.
- [`../design/evidence-spec.md`](../design/evidence-spec.md) -- the evidence and detector
  contract (run-directory layout is section 2.1).
