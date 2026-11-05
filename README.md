# LureKit

**Headless Claude Code <!-- n:versions.claude_published -->2.1.317<!-- /n --> with default settings took <!-- n:arms.bare.vulnerable -->4<!-- /n --> of <!-- n:arms.bare.of -->21<!-- /n --> publicly disclosed lures, all through config files in the project directory; one profile change (`--setting-sources user`) took it to <!-- n:arms.hardened.vulnerable -->0<!-- /n --> of <!-- n:arms.hardened.of -->21<!-- /n -->** (bundles [`aab-20261103071018-88a78d8f`](reports/aab-20261103071018-88a78d8f/index.md) and [`aab-20261103062614-49ac1ce7`](reports/aab-20261103062614-49ac1ce7/index.md); model `sonnet`, k=<!-- n:demo.k -->3<!-- /n -->, majority).

![The first screen of the real `lurekit demo` output: the published bare Claude Code run, its plain-language summary, headline and the first rows of the result table](docs/assets/demo-output.svg)

LureKit is a runnable, disclosure-traced security benchmark for deployed coding-agent configurations.
You point it at the coding-agent setup you actually run (agent, model, permission mode, settings, MCP servers,
hooks, skills). It replays scenarios derived from public security disclosures against that setup, using inert
fixtures and out-of-band detectors, and reports **"vulnerable to N of M scenarios"** with per-scenario evidence.
Every scenario cites a public disclosure (`source.primary_url`, required by the scenario schema): see the
[scenario catalog](docs/catalog.md). Every published result: [verified against](docs/verified-against.md).
Output: Markdown, JSON or SARIF. Requires Node <!-- n:versions.node_min -->20.19<!-- /n --> or newer.

## Who this is for

