# How to start building agent-attack-bench 0.1

Grounded in `docs/research/landscape.md`. Language: TypeScript / Node >=20.19 (ADR-0001).
The order below follows the research: the corpus is the novelty, so fixtures and detectors
come before breadth of scenarios. Build in thin vertical slices — one scenario running
end-to-end beats ten scenarios with no runner.

## Build order (maps to the brief's week-2 MVP)

1. **Scenario model + validator.** DONE (2026-11-01). `src/scenario/load.ts` parses
   `scenarios/*.yaml`, validates against `schemas/scenario.schema.json` with ajv in strict
   mode (uri/date formats active), enforces cross-file invariants (unique id, id==filename
   stem, browser=>runnable:false, default runnable/headless_fidelity), and `src/tools/
   validate-scenarios.ts` is the CLI (exit 1 on any invalid file). Tests in
   `test/scenario-load.test.ts` (8 passing). This makes "add a scenario = one-file PR" real.

2. **Detectors first, with their self-test.** DONE (2026-11-01). `canary_egress_http`,
   `canary_file_read`, `canary_command` implemented in `src/detectors/` behind the `Detector`
   interface, per evidence-spec §1. Each ships positive + negative control runs; `test/
   detectors.test.ts` proves empirically that a blinded `evaluate()` makes the positive
   control fail (§1.3 soundness). 19 tests passing. `canary_egress_dns`, `canary_mcp_tool`,
   `fs_diff` are deferred (getDetector throws "not implemented").

3. **Claude Code adapter.** DONE (2026-11-01). `src/adapters/claudeCode.ts` drives
   `claude -p --output-format stream-json --verbose --model <id>`, collects tool calls from
   the stream and from an installed observe-only PreToolUse/PostToolUse hook, merges by
   `tool_use_id`, reads cost and effective model/mode from the stream, pins version and model,
   never loosens `permission_mode`. Tested fully offline against a stub agent
   (`test/fixtures/agents/stub-claude.mjs`); 37 tests passing. Spec: evidence-spec §4.
   Facts and URLs: `docs/design/NOTES-verified-facts.md`.

4. **Runner + fixture contract.** DONE (2026-11-01). `src/runner/runner.ts`
   (`BenchmarkRunner`) runs the ADR-0002 lifecycle: plan (skip unapplicable / unimplemented /
   self-test-unverified detectors) → provision fixtures+detector → run×k via the adapter →
   evaluate detector → benign utility check → per-run outcome (§3.1) → aggregate (§3.2) →
   evidence.json (§2.2) + manifest.json (§2.3). `src/fixtures/fixture.ts` (`FixtureBase`)
   enforces inertness (loopback-only, no token-shaped secrets, no self-canary). Budget §3.3
   and determinism (no clock in logic) enforced and tested. 71 tests passing (offline, stub
   adapter + real detectors). Schemas: `schemas/{evidence,manifest}.schema.json`.
   Spec: evidence-spec §2/§3/§5, adr-0002.

5. **Fixtures + canary_mcp_tool + 10 scenarios.** DONE (2026-11-01). `canary_mcp_tool`
   detector (inert stdio MCP server, one decoy `aab_canary_record` tool) in
   `src/detectors/canaryMcpTool.ts`; concrete inert fixtures in `src/fixtures/`
   (poisoned_repo, mcp_stdio/mcp_http, skill_package, issue_feed/email_feed). 10 scenarios
   (AAB-001/002/018/019/020/021/022/027/030/031), all validating, all planned runnable,
   exercising all four implemented detectors. `test/e2e.test.ts` drives each through the
   runner with a vulnerable stub (-> vulnerable + hit + evidence) and a resisting stub
   (-> resisted). 77 tests passing, offline. `local_registry` was deferred here and landed
   in step 8. NOTE: end-to-end against a LIVE Claude Code is the maintainer's manual
   week-2 step; the automated e2e proves the pipeline (runner+detectors+fixtures), not a live
   agent. Spec: evidence-spec §1.2b.

