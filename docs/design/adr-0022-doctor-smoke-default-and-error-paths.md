# ADR-0022: Doctor, smoke default and newcomer error paths

Status: proposed, implemented (2026-11-03); awaiting maintainer approval. Authorises
`lurekit doctor` (`src/doctor.ts`, `cmdDoctor` in `src/cli.ts`), the live-run plan and
confirmation in `cmdRun`, the post-run diagnosis (`src/diagnose.ts`), the stderr/result-error
warnings of the Claude Code adapter (`src/adapters/claudeCode.ts`), the stub failure modes in
`test/fixtures/agents/stub-claude.mjs`, and `test/doctor.test.ts` and
`test/newcomer-errors.test.ts`. Builds on ADR-0006 (cost control), ADR-0008 (adapters) and
ADR-0021 (the shipped demo bundle, used here as the cost basis).

## Context
A newcomer's first live run hit Node, binary, auth, model and cost surprises, and the messages did
not say what to do: a missing binary or a missing login produced a normal-looking report in which
every scenario was `inconclusive`, exit 0, with the reason only inside `evidence.json`. And a first
`lurekit run` launched immediately; with the shipped corpus and `--mode full` that is about 4.6 USD
on sonnet (the published run spent 3.84 USD on 21 scenarios at k=3).

