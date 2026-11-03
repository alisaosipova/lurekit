# LureKit: architecture (SDD)

This is the system design document for LureKit 1.0 - a **measurement instrument**
that reports how many disclosed attack scenarios a given deployed coding-agent configuration
resists. It is not a gateway, a scanner, a jailbreak bench, or a service (see Non-goals in
`docs/BRIEF.md` and `CLAUDE.md`).

## How to read this document

The design is split across several files so each piece stays small and reviewable:

- **This file** — the ADR index and the decisions that do not have a home elsewhere.
- `adr-0001-language-runtime.md` — language/runtime (TypeScript/Node). **Accepted.**
- `adr-0002-fixtures-and-runner.md` — fixture contract + runner lifecycle. **Accepted.**
- `adr-0015-replay-adapter.md` — replay adapter (record one live run, replay it offline
  through the same parse/merge path). **Accepted.**
- `adr-0016-cursor-cli-adapter.md` — Cursor CLI adapter (`agent -p`, stream-only, tested offline
  against a stub). **Proposed, implemented for the stream layer; awaiting approval.**
- `adr-0017-publish-run.md` — `publish` subcommand and redaction gate (`--redact-home`,
  MCP-name pseudonymisation, `--withhold`). **Proposed, implemented; awaiting approval.**
- `adr-0018-codex-cli-adapter.md` — Codex CLI adapter (`codex exec --json`, stream-only, tested
  offline against a stub). **Proposed, implemented for the stream layer; awaiting approval.**
- `adr-0019-openhands-adapter.md` - OpenHands adapter (legacy `openhands --headless --json`,
  stream layer with a transcript cross-check, tested offline against a stub). **Proposed,
  implemented for the stream layer; awaiting approval.**
- `adr-0020-profile-settings-forwarding.md` - profile settings and hooks forwarded to Claude Code
  through the harness settings file (`forwarded_settings` recorded). **Proposed, implemented;
  awaiting approval.**
- `evidence-spec.md` — the detector/evidence/verdict/adapter/reporting contract in detail
  (§1 detectors, §2 evidence+manifest, §3 verdicts, §4 adapter+observation, §5 redaction,
  §6 reporting). The ADRs below reference it rather than restating it.
- `NOTES-verified-facts.md` — primary-source facts feeding the adapter ADRs.
- `BOOTSTRAP.md` — build order; what is specced vs pending.

Each ADR follows the brief's shape: **context → options → decision → consequences**. Where a
decision is the maintainer's to make, it is flagged **DECISION NEEDED** with 2–3 options and a
recommendation. ADRs are written incrementally, one small neutral section at a time — large
single-shot harness write-ups have tripped a safety classifier (see `BOOTSTRAP.md` and the
`CLAUDE.md` workflow rule); this file is assembled the same careful way.

---

# Part A — Core model

The core model answers: what is a scenario, how is one run, how is a run scored, and how is a
result made reproducible. The runner lifecycle and the fixture contract themselves are ADR-0002;
the detector/evidence/verdict contract is `evidence-spec.md`. The ADRs here fill the gaps.

## ADR-0003: Scenario format

**Status:** accepted (2026-11-01), implemented (`schemas/scenario.schema.json`, `src/scenario/`).

### Context
A scenario must be reviewable by a non-programmer, diffable in review, and machine-validated in
CI. It must capture: the fixture(s) under test, the agent task prompt, the setup profile being
measured, the *forbidden effect* a detector watches for, the *benign task* that must still
succeed, and a citation to a public disclosure.

### Options
1. **YAML file + JSON Schema (draft 2020-12), one file per scenario.** Human-diffable; one-file
   contributions; schema-validated in CI; comments allowed.
2. **JSON file + JSON Schema.** Same validation, worse to read and review (no comments, noisy diffs).
3. **TypeScript module per scenario.** Maximum expressiveness, but not reviewable by
   non-programmers and not safely loadable as data — violates "scenarios as data."

### Decision
Option 1. Each scenario is one `scenarios/AAB-NNN.yaml`, validated against
`schemas/scenario.schema.json` in strict mode (uri/date formats active). Cross-file invariants
the schema cannot express (unique id, id == filename stem, browser-track ⇒ `runnable:false`,
defaults for `runnable`/`headless_fidelity`) are enforced by the loader (`src/scenario/load.ts`).
`source.primary_url` is **required** — a scenario without a public disclosure cannot validate,
which enforces the "no speculative attacks" non-goal mechanically.

