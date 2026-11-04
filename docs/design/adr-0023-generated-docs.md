# ADR-0023: Generated docs: scenario catalog, verified-against matrix, demo image

Status: proposed, implemented (2026-11-03); awaiting maintainer approval. Authorises
`scripts/catalog.mjs`, `scripts/matrix.mjs`, `scripts/render-demo-svg.mjs`, the npm scripts
`catalog`, `matrix`, `assets:demo` and `docs:check`, the `docs` job in `.github/workflows/ci.yml`,
and `test/generated-docs.test.ts`. Builds on ADR-0012 (publishing), ADR-0014 (withheld results),
ADR-0017 (bundles) and ADR-0021 (the shipped demo bundle).

## Context
A reader could not browse the corpus without opening 52 YAML files, could not see which agent
versions and profiles have published results without opening ten bundles, and the README showed
no output. Hand-written tables of either would drift from the YAML and the bundles.

## Decision
- **`docs/catalog.md`** is generated from `scenarios/*.yaml`: id, name, surface, effect,
  disclosure (linked `source.primary_url`, labelled by CVE, else GHSA id, else host; `source.date`),
  `applies_to`, runnable, `source.fix_status`, tier; sorted by id. Every cell is a scenario field.
- **`docs/verified-against.md`** is generated from `reports/*/`: per bundle, `manifest.json`
  (agent, agent_version, model, date, mode, k, `vulnerable_if`, `setting_sources`,
  `permission_mode`, settings digest) and `report.json` `score.headline`. The profile label is
  derived: `hardened` when `setting_sources` is `["user"]`, else `bare`; `+ netread` when the
  settings digest equals the runner's digest (sha256 of canonical JSON) of
  `profiles/settings/allow-loopback-curl.json`. The withheld/excluded split is read from the
  bundle's `index.md` sections, because the manifest records only corpus and results; the script
  fails unless the corpus ids missing from the results equal withheld + excluded. The validity
  note of `docs/reports/2026-11-02-claude-code-2.1.316.md` is a fixed rule: a 2026-11-02 bundle
  whose results include AAB-017, AAB-021 or AAB-056 carries footnote [1] naming those ids.
- **`docs/assets/demo-output.svg`** is rendered from the real `lurekit demo` stdout: lines 1
  through the fourth result-table row, word-wrapped at 110 columns, unchanged otherwise; the only
  added text is the title bar and a footer saying how many lines are shown. Adapted from
  mcp-review-check `docs/launch/render-svg.mjs`.
- All three outputs are pure ASCII (non-ASCII in a source cell is an error; in the SVG it becomes
  an XML character reference), and the SVG must stay under 60 KB.
- Drift: each script has `--check`; `test/generated-docs.test.ts` compares the committed files with
  the generated output inside `npm test` (the SVG test drives `main(['demo'])` from `src/`, so it
  needs no build); the CI `docs` job rebuilds, regenerates and fails on `git diff`.

## Consequences
- Adding a scenario or publishing a bundle requires `npm run catalog` / `npm run matrix` in the
  same change; a change to the demo bundle or to the Markdown reporter requires
  `npm run build && npm run assets:demo`.
- The scripts are repository tooling, not shipped in the npm package.

## Amendment (2026-11-03, block 6): numbers emitter, every hand-written count checked

Status: proposed, implemented; awaiting maintainer approval. Before, README.md,
`docs/guide/getting-started.md` and `docs/guide/cli-reference.md` carried hand-typed counts and
costs (scenario totals, per-agent plan counts, USD estimates, the pinned Claude Code version, the
SARIF driver version) that drifted from the code; `docs:check` needed a prior build and checked
only the three generated files.

