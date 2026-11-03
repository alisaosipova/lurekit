# ADR-0021: Demo command and prescriptive report layer

Status: proposed, implemented (2026-11-03); awaiting maintainer approval. Authorises
`lurekit demo` and the bundled `demo/<benchmark_run_id>/` copy (`src/cli.ts`, package.json
`files`), `src/report/guidance.ts`, the two new layers in `src/report/markdown.ts`, and
`test/demo-guidance.test.ts`. Builds on evidence-spec section 6 (reporters are pure functions of
the manifest) and ADR-0017 (published bundles).

## Context
A newcomer cannot see a LureKit report without an authenticated agent and a few dollars of spend.
The Markdown report is written for an auditor: it states what happened per scenario but not, in
plain words, what it means or which setting to change.

## Decision
- **Demo.** One published bundle (`aab-20261103071018-88a78d8f`, bare, k=3) ships with the
  package as `demo/<id>/manifest.json` and `report.json` only (no evidence). The copies must be
  byte-identical to `reports/<id>/`; a unit test asserts it. `lurekit demo [--format
  json|markdown|sarif] [--output <file>]` renders the bundled manifest through `report()`, the same
  path as `lurekit report`, prefixed (Markdown) or accompanied on stderr (json/sarif) by a banner
  built from the manifest: agent, version, model, date, spend, and how to measure your own setup.
  It accepts no other flag and no positional argument; it exits 0. Offline, no auth, no cost.
- **Plain-language summary**, above the audit tables: 3-5 sentences computed from the manifest and
  scoring block (vulnerable of measured, resisted split, vulnerable surfaces, inconclusive count,
  k and `vulnerable_if`, the arm). Terms are defined once inline. A replay warning (ADR-0015),
  when any evidence record carries it, comes before the summary.
- **What to change**, after the tables: only when a scenario is vulnerable. Vulnerable scenarios
  are grouped by scenario `surface` (from the corpus; `unknown` when the scenario file is not
  available). A static table maps a surface to a hardening setting **only when published bundles
  show it resisting that surface**, with the citation; a unit test checks each cited number
  against `reports/`. Today the one entry is `settings_hooks_file` -> `--setting-sources user`.
  Any other surface prints "no verified fix in the published runs yet". Clean runs print
  "Nothing to change from this run"; inconclusive-only runs print "Nothing to change from this
  run yet" and say the run does not show whether a change is needed; both point to the
  inconclusive reasons table when inconclusive > 0. The reference profile is cited by its repository
  path and marked as not in the npm package (a URL would trip the publish gate's host allowlist). The demo banner's `lurekit run` command names the
  shipped corpus path relative to the caller's working directory.
- Every count printed is computed from the run being rendered; the only static numbers are the
  citation of the knob's evidence bundles.

## Consequences
- The audit tables are unchanged; the new layers only add lines above and below them.
- Surfaces come from the scenario corpus shipped with the running lurekit version (for `report`,
  `publish`, `demo`) or the corpus of the run (`run`); a later corpus edit could change a label.
- The interactive Claude Code equivalent of `--setting-sources user` is UNVERIFIED; the section
  says so. A new mapping needs a published bare/hardened pair on the same corpus and version.
