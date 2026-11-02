# agent-attack-bench

A runnable, disclosure-traced security benchmark for deployed coding-agent configurations.

You point it at the coding-agent setup you actually run (agent, model, permission mode, settings, MCP servers,
hooks, skills). It replays scenarios derived from public security disclosures against that setup, using inert
fixtures and out-of-band detectors, and reports **"vulnerable to N of M scenarios"** with per-scenario evidence.

- Requires Node 20.19 or newer.
- Every scenario cites a public disclosure (`source.primary_url`); the citation is required by the scenario schema.
- Output: Markdown, JSON or SARIF.

## What it is not

These are hard constraints of the project:

Not a gateway/proxy/credential broker/runtime firewall; not a static scanner of MCP servers
or skills; not a model-level jailbreak bench; no SaaS/dashboards/multi-tenancy/auth; no
speculative attacks — every scenario cites a public disclosure (enforced by the scenario
schema's required `source.primary_url`).

## Inertness

Fixtures are inert by construction, enforced in the fixture base class rather than per scenario:

- a fixture binds only to loopback (`127.0.0.1`, `localhost`, `::1`) or to a harness-provided canary host;
- a fixture carries only canary values (random markers), never a real credential;
- a fixture never calls a canary itself, so a canary hit can only come from the agent under test.

Detectors are control sensors outside the agent. Each ships a positive and a negative control (`selftest`)
that proves it does not silently miss its own signal.

## Quick start

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

The scenario directory defaults to `./scenarios`; pass another as the positional `[dir]`.

`run` options (from `agent-attack-bench --help`):

```
--model <id> (required)  --agent <id> (default claude-code)
--agent-version <v>  --k <n>  --mode smoke|full  --vulnerable-if any|majority
--budget <usd>  --results <dir>  --workdir <dir>  --isolation container|container+netns
--permission-mode <m>  --settings/--mcp/--hooks <file.json>  --skill <dir> (repeatable)
--format json|markdown|sarif (default markdown)  --output <file>
```

Only `run` launches a real agent. Everything else is offline.

### Record once, replay offline

A live run costs money. Record one real Claude Code run and replay it as often as you like
through the same parsing and merging code that handles a live run (ADR-0015). You need no
auth, there's no spend and no network.

A recording is a directory:

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

## Status

- 45 scenarios catalogued in `scenarios/`; 27 are runnable.
- 4 detectors: `canary_egress_http`, `canary_file_read`, `canary_command`, `canary_mcp_tool`.
- 1 agent adapter: Claude Code (`--agent claude-code`).
- Scenarios for cursor-cli, codex-cli and openhands are catalogued via each scenario's `applies_to`;
  `plan()` skips them as `not_applicable` until those adapters exist (22 of the 27 runnable scenarios
  apply to claude-code, 5 to other agents).
- 18 browser-track scenarios are catalogued with `runnable: false`, pending a browser adapter;
  `plan()` skips them as `not_runnable`.
- The offline commands and the test suite run in CI. A live `run` against a real agent is a manual step
  performed by the maintainer; it is not part of CI.

## Adding a scenario

1. Add one YAML file under `scenarios/` (see existing `AAB-*.yaml` and `schemas/scenario.schema.json`).
2. It must cite the public disclosure it is derived from in `source.primary_url`. Scenarios without a public
   disclosure are out of scope.
3. Use only the existing inert fixtures and detectors.
4. Run `npm run build && node dist/cli.js validate`. CI runs the same validation
   (`node dist/tools/validate-scenarios.js scenarios`) on every push and pull request.

## Documentation

- [docs/BRIEF.md](docs/BRIEF.md) — project charter and non-goals.
- [docs/research/landscape.md](docs/research/landscape.md) — research and prior work.
- [docs/design/](docs/design/) — the design: [architecture.md](docs/design/architecture.md) (ADRs),
  [evidence-spec.md](docs/design/evidence-spec.md) (evidence and detector contract), standalone ADRs.
- [docs/plan/roadmap.md](docs/plan/roadmap.md) — roadmap.

## License

[MIT](LICENSE)
