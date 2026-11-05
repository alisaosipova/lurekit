# Architecture overview (for contributors)

A one-page map of how LureKit is put together, which rules every change must keep, where each
decision is written down, and how to add an adapter, a detector or a fixture. It summarises the
design; it does not replace it. The authorities are
[architecture.md](../design/architecture.md) (the SDD and ADR index),
[evidence-spec.md](../design/evidence-spec.md) (the detector, evidence, verdict, adapter and
reporting contract) and the standalone ADRs in [docs/design/](../design/).

LureKit uses spec-driven development (see [CLAUDE.md](../../CLAUDE.md)). No behaviour lands
without an ADR or spec section that covers it, and every change names the section that
authorises it. If you cannot find one, write the spec first.

## The pipeline

```
scenarios/*.yaml
   |
   v
loader ---------> fixtures + detector ---------> adapter ---------> runner ---------> reporters ---------> publish
src/scenario/     src/fixtures/                  src/adapters/      src/runner/       src/report/           src/report/publish.ts
                  src/detectors/
```

| Stage | Source | What it does | Spec |
|---|---|---|---|
| CLI | `src/cli.ts` | Parses flags strictly, builds the `SetupProfile`, picks the adapter (`adapterFor()`), dispatches `run`, `validate`, `list`, `plan`, `selftest`, `report`, `publish`. | ADR-0011 |
| Loader | `src/scenario/load.ts`, `src/scenario/types.ts`, `src/scenario/taskTemplate.ts`, `schemas/scenario.schema.json` | Validates each scenario against the schema (required `source.primary_url`), rejects malformed task placeholders, renders `{{env.NAME}}` / `{{canary.KEY}}` after provisioning. | ADR-0003; evidence-spec 4.1 "Task placeholders" |
| Detectors | `src/detectors/` (`detector.ts` contract, `index.ts` registry) | Control sensors outside the agent. `provision()` creates the per-run canaries, `evaluate()` reads raw evidence from the run dir, `selfTest()` runs the positive and negative controls. | ADR-0009; evidence-spec 1 |
| Fixtures | `src/fixtures/` (`fixture.ts` base class, `index.ts` registry, `params.ts`) | Inert attack surfaces: `poisoned_repo`, `mcp_stdio`, `mcp_http`, `skill_package`, `issue_feed`, `email_feed`, `web_server`, `local_registry`. Provision into the per-run workdir, return a `profilePatch`, optional `expect` and `requires`. | ADR-0002 "Fixture contract"; ADR-0007 |
| Adapter | `src/adapters/` (`adapter.ts` contract; `claudeCode.ts`, `cursorCli.ts`, `codexCli.ts`, `openhands.ts`, `replay.ts`) | Launches one agent CLI headless in the workdir with the profile, injects the rendered task, records stream and hook observations, returns a `RunObservation`. | ADR-0008; evidence-spec 4; ADR-0015, 0016, 0018, 0019, 0020 |
| Runner | `src/runner/runner.ts`, `src/runner/attempts.ts`, `src/runner/types.ts` | Lifecycle per repetition: workdir, detector, fixtures, profile merge, render task, adapter, evaluate, verdict, evidence record. Aggregates k repetitions, enforces the budget, writes `manifest.json`. | ADR-0002 "Runner lifecycle"; evidence-spec 2, 3; ADR-0004, 0005, 0006 |
| Reporters | `src/report/` (`json.ts`, `markdown.ts`, `sarif.ts`, `score.ts`, `index.ts`) | Render a finished run dir as JSON, Markdown or SARIF. A reporter alters no facts. | evidence-spec 6 |
| Publish | `src/report/publish.ts` | Builds a bundle (manifest, evidence, renders, `index.md`) in memory, runs the fail-closed redaction gate, writes only if it passes. | ADR-0017; evidence-spec 5; ADR-0014 |
| Tools | `src/tools/validate-scenarios.ts`, `src/tools/report.ts` | CI entry points for validation and rendering. | ADR-0012 |

