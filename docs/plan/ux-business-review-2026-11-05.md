# UX and business review, 2026-11-05 (after 1.5.0)

Method: a first-run walk from an empty directory (`--help`, `doctor`, `plan`, `report`) and a
short read of public guidance for security teams deploying coding agents. Findings are what a
security engineer or a CISO's team needs to act on a LureKit result; each item is one small
change, spec first.

## What the sources say (directional, vendor and practitioner material)

- Security teams treat a coding agent as a privileged identity and want an inventory, measured
  policy compliance and audit-ready evidence rather than annual attestations
  ([codecosts CISO guide](https://codecosts.pages.dev/blog/ai-coding-tools-for-cisos-2026.html),
  [governance questions for Claude Code](https://www.pulse.bot/cybersecurity/news/beyond-the-cli-5-governance-questions-every-ciso-must-ask-before-deploying-claude-code-45d99494-470b-4957-a42a-2c5842676a18/)).
- They speak in frameworks: the OWASP Top 10 for Agentic Applications (ASI01..ASI10, published
  December 2025) is the common vocabulary
  ([Cycode summary](https://cycode.com/blog/owasp-top-10-agentic-applications/),
  [Teleport summary](https://goteleport.com/blog/owasp-top-10-agentic-applications)).
- Compliance timelines (the EU AI Act fully applicable from 2 August 2026) push for repeatable,
  dated evidence ([Encore compliance guide](https://encore.dev/guides/ai-code-compliance)).

LureKit already tags every scenario with its ASI and MCP classes, but no report shows them.

## Items

| Id | Problem | Change | Status |
|---|---|---|---|
| UB-1 | Reports never show the OWASP Agentic (ASI) classes the scenarios already carry, so a security team cannot map a result to its framework. | A "By OWASP Agentic Top 10" section in the terminal and Markdown views and a `by_asi` block in SARIF run properties: per ASI id, scenarios measured, vulnerable, resisted, inconclusive. | done |
| UB-2 | `lurekit --help` opens with 100+ lines of flag detail; a newcomer does not see the three commands that matter. | A five-line "Start here" block at the top of the usage (demo, doctor, run smoke, report). | done |
| UB-3 | doctor's isolation row is a long sentence marked ok, about a label that does nothing. | Shorten to one clause and point to the guide. | done |
| UB-4 | Gating CI on "nothing got worse" needs two commands (`run`, then `diff --fail-on-regression`). | `run --baseline <runDir>`: after the run, diff against the baseline, print the transitions and exit 3 on a regression. | open |
| UB-5 | There is no page for the security team that buys the tool: what a result proves, how to use it as evidence, how to wire it into CI. | `docs/guide/for-security-teams.md`: the question LureKit answers, evidence it produces (bundles, SARIF, diff), the ASI mapping, a CI recipe with `--fail-on`/`--baseline`, limits. | open |
| UB-6 | Business readers want one page they can forward; the terminal view and Markdown assume a technical reader. | `--format html`: a self-contained single-file report (no external assets), same data as Markdown, verdict colours, the ASI table and the What to change section. | open |