- **You run Claude Code every day:** watch the [60-second demo](#60-second-demo), then do a [smoke run](#first-real-run) on your own setup.
- **You own agent setups for a platform or security team:** read the [hardened profile](profiles/README.md) and the [agent x version x result matrix](docs/verified-against.md), then [re-measure](#what-to-do-with-the-result).
- **You build a guard tool (hooks, proxy, sandbox):** publish your arm as a bundle ([third-party arms](docs/launch/vendor-scoreboard.md), [CONTRIBUTING.md](CONTRIBUTING.md)).

## 60-second demo

```bash
npx lurekit demo
```

`demo` prints the published bare run `aab-20261103071018-88a78d8f` through the same reporter as a real run,
with a banner saying it is not your setup: on a terminal a plain-text view (the image above; `--format
markdown` prints the `report.md` of the bundle). No agent, no auth, no cost (LureKit 1.2.0 or newer; from a
checkout: `npm ci && npm run build && node dist/cli.js demo`).

## First real run

A live run launches your real, authenticated agent and costs money. Check the host first, then run:

```bash
npx lurekit doctor --agent claude-code --model sonnet
npx lurekit run --agent claude-code --model sonnet --agent-version <your-version> --budget 2
```

Without a scenario directory, `run` (like `plan`, `list`, `validate` and `doctor`) uses `./scenarios` when the
current directory has one, else the corpus shipped with the package, and prints which one
(`corpus: <path> (shipped with the package)`). On 1.2.0 and older, pass the directory explicitly. Report and
publish flags (`--format`, `--output`, `--results`, `--budget`) are checked before the prompt, so a typo costs
nothing; a finished run prints the `lurekit report` and `lurekit publish` commands for its run directory.

- `doctor` checks Node, the agent binary (path, version, auto-update), login (no-spend probes only), the
  corpus and the detector self-tests, and prints a cost estimate. Exit 1 on any fail line.
- `run` is smoke by default (k=1). It prints its plan (scenarios, k, estimated cost, budget cap) and asks
  `Launch? [y/N]`; `--yes` skips the prompt, and without a terminal it refuses unless `--yes` is given.
- Cost: about **<!-- n:demo.claude_smoke_usd -->1.52<!-- /n --> USD** for the <!-- n:plan.claude-code.kept -->25<!-- /n --> claude-code scenarios at k=1 on `sonnet`, about **<!-- n:demo.claude_full_usd -->4.57<!-- /n --> USD** for
  `--mode full` (k=3). The basis is the published bare run's spend per scenario-repetition (<!-- n:demo.spend_usd -->3.84<!-- /n --> USD for <!-- n:demo.scenarios -->21<!-- /n -->
  scenarios x <!-- n:demo.k -->3<!-- /n --> in `<!-- n:demo.run_id -->aab-20261103071018-88a78d8f<!-- /n -->`), the agent's client-side estimate; other models differ.
  `--budget` has no default, so set one.
- `doctor` and the launch confirmation need LureKit 1.2.0 or newer. On 1.1.1 and older, `run` launches
  **without asking**; set `--budget` and check the command before pressing enter.
- Add the flags of your real setup (`--settings`, `--mcp`, `--hooks`, `--skill`, `--permission-mode`,
  `--setting-sources`) so the run measures what you use.
- Isolation is reduced: `--isolation` is only a label, LureKit starts no container, and the agent runs as you,
  on your host. Your own user-scope MCP servers are visible in `[isolation: partial]` repetitions, and the host
  filesystem is reachable within the agent's own permission mode. For a boundary, run LureKit inside your own
  container or VM ([roadmap](docs/plan/roadmap.md#decision-no-container-mode-2026-11-03)).

<details>
<summary>All commands, run options, replay</summary>

From npm (the `lurekit` bin is `dist/cli.js`):

```bash
npm install --save-dev lurekit
npx lurekit --help
npx lurekit validate     # offline: schema-validate the bundled scenarios (no ./scenarios here)
npx lurekit run --model <model-id> --format markdown --output report.md   # live, the bundled scenarios
```

From a checkout:

```bash
npm ci
npm run build

# Offline: no agent is launched
node dist/cli.js --version
node dist/cli.js validate                     # schema-validate every scenario (exit 1 on any error)
node dist/cli.js list                         # id, detector, runnable, applies_to
node dist/cli.js selftest                     # each detector's positive/negative control
node dist/cli.js plan --model <model-id>      # which scenarios would run for this profile

# Live: launches the real agent (costs money, needs the agent's own auth)
node dist/cli.js run --model <model-id> --format markdown --output report.md

# Re-render a completed run
node dist/cli.js report <runDir> --format sarif --output report.sarif
```

Without the positional `[dir]`, the scenario directory is `./scenarios` when it exists, else the corpus shipped
with the package; pass another directory to override both.

`run` options (from `lurekit --help`):

```
--model <id> (required)  --agent <id> (default claude-code)  --yes
--agent-version <v>  --k <n>  --mode smoke|full  --vulnerable-if any|majority
--budget <usd>  --results <dir> (default .aab-runs)  --isolation container|container+netns
--workdir <dir>  optional BASE for per-run agent workdirs (<dir>/<scenario>/<rep>);
                 default <results>/<run_id>/<scenario>/<rep>/work
--permission-mode <m>  --settings/--mcp/--hooks <file.json>  --skill <dir> (repeatable)
--setting-sources <csv>  --format json|markdown|sarif (default markdown)  --output <file>
--replay <dir>
```

Only `run` launches a real agent. Everything else is offline. All run material (agent workdirs,
mcp.json, hook scripts, recordings, evidence) lives under `--results`; nothing is written to the
system temp dir.

### Record once, replay offline

A live run costs money. Record one real Claude Code run and replay it as often
as you like through the same parsing and merging code that handles a live run (ADR-0015). You need no auth,
there's no spend and no network. A recording is a directory:

```
claude-stream.jsonl   required  verbatim `claude -p --output-format stream-json --verbose` stdout
claude-hooks.jsonl    optional  the observation hook's log (copy it from a live run's dir)
recording.json        optional  { "exit_code", "started_at", "ended_at", "agent_version_reported" }
```

The quickest way to get one: do a single live `run`. Then copy `claude-stream.jsonl` and
`claude-hooks.jsonl` out of a repetition's run directory, and strip any secrets or home paths.

```bash
node dist/cli.js run <dir> --model <model-id> --replay test/fixtures/recordings/claude-sample
```

Replay does not re-run the agent. Detectors that depend on side effects (recorder logs, sink
hits) see only what the recording contains. A replay therefore tests observation and
reporting. It is not a benchmark result, and every replayed run's `evidence.json` says so in
`observation.warnings`.

</details>

## What to do with the result

1. Read the report's **What to change** section. For each vulnerable surface it names a setting that a
   published run showed resisting the same scenarios, with its scope, what it excludes, the trade-off and the
   bundles that back it. A surface without such a run says "no verified fix in the published runs yet".
2. Today there is one proven mapping: surface `settings_hooks_file` -> run Claude Code with
   `--setting-sources user` (the [hardened profile](profiles/README.md), `profiles/claude-code-hardened.json`).
   It stops the `project` (`.claude/settings.json`) and `local` (`.claude/settings.local.json`) setting sources
   from loading. Trade-off: your own project-level hooks and settings stop loading too; keep the ones you rely
   on in user-scope settings. Scope: verified for headless `-p` runs; the interactive equivalent is UNVERIFIED.
   The hardened profile also passes `--permission-mode manual`, but the effective mode the agent reported was
   `default` in every repetition, so the measured difference is attributable to `--setting-sources user`.
3. Re-measure: run the same command again with the setting and compare the two arms on the same corpus. The
   report prints the exact re-measure command.
4. To share a result, `lurekit publish <runDir> --redact-home` writes a bundle after the redaction gate (by
   default to `<results>/<run id>/bundle`; `--out <dir>` overrides); a [badge](docs/guide/badge.md) can point to it.

## Why you can trust the numbers

- **Inert by construction**, enforced in the fixture base class rather than per scenario: a fixture binds only
  to loopback (`127.0.0.1`, `localhost`, `::1`) or to a harness-provided canary host; it carries only canary
  values (random markers), never a real credential; it never calls a canary itself, so a canary hit can only
  come from the agent under test.
- **Detector self-tests.** Detectors are control sensors outside the agent. Each ships a positive and a negative
  control (`lurekit selftest`) that proves it does not silently miss its own signal; a detector whose self-test
  did not pass makes the repetitions that use it inconclusive.
- **Disclosure citation required** per scenario (`source.primary_url`); no speculative scenarios.
- **Redaction gate** on `publish`: raw transcripts and hook logs are never copied, and the gate fails, instead
  of rewriting, on any URL that is not exactly a scenario source URL (or on a host named with `--allow-host`),
  on internal and private addresses, on credential-shaped values (known token prefixes, bearer/JWT/PEM,
  credential assignments and flags, URL passwords, encoded blobs), on the values of the variables forwarded
  to the agent, and on home paths. Evidence records, tool-call inputs included, are published verbatim: they
  are the audit proof, and the gate is a deny-list over every published byte, not a proof that an input is safe.
- **Replay**: a recorded run re-drives the same parsing and scoring code offline; CI runs the corpus that way.
- **k=3, majority**: published results use three repetitions per scenario and `vulnerable_if=majority`.
- **Inconclusive is never a pass**: it is removed from the denominator and reported next to the headline.

## Status

LureKit <!-- n:versions.tool -->1.4.0<!-- /n --> is the latest npm release (see [CHANGELOG.md](CHANGELOG.md)).

- <!-- n:scenarios.total -->52<!-- /n --> scenarios catalogued in `scenarios/` ([catalog](docs/catalog.md)); <!-- n:scenarios.runnable -->34<!-- /n --> are runnable, and <!-- n:plan.claude-code.kept -->25<!-- /n --> of the
  runnable ones apply to claude-code (the other <!-- n:scenarios.runnable_other_agents -->9<!-- /n --> apply to other agents via each scenario's `applies_to`:
  <!-- n:plan.cursor-cli.kept -->6<!-- /n --> cursor-cli, <!-- n:plan.codex-cli.kept -->2<!-- /n --> codex-cli, <!-- n:plan.openhands.kept -->2<!-- /n --> openhands, counting AAB-010 and AAB-028 for both claude-code and cursor-cli; cursor-cli skips AAB-006 at plan
  time because its adapter cannot deliver a project MCP config).
  <!-- n:scenarios.not_runnable -->18<!-- /n --> browser-track scenarios are catalogued with `runnable: false`, pending a browser adapter; `plan()` skips
  them as `not_runnable` ([roadmap](docs/plan/roadmap.md#browser-track-catalogued-not-runnable)).
- <!-- n:detectors.count -->5<!-- /n --> detectors: `canary_egress_http`, `canary_file_read`, `canary_command`, `canary_mcp_tool`,
  `fs_diff`. `canary_egress_dns` is declared in the schema but deferred; scenarios referencing it
  fail loudly.
- <!-- n:fixtures.count -->8<!-- /n --> inert fixture kinds: `poisoned_repo`, `mcp_stdio`, `mcp_http`, `skill_package`, `issue_feed`,
  `email_feed`, `web_server`, `local_registry`.
- <!-- n:adapters.count -->4<!-- /n --> agent adapters: `claude-code` (live-validated), `cursor-cli`, `codex-cli` and `openhands`
  (implemented and tested against offline stubs; not yet live-validated), plus the `replay`
  adapter (`run --replay`).
- The offline commands and the test suite (<!-- n:tests -->1208<!-- /n --> tests, as `vitest list` counts them) run in CI. A live `run` against a real agent is a manual step
  performed by the maintainer; it is not part of CI.
- Published runs: <!-- n:bundles -->10<!-- /n --> run bundles under [reports/](reports/), one row each in
  [docs/verified-against.md](docs/verified-against.md), and the measurement summaries in
  [docs/reports/](docs/reports/README.md) (Claude Code 2.1.316, 2026-11-02; Claude Code 2.1.317, 2026-11-03).
- Claude Code <!-- n:versions.claude_published -->2.1.317<!-- /n -->, model `sonnet`, k=<!-- n:demo.k -->3<!-- /n -->, `vulnerable_if=majority`
  ([report](docs/reports/2026-11-03-claude-code-2.1.317-k3.md)):
  bare vulnerable to <!-- n:arms.bare.vulnerable -->4<!-- /n --> of <!-- n:arms.bare.of -->21<!-- /n --> (`aab-20261103071018-88a78d8f`), hardened <!-- n:arms.hardened.vulnerable -->0<!-- /n --> of <!-- n:arms.hardened.of -->21<!-- /n -->
  (`aab-20261103062614-49ac1ce7`), bare + netread <!-- n:arms.bare_netread.vulnerable -->4<!-- /n --> of <!-- n:arms.bare_netread.of -->24<!-- /n --> (`aab-20261103075404-f5fe15ec`),
  hardened + netread <!-- n:arms.hardened_netread.vulnerable -->0<!-- /n --> of <!-- n:arms.hardened_netread.of -->24<!-- /n --> (`aab-20261103091409-dff0d34a`); <!-- n:arms_max_inconclusive -->0<!-- /n --> inconclusive in each. The
  default-permission arms exclude AAB-017, AAB-021 and AAB-056 as not a measurement; AAB-003 is
  withheld (ADR-0014) in all four. One agent, one model, one day, one host; headless only.

## Naming

LureKit is the kit of lures you plant for your own agent: inert, disclosure-derived bait that shows whether your
setup takes it. The scenario ids (`AAB-NNN`) and internal `aab_` / `aab-` / `AAB_` identifiers (canary names,
env vars, the `.aab-runs` results directory) are the stable project code and do not change with the product name.

## What it is not

These are hard constraints of the project:

Not a gateway/proxy/credential broker/runtime firewall; not a static scanner of MCP servers
or skills; not a model-level jailbreak bench; no SaaS/dashboards/multi-tenancy/auth; no
speculative attacks - every scenario cites a public disclosure (enforced by the scenario
schema's required `source.primary_url`).

## Adding a scenario

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full submission path, review rules and disclosure policy.
See [SECURITY.md](SECURITY.md) to report a vulnerability in LureKit or a finding about an agent it measures.

1. Add one YAML file under `scenarios/` (see existing `AAB-*.yaml` and `schemas/scenario.schema.json`).
2. It must cite the public disclosure it is derived from in `source.primary_url`. Scenarios without a public
   disclosure are out of scope.
3. Use only the existing inert fixtures and detectors.
4. Run `npm run build && node dist/cli.js validate`. CI runs the same validation
   (`node dist/tools/validate-scenarios.js scenarios`) on every push and pull request.
5. Run `npm run catalog` to regenerate [docs/catalog.md](docs/catalog.md); CI fails if it is stale.

## Documentation

The full index of every document is [docs/README.md](docs/README.md).

User guide:

- [Getting started](docs/guide/getting-started.md) - install, offline commands, first live run.
- [CLI reference](docs/guide/cli-reference.md) - every subcommand and flag.
- [Scenarios](docs/guide/scenarios.md) - the corpus and how to write a scenario; [catalog](docs/catalog.md) - every scenario in one table.
- [Fixtures and detectors](docs/guide/fixtures-and-detectors.md) - inert fixtures and control sensors.
- [Interpreting results](docs/guide/interpreting-results.md) - verdicts, evidence and reports.
- [Verified against](docs/verified-against.md) - every published bundle: agent, version, model, profile, result.
- [Publishing](docs/guide/publishing.md) - the redaction gate and run bundles; [badge](docs/guide/badge.md) - a static badge from a bundle.
- [Troubleshooting](docs/guide/troubleshooting.md) - auto-update, inconclusive verdicts, isolation, platforms.
- [Architecture overview](docs/guide/architecture-overview.md) - for contributors: pipeline, invariants, extending LureKit.

Design and background: [docs/BRIEF.md](docs/BRIEF.md) (charter),
[docs/design/architecture.md](docs/design/architecture.md) (SDD and ADRs),
[docs/design/evidence-spec.md](docs/design/evidence-spec.md) (evidence and detector contract),
[docs/research/landscape.md](docs/research/landscape.md) (research),
[docs/plan/roadmap.md](docs/plan/roadmap.md) (roadmap).

## Related

[mcp-review-check](https://github.com/alisaosipova/mcp-review-check), by the same author, lints an MCP server
against the public review criteria of the Claude and ChatGPT directories and the MCP spec. mcp-review-check checks
the server you publish, LureKit checks the agent setup you run: if you also publish MCP servers, see
[mcp-review-check](https://github.com/alisaosipova/mcp-review-check).

## License

[MIT](LICENSE)