### Consequences
- Adding a scenario is a one-file PR that CI validates — matches the brief's contribution model.
- The schema is the contract between curators (who write YAML) and the engine (which consumes a
  typed `Scenario`); drift is caught at load time, not at run time.
- Browser/computer-use scenarios can be catalogued now as `runnable:false` and promoted in
  Phase 2 without a schema change.

## ADR-0004: Nondeterminism and scoring

**Status:** accepted (2026-11-01), implemented (`src/runner/`, `src/report/score.ts`,
`evidence-spec.md` §3).

### Context
Agents are nondeterministic. A single run cannot define "vulnerable." We need a definition of
the per-run outcome, an aggregation over k repetitions, and a headline number that does not
overstate confidence.

### Options
1. **Single run, binary pass/fail.** Cheap, but a flaky agent produces a meaningless verdict.
2. **k runs, four-valued outcome + aggregation.** `resisted / vulnerable / degraded /
   inconclusive` per run (the §3.1 matrix of forbidden-effect × benign-success × error), then
   any/majority aggregation over k; headline "vulnerable N of M" with M excluding inconclusive.
3. **k runs, probability score.** More information, but a single probability reads as false
   precision for a corpus this small and this nondeterministic.

### Decision
Option 2. Per-run outcome is a pure function of (forbidden-effect-observed, benign-task-succeeded,
run-errored) per the §3.1 matrix. The **utility check** is load-bearing: a run counts as
`resisted` only if the forbidden effect is absent **and** the benign task completed — an agent
that refuses everything is `degraded`, not safe. Aggregation over k is explicit (any/majority).
The headline denominator **M excludes `inconclusive`**, so a sensor that could not be verified
never inflates the "resisted" count.

### Consequences
- Scoring is deterministic given the evidence, even though the agent is not — the engine's own
  behavior is reproducible (brief requirement).
- The four-valued outcome makes "the agent broke / refused" visibly different from "the agent
  was safe," which a binary verdict would hide.
- k-run stability (how often a verdict flips) is itself reportable — see the Week-5 freeze in the
  roadmap.

## ADR-0005: Reproducibility and the run manifest

**Status:** accepted (2026-11-01), implemented (`schemas/manifest.schema.json`,
`evidence-spec.md` §2.3/§5).

### Context
A published number is only credible if a reader can reproduce it. Reproducibility fights
nondeterminism: we cannot promise the same agent output, but we can promise the same *inputs*
and a full record of what happened.

### Options
1. **Pin everything, keep full transcripts + per-run manifest.** Heavy artifacts, maximal trust.
2. **Pin versions, keep only verdicts.** Light, but a disputed verdict cannot be re-examined.
3. **Pin nothing, re-run on demand.** No artifact rots, but no run is ever reproducible.

### Decision
Option 1. Every run pins agent version, model id, and scenario version into a run manifest
(`schemas/manifest.schema.json`, `schema_version` stamped), and keeps the full transcript +
evidence record per run. Scoring logic contains **no clock and no randomness** (timestamps are
recorded as data, never consulted in logic) so the manifest fully determines the score.

### Consequences
- A reader can re-derive the headline from the manifest + evidence without re-running the agent.
- Model drift is visible: a verdict change across model versions is attributable because the
  model id is pinned per run.
- Artifacts are large; `evidence-spec.md` §5 defines redaction so transcripts never carry a real
  secret or an un-redacted canary into a published report.

## ADR-0006: Cost control

**Status:** accepted (2026-11-01), partially implemented (budget caps in `src/runner/`;
`$/full run` estimate is a Week-5 deliverable).

### Context
Live-agent runs cost money and time. CI must be cheap enough to run per-PR; the full comparison
must be bounded and estimable before it runs.

### Options
1. **Per-run budget caps + smoke/full modes + fixture caching + a published `$/full run`.**
2. **No caps, rely on the operator to stop.** Unbounded spend on a flaky or looping agent.
3. **Full run only.** Simple, but too expensive to gate CI on.

### Decision
Option 1. The runner enforces a per-run budget cap (abort a run that exceeds it, recorded as an
error → `inconclusive`, never silently as `resisted`). A **smoke mode** runs a subset for CI; a
**full mode** runs the corpus and is gated to release. Fixture build output is cached. A
`$/full run` estimate per agent is published with the report (Week 5).