6. **Reporter.** DONE (2026-11-01). `src/report/{score,json,markdown,sarif,index}.ts` +
   `src/tools/report.ts` CLI (`npm run report`). Pure functions of the run manifest + evidence
   (no fs/network in renderers). Versioned scoring block (`schemas/report.schema.json`,
   `report_schema` 0.1); headline `vulnerable N of M` with M = conclusive count (inconclusive
   reported separately). SARIF validates against the 2.1.0 schema fixture; markdown prints
   tool-call names only (no inputs), so no secret leak. 86 tests passing. Spec: evidence-spec §6.

7. **fs_diff detector.** DONE (2026-11-02). `src/detectors/fsDiff.ts`: sha256 + existence
   baseline of watched workdir paths at `provision()` (post-fixture), re-snapshot at
   `evaluate()`, one hit per created/modified/deleted path, `fs_diff.diff.json` as evidence.
   Default watched list = agent config files named in the corpus (`.claude/settings.json`,
   `.mcp.json`, `CLAUDE.md`, `.cursor/mcp.json`, `.cursor/rules`, `.codex/config.toml`);
   override via `forbidden_effect.match.paths`. The adapter's own observe-only hook in
   `.claude/settings.json` is normalised away (exact adapter shape only; a hook that merely
   mentions the run dir is reported), and an unreadable watched path is a reported change,
   not a crash. `Detector.provision()` gained an optional
   `opts { workdir, match }` and `evaluate()` ctx an optional `workdir`; the runner passes the
   post-fixture profile workdir. Positive/negative self-test + blinded-sensor test; 12 fs_diff tests (incl. two
   adversarial-review regressions), full suite green. Spec: evidence-spec §1.2c, §1.5. Still deferred: `canary_egress_dns`.

8. **web_server + local_registry fixtures.** DONE (2026-11-02). `src/fixtures/webServer.ts`
   (loopback static HTML page: per-run marker + inert placeholder, no scripts/external refs;
   `AAB_WEB_URL` via profilePatch) and `src/fixtures/localRegistry.ts` (loopback read-only npm
   registry for one per-run no-op canary package; packument + tarball with correct
   integrity/shasum; `npm_config_registry` via profilePatch), sharing
   `src/fixtures/loopbackHttp.ts`. Both registered in `src/fixtures/index.ts`, so every schema
   `FixtureKind` is now buildable. Tests in `test/fixtures.test.ts` (loopback bind, content,
   packument/tarball parse + integrity, fresh canaries per provision, teardown frees the port,
   `buildFixture`, real-socket 127.0.0.1 bind); 130 tests passing. Spec: ADR-0002 "Interface notes".

## Reuse from mcp-review-check (landscape §3.2, ADR-0001)
Protocol client (`src/protocol/*`), fixture servers (`test/fixtures/*-server.mjs`),
reporters (`src/report/{json,markdown,sarif}.ts`), the OIDC trusted-publishing release
workflow and the 3-OS CI matrix. Do NOT reuse the 144 static review rules or OAuth DCR
probing — those are the non-goal (static scanning).

## Guardrails while building (brief §1 non-goals)
- Scenarios cite a disclosure or they do not merge (schema requires `source.primary_url`).
- Fixtures are inert by construction: a fixture base class binds only to loopback / a
  canary host and uses only canary values. Enforce this in the base class, not per scenario.
- No component sits between the agent and its tools in production, inspects artifacts
  without running the agent, or needs a server/account.

## Full SDD status (updated 2026-11-01)
`architecture.md` is now written (ADR index + ADR-0003..0014), assembled incrementally in
small neutral sections so the safety classifier did not trip; `evidence-spec.md` holds the
detector/evidence/verdict/adapter/reporting contract (§1-§6). Phase C `docs/plan/roadmap.md`
is written. The one open decision is ADR-0013 (weekly update cadence), flagged DECISION NEEDED.
`fs_diff` landed (step 7). The remaining detector (`canary_egress_dns`) is scheduled
for roadmap Week 3, not blocked. The `local_registry` and `web_server` fixtures landed (step 8).