- **Emitter.** `scripts/numbers.mjs` (repository tooling, not shipped) prints one JSON object of
  facts computed from the tree: scenario counts from the loader (total, runnable, not runnable,
  runnable but not for claude-code); per-agent `kept`/`skipped` from the real `lurekit plan` of
  the built CLI (`dist/cli.js` `main()`, same plan logic as a user's run); the test count; the
  adapters (`SUPPORTED_AGENTS`), implemented and deferred detectors (`IMPLEMENTED_DETECTORS`
  against the schema enum) and fixture kinds (`IMPLEMENTED_FIXTURES`); versions (package, the
  pinned Claude Code version, the `claude auth status` minimum, the Node minimum, SARIF); the demo
  bundle's spend and the doctor cost basis and estimates derived from it (`costBasis`, `usd`);
  every arm the hardening knob cites, read from its bundle's `report.json`; the number of
  published bundles; and exact output lines (`plan`, `validate`, `list`, the doctor cost line, the
  refused live-run preview, a replay of the sample recording, the demo headline, the SARIF
  header of a fresh run). Scratch for the preview and the replay is `.aab-runs/_numbers`
  (git-ignored), removed afterwards. No agent is launched (the adapter is a proxy that throws on
  use), no network.
- **Test count.** The number of test cases `vitest list --json` collects (after loops and
  `each` expand): the "Tests" total of `vitest run`, not the number of `it(` call sites.
- **One pinned version.** `PUBLISHED_CLAUDE_VERSION` in `src/report/guidance.ts` is the only place
  the Claude Code version is typed. `HARDENING_KNOBS`, doctor's `PINNED_CLAUDE_FALLBACK` (the
  pinned-install recipe), the docs (checked) and `examples/run-live.sh` (reads it from `dist/` with
  `node -e`; the check fails if the script types any x.y.z) take it from there; a unit test pins
  it to the demo manifest.
- **Markers.** Each quoted number is wrapped as `<!-- n:KEY -->VALUE<!-- /n -->` (KEY a dotted
  path into the JSON) and must equal the emitted value exactly. Output excerpts in fenced code
  blocks are preceded by `<!-- n-line:K1,K2 -->`; the next block must contain each emitted line
  (surrounding spaces trimmed). An unknown key, a drifted value, a missing line, a malformed
  marker or a checked file with no marker fails `--check`.
- **Wiring.** `npm run docs:numbers` prints the JSON; `npm run docs:check` builds first, then runs
  `numbers.mjs --check`, then the three existing `--check` scripts. The CI `docs` job runs
  `npm run docs:check`; the CI test job builds before `npm test`. `test/numbers.test.ts` tests the
  marker checker on synthetic text and, when `dist/` is fresh, runs the full check with
  `--skip-tests` (so the test does not re-collect the suite it is part of; the docs job checks the
  test count).
- **Not checked.** Release-history facts ("1.2.0 or newer", "1.1.1 and older"), example outputs of
  one particular run (e.g. `published 30 file(s)`), and verified-on citations of a past binary
  (`claude --help` 2.1.316) stay as written; they are history, not counts of the current tree.

## Amendment (2026-11-04, block 7): the demo image is the terminal view

Status: proposed, implemented; awaiting maintainer approval. Before, the image was the first
lines of the Markdown that `lurekit demo` printed, word-wrapped at 110 columns by the script:
Markdown syntax and pipe-table rows wrapped across three lines, unreadable.

- **Input.** `scripts/render-demo-svg.mjs` runs `node dist/cli.js demo` with `COLUMNS=110` and
  `NO_COLOR=1` (a pipe: the CLI prints the terminal view of ADR-0021 amendment block 7 at 110
  columns, no ANSI codes) and takes the lines from the top through the table header, its rule
  and the first `TABLE_ROWS` (4) result rows. The script wraps nothing: the CLI already fits
  every shown line in 110 columns, and the script fails if one is wider (a command line is
  exempt). `--stdin` (the generated-docs test) takes the same output rendered in-process with
  `CliDeps.terminal()` returning `COLUMNS=110`.
- **Styling by line kind**, from the text alone: the banner's first line, the title, the
  headline and the table header bold; the title rule, the table rule and the setup line dim; a
  table row split into id, verdict and the rest, the verdict cell coloured by its first word
  (red vulnerable, green resisted, yellow inconclusive/degraded). Each span carries an explicit
  `x` from its character offset, so a renderer that does not flow `tspan`s (ImageMagick) places
  it where a browser does.
- **Unchanged.** The title bar and the dim footer are the only text that is not demo output;
  pure ASCII, under 60 KB; `--check` and the CI docs job as before. `scripts/numbers.mjs` reads
  the demo title, headline and Resisted lines from the terminal view (what `lurekit demo` prints
  to a pipe), and the getting-started excerpt shows those lines.
