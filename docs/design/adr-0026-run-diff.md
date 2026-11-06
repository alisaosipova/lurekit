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

## Amendment (2026-11-05, UB-4): `run --baseline <runDir>`

Gating CI on "nothing got worse" needed two commands, `run` and then `diff --fail-on-regression`.
`lurekit run --baseline <runDir>` (a `run`-only string flag) does both:

- Before the run, the baseline's `manifest.json` must parse and carry a `results` array, or the
  run is refused with exit 1 before any prompt, spawn or spend (the ADR-0022 pre-spend rule,
  `preSpendProblem` in `src/cli.ts`).
- After the report and the diagnosis, the diff baseline -> this run (the Decision above, same
  `diffRuns`) is printed on stderr under "Compared with the baseline <runDir>:", with the
  like-for-like notes. stdout keeps only the report, so `--format json|sarif` stays parseable.
- Exit code: 3 when a row is `regressed` (`gate: --baseline tripped by <ids> (exit 3)`), 3 when
  `--fail-on` trips, else the run's own code. The comparison is printed in both cases.

`diff` and `--baseline` share one manifest reader; a JSON file without `results` is now a
readable error (`... is not a run manifest`) instead of a failure inside the comparison.

Test plan (`test/run-baseline.test.ts`, offline replay of AAB-030, which scores degraded): a
baseline edited to `resisted` exits 3 and names AAB-030; a `degraded` baseline exits 0 and still
prints the comparison; a missing baseline is refused before the adapter is touched; `report`
rejects the flag.