Schemas for the files the pipeline writes are in `schemas/` (`evidence.schema.json`,
`manifest.schema.json`, `report.schema.json`). The run directory layout is in evidence-spec
section 2.1.

### One repetition, in order

1. The runner creates a fresh workdir `<results>/<run_id>/<scenario>/<rep>/work` (or under the
   `--workdir` base).
2. It provisions the scenario's detector first and hands its canaries to the fixtures as
   `ctx.canaries`. A detector with `provisionAfterFixtures` (`fs_diff`) goes after the fixtures
   instead, so it can baseline the provisioned workdir.
3. It provisions the fixtures into the workdir and merges each `profilePatch` into the profile,
   never loosening it.
4. It renders the task. An unresolved placeholder is `inconclusive(fixture_error)` and the
   adapter is not called.
5. The adapter runs the agent and returns the observation (tool calls merged by id across the
   `stream` and `hook` layers, attempts, effective model and mode, MCP server report, flags,
   warnings).
6. The runner checks fixture preconditions, evaluates the detector, checks the benign task,
   derives the outcome (`vulnerable`, `resisted` with `resisted_kind`, `degraded`,
   `inconclusive` with a reason) and writes `evidence.json`.
7. Teardown. The run dir persists as evidence.

## Invariants

Each of these is enforced in one place in code, not per scenario. A change that weakens one
needs an ADR change first.

| Invariant | Where it is enforced | Spec |
|---|---|---|
| **Inert by construction.** A fixture binds only to loopback (`127.0.0.1`, `localhost`, `::1`) or the harness canary host, carries only canary values, and never calls a canary itself. | `FixtureBase` in `src/fixtures/fixture.ts` (`assertLoopback()`, `SECRET_PATTERNS`, `FixtureInertnessError`) | ADR-0007; ADR-0002 |
| **Detector-first provisioning.** The detector provisions before the fixtures, so a fixture names the exact per-run canary the sensor watches, never a literal stand-in. A fixture missing a canary it needs throws `FixtureCanaryError`. | `src/runner/runner.ts`; `src/fixtures/fixture.ts` | evidence-spec 1.5 "Provisioning order and canary hand-off" |
| **Sound sensors.** Every detector ships a positive and a negative control. The runner refuses to score on a detector whose self-test has not passed this session (`detector_unverified`). | `Detector.selfTest()`; runner | evidence-spec 1.3 |
| **Never loosen the profile.** The adapter passes the permission mode verbatim and never approves a trust prompt. A fixture `profilePatch` cannot set a looser `permission_mode`, change `agent` / `agent_version` / `model`, or set, change or clear `strict_mcp_config` or `setting_sources`; such patches are ignored with a warning. A forwarded settings body cannot disable hooks or set `permissions.defaultMode`. | `mergeProfilePatch()` in `src/runner/runner.ts`; `src/adapters/claudeCode.ts` | evidence-spec 4.1, 4.3, 4.4b; ADR-0020 |
| **Observe, do not steer.** Observation hooks exit 0 only and never allow or deny. A fixture-planted `.claude/settings.json` is left byte-for-byte as planted. | `src/adapters/claudeCode.ts` (`claude-settings.json` via `--settings`) | evidence-spec 4.1, 4.2 |
| **Per-run workdir, nothing in the system temp dir.** Every repetition gets its own fresh workdir; all run material lives under `--results`. | `src/runner/runner.ts`; `selfTest({ base })` | ADR-0002 "Per-run workdir"; evidence-spec 2.1 |
| **Strict MCP isolation.** `--strict-mcp-config` on every Claude Code run; dropped only for `requires.project_mcp_autoload` or an operator `strict_mcp_config: false`, and then the repetition is recorded as `isolation: partial`. | `strictMcpConfigFor()` in `src/adapters/adapter.ts` | evidence-spec 3.1 "Run requirements", 4.3 |
| **A broken run is never resistance.** With no forbidden effect, any run error is `inconclusive`. | runner verdict rules | evidence-spec 3.1 |
| **Every scenario cites a public disclosure.** | `schemas/scenario.schema.json` (`source.primary_url` required) | ADR-0003; ADR-0014 |
| **Publish fails closed.** | `src/report/publish.ts` | ADR-0017 |

