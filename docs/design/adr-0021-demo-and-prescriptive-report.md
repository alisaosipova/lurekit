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

## Amendment (2026-11-03, block 5): re-measure composition and version comparison

Status: Accepted. Before, the "What to change" re-measure command hard-coded the corpus as
`scenarios`, had no `--budget`, silently dropped the user's own setup flags, and the version line
compared `2.1.317` with `2.1.317 (Claude Code)` as different strings.

- **Re-measure composition** (`reMeasureCommand` in `src/report/guidance.ts`, still pure): `lurekit
  run <corpus> --agent <a> --model <m> --agent-version <v> <knob run_flags> --mode <mode> --k <k>
  --vulnerable-if <rule> --budget <usd>`, followed by "(add your own --settings/--mcp/--hooks/--skill
  flags; the manifest does not record their file paths)". Agent, model, version, mode, k and
  vulnerable_if come from the manifest. `<corpus>` is passed in by the caller
  (`ReportOptions.reMeasure.corpus`): `run` passes the corpus it resolved (ADR-0022 amendment),
  `report` the corpus a bare `lurekit run` would resolve from the cwd, `demo` the shipped corpus;
  `publish` passes none, so a shared bundle prints `<scenario-dir>` (a path on the publisher's host
  would mean nothing to a reader and could trip the home-path gate). `--budget` is the run's own
  `budget_usd` when it had one, else the caller's `budgetEstimateUsd` (the doctor estimate:
  scenarios x k x the published run's per-repetition cost for the same agent, rounded up to the
  cent), else `<usd>`.
- **Version comparison.** Both the run's `agent_version` and the knob's are normalised to their
  leading `x.y.z` before comparing (`leadingSemver`; a string without one, e.g. `unpinned`, is
  compared as is). The "re-measure before relying on it" version line is printed only when they
  differ.

## Amendment (2026-11-03, block 6): report verbosity and URL policy

Status: proposed, implemented; awaiting maintainer approval. Before, the plain-language paragraph
repeated the headline and the Resisted line in five long sentences, the per-vulnerable block
printed `- isolation: partial [isolation: partial]`, the scoring-notes line cited spec sections,
the What to change evidence line cited a NOTES file, and the report named `profiles/` and
`docs/guide/` files that are not in the npm package without saying where to find them.

- **Verbosity rule.** The plain-language paragraph says only what the headline and the Resisted
  line do not: (1) the attack surfaces the working lures used (or that none worked, or that
  nothing was measured conclusively), (2) the confidence (k, the `vulnerable_if` rule, and for
  k > 1 how many conclusive scenarios were unanimous; for k = 1 the advice to re-run with --k 3),
  (3) what inconclusive and degraded mean, only when the run has any. At most three sentences; no
  count from the headline or the Resisted line is repeated. The "one arm" sentence is dropped.
- **Isolation line.** The per-vulnerable block prints `- isolation: partial (see the note under the
  table)`: the `[isolation: partial]` marker stays in the table cell and is explained once, in the
  note under the table.
- **Scoring-notes line.** The Markdown report prints `MARKDOWN_SCORING_NOTES`: the same rules in
  plain words plus one link to the interpreting-results guide. `report.json` keeps its
  `scoring_notes` string unchanged, so the published `report.json` files and the demo copy stay
  byte-identical to what `report()` renders.
- **URL policy for unshipped files.** A Markdown report never names a spec section, a NOTES file
  or a bare repository path. A file that is not in the npm package (a reference profile, a guide)
  is cited as a Markdown link with plain link text and its repository URL on the main branch
  (`repoFileUrl()`: `https://github.com/alisaosipova/lurekit/blob/main/<path>`). The publish
  redaction gate accepts exactly these URLs (`REPORT_REPOSITORY_URLS`, added to its intrinsic
  exact-string list next to the repository and SARIF schema URLs), never the whole host. A unit
  test checks that every such URL is in that list and that its path exists in the repository.
  This replaces "The reference profile is cited by its repository path and marked as not in the
  npm package" in the Decision above.
- **Audit tables.** Unchanged. The table rows, the headline, the Resisted line and the
  per-vulnerable source/evidence/detector/tool-call lines stay byte-identical to the published
  `report.md`. The byte-identity test (`test/demo-guidance.test.ts`) now maps the published file
  through exactly two substitutions (the isolation line and the scoring-notes line) before
  comparing, and separately asserts that every table row is identical; any other drift fails it.
- **Source column not changed.** Rendering the source cell as `[host](url)` would narrow the table,
  but it changes every table row and so breaks the rule that the audit tables stay byte-identical
  to the published reports. Deferred: it needs a maintainer decision to re-baseline the published
  `report.md` files (or to accept a table that differs from them).
- **Demo banner.** Short lines (one fact per line, at most 130 characters), the `lurekit run`
  command on its own line after the `lurekit doctor` line; the facts are unchanged.

## Amendment (2026-11-04, block 7): terminal view