## Decision
- **`lurekit doctor [dir] [--agent <id>] [--model <id>] [--format text|json]`.** Offline except
  for probing the LOCAL agent binary with commands that start no model turn. One line per check,
  `ok` / `warn` / `fail`, and for warn/fail one `fix:` line with a command. Exit 0 when no line is
  `fail`, else 1. `--format json` prints `{agent, model, checks[], estimate, fail, warn}`.
  Checks, in order:
  - `node`: `process.versions.node` >= 20.19 (package.json engines).
  - `binary`: the adapter's own resolution (`AAB_*_BIN`, else the default name on PATH, then
    realpath; `resolveAgentBinary`), the real path, and `<bin> --version` (last non-empty line,
    since OpenHands prints a banner first).
  - `update`: Claude Code under `.../lib/node_modules/@anthropic-ai/claude-code/` (or
    `npm/node_modules/...` on Windows) is the npm-global install that auto-updated in place and broke
    two live batches (NOTES); warn with the verified recipe `npm install --prefix
    .aab-runs/_bin/claude-<v> @anthropic-ai/claude-code@<v> && export AAB_CLAUDE_BIN=...`. A
    separate `--prefix` install is ok. Cursor: warn (auto-update on by default, NOTES). Codex and
    OpenHands: ok, with "UNVERIFIED (NOTES)".
  - `auth`, never reading a credential value:
    - claude-code: `claude auth status --json` (listed in `claude --help` 2.1.318; verified on
      this host with the network namespace removed: answers in about 0.2 s, exit 0 and
      `loggedIn: true` when logged in, exit 1 and `loggedIn: false` with an empty HOME). Only
      `loggedIn` and `authMethod` are kept; the other fields (account email, org) are discarded
      unread. Any other answer prints `not checked: ... run it yourself`. The probe runs only when
      `--version` answered `<x.y.z> (Claude Code)` with x.y.z >= 2.1.317 (`claude auth --help`
      lists `status` on 2.1.317 and 2.1.318); an older, unversioned or non-Claude binary is never
      asked (it might read `auth status` as a prompt) and the line says `not checked`.
    - cursor-cli: `CURSOR_API_KEY` present -> ok (not validated); else `agent status --format json`
      (verified 2026-11-03: `{"status":"unauthenticated","isAuthenticated":false,...}`, offline;
      it reports the login only, not the key, so the key check comes first).
    - codex-cli: the adapter gives each run its own `CODEX_HOME`, so only `CODEX_API_KEY` reaches
      the run; absent -> fail.
    - openhands: `LLM_API_KEY` absent -> fail (the CLI's own "Missing required environment
      variable(s): LLM_API_KEY", reproduced 2026-11-03), plus a `permission` warn: headless needs
      `--permission-mode always-approve`.
  - `model`: no adapter validates a model id offline. Claude: the documented aliases from `claude
    --help` ('fable', 'opus', 'sonnet') or a `claude-*` name are ok, anything else warns.
  - `isolation`: `--isolation container|container+netns` is copied into `manifest.config.isolation`
    and nothing else (verified by reading `src/cli.ts` buildConfig and `src/runner/runner.ts`
    writeManifest); no container runtime is started, required or checked.
  - `corpus` (the shipped `scenarios/` unless `[dir]` is given) and `selftest`: the detector
    self-tests run once (`runDetectorSelfTests`, shared with `lurekit selftest`) and the runner's own
    `plan` reuses the results to count the scenarios that would run for the agent.
  - `cost`: per scenario-repetition cost = the shipped demo manifest's `totals.spend_usd` divided by
    its repetitions (3.838067 / 63 = 0.061 USD), only when the demo's agent is the agent checked:
    "about X USD for smoke (k=1), about Y USD for full (k=3) on sonnet, from a published run; other
    models differ". Any other agent: "no published run yet for <agent>, no estimate".
- **Smoke by default, with confirmation.** `run` without `--mode` is smoke (k=1), as before. A
  live run (no `--replay`) now prints the plan first: scenarios kept/skipped, k and mode, the
  number of launches, the estimate (same basis, scaled by the run's own k), the budget cap; with
  the host probe it adds the `binary` and `auth` lines. Then:
  - `--yes`: launch without a prompt;
  - stdin is a terminal: ask `Launch? [y/N] `; only `y`/`yes` launches;
  - otherwise refuse with exit 1 and a message naming `--yes`, so CI never launches by accident.
  `--mode full` asks the same way. `--replay` never asks (zero cost). A `fail` binary line refuses
  before the prompt, with the fix. An openhands profile without `always-approve` is refused once
  up front instead of failing in every repetition.
- **Progress.** `run` prints `[i/N] <scenario id> <name>` before each scenario (the same
  plan -> runScenario -> writeManifest steps as `BenchmarkRunner.run`, unrolled in the CLI), so a
  stalled agent is visible.
- **Post-run diagnosis.** After the report, the warnings of every repetition that did not measure
  are classified (first match wins): budget, binary, permission, auth, network, model, adapter.
  Each category prints what happened, one recorded warning, the evidence path and `next: <command>`.
  When nothing was measured and a category other than budget is present, `run` exits 1.
- **Claude Code adapter.** On a non-zero exit it records `agent exited <n>; stderr: <excerpt>`
  (`stderrExcerpt`: one line, capped, live-credential shapes withheld; at most 64 KiB is held in
  memory and nothing is written to disk), and a final result event with `is_error: true` records
  `result event reports is_error=true: <excerpt>`. Before, both were dropped.

## Before and after
Reproduced on 2026-11-03. "real" = the installed binary with no credentials, run with the network
namespace removed (`unshare -rn`, loopback up), so nothing could be spent; "stub" = the offline
test stubs. No Claude Code `-p` run was made.

| Failure | How reproduced | Before | After |
|---------|----------------|--------|-------|
| No agent binary | real (PATH without `claude`) | Run started; each repetition retried 4 times (about 7 s) and became inconclusive(adapter_error); stderr showed only the run header and manifest path; exit 0. Reason only in evidence: `version probe failed after 4 attempt(s): agent binary "claude" not found or not executable` | Before launch, exit 1: `refusing to launch: claude-code binary "claude" not found on PATH (and AAB_CLAUDE_BIN is not set).` / `Next: npm install --prefix .aab-runs/_bin/claude-2.1.317 @anthropic-ai/claude-code@2.1.317 && export AAB_CLAUDE_BIN=...`. Without the probe (adapter-level): `the claude-code binary could not be launched` ... `next: lurekit doctor --agent claude-code`, exit 1 |
| Wrong `AAB_CLAUDE_BIN` | real (`/opt/nope/claude`) | Same as above with the path; exit 0 | `refusing to launch: AAB_CLAUDE_BIN=/opt/nope/claude does not point to an executable file.` / `Next: fix the path (...) or run: unset AAB_CLAUDE_BIN`, exit 1 |
| Cursor not logged in | real (agent 2026.10.22-27dcf5f) | Report all inconclusive, exit 0; `agent authentication failed (exit 1): Error: Authentication required. ...` only in evidence | Plan shows `fail auth not logged in (agent status: isAuthenticated=false) and CURSOR_API_KEY is not set` / `fix: agent login`; after the run `cursor-cli is not authenticated for this run` / `next: agent login, then lurekit doctor --agent cursor-cli`, exit 1 |
| Codex without `CODEX_API_KEY` | stub (replays the observed 401 sequence; a real run needs api.openai.com) | Exit 0, 401 text in evidence only | doctor `fail auth CODEX_API_KEY is not set; lurekit runs codex with a run-scoped CODEX_HOME ...`; after a run `next: export CODEX_API_KEY=<your key>, then lurekit doctor --agent codex-cli`, exit 1 |
| OpenHands without `--permission-mode` | real (OpenHands CLI 1.16.0) | Every repetition inconclusive(adapter_error), exit 0; the adapter's refusal only in evidence | `refusing to run: openhands: headless mode always runs always-approve with no sandbox; the profile must state permission_mode: always-approve to run it (pass --permission-mode always-approve)`, exit 1, nothing launched |
| OpenHands without `LLM_API_KEY` | real | inconclusive(precondition_failed), exit 0 | Plan shows `fail auth LLM_API_KEY is not set ...`; after `openhands is not authenticated for this run` / `next: export LLM_API_KEY=<your key>, then lurekit doctor --agent openhands`, exit 1 |
| Claude Code not logged in | stub (`AAB_STUB_FAIL=auth`; wording is a placeholder) and `claude auth status` real | Adapter dropped stderr and the result text: evidence had only the exit code; exit 0 | doctor `fail auth not logged in (claude auth status: loggedIn=false)` / `fix: claude auth login (or export ANTHROPIC_API_KEY=<your key>)`; the adapter records `result event reports is_error=true: ...`, the diagnosis says `next: claude auth login, then lurekit doctor --agent claude-code`, exit 1 |
| Unknown model id | codex real (offline): `Model metadata for <id> not found. Defaulting to fallback metadata` and it still calls the API; cursor real: the auth check runs first, so not observable; openhands real: the key check runs first; claude: stub only | Not distinguished from any other inconclusive | doctor `model` line (claude: warn with `--model sonnet`); diagnosis `the model id "<id>" is not one <agent> knows` when a recorded text says so |
| `--budget` reached mid-run | stub (cost 1 USD per run, `--budget 1.5`, k=3) | Two repetitions inconclusive(budget_exhausted) in the table, no hint, exit 0 | `- 2 repetition(s): not run: the next repetition could have exceeded --budget 1.5 USD (spent 1.00 USD so far)` / `next: re-run with a higher cap, e.g. --budget 3`, exit 0 (something was measured) |
| Network off | claude stub (`AAB_STUB_FAIL=network`); codex real (offline) | claude: nothing recorded; codex: retries forever ("Reconnecting... waiting for network"), no output from lurekit | claude: `agent exited 1; stderr: Error: getaddrinfo ENOTFOUND ...` and `could not reach its model API (network or DNS failure)`. codex: still hangs (no per-repetition timeout), but the `[i/N]` progress line names the stuck scenario |
| Scenario dir missing | real | `refusing to run: 1 scenario file(s) are invalid (run 'validate' first)` | `refusing to run: scenario directory "<dir>" does not exist. Next: pass the path of a scenario directory, e.g. the corpus shipped with lurekit: <path>` |
| Invalid scenario file | stub corpus | Count only | Count, the first file and message, `Next: lurekit validate <dir>` |
| Results dir not writable | real (mode 555 parent) | Header printed, then `error: EACCES: permission denied, mkdir '<dir>'` | `refusing to run: cannot write results under <dir> (EACCES). Next: pass --results <a directory you can write>, e.g. --results ./lurekit-runs`, before any launch |
| Live run in CI without `--yes` | real (stdin `/dev/null`) | Launched | `refusing to launch: a live run starts claude-code and spends money, and stdin is not a terminal, so lurekit cannot ask.` / `Next: re-run with --yes ...`, exit 1 |

## Consequences
- A script that called `lurekit run` for a live agent without a terminal must add `--yes`. CI is
  unaffected: its two `run` calls use `--replay`.
- `run` exits 1 when nothing was measured for a setup reason; a run with at least one measurement
  still exits 0, so the replay CI jobs keep exit 0.
- The cost estimate is one published run's client-side figure for one model; it is printed as an
  estimate and labelled with its source. It will move when a new bundle replaces the demo.
- `claude auth status` reads Claude Code's own credential store (as `claude` itself does); lurekit
  keeps two fields. A login does not prove that a subscription or key can pay for `-p` runs.
- Open: no per-repetition timeout, so an agent that waits for the network forever (codex) still
  blocks the run; the real Claude Code texts for "not logged in", "unknown model" and "offline" in
  `-p` mode are UNVERIFIED (no live run was made), so the stub texts and the diagnosis patterns for
  them are placeholders until a recording exists.
