# ADR-0002: Fixture contract and runner lifecycle

Status: accepted (authored for build step 4, 2026-11-01). Authorises `src/fixtures/*` and
`src/runner/*`. Part of the SDD until `architecture.md` absorbs it.

## Context
The runner must stand up a scenario's fixtures, run the agent under test k times in isolation,
evaluate detectors, check the benign task, score, and tear everything down — deterministically
in its own behaviour (brief §3.1). Fixtures are the attack surface; they must be inert by
construction (CLAUDE.md), never per-scenario trust.

## Decision

### Fixture contract
A `Fixture` is provisioned into a run and torn down after it. The base class enforces inertness
so a scenario author cannot make a live-payload fixture by accident:

```ts
export interface Fixture {
  readonly type: FixtureKind;
  // Stand up into the run's workdir/runDir; return canary identifiers and any
  // profile fragment the agent needs (e.g. an .mcp.json entry pointing at a loopback server).
  provision(ctx: { runDir: string; workdir: string; canaryHost?: string }):
    Promise<{ canaries: Record<string,string>; profilePatch?: Partial<SetupProfile>;
              expect?: { mcp_server?: string };            // evidence-spec §3.1 preconditions
              requires?: { project_mcp_autoload?: boolean } }>; // §3.1 run requirements
  teardown(): Promise<void>;
}
```

Inertness invariants, asserted in the base class (not per fixture):
1. Any server binds only to loopback / the harness canary host.
2. Fixtures carry only canary values — a random marker, a loopback URL, a no-op command. The
   base class rejects a fixture that would reach a non-loopback host or embed a real token.