Status: proposed, implemented; awaiting maintainer approval. Before, `lurekit demo` and
`lurekit report --format markdown` printed the Markdown report raw to the terminal: literal
`**bold**`, backticks, a `|---|` pipe table whose rows carry 90-character source URLs and wrap at
the terminal width; the README image, rendered from that output, was unreadable ("the SVG in the
repo is broken, a human cannot read it").

- **Two renderings of one data set.** The Markdown report stays the artifact format: `report.md`
  in a bundle, `--format markdown` (alias `md`), and `--output <file>` without `--format`. Its
  bytes are unchanged (the byte-identity tests of `test/demo-guidance.test.ts` stand). A new
  `text` format (`src/report/terminal.ts`, `renderTerminal(data, { width, color })`, dispatched
  by `report()` like the other formats) renders the same inputs (manifest, scoring block, the
  guidance layers, the evidence lookup, and for `demo` the banner lines) for a person reading a
  terminal. It adds no fact and drops none: every count, scenario id (in the same order) and
  source URL of `report.md` appears in the terminal view; a unit test checks each against
  `report.json`.
- **Layout.** The demo banner as a bold title and prose paragraphs wrapped at the width (the
  Markdown banner's one-fact-per-line text is joined into paragraphs, a line ending with a
  colon closing one, so no half-line dangles at 80 or 100 columns); the bundle URL and the
  `lurekit run` command whole on their own indented lines, never wrapped; the title underlined
  with `=`; the plain-language paragraph wrapped at the width; the headline (`Vulnerable to N
  of M scenarios (degraded: d, inconclusive: i).`, the parenthesis moved to an indented second
  line when the headline does not fit the width) and the Resisted line (`Resisted: a not
  attempted, b denied`, with the meaning of denied on the next line); the setup facts on one line (model,
  the profile digest shortened to 12 hex characters and `...`, the run id). Then the result
  table as aligned columns: `id`, `verdict` in words (`resisted (denied)`, `vulnerable
  (isolation: partial)`), `conf` (the confidence tally compacted: `3/3 vulnerable` -> `3/3`,
  `0/3 vulnerable, 1 inconclusive` -> `0/3 +1 inc`; a legend line follows the table), `source`
  (a short reference: the CVE id when the name or URL has one, else the GHSA id, else the URL
  host without `www.`) and `name`, truncated with `...` to the columns left. A table row is
  never wrapped. The source column is shown only when the name still gets 36 columns
  (`NAME_MIN`); below that it is dropped from the table, because every URL is in the numbered
  **Sources** list that follows the table (`N. <id>  <url>`, table order). Then the isolation
  note (when any row is partial), the per-vulnerable block (id and name, isolation, evidence
  pointer, detector and tool-call name when evidence is available), the reading notes, and
  What to change: the guidance layer's Markdown lines rendered as plain text (headings
  underlined with `-`, bullets with a hanging indent, `[text](url)` as `text <url>`); the
  re-measure command is printed whole on its own indented line after its note, never wrapped,
  so it can be copied.
- **Width.** `process.stdout.columns` when stdout is a TTY; else `COLUMNS` from the environment
  when it is a positive integer; else 100; never below 60 (`terminalWidth`). Every line but a
  URL, a command line and a table row's padding fits the width; URLs and commands are never
  broken.
- **Colour.** ANSI bold, dim, red (vulnerable), green (resisted) and yellow (inconclusive,
  degraded) only when stdout is a TTY, `NO_COLOR` is unset or empty, and `FORCE_COLOR` is not
  `0` (`colorEnabled`); a `--output` file is never coloured; `FORCE_COLOR` does not turn colour
  on for a pipe. Padding is computed on the uncoloured text.
- **CLI.** `demo` and `report`: without `--format`, stdout gets `text` and `--output` gets
  `markdown`; `--format text|markdown|json|sarif` names the format (so `report` no longer prints
  JSON by default on stdout; `--format json` is unchanged and still prints `report.json`
  exactly). `run` keeps `markdown` as its default and accepts `text` as well. The process facts
  the view needs (TTY, columns, the colour variables) come through `CliDeps.terminal()`, so the
  tests are hermetic; absent it means a pipe at 100 columns, no colour. For `json` and `sarif`
  the demo banner still goes to stderr; for `text` it is part of the view.
- **README image.** `scripts/render-demo-svg.mjs` renders the first screen of the terminal view
  (ADR-0023 amendment below): no Markdown syntax, aligned columns, verdict cells coloured by
  kind.
- **Not changed.** The Markdown reporter, `report.md` in every published bundle, `report.json`,
  SARIF, the publish gate.

## Amendment (2026-11-05, blocks B16e/B18: UX-07, UX-09, UX-14, UX-17)

- `run` prints the terminal view by default, like `demo` and `report`; with `--output` it writes
  Markdown (UX-07).
- Re-measure commands give `--agent-version` the leading semver only (`2.1.317`, not
  `'2.1.317 (Claude Code)'`), so they paste into POSIX shells, PowerShell and cmd.exe alike; the
  rest of the line uses no shell-specific syntax (UX-09).
- Below 100 columns the terminal table uses compact verdict labels: `vulnerable*` (the note
  under the table starts `* = isolation: partial`), `resisted (not att.)`, `(low conf.)`,
  `(reduced)` (UX-14). The Markdown report is unchanged.
- The terminal view's `evidence:` lines are prefixed with the run directory as the CLI resolved
  it, and for `demo` with the published bundle URL, so they open as printed; the renderer takes
  the prefix as an option and stays pure (UX-17). The Markdown evidence lines are unchanged.

## Amendment (2026-11-05, UB-1): results by OWASP Agentic Top 10

Every scenario carries its OWASP Top 10 for Agentic Applications classes (`class.asi`, names in
docs/research/landscape.md, source genai.owasp.org). The terminal view prints a "By OWASP Agentic
Top 10" table after the result table: one row per ASI id that has at least one measured
scenario, with the category name and the counts measured / vulnerable / resisted /
inconclusive (degraded counts with resisted's neighbour column, shown as its own count when
non-zero). A scenario with several classes counts in each. SARIF carries the same rows as
`run.properties.by_asi`. The classes come from the corpus (the scenario files), like the
attack surfaces, so a published bundle is shown with the classes of the shipped corpus. The
Markdown report and report.json are unchanged (byte-identity with published bundles).

