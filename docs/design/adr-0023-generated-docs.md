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
