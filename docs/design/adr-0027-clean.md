# ADR-0027: `lurekit clean`, removing adapter caches that are not evidence

Status: accepted (2026-11-05, ENGINE-14).

## Context

Run directories grow mostly through adapter caches, not evidence: a run-scoped Codex home holds
about 106 MB per repetition, 103 MB of it under `codex-home/.tmp` (a plugins git pack). The
`work/` trees are small and are referenced by evidence (fs_diff, benign checks), so they stay.

## Decision

`lurekit clean [resultsRoot]` (default `.aab-runs`) lists, with sizes, the cache directories it
may delete: `<run>/<scenario>/<rep>/codex-home/.tmp`. Without `--yes` it only prints the list and
the total (a dry run); with `--yes` it deletes exactly those directories. It never touches
`evidence.json`, `manifest.json`, streams, `work/`, artefact files, or anything outside the
results root, and it refuses a path that is a symlink. `lurekit doctor` prints the size of the
results root and the reclaimable cache size, with `lurekit clean --yes` as the fix when it is
over 1 GB.

## Consequences

A cleaned run still reports, publishes and diffs: none of those read the Codex cache. Re-running
Codex against a cleaned run dir is not a use case (each repetition gets a fresh home).

## Test plan

A fake results tree with a codex `.tmp` cache, evidence and work files: the dry run lists only
the cache and deletes nothing; `--yes` deletes only the cache; evidence and work are untouched.
