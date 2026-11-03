# Cadence, contributions, docs site, and measurement

DRAFT for the maintainer to rewrite. Plans only; nothing here is applied. Any part that changes code
or published-data contracts needs an ADR first (CLAUDE.md, SDD rule 1). ADR-0013 (update cadence)
is still DECISION NEEDED; its recommendation is "hand-curated" for now and explicitly avoids
scheduled automated re-runs (`docs/design/architecture.md`). Everything below is hand-run.

## 1. "This week's lure"

Each week:

1. One new disclosure-traced scenario: one `scenarios/AAB-NNN.yaml` citing a public disclosure in
   `source.primary_url`, existing fixtures and detectors only (CONTRIBUTING.md). Ships as a patch
   release (CHANGELOG.md versioning policy: new scenarios on existing fixtures are a patch).
2. Re-run of the standard arms on the current Claude Code version: bare, hardened, bare + netread,
   hardened + netread; k=3, full mode, `--budget 8` each (the configuration of the 2026-11-03 runs,
   `reports/<bundle>/manifest.json`). Publish with `lurekit publish`, withholding any scenario under
   coordinated disclosure.
3. A short post (150 to 300 words): the disclosure, what the scenario checks at disclosure level, the
   verdict per arm, and whether anything moved since last week. If nothing moved, say so in one line.

### What it costs

Published spend for one round of the four standard arms (client-side `total_cost_usd` estimate,
subscription login, not an amount billed; `manifest.json` `totals.spend_usd`):

| arm | bundle | spend (USD) |
|---|---|---|
| bare | `aab-20261103071018-88a78d8f` | 3.838067 |
| hardened | `aab-20261103062614-49ac1ce7` | 4.082348 |
| bare + netread | `aab-20261103075404-f5fe15ec` | 4.340191 |
| hardened + netread | `aab-20261103091409-dff0d34a` | 4.586967 |

- Full weekly round: 16.847573 USD per week (sum of the four), about 73 USD per month at 4.33
  weeks (arithmetic, not a measurement).
- One added scenario: about 0.05 to 0.06 USD per repetition (3.838067 USD over 63 to 75
  repetitions, depending on whether excluded and withheld scenarios count; estimate), so under 1 USD
  per week across four arms at k=3.
- With a subscription login, the real constraint is the plan's usage limit, not USD (verify
  against the plan in use before committing to a weekly cadence).

### Solo-sustainable version

- Weekly: the new scenario plus bare and hardened only, k=3: 7.920415 USD (3.838067 + 4.082348).
- Monthly, or when the Claude Code version changes: the two netread arms (8.927158 USD).
- Skip a week rather than publish a k=1 number as a headline. A k=1 smoke run (1.395508 USD for 21
  scenarios, `docs/reports/2026-11-02-claude-code-2.1.316.md`) is fine for checking a new scenario
  before the real run, not for the post.
- Fixed time budget: if a week's round takes more than one evening, publish the scenario and skip
  the post.

## 2. Scenario contributions

- Issues labelled `good-first-scenario`: each one names a public disclosure (URL), the surface, the
  existing fixture and detector that fit, and the reference scenario to copy (AAB-001 for a patched
  CVE, AAB-020 for an unpatched class, as CONTRIBUTING.md says). Only disclosures that are patched or
  past 90 days. Keep 3 to 5 open at a time.
- Template path: `examples/scenario-template.yaml` -> `scenarios/AAB-NNN.yaml`; check with
  `npm run build && node dist/cli.js validate` (README.md, "Adding a scenario"). Submission issue
  form: `.github/ISSUE_TEMPLATE/scenario-submission.yml`.
- Credits in the catalog: the scenario schema has no author or credit field today
  (`schemas/scenario.schema.json`). Options: (a) a `Contributors` column in the generated catalog
  page taken from the commit's DCO `Signed-off-by` line (no schema change), or (b) an optional
  `credits` field (schema change, minor release, ADR). Recommendation: (a) first.
- Public disclosure queue: a page listing only what is already public, for each held scenario: id,
  "withheld pending coordinated disclosure", the date it will be published (fix date or disclosure
  date + 90 days). No surface, vendor or detail before publication. Today that is AAB-003 (withheld in
  all four 2026-11-03 bundles). Submissions of unpatched issues go through private vulnerability
  reporting, never a public issue (CONTRIBUTING.md, "Unpatched issues").