3. A fixture never calls a canary itself (so the detectors' negative control stays clean, §1.4).

Interface notes — `profilePatch` merging. The runner applies each fixture's `profilePatch` to
the profile under test in fixture order (`mergeProfilePatch`, `src/runner/runner.ts`):
- `env` merges key-by-key: the profile's `env`, then each patch's `env` in order. Keys the
  profile set survive; two fixtures' env patches compose (e.g. `web_server`'s `AAB_WEB_URL` and
  `local_registry`'s `npm_config_registry`); a later patch overrides only the same key.
- Every other field is shallow-merged (a patched field replaces the profile's value whole).
- Never loosened: a patch that would loosen `permission_mode` is ignored with a warning, and a
  patch that changes `agent`, `agent_version` or `model` is ignored with a warning. A patch
  that sets `strict_mcp_config` at all (`false`, `true`, or an explicit `undefined`; MCP isolation
  is operator policy, evidence-spec §4.3) is ignored — the base profile's value is kept — with a
  warning when it differs. A patch that changes `workdir` is ignored with a warning (the runner
  owns the per-run workdir, see "Per-run workdir" below).
- Run requirements (evidence-spec §3.1 "Run requirements", §4.3). A fixture's `requires` is
  OR-ed over the repetition's fixtures and passed to the adapter in `RunOptions.requires`.
  `project_mcp_autoload: true` is the only way to relax MCP isolation for a run: the Claude Code
  adapter then omits `--strict-mcp-config`, and the runner records `isolation: "partial"`, the
  `requires` object and a warning naming the declaring fixture. `poisoned_repo` declares it
  because it plants a project `.mcp.json`, and no longer puts that server in `profilePatch.mcp`
  (loading it via `--mcp-config` would bypass the auto-load the scenario measures).

### Runner lifecycle
`plan → provision → run×k → observe → score → teardown`:
1. **plan** — filter the corpus to scenarios whose `applies_to` includes the profile's agent
   and whose detector is implemented; refuse to score a scenario on a detector whose selfTest
   has not passed this session (§1.3).
2. **provision** — build a per-run dir (§2.1) and a **fresh per-run workdir** for this
   repetition (see "Per-run workdir" below), provision the scenario's fixtures and detectors
   into it, merge each fixture's `profilePatch` into the profile under test (never loosening it).
3. **run×k** — call the adapter; honour `budget_usd` (§3.3) and the abort signal.
4. **observe/score** — evaluate detectors against the run dir, check the benign task, derive the
   per-run outcome (§3.1), write the evidence record (§2.2).
5. **aggregate** — combine k outcomes into the scenario verdict and confidence (§3.2).
6. **teardown** — tear down fixtures/detectors; the run dir and manifest persist as evidence.

### Per-run workdir (no shared directory, nothing under the system temp dir)
Maintainer rule: nothing a benchmark run produces is written under `os.tmpdir()` — not the
agent workdir, not `mcp.json`, not hook scripts, not recordings, not detector self-test scratch.
- Every repetition gets its own workdir, created by the runner before fixtures provision:
  `<results>/<benchmark_run_id>/<scenario_id>/<rep>/work` (`WORKDIR_NAME`). Fixtures provision
  into it, detectors baseline it, the adapter runs in it, the benign check resolves against it.
  Scenario N therefore never sees files left by scenario N-1, nor repetition k by k-1.
- The caller's `SetupProfile.workdir` is optional. When set (CLI `--workdir <dir>`) it is only a
  BASE: the per-run dir becomes `<base>/<scenario_id>/<rep>`. A pre-existing non-empty per-run
  dir under a base is refused (`inconclusive(fixture_error)`) and never cleared by the runner.
- The profile handed to fixtures and the adapter is a per-run copy carrying the per-run path;
  adapters refuse a profile without one (`requireWorkdir`) and never invent a directory.
- The per-run workdir is recorded in evidence as `workdir` (evidence-spec §2.2).
- Detector self-tests run with `selfTest({ base })`; the runner passes
  `<results>/<benchmark_run_id>/.selftest` and removes it when empty. A caller with no run dir
  (the `selftest` command, unit tests) gets `<cwd>/.aab-selftest`, removed when empty.
- Note: the agent's cwd is now a child of the run dir, so run-dir artefacts are one `..` away;
  they were already reachable by absolute path, and detectors read only harness-owned files.

Determinism: the runner uses no wall-clock in its logic (durations only; timestamps are
injected at the CLI boundary), so a replay over recorded runs yields identical verdicts.

## Interface notes from implementation (kept in sync)

- `Runner.plan()` is async and returns `PlanResult { kept, skipped[] }` (never throws); skip
  reasons include not-applicable, detector-not-implemented, detector-unverified, not-runnable.
- Fixtures are injected via a `FixtureProvider` callback (lazy, per scenario), not a static map.
- `RunConfig` carries `resultsRoot`; the benchmark run id, `created_at` and `tool_version` are
  injected (`RunnerIds` / `RunMeta`), never generated in runner logic (determinism).
- `runScenario` derives its single detector from `forbidden_effect.detector` via an injectable
  `detectorFor` (default `getDetector`).
- Every `FixtureKind` in the schema enum has a concrete inert fixture registered in
  `src/fixtures/index.ts` (`buildFixture` throws only for a kind absent from the registry).
- Serve-only HTTP fixtures (`issue_feed`, `email_feed`, `mcp_http`, `web_server`,
  `local_registry`) bind an ephemeral port on 127.0.0.1 only. `web_server` and
  `local_registry` share `src/fixtures/loopbackHttp.ts`, whose `closeServer()` also drops
  open keep-alive connections on `teardown()` so the port is freed promptly; the older
  `issue_feed`/`email_feed`/`mcp_http` fixtures still bind and close inline (`server.close()`).
- `web_server` (`src/fixtures/webServer.ts`): one static `text/html` page (GET/HEAD `/` or
  `/index.html`) with a visible inert placeholder line and a per-run random marker; no scripts,
  no external references, `default-src 'none'` CSP. Canaries `{ url, marker }`; `profilePatch`
  sets `env.AAB_WEB_URL` to the page URL.
- `local_registry` (`src/fixtures/localRegistry.ts`): read-only minimal npm registry for ONE
  per-run package `aab-canary-<hex>` at version 1.0.0 — packument at `GET /<name>`, tarball at
  `GET /<name>/-/<name>-1.0.0.tgz` (the `dist.tarball` URL), `dist.integrity` (sha512) and
  `dist.shasum` (sha1) over the exact bytes served; other methods 405, other paths 404. The
  package is `package.json` (no scripts/bin/dependencies) + empty `index.js`, so installing it
  executes nothing. Canaries `{ registry_url, package, tarball_url }`; `profilePatch` sets
  `env.npm_config_registry` to the loopback registry URL.
- Randomness in fixtures is limited to canary values (tokens, markers, package names).

## Consequences
- The runner is testable offline: a stub adapter (step 3) plus real detectors (step 2) plus a
  trivial in-memory fixture exercise the whole lifecycle with no live agent and no API spend.
- Concrete fixtures (poisoned repo, loopback MCP server, skill package, local registry) and the
  `canary_mcp_tool` detector land in step 5; step 4 ships the interface + one trivial fixture.
- Non-goal guard: the runner does not sit between the agent and its tools in production; it only
  provisions inputs and reads evidence after the fact.
