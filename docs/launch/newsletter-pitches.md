# Newsletter pitches

DRAFT for the maintainer to rewrite. One pitch per newsletter, three sentences each. Do not send
the same text to two venues. No follow-up nagging; one email, one link.

Facts used (all from this repository, 2026-11-03):

- Headline: default Claude Code 2.1.317 took 4 of 21 lures, all through config files in the project
  directory (settings/hooks and `.mcp.json`); one profile change (`--setting-sources user`) took it
  to 0 of 21. Source: `reports/aab-20261103071018-88a78d8f/report.json` and
  `reports/aab-20261103062614-49ac1ce7/report.json` (`score.headline`), summarised in
  `docs/reports/2026-11-03-claude-code-2.1.317-k3.md`.
- Conditions: headless `claude -p`, model alias `sonnet`, k=3, majority rule, one host, one day.
  Interactive mode not measured. Source: same summary report; `docs/launch/article-lurekit-2026-11.md`.
- Link: https://github.com/alisaosipova/lurekit (from `package.json` `repository`). The summary
  report link below assumes `feat/user-value` is merged to `main` before sending (verify).
- Article URL: not published yet. Replace `<ARTICLE_URL>` once `article-lurekit-2026-11.md` is live.

Positioning sentence (verbatim, use where a one-liner is asked for):
"Measure what your coding-agent setup will take from a poisoned repo, skill or MCP tool, using inert
lures that cite real disclosures, and get the one setting that stops it."

## tl;dr sec (Clint Gibler)

Submission path: reply to the newsletter email or the contact/submit link on tldrsec.com (verify).
The newsletter curates links with a one-line summary; a write-up with method and data is more
useful to them than a repo link alone (verify).

> I measured which publicly disclosed coding-agent lures a default Claude Code 2.1.317 setup takes
> in headless mode: 4 of 21, all through config files in the cloned project directory
> (settings/hooks and .mcp.json), and 0 of 21 with `--setting-sources user`. LureKit, the open-source
> tool behind it, runs inert, disclosure-cited scenarios against the agent setup you actually use
> and publishes redacted evidence bundles. Write-up with method and limits: <ARTICLE_URL>; repo:
> https://github.com/alisaosipova/lurekit.

## Agentic Security Newsletter

Submission path: unknown offline; find the editor contact on the newsletter's site (verify the
newsletter name and that it accepts tool submissions).

> LureKit is a disclosure-traced benchmark for deployed coding-agent setups: each scenario cites a
> public advisory or write-up and replays it with inert canaries against your real agent, settings,
> hooks, MCP servers and skills. First published result: default headless Claude Code 2.1.317 took 4
> of 21 lures, all four via project-directory config (settings/hooks and .mcp.json), and
> `--setting-sources user` brought it to 0 of 21 (k=3, one model, one host). Bundles and limitations:
> https://github.com/alisaosipova/lurekit.

## Console.dev

Submission path: the "submit a tool" form on console.dev (verify). Console reviews developer
tools and states it does not accept payment for inclusion (verify); it tends to want an open-source
tool with docs and a release, not a write-up.

> LureKit is an MIT-licensed Node CLI (`npx lurekit demo` runs offline with no agent, no auth, no
> cost) that measures which publicly disclosed repo, skill and MCP-tool lures your coding-agent setup
> takes, using inert fixtures and detectors that each ship a positive and a negative control. On
> Claude Code 2.1.317 headless, the default setup took 4 of 21 and `--setting-sources user` took it to
> 0 of 21, and the Markdown report names that one setting. Repo: https://github.com/alisaosipova/lurekit.

Note before sending: `lurekit demo` ships in LureKit 1.2.0; verify it is on npm first
(`npm view lurekit version`).

## Changelog News

Submission path: the news submission form on changelog.com (verify). Items are short; a link to
the write-up plus one sentence is the usual shape (verify).

> A small open-source benchmark asks a narrow question: which publicly disclosed lures does the
> coding agent you actually run take from a cloned repo? On default headless Claude Code 2.1.317 it
> was 4 of 21, all through project config files (settings/hooks and .mcp.json), and one flag
> (`--setting-sources user`) made it 0 of 21. Write-up: <ARTICLE_URL> (code:
> https://github.com/alisaosipova/lurekit).

## Risky Bulletin / Risky Biz news section

Submission path: news tips to the Risky Business news team by email (address on risky.biz;
verify). Their news section covers incidents and research, not tool launches, so pitch the
measurement, not the tool (verify).

> Measurement note on coding-agent supply-chain lures: a default headless Claude Code 2.1.317 setup
> started a project-shipped MCP server or ran project hooks in 4 of 21 disclosure-derived scenarios,
> each one traced to a published advisory (including CVE-2025-59536 and CVE-2026-47751) or the
> StepSecurity ChainDrop worm write-up. Loading only user-scope settings (`--setting-sources user`)
> stopped all four; the interactive trust-dialog path was not measured. Method, inert fixtures and
> evidence bundles: <ARTICLE_URL>.

Sources for the IDs: `docs/launch/article-lurekit-2026-11.md`, section "The finding" (AAB-001,
AAB-002, AAB-016, AAB-032).

## This Week in Security (Hackaday, Jonathan Bennett)

Submission path: Hackaday tips line (tips@hackaday.com) or the column author directly (verify both).
The column discusses a handful of stories in prose; a clear "what happened, why it matters" email
works better than a feature list (verify).

> If you point a coding agent at a cloned repo in a script or CI job, the repo's own config files
> are part of the attack surface: in my measurement, default headless Claude Code 2.1.317 took 4 of
> 21 disclosure-derived lures, and all four came through project settings, hooks and .mcp.json, not
> through the model reading anything during the task. Passing `--setting-sources user` brought that
> to 0 of 21, at the cost of your own project-level hooks no longer loading. Every lure is inert
> (loopback-only canaries), and the bundles are public: https://github.com/alisaosipova/lurekit.

## Before sending any of these

- Merge and release first; every link must resolve on the default branch.
- Re-read the limits paragraph of the article; a newsletter editor will quote the number without it.
- Do not claim anything about Cursor, Codex or OpenHands: those adapters are tested against offline
  stubs only (`README.md`, Status).