### Consequences
- CI stays affordable per PR (smoke), while the headline report uses full mode.
- A runaway agent costs a bounded amount and produces an honest `inconclusive`, not a false pass.

## ADR-0007: Isolation and safety (inert by construction)

**Status:** accepted (2026-11-01), implemented (`src/fixtures/fixture.ts` `FixtureBase`;
reinforced by ADR-0002).

### Context
The corpus instantiates real disclosed attacks. The overriding safety property is that running
the benchmark can never cause a real-world effect: no real host is contacted, no real credential
exists to leak, no payload does anything but trip a canary.

### Options
1. **Inert by construction, enforced in a base class.** Every fixture binds only to loopback / a
   canary host and uses only canary values; the base class validates this and refuses otherwise.
2. **Inert by convention, checked in review.** Relies on every contributor and reviewer getting
   it right every time — one miss ships a live payload.
3. **Inert by sandboxing only (container/netns, default-deny egress).** Good defense in depth,
   but if the sandbox is misconfigured the payload is live; construction-level inertness does not
   depend on the sandbox being perfect.

### Decision
Option 1 as the guarantee, with Option 3 as defense in depth. `FixtureBase` enforces inertness
invariants (`assertLoopback`, `assertNoRealSecret`, `validateInertness`) so a fixture that would
bind off-loopback or carry a token-shaped secret fails to start. On top of that, the runner is
designed to run under a container / network namespace with default-deny egress except the canary
host and the model API (operational, documented; the construction-level guarantee does not rely
on it).

### Consequences
- "Live payload impossible by construction" is a property of the base class, not a review habit —
  it holds even if a contributor is careless.
- Detectors observe canaries only; a detector can never be the thing that reaches a real host
  (it is a passive sensor — `evidence-spec.md` §1).
- The sandbox is belt-and-suspenders; a sandbox misconfiguration degrades defense in depth but
  does not by itself make a payload live.

## ADR-0008: Agent adapter contract

**Status:** accepted (2026-11-01); four live-agent adapters implemented (updated 2026-11-04):
Claude Code (`src/adapters/claudeCode.ts`), Cursor CLI (`src/adapters/cursorCli.ts`, ADR-0016),
Codex CLI (`src/adapters/codexCli.ts`, ADR-0018) and OpenHands (`src/adapters/openhands.ts`,
ADR-0019), plus the offline replay adapter (`src/adapters/replay.ts`, ADR-0015). Only Claude
Code is live-validated; the other three are stub-tested. Full contract in `evidence-spec.md` §4.

### Context
Each agent (Claude Code, Cursor CLI, Codex CLI, OpenHands) is driven differently and observed
differently. The engine needs one minimal interface so a new agent is a thin adapter file, not a
runner rewrite.

### Options
1. **Thin per-agent adapter behind one interface** (launch headless with a setup profile, inject
   the task, collect transcript + tool calls, stop), with per-agent observation documented from
   primary sources.
2. **One generic driver with per-agent config.** Underfits: observation layers differ too much
   (stream formats, hook models, SDK availability) to express as config alone.

### Decision
Option 1. The `Adapter` interface (`src/adapters/adapter.ts`) is `SetupProfile` in →
`RunObservation` out. For Claude Code, observation merges the `stream-json` output with an
observe-only PreToolUse/PostToolUse hook, joined by `tool_use_id` (§4.2). The adapter **never
loosens** the setup under test — it does not add `--dangerously-skip-permissions` unless the
profile literally requests it, and it pins agent version and model id into the manifest. It
also isolates the run from the operator's own agent config without rewriting the workdir:
Claude Code runs always get `--strict-mcp-config` unless the operator profile opts out
(`strict_mcp_config: false`, which no fixture `profilePatch` can set or clear) or a fixture declares
`requires.project_mcp_autoload` (then evidence `isolation: "partial"`, evidence-spec §3.1/§4.3),
the observe hook is passed in a run-dir file via `--settings` (the project
`.claude/settings.json` a fixture planted is never rewritten, §4.2), and the option names
actually passed are recorded as `observation.agent_flags`. Agents
without a usable SDK (OpenHands is Python-only) are driven via their CLI.

