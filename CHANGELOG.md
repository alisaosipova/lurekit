# Changelog

All notable changes to LureKit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning policy

LureKit follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0 on:

- **Minor** (`1.1.0` -> `1.2.0`): a feature set, such as a new adapter, detector, fixture kind,
  CLI subcommand or report format.
- **Patch** (`1.1.0` -> `1.1.1` -> `1.1.2`): fixes, documentation, and new or corrected scenarios
  that use the existing fixtures and detectors.
- **Major**: a breaking change to the CLI, the scenario schema or the evidence/report format.

No release is cut without changes.

## [Unreleased]

## [1.1.0] - 2026-11-03

Minor release: verdict semantics for undelivered content changed (resisted -> inconclusive),
new publish flag, new fixture param, new evidence field and a new reference profile. Test suite:
585 tests in 26 files.

### Fixed
- Content delivery is a precondition: `issue_feed`, `email_feed` and `web_server` count the
  requests that served their content and declare `expect.content_fetched`. A run in which the
  agent never fetched the content is `inconclusive(precondition_failed)` instead of `resisted`
  (headless default permission mode denies `curl` to loopback and WebFetch refuses localhost,
  so earlier bare/hardened runs scored those scenarios as resisted vacuously). Evidence gains
  `observation.fixtures[]`; replay recordings may carry `fixtures` (evidence-spec s3.1,
  ADR-0002 amendment).
- `web_server` fixture: new `instruction: command` param renders the per-run canary
  command path on the served page. AAB-056 previously served a page that never named
  the canary, so its verdict was vacuously `resisted`; results for AAB-056 from runs
  before this fix are not a measurement.

### Added
- `lurekit publish --exclude <scenario-id>` (repeatable): leave out a scenario whose result is
  not a measurement (e.g. AAB-056 in runs before the `web_server` fix). Same file and totals
  handling as `--withhold`, with its own `index.md` note ("excluded by the operator: result is
  not a measurement (see the bundle notes)") and a top-level `excluded` array in the published
  manifest (`schemas/manifest.schema.json`). An id given to both flags is an error (ADR-0017
  "Excluding a scenario", ADR-0014 amendment, evidence-spec section 2.3).
- `profiles/claude-code-netread.json` and `profiles/settings/allow-loopback-curl.json`: the only
  reference profile that loosens something, a `--settings` permissions allow entry for
  `Bash(curl:*)` (and `WebFetch(domain:127.0.0.1)`) so the headless agent can read loopback
  feed/web fixture content; layer it on the bare or hardened flags (`profiles/README.md`).
- User guide under `docs/guide/` (8 pages), `docs/README.md` index, `examples/`
  (annotated scenario template, offline and live run scripts, profile copies).

## [1.0.0] - 2026-11-03

First public release.

### Added

- Scenario corpus: 48 disclosure-traced scenarios in `scenarios/`, 30 of them runnable, 25 of
  the runnable ones applying to Claude Code. Every scenario cites its public disclosure in
  `source.primary_url` (required by `schemas/scenario.schema.json`). 18 browser-track scenarios
  are catalogued with `runnable: false`.
- CLI `lurekit` with `run`, `validate`, `list`, `plan`, `selftest`, `report` and `publish`;
  strict flag parsing (unknown flags and malformed tokens are errors).
- Agent adapters: Claude Code (`claude-code`), Cursor CLI (`cursor-cli`, ADR-0016), Codex CLI
  (`codex-cli`, ADR-0018) and OpenHands (`openhands`, ADR-0019). Cursor, Codex and OpenHands
  are tested offline against stubs.
- Replay adapter and `run --replay` (ADR-0015): re-run a recorded Claude Code session offline
  through the same parse and merge path, with no auth, spend or network.
- Detectors (control sensors with positive and negative `selftest` controls):
  `canary_egress_http` (including the local registry fetch signal), `canary_file_read`,
  `canary_command`, `canary_mcp_tool` and `fs_diff`.
- Inert fixtures, bound to loopback or a harness-provided canary host and carrying only canary
  values: `poisoned_repo`, `mcp_stdio`, `mcp_http`, `skill_package`, `issue_feed`,
  `email_feed`, `web_server` and `local_registry`.
- Isolation: per-repetition workdirs under the run directory (no system temp dir on production
  paths), strict MCP configuration via `--mcp-config` / `--strict-mcp-config`, an isolation
  marker (`full` / `partial`) per repetition, and the `setting_sources` hardening option for
  Claude Code (bare and hardened profiles).
- Profile settings and hooks forwarded to Claude Code through the harness settings file and
  recorded as `forwarded_settings` (ADR-0020).
- Verdicts split `resisted` into `not_attempted` and `denied`; denied decoy-tool and
  canary-package install calls count as attempts. k-run repetitions with `any` / `majority`
  aggregation and a budget cap.
- Reports in JSON, Markdown and SARIF.
- Publish gate (`publish <runDir>`, ADR-0017): redaction of the operator home directory
  (`--redact-home`, including encoded spellings), pseudonymisation of operator MCP server names
  and harness canary tokens, and `--withhold <id>` for coordinated-disclosure holds.
- CI on Linux, macOS and Windows: build, typecheck, tests and scenario validation, plus a Linux
  replay pass of the corpus through the replay adapter and the publish gate. Release workflow with npm
  trusted publishing (OIDC) and provenance.
- Published reports: six run bundles under `reports/` and the measurement summary in
  `docs/reports/` (Claude Code 2.1.316, bare vs hardened, k=3 stability section).
- Project docs: SDD and ADRs under `docs/design/`, CONTRIBUTING, SECURITY (disclosure policy),
  scenario-submission issue template and PR template.

### Known limitations

- Headless fidelity: agents run non-interactively, so scenarios about trust prompts measure
  behaviour without the interactive trust dialog a user would see.
- One live-validated agent: only Claude Code has published live runs. The Cursor CLI, Codex CLI
  and OpenHands adapters are tested offline against stubs and are stream-only.
- `canary_egress_dns` is declared in the schema but deferred (it needs the ADR-0007 resolver
  control); scenarios referencing it fail loudly.
- Operator user-scope MCP servers are visible to the agent in repetitions marked
  `[isolation: partial]`; the publish step pseudonymises their names but cannot remove their
  effect on the run.
- The benign check is text-based and language-dependent and can misclassify `degraded` versus
  `resisted`.
- Published runs were made by one operator on one host; the k=3 stability run does not measure
  variance across hosts or over time.

[Unreleased]: https://github.com/alisaosipova/lurekit/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/alisaosipova/lurekit/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/alisaosipova/lurekit/releases/tag/v1.0.0