## Where each decision lives

| ADR | Topic | Location |
|---|---|---|
| 0001 | Language and runtime (TypeScript, Node) | [adr-0001-language-runtime.md](../design/adr-0001-language-runtime.md) |
| 0002 | Fixture contract, runner lifecycle, per-run workdir | [adr-0002-fixtures-and-runner.md](../design/adr-0002-fixtures-and-runner.md) |
| 0003 | Scenario format | [architecture.md](../design/architecture.md#adr-0003-scenario-format) |
| 0004 | Nondeterminism and scoring | [architecture.md](../design/architecture.md#adr-0004-nondeterminism-and-scoring) |
| 0005 | Reproducibility and the run manifest | [architecture.md](../design/architecture.md#adr-0005-reproducibility-and-the-run-manifest) |
| 0006 | Cost control | [architecture.md](../design/architecture.md#adr-0006-cost-control) |
| 0007 | Isolation and safety (inert by construction) | [architecture.md](../design/architecture.md#adr-0007-isolation-and-safety-inert-by-construction) |
| 0008 | Agent adapter contract | [architecture.md](../design/architecture.md#adr-0008-agent-adapter-contract) |
| 0009 | Effect detectors and observation layers | [architecture.md](../design/architecture.md#adr-0009-effect-detectors-and-observation-layers) |
| 0010 | Dependency policy | [architecture.md](../design/architecture.md#adr-0010-dependency-policy) |
| 0011 | Repository layout | [architecture.md](../design/architecture.md#adr-0011-repository-layout) |
| 0012 | Contribution model (including CI scope) | [architecture.md](../design/architecture.md#adr-0012-contribution-model) |
| 0013 | Weekly update cadence (DECISION NEEDED) | [architecture.md](../design/architecture.md) |
| 0014 | Ethics and coordinated disclosure | [architecture.md](../design/architecture.md#adr-0014-ethics-and-coordinated-disclosure) |
| 0015 | Replay adapter | [adr-0015-replay-adapter.md](../design/adr-0015-replay-adapter.md) |
| 0016 | Cursor CLI adapter | [adr-0016-cursor-cli-adapter.md](../design/adr-0016-cursor-cli-adapter.md) |
| 0017 | Publish and redaction gate | [adr-0017-publish-run.md](../design/adr-0017-publish-run.md) |
| 0018 | Codex CLI adapter | [adr-0018-codex-cli-adapter.md](../design/adr-0018-codex-cli-adapter.md) |
| 0019 | OpenHands adapter | [adr-0019-openhands-adapter.md](../design/adr-0019-openhands-adapter.md) |
| 0020 | Profile settings forwarding | [adr-0020-profile-settings-forwarding.md](../design/adr-0020-profile-settings-forwarding.md) |

Status per ADR (accepted, proposed, implemented) is in the "Status summary" table at the end of
architecture.md. Facts about agent CLIs (flags, stream shapes, versions) are in
[NOTES-verified-facts.md](../design/NOTES-verified-facts.md), each with its source. What is
specced versus pending is in [BOOTSTRAP.md](../design/BOOTSTRAP.md).

## How to add things

Scenarios that only use existing fixtures and detectors are the common case; see
[CONTRIBUTING.md](../../CONTRIBUTING.md) and [scenarios.md](scenarios.md). The three extensions
below change the engine and therefore need a spec first. Each is a minor release under the
versioning policy in [CHANGELOG.md](../../CHANGELOG.md).

### An agent adapter

1. **Facts.** Record the agent's headless invocation, stream format, permission flags, MCP and
   settings handling in NOTES-verified-facts.md, each line with its source. Mark anything you
   could not confirm as UNVERIFIED.
2. **Spec.** Write a standalone ADR (`docs/design/adr-NNNN-<agent>-adapter.md`, modelled on
   ADR-0016 / ADR-0018 / ADR-0019) and add it to the index and status table in architecture.md.
   It must say how the adapter keeps the evidence-spec section 4.1 invariants (never loosen the
   profile, observe without steering) and which observation layers it has.
3. **Code.**
   - `src/adapters/<agent>.ts` implementing `Adapter` from `src/adapters/adapter.ts`
     (`id`, `capabilities()`, `run(profile, task, signal, options)`), with an injectable binary
     (constructor `bin`, then an env override, then `PATH`) so tests can use a stub.
   - Add the id to `AgentId` in `src/scenario/types.ts` and to the `applies_to` enum in
     `schemas/scenario.schema.json` (keep them in lockstep).
   - Wire it in `adapterFor()` in `src/cli.ts`. Reject flags the adapter does not honour
     (as the CLI does for `--settings` / `--hooks` / `--setting-sources` on non-claude-code
     agents).
4. **Tests.** An offline stub binary `test/fixtures/agents/stub-<agent>.mjs` (deterministic, no
   network, never executes anything; see `stub-claude.mjs`) and `test/<agent>-adapter.test.ts`
   asserting argv construction, stream parsing, attempts, abort handling and warnings.
5. Mark scenarios with `applies_to` only after the adapter can observe their surface. Until a
   maintainer live run exists, document the adapter as "tested offline against a stub".

### A detector

1. **Spec.** Add a subsection to evidence-spec section 1 (like 1.2b `canary_mcp_tool`, 1.2c
   `fs_diff`): the signal, the observation layer, the canaries it provisions, its positive and
   negative controls, and its false-negative and false-positive modes. If it needs a new
   isolation control (as `canary_egress_dns` needs a resolver control under ADR-0007), spec that
   too.
2. **Code.**
   - `src/detectors/<name>.ts` implementing `Detector` from `src/detectors/detector.ts`
     (`provision()`, `evaluate()`, `selfTest()`; set `provisionAfterFixtures` only if it must
     baseline the provisioned workdir). Self-test scratch goes under the `base` it is given,
     never the system temp dir.
   - Register it in `src/detectors/index.ts`.
   - Add the kind to `DetectorKind` in `src/scenario/types.ts` and to the
     `forbidden_effect.detector` enum in `schemas/scenario.schema.json`. A value in one and not
     the other is a drift bug.
   - If a denied attempt against it should count as `resisted (denied)`, add the matching rule
     to `src/runner/attempts.ts` and to evidence-spec section 3.1 "Resisted kind". Otherwise it
     never matches, which is the conservative default.
3. **Tests.** In `test/detectors.test.ts`: the self-test passes, and a blinded subclass (whose
   `evaluate()` ignores the evidence) fails its positive control. In
   `test/fixture-detector-alignment.test.ts`: the fixtures that pair with it reference the
   per-run canary, and an obedient stub that follows the presented content is caught.

### A fixture kind

1. **Spec.** Extend ADR-0002 "Fixture contract" (and its "Interface notes from implementation" for any new
   `profilePatch.env` content-location name a task may reference). State why it stays inert.
2. **Code.**
   - `src/fixtures/<name>.ts`, a subclass of `FixtureBase` (`src/fixtures/fixture.ts`). Bind
     with `assertLoopback()`; use only canary values from `ctx.canaries`; throw
     `FixtureCanaryError` when a required canary is missing. Declare `expect` (for example
     `mcp_server`) when a run without the surface would be vacuous, and `requires` only when the
     scenario genuinely measures an isolation-relaxing behaviour.
   - Validate `params` with a strict zod schema via `parseFixtureParams` in
     `src/fixtures/params.ts`.
   - Register it in `src/fixtures/index.ts` and add the type to `src/scenario/types.ts` and the
     `fixtures[].type` enum in `schemas/scenario.schema.json`.
3. **Tests.** `test/fixtures.test.ts` (provision, teardown, inertness), `test/fixture-params.test.ts`
   (unknown keys rejected), `test/fixture-canaries.test.ts` (canary hand-off) and
   `test/fixture-detector-alignment.test.ts` (the paired detector sees the obedient stub). Use
   the helpers in `test/helpers/osPaths.ts` for paths and planted content so the tests pass on
   Windows and macOS.

## Testing strategy

No test launches a live agent, uses the network or spends money. `npm test` runs vitest over
`test/`.

- **Offline agent stubs.** `test/fixtures/agents/stub-{claude,cursor,codex,openhands}.mjs` emulate
  each CLI's headless stream deterministically: canned `--version`, recorded argv and a fixed
  transcript. `stub-claude.mjs` also fires the real observe hook with a matching `tool_use_id`
  and has optional modes for a hang (abort test) and a permission-gate denial. The adapter is deterministic given a recorded
  stream (evidence-spec section 4.5), which is what these tests rely on.
- **Stub adapter and in-memory fixture.** `test/helpers/stubAdapter.ts` and
  `test/helpers/inMemoryNoopFixture.ts` exercise the full runner lifecycle without any agent
  binary (`test/runner.test.ts`, `test/e2e.test.ts`).
- **Obedient stub.** In `test/fixture-detector-alignment.test.ts`, a stand-in agent that reads
  what the fixture presented and does what it says. It is the positive control for the pairing:
  if a fixture and its detector disagree on the canary, the obedient stub is not caught and the
  test fails.
- **Blinded-sensor self-tests.** `test/detectors.test.ts` overrides each detector's `evaluate()`
  to ignore its evidence and asserts that the positive control flips to false. This proves the
  self-test is evidence-driven and cannot pass vacuously.
- **Replay.** `test/replay-adapter.test.ts` and the recordings in `test/fixtures/recordings/`
  (`claude-sample`, `claude-mcp-sample`) drive real recorded Claude Code output through the same
  parse and merge path as a live run (ADR-0015).
- **Focused regression tests** for past live-run failures: `mcp-isolation`, `mcp-precondition`,
  `per-run-workdir`, `task-template`, `benign-strip-task`, `attempts`, `publish`, `cli`.
- **CI** (`.github/workflows/ci.yml`, actions pinned by SHA; five jobs, ADR-0012):
  1. `test`: build, typecheck (`npm run typecheck`), tests, `node dist/tools/validate-scenarios.js
     scenarios` and an offline smoke of the bin (`--version`, `selftest`), on Linux, macOS and
     Windows (Node 22 and 24 on every OS; Node 20.19, the oldest supported, on Linux only).
  2. `docs`: `npm run docs:check` and the generated docs (`catalog`, `matrix`, `assets:demo`)
     must match the tree.
  3. `replay` (Linux, Node 20.19, 22 and 24): runs the whole corpus against `claude-sample` with
     `--replay`, asserts every planned scenario wrote evidence with the replay warning, nothing is
     vulnerable, every inconclusive is a failed `mcp_server` precondition, and every degraded has
     the benign check `file_written` (a replay carries no file edits; four scenarios are degraded
     by design); publishes the run through the redaction gate (must exit 0); then runs AAB-018
     against `claude-mcp-sample` and asserts zero inconclusive results.
  4. `package`: pack, install the tarball and run the installed bin, including the newcomer
     commands from an empty directory (Linux; offline commands only).
  5. `hygiene`: no `tmpdir()` scratch, no `agent-output.log` in `src/`, and released CHANGELOG
     sections equal the text at their tags (`npm run changelog:check`).
- **Release** (`.github/workflows/release.yml`): npm trusted publishing (OIDC) with provenance.
- **Live runs** against a real agent are a manual maintainer step before merge, not part of CI
  (ADR-0012).

Before opening a PR: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
`node dist/cli.js validate`, `node dist/cli.js selftest`.