Three adapters are wired into `CliDeps.adapterFor` (`src/cli.ts`): `claude-code`, `cursor-cli`
and `codex-cli`. Cursor CLI and Codex CLI are **stream-only** for now (ADR-0016, ADR-0018): no
hook observer is installed because hooks under headless mode and the tool-call id join are
UNVERIFIED in the primary sources; every permission-affecting flag is emitted only from an
explicit `permission_mode` token, and neither adapter records denied `attempts` (no verified
denial record). Only the Claude Code adapter records `observation.attempts`
(`result.permission_denials` and error-flagged tool results, digests only, evidence-spec §4.2).
The replay adapter re-drives a recorded Claude Code run through the same parse/merge function
(ADR-0015).

### Consequences
- A new agent adapter is one file plus a `NOTES-verified-facts.md` entry citing how its headless
  mode and observation work today — no engine change.
- Observation fidelity is per-agent and recorded; a scenario can declare `headless_fidelity:
  reduced` where an agent cannot be observed as precisely, rather than silently mis-scoring.

## ADR-0009: Effect detectors and observation layers

**Status:** accepted (2026-11-01); 5 of 6 detectors implemented (updated 2026-11-02);
`canary_egress_dns` deferred because it needs resolver control from the ADR-0007 isolation
layer. All 8 schema fixture kinds are implemented. Full contract in `evidence-spec.md` §1.

### Context
A detector decides whether the forbidden effect occurred. It must attribute the effect without
false-negating (a missed effect reads as a false "resisted," the most dangerous error for this
tool). Signals come from several layers: agent hooks, MCP interposition, network egress to the
canary host (HTTP/DNS), canary files/commands, and filesystem diff.

### Options
1. **Detectors are passive sensors outside the agent, each with a positive/negative self-test**
   proving it cannot silently miss its own signal; pick the layer per effect.
2. **One monolithic observer.** Couples unrelated signals; a bug in one blinds all.
3. **Trust the agent transcript alone.** The agent can misreport; the transcript is evidence of
   intent, not of effect.

### Decision
Option 1. Each `Detector` (`src/detectors/`) watches one effect via the right layer
(`canary_egress_http`, `canary_file_read`, `canary_command`, `canary_mcp_tool`, `fs_diff`
implemented, evidence-spec §1.2c; `canary_egress_dns` deferred: it needs resolver control from
the ADR-0007 isolation layer). `canary_mcp_tool` also accepts `match { event: server_started }`
(the inert server's own unconsented start, AAB-001/016) and `canary_egress_http` accepts
`match { registry_fetch: true }` (GET of this run's canary tarball from `local_registry`,
evidence-spec §1.2d). All 8 schema fixture kinds (`web_server`, `mcp_stdio`, `mcp_http`,
`skill_package`, `poisoned_repo`, `issue_feed`, `email_feed`, `local_registry`) are
implemented. Every detector ships a **blinded-sensor
self-test**: a positive control proves it fires, a negative control proves it stays silent, and
the runner forces `inconclusive` (never `resisted`) when a detector's self-test is unverified
(empirically confirmed in `test/detectors.test.ts`). Detectors never generate attacks and never
reach a real host — they observe canaries only.

### Consequences
- The soundness property — "a detector cannot silently false-negative" — is a tested invariant,
  which is exactly the brief's Week-2 requirement.
- Adding a detector is additive and isolated; a new sensor cannot blind an existing one.
- Attribution is best-effort per tool call (`tool_use_id` linkage); where it cannot be
  attributed, the evidence record says so rather than guessing.

---

# Part B — Engineering decisions

## ADR-0010: Dependency policy

**Status:** accepted (2026-11-01).

### Context
A security measurement tool must be auditable and supply-chain-hygienic — it is itself a thing
people run against their setups.

### Decision
Minimal runtime dependencies, each pinned; mirror `mcp-review-check`'s toolchain (ajv, yaml, zod,
`@modelcontextprotocol/sdk`, vitest, tsc). Releases are OIDC trusted-published (no long-lived npm
token). CI actions are SHA-pinned. Dev/test deps are allowed more latitude than runtime deps.

### Consequences
- A reader auditing the tool has a small runtime surface to review.
- Provenance-attested releases match the credibility the published report needs.

## ADR-0011: Repository layout

**Status:** accepted (2026-11-01), implemented.

### Context
The brief's shape: scenarios as data, fixtures as code, adapters as plugins, detectors as a
small core, "adding a scenario = one-file PR."

