# ADR-0026: `lurekit diff`, run comparison and regression mode

Status: accepted (2026-11-05, block B20, FEATURE-06). Builds on ADR-0005 (reporting) and
evidence-spec s6.1/s6.2.

## Context

Comparing two runs (bare vs hardened, one agent version vs the next) was done by hand in the
published reports. The manifests already hold everything needed: per-scenario verdicts and the
setup they were measured under.

## Decision

`lurekit diff <runA> <runB>` reads the two `manifest.json` files (no evidence, no agent) and
prints one row per scenario present in either run: `id`, verdict in A, verdict in B, and the
transition (`same`, `regressed`, `improved`, `changed`, `only in A`, `only in B`). Order of
badness: `resisted` < `degraded` < `inconclusive` < `vulnerable`; `regressed` means B is worse
than A on that order, `improved` better; `changed` covers a move between `degraded` and
`inconclusive` (neither is better). A summary line counts each transition.

Like-for-like guards are printed, not enforced: a different `k`, `vulnerable_if`, mode, corpus
digest or scenario filter is named on stderr as `note: ... differ`, because the comparison then
mixes measurement conditions.

`--format json` prints `{a, b, notes, rows: [{id, a, b, transition}], counts}`.
`--fail-on-regression` exits 3 when any row is `regressed` (the ADR-0022 gate code), so CI can
fail when a setup change made something worse.

## Consequences

No new data is produced; the diff is a pure function of two manifests. A partial run (ADR-0024
B13a) can be diffed; its missing scenarios show as `only in` the other run.

## Test plan

Two published bundles (bare and hardened 2.1.317) diff to the per-scenario changes the published
report describes; identical runs give only `same`; `--fail-on-regression` returns 3 on a
regression and 0 otherwise; JSON output parses; a missing manifest is a readable error.