## 3. Docs site and search

- GitHub Pages from `docs/` on the default branch (verify the repo setting supports `/docs`
  without a build step). Caution: `docs/` also holds `launch/`, `design/` and `research/`; either
  exclude `launch/` from the site (Jekyll `exclude` in `docs/_config.yml`; verify) or keep drafts
  out of `docs/` before enabling Pages.
- One page per scenario, generated from `scenarios/*.yaml` (a generator is a code change: ADR
  first). Page title: scenario name plus the CVE or GHSA id, because that is what people search for
  (for example "CVE-2025-59536" for AAB-001). Content: the disclosure link, the surface, what the
  detector checks, the verdict per published arm with bundle links, and the "What to change" line
  if a verified fix exists. No reproduction steps beyond the disclosure.
- Index pages: the catalog, the results matrix, the getting-started guide, the latest measurement
  summary. Each page links its source file in the repo.
- No analytics script on the site (consistent with "no telemetry"); use GitHub traffic and
  referrers instead (section 5).

## 4. Badges in other repos

LureKit runs are manual and live runs are not in CI (README.md, Status), so a badge cannot
refresh itself. Use a static badge whose text carries the date and agent version, so staleness is
visible, and that links to the published bundle:

```markdown
[![LureKit: vulnerable to 0 of 21 (Claude Code 2.1.317, 2026-11-03)](https://img.shields.io/badge/LureKit-0%20of%2021%20%28claude--code%202.1.317%2C%202026--11--03%29-blue)](https://github.com/alisaosipova/lurekit/tree/main/reports/aab-20261103062614-49ac1ce7)
```

- The example links the maintainer's hardened bundle. Offer a badge only to projects that publish
  their own bundle, linked to that bundle (a third-party arm, `vendor-scoreboard.md`).
- Wording is the headline verbatim; never "secure" or "passed".
- `lurekit report` could print this snippet for a run (code change: ADR first).

## 5. Measurement

Record weekly in a local file outside the published tree (for example `.aab-runs/metrics.csv`,
ignored by `.gitignore` line 4). GitHub keeps traffic for 14 days only, so a missed week is lost data.

| metric | how (maintainer runs it, needs network) |
|---|---|
| GitHub views, unique visitors, clones | `gh api repos/alisaosipova/lurekit/traffic/views` and `.../traffic/clones` |
| Referrers and popular paths | `gh api repos/alisaosipova/lurekit/traffic/popular/referrers` and `.../popular/paths` |
| npm downloads | `curl -s https://api.npmjs.org/downloads/point/last-week/lurekit` (CI and mirrors inflate it) |
| Action installs | LureKit ships no GitHub Action (only `.github/workflows/ci.yml`, `release.yml`). Track it for mcp-review-check: code search for `uses: alisaosipova/mcp-review-check` (verify search syntax) |
| Inbound issues and PRs from strangers | `gh issue list` / `gh pr list` with authors other than the maintainer and bots |
| Third-party arms | count of `docs/results/arms/*` not run by the maintainer |
| Scenarios from others | merged scenario PRs whose author is not the maintainer |

Rule: double down only on referrers that bring people. A referrer counts when it shows up in
traffic referrers and is followed within two weeks by at least one of: a stranger's issue, PR,
scenario, published bundle, or a demo/run question. Views alone do not count. Each month, drop the
venue with the lowest yield and spend that time on the one with the highest.

## 6. ROADMAP paragraph (ready to paste into `docs/plan/roadmap.md`)

Note: the roadmap already has a kill criterion keyed to "four months after the 0.1 report". The
paragraph below keys it to the article; the maintainer decides whether it replaces or follows the
existing one.

> **Kill criterion (distribution).** If four months after the LureKit article nobody but the
> maintainer runs it or submits a scenario, LureKit drops to maintenance mode and distribution time
> stops. "Runs it" means a published bundle, an issue or a discussion showing a run against the
> person's own setup; "submits a scenario" means a scenario PR or a private submission from someone
> other than the maintainer. The date is fixed when the article is published and stated in the
> README. Maintenance mode means security fixes and disclosure-status updates only, no new scenario
> classes or agents, until external demand reappears.