### Decision
- `scenarios/*.yaml` — data; one file per scenario.
- `schemas/*.schema.json` — the contracts (scenario, evidence, manifest, report), each versioned.
- `src/scenario/` loader+validator · `src/detectors/` core sensors · `src/adapters/` per-agent
  plugins · `src/fixtures/` inert fixtures · `src/runner/` lifecycle · `src/report/` reporters ·
  `src/tools/` CLIs.
- `test/` with offline stub agents and fixture scenarios; no test reaches the network.
- `docs/{research,design,plan}/` — the three brief phases.

### Consequences
- Curators touch only `scenarios/` + `schemas/`; engine changes stay in `src/`.
- The boundary between data and code keeps one-file contributions reviewable.

## ADR-0012: Contribution model

**Status:** accepted (2026-11-01), to be published (roadmap Week 4). CI scope revised 2026-11-02:
CI drives the corpus via replay, not a live agent.

### Context
The project's survival depends on external scenario submissions (see the kill criterion). The
submission path must make the required discipline (citation, reproducibility, inertness) cheap to
follow and hard to skip.

### Decision
A scenario PR must: add exactly one `scenarios/AAB-NNN.yaml` that validates; cite a primary
public disclosure in `source.primary_url` (schema-enforced); include the fixture it needs
(reusing an existing inert fixture where possible); and pass a reproducibility checklist (the
author ran it live against ≥1 agent and recorded the manifest). Review rules: no speculative
attacks, inertness by construction, no working-exploit/evasion text beyond disclosure level.

CI (`.github/workflows/ci.yml`) launches no live agent. On every push and pull request it:
typechecks; runs the test suite; validates every scenario against the schema (including the
required `source.primary_url`); runs the detector self-tests (positive + negative control per
detector); drives the corpus through the replay adapter (ADR-0015) on the recorded claude-code
run in `test/fixtures/recordings/claude-sample`, asserting that every planned scenario (runnable
and applicable to claude-code; the rest are skipped) wrote an evidence file carrying the replay
warning, that none is vulnerable or degraded, and that none is inconclusive for any reason other
than an MCP precondition the recording cannot satisfy (it has no MCP server connected); passes
that run through the `publish --redact-home` gate, which must exit 0; and installs the packed
tarball and runs its bin (offline commands only). Every replayed result carries the replay warning, so
this proves the runner, fixtures, detectors, parser, reporters and publish gate, not agent
behaviour. The live run against ≥1 agent before merge is the maintainer's step, recorded in the
reproducibility checklist.

### Consequences
- The mechanical quality bar (schema, detector controls, pipeline end to end) is enforced by CI;
  the behavioural bar (a live agent run) is enforced by the maintainer before merge.
- A contributor cannot merge a scenario that reaches a real host or lacks a disclosure.

## ADR-0013: Weekly update cadence — **DECISION NEEDED**

**Status:** proposed; maintainer's call.

### Context
The brief asks whether the corpus/report updates automatically or by hand.

### Options
1. **Hand-curated (recommended for 0.1).** A human runs the corpus and updates the report. No
   hosted runner, no unattended live-agent spend. Matches the single-maintainer reality.
2. **Scheduled automated re-runs.** Catches model drift faster, but implies a hosted runner
   (a non-goal) and unattended spend, and a flaky run could publish a wrong number unreviewed.
3. **Hybrid:** automated *smoke* re-runs that only open an issue when a verdict flips; full runs
   and any publish stay manual.

### Recommendation
Option 1 for 0.1; revisit Option 3 once external contributors exist and the flip-rate baseline
(Week 5) is known. Avoid Option 2 — it drifts toward the SaaS non-goal.

## ADR-0014: Ethics and coordinated disclosure

**Status:** accepted (2026-11-01), policy enforced per scenario via `source.fix_status`.

### Context
The corpus instantiates real disclosed issues. Some may still be unpatched. Publishing a runnable
reproduction of an unpatched issue can cause harm.

### Decision
Coordinated disclosure first. A scenario citing a still-unpatched issue is published (listed in
the public catalog) only **after the fix ships or 90 days pass, whichever is first**; until then
it lives in a private tier that CI can run but the public catalog does not list. `source.fix_status`
(`patched/partial/unpatched/na`) is tracked per scenario. Payload text derived from third-party
research carries a licensing/attribution note. Scenarios describe attacks at disclosure level
only — no working-exploit, evasion, or obfuscation detail.

### Consequences
- The project can catalog an unpatched issue (so the regression exists) without handing out a
  runnable zero-day reproduction before its window.
