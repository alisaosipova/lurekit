# LureKit documentation

Every document in `docs/`, one line each. Start with the user guide; the design documents are the
authority when the two disagree.

## User guide (`guide/`)

- [guide/getting-started.md](guide/getting-started.md) - install, first offline commands, first live run.
- [guide/cli-reference.md](guide/cli-reference.md) - every `lurekit` subcommand and flag.
- [guide/scenarios.md](guide/scenarios.md) - the scenario corpus and how to write or submit a scenario.
- [guide/fixtures-and-detectors.md](guide/fixtures-and-detectors.md) - the inert fixture kinds and the detector control sensors.
- [guide/interpreting-results.md](guide/interpreting-results.md) - verdicts, `resisted_kind`, isolation markers, evidence records and reports.
- [guide/publishing.md](guide/publishing.md) - publishing a run through the redaction gate.
- [guide/troubleshooting.md](guide/troubleshooting.md) - common problems: agent auto-update, inconclusive verdicts, isolation, platforms, the redaction gate.
- [guide/architecture-overview.md](guide/architecture-overview.md) - contributor map: pipeline, invariants, ADR locations, how to add an adapter, detector or fixture, testing strategy.
- [guide/badge.md](guide/badge.md) - a static shields.io badge from a published bundle, and what it must not claim.

## Generated (`docs/`, do not edit by hand)

- [catalog.md](catalog.md) - every scenario in one table: surface, effect, linked disclosure, applies_to, runnable, fix status, tier (`npm run catalog`, from `scenarios/*.yaml`).
- [verified-against.md](verified-against.md) - agent x version x result matrix over every published bundle, with profile, withheld/excluded counts and validity notes (`npm run matrix`, from `reports/*/`).
- [assets/demo-output.svg](assets/demo-output.svg) - the README image: the first lines of the real `lurekit demo` output (`npm run assets:demo`).

## Project (`docs/`)

- [BRIEF.md](BRIEF.md) - project charter, scope and non-goals.

## Research (`research/`)

- [research/landscape.md](research/landscape.md) - research on prior work, agent surfaces and disclosures.

## Design (`design/`)

- [design/architecture.md](design/architecture.md) - the SDD: ADR index, ADR-0003..0014, threats to validity, status summary.
- [design/evidence-spec.md](design/evidence-spec.md) - detector, evidence record, verdict, adapter, redaction and reporting contract.
- [design/NOTES-verified-facts.md](design/NOTES-verified-facts.md) - primary-source facts about agent CLIs and tools that feed the ADRs.
- [design/BOOTSTRAP.md](design/BOOTSTRAP.md) - build order and what is specced versus pending.
- [design/setups-week6.md](design/setups-week6.md) - proposal for the defensive-setup comparison (HOL Guard, agentcage, cc-audit, Cursor, Codex).
- [design/adr-0001-language-runtime.md](design/adr-0001-language-runtime.md) - ADR-0001: TypeScript on Node.
- [design/adr-0002-fixtures-and-runner.md](design/adr-0002-fixtures-and-runner.md) - ADR-0002: fixture contract, runner lifecycle, per-run workdir.
- [design/adr-0015-replay-adapter.md](design/adr-0015-replay-adapter.md) - ADR-0015: record one live run, replay it offline.
- [design/adr-0016-cursor-cli-adapter.md](design/adr-0016-cursor-cli-adapter.md) - ADR-0016: Cursor CLI adapter.
- [design/adr-0017-publish-run.md](design/adr-0017-publish-run.md) - ADR-0017: `publish` subcommand and redaction gate.
- [design/adr-0018-codex-cli-adapter.md](design/adr-0018-codex-cli-adapter.md) - ADR-0018: Codex CLI adapter.
- [design/adr-0019-openhands-adapter.md](design/adr-0019-openhands-adapter.md) - ADR-0019: OpenHands adapter.
- [design/adr-0020-profile-settings-forwarding.md](design/adr-0020-profile-settings-forwarding.md) - ADR-0020: forwarding profile settings and hooks to Claude Code.
- [design/adr-0021-demo-and-prescriptive-report.md](design/adr-0021-demo-and-prescriptive-report.md) - ADR-0021: `lurekit demo` and the plain-language / "What to change" report layers.
- [design/adr-0022-doctor-smoke-default-and-error-paths.md](design/adr-0022-doctor-smoke-default-and-error-paths.md) - ADR-0022: `lurekit doctor`, smoke default and launch confirmation, newcomer error paths.
- [design/adr-0023-generated-docs.md](design/adr-0023-generated-docs.md) - ADR-0023: generated catalog, verified-against matrix and demo image, diffed in CI.

## Plan (`plan/`)

- [plan/roadmap.md](plan/roadmap.md) - roadmap and phases, kill criteria, the no-container decision, the browser-track list.

## Reports (`reports/`)

- [reports/README.md](reports/README.md) - index of published measurement summaries and their run bundles.
- [reports/2026-11-02-claude-code-2.1.316.md](reports/2026-11-02-claude-code-2.1.316.md) - Claude Code 2.1.316: first published runs, k=3 stability, bare vs hardened (with a 2026-11-03 validity note).
- [reports/2026-11-03-claude-code-2.1.317-k3.md](reports/2026-11-03-claude-code-2.1.317-k3.md) - Claude Code 2.1.317: four k=3 arms (bare, hardened, each with and without netread), exclusions and the content-delivery lesson.

## Elsewhere in the repository

- [../README.md](../README.md) - overview and quick start.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) - scenario submission path, review rules, disclosure policy.
- [../SECURITY.md](../SECURITY.md) - private vulnerability reporting.
- [../CHANGELOG.md](../CHANGELOG.md) - releases and versioning policy.
- [../profiles/README.md](../profiles/README.md) - reference Claude Code setup profiles (bare, hardened).
- [../reports/](../reports/) - published run bundles (manifest, evidence, renders).