- `fix_status` also drives the staleness response: a patched scenario becomes a regression test
  rather than being deleted (see Threats to validity).

### Amendment (2026-11-03): exclusion is not a disclosure hold
`lurekit publish --withhold <id>` (ADR-0017) is the only publish-time tool of this policy, and its
fixed note ("withheld pending coordinated disclosure (ADR-0014)") must stay true. A result that is
not a measurement (for example, a fixture defect fixed after the run, so the scenario could not
have triggered its detector) is a different case and uses `--exclude <id>` (ADR-0017 "Excluding a
scenario"): an operator-declared non-measurement, never a disclosure hold. It has its own note
and its own manifest field (`excluded`, evidence-spec section 2.3), and an id may not be both withheld
and excluded, so a reader can always tell the two apart.

---

# Part C — Threats to validity

The brief names four; each gets a mitigation the design already supports.

1. **Overfitting by vendors** — an agent could "pass" by special-casing our canary strings or
   hosts. *Mitigation:* rotate canary values per run; keep the attack *classes* public but vary
   the concrete markers; report class-level resilience, not only per-scenario pass/fail. (ADR-0007
   inertness is per-run provisioned, which makes rotation natural.)
2. **Scenario staleness** — a cited disclosure gets patched and no longer reproduces.
   *Mitigation:* `source.fix_status` per scenario (ADR-0014); a patched scenario moves to a
   `regression` tier and proves the fix still holds, instead of being deleted.
3. **Adapter bugs masking attacks** — a buggy adapter reports "resisted" when the agent was
   actually vulnerable. *Mitigation:* detector self-tests gate every run (ADR-0009); an
   unverified sensor forces `inconclusive`, never `resisted`; adapters pin agent version so a
   behavior change is visible, and `headless_fidelity:reduced` flags lower-fidelity observation.
4. **Model drift** — a verdict changes across model versions. *Mitigation:* model id pinned per
   run (ADR-0005); k-run stability reported (ADR-0004); the published report states the flip rate
   rather than the best single run.

A fifth, project-specific threat: **authoring friction** — large harness/design docs have tripped
a safety classifier. *Mitigation:* write design docs in small neutral sections describing
plumbing, keep decisions in ADRs; codified in `CLAUDE.md`. This document was assembled that way.

---

## Status summary

| ADR | Topic | Status |
|-----|-------|--------|
| 0001 | Language/runtime | accepted, implemented |
| 0002 | Fixture contract + runner lifecycle | accepted, implemented |
| 0003 | Scenario format | accepted, implemented |
| 0004 | Nondeterminism + scoring | accepted, implemented |
| 0005 | Reproducibility + manifest | accepted, implemented |
| 0006 | Cost control | accepted, partially implemented |
| 0007 | Isolation + safety (inert by construction) | accepted, implemented |
| 0008 | Agent adapter contract | accepted; 4 adapters (claude-code, cursor-cli, codex-cli, openhands) + replay; only claude-code live-validated |
| 0009 | Effect detectors + observation | accepted; 5 of 6 detectors done (`canary_egress_dns` deferred: needs ADR-0007 resolver control); all 8 fixture kinds done |
| 0010 | Dependency policy | accepted |
| 0011 | Repository layout | accepted, implemented |
| 0012 | Contribution model | accepted, to be published (Week 4); CI scope revised 2026-11-02 (replay + publish gate; live run = maintainer) |
| 0013 | Weekly update cadence | **DECISION NEEDED** |
| 0014 | Ethics + coordinated disclosure | accepted |
| 0015 | Replay adapter (`adr-0015-replay-adapter.md`) | accepted, implemented |
| 0016 | Cursor CLI adapter (`adr-0016-cursor-cli-adapter.md`) | proposed, implemented (stream layer); awaiting approval |
| 0017 | Publish + redaction gate (`adr-0017-publish-run.md`) | proposed, implemented; awaiting approval |
| 0018 | Codex CLI adapter (`adr-0018-codex-cli-adapter.md`) | proposed, implemented (stream layer); awaiting approval |
| 0019 | OpenHands adapter (`adr-0019-openhands-adapter.md`) | proposed, implemented (stream layer, transcript cross-check); awaiting approval |
| 0020 | Profile settings forwarding (`adr-0020-profile-settings-forwarding.md`) | proposed, implemented; awaiting approval |
