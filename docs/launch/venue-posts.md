# Venue posts

DRAFT for the maintainer to rewrite. Different text per venue. Each section starts with that
venue's rules as I remember them; anything marked (verify) was not checkable offline. Read the
current sidebar/rules page before posting. Post once per venue, as yourself, and answer comments.
No cross-posting the same text, no asking anyone to upvote, star or comment.

Numbers used, and where they come from:

- 4 of 21 (bare) and 0 of 21 (`--setting-sources user`), Claude Code 2.1.317, headless `-p`, model
  `sonnet`, k=3, majority: `reports/aab-20261103071018-88a78d8f/report.json`,
  `reports/aab-20261103062614-49ac1ce7/report.json`.
- 4 of 24 and 0 of 24 with the netread allow list: `reports/aab-20261103075404-f5fe15ec/report.json`,
  `reports/aab-20261103091409-dff0d34a/report.json`.
- Spend 3.838067 USD (bare k=3 run), demo estimate about 1.28 USD for a k=1 smoke of the same 21:
  `reports/aab-20261103071018-88a78d8f/manifest.json` `totals.spend_usd`; the `lurekit demo` banner.
- 25 claude-code scenarios in the current corpus: `README.md`, Status.
- Smoke spend 1.395508 USD (21 scenarios, `aab-20261102112637-5c55ad74`) and 1.598072 USD (24,
  `aab-20261102161512-ca5fe106`): `docs/reports/2026-11-02-claude-code-2.1.316.md`.
- Same four vulnerable on 2.1.316: `docs/reports/2026-11-02-claude-code-2.1.316.md`.

## r/netsec

Rules (verify): technical content only, link posts to the primary write-up, no product
announcements or "check out my tool" posts, self-promotion tolerated only when the post itself is
substantive research; editorialised titles get removed. No pitch, no call to action.

Post type: link to the article (`<ARTICLE_URL>`), not to the repo.

Title:

> Which disclosed coding-agent lures does a default headless Claude Code take from a cloned repo? 4 of 21, all via project config files

First comment (only if the subreddit expects one; keep it as context, not promotion):

> Method notes for anyone checking the numbers. Each scenario cites a public disclosure and reduces
> it to an inert lure (loopback-only canaries, decoy files, a decoy MCP tool); detectors run outside
> the agent and each has a positive and a negative control. k=3, majority rule, model `sonnet`,
> Claude Code 2.1.317, headless `-p`. All four vulnerable scenarios are settings/hooks and
> `.mcp.json` loaded at startup from the working directory (AAB-001 / CVE-2025-59536, AAB-002,
> AAB-016 / CVE-2026-47751, AAB-032). `--setting-sources user` excluded the project and local
> sources and all four became resisted, not attempted.
>
> What it does not show: the interactive trust dialog (headless has none), other agents (the other
> adapters are stub-tested only), other models, other hosts. Three feed/web scenarios are excluded
> from the default-permission arms because the injected content never reached the model; scoring
> them "resisted" would have been vacuous. The raw evidence bundles are linked from the article.

## r/ClaudeAI

Rules (verify): post flair required; self-promotion limited and must be useful to Claude users;
no referral links; low-effort project showcases may be removed or sent to a weekly thread.

Angle: "I measured my own setup", practical, ends with the setting and its trade-off.

Title:

> I measured what my headless Claude Code setup loads from a cloned repo: 4 of 21 disclosed lures, fixed by one flag

Body:

> I run Claude Code headless (`claude -p`) in scripts against repos I did not write. I wanted to
> know which publicly disclosed repo lures it actually takes with my setup, so I built a small
> benchmark that plants inert versions of them (canary commands, a decoy MCP server, loopback-only
> URLs) and watches from outside the agent.
>
> Result on 2.1.317, model sonnet, 3 repetitions each: 4 of 21 taken. All four were config files in
> the project directory that load at startup: `.claude/settings.json` hooks and a project
> `.mcp.json`. None needed the model to read anything during the task.
>
> The fix that worked: `--setting-sources user`. It loads only your user-scope settings, so project
> and local settings in the cloned repo are ignored. Same 21 scenarios: 0 of 21.
>
> Trade-off: your own project-level hooks and settings stop loading too; move what you need to
> `~/.claude/settings.json`. I only verified this for headless runs; I did not measure the
> interactive trust dialog.
>
> If you want to check your own setup: `npx lurekit demo` shows a published run offline with no
> cost. My live k=1 smoke runs reported about 1.40 USD (21 scenarios) and 1.60 USD (24) in
> agent usage, the agent's own estimate; the current corpus has 25 Claude Code scenarios.
> Repo and evidence: https://github.com/alisaosipova/lurekit

Note: `lurekit demo` is under Unreleased in `CHANGELOG.md`; post this only after the release that ships
it is on npm (verify with `npm view lurekit version`).

## r/cursor

Rules (verify): flair required; self-promotion allowed if relevant to Cursor users; bug reports go
to the Cursor forum.

Constraint: LureKit has no live Cursor result. The `cursor-cli` adapter is implemented and tested
against offline stubs only (`README.md`, Status). Do not post a Cursor number. Two honest options:

1. Do not post on r/cursor until a live `cursor-cli` run is published.
2. Post as a request for a measurement, not a result:

Title:

> Looking for someone to measure Cursor CLI against disclosed repo lures (my Claude Code numbers inside)

Body:

> I measured headless Claude Code 2.1.317 against 21 inert, disclosure-derived repo lures: default
> took 4 (all via project config files), `--setting-sources user` took 0. LureKit also has a
> `cursor-cli` adapter with 7 Cursor scenarios, including AAB-057 (CVE-2025-64109, a project
> `.cursor/mcp.json` server started with no approval), but I have only tested it against offline
> stubs, so I have no Cursor number to share. If you run Cursor CLI headless and want to try it,
> the run writes a redacted bundle you can share or keep. I would rather publish a real Cursor
> result than guess. https://github.com/alisaosipova/lurekit

Source for 7 cursor-cli scenarios and AAB-057: `CHANGELOG.md` [Unreleased] and `README.md`, Status.
Note: AAB-057 is Unreleased; post option 2 only after the release that ships it.

## lobste.rs

Rules (verify): invite-only; you need an account from an existing member before you can post.
Self-promotion is allowed when it is a minority of your activity; authors tick "I am the author".
Tag choice matters (`security`, plus `ai` / `vibecoding` if they exist; verify). Titles should be
the article title, not a pitch.

Flag: invite needed. If you do not have an account, do not ask strangers for an invite to post
this; skip the venue.

Title (article title, unchanged):

> What does my coding agent take from a cloned repo?

Author comment:

> Author here. The narrow claim: on headless Claude Code 2.1.317, 4 of 21 disclosure-derived lures
> got through, all via project-directory config loaded at startup, and loading only user-scope
> settings stopped them. The interesting part for me was the method: inconclusive is never counted
> as a pass, and a "resisted" verdict where the injected content never reached the model is now
> scored as a failed precondition instead. Limits are in the last section.

## MCP GitHub Discussions (modelcontextprotocol org)

Rules (verify): discussions are for the protocol, SDKs and ecosystem; announcement or "show and
tell" categories may exist; off-topic or promotional posts get closed. LureKit is not an MCP server
and not a spec proposal, so only post if there is a show-and-tell or security category.

Angle: what project `.mcp.json` auto-load means for clients, with data.

Title:

> Measurement: project-scoped .mcp.json servers started by a headless client from an untrusted directory

Body:

> Data point for client implementers. In headless Claude Code 2.1.317, two of four vulnerable
> scenarios in my benchmark were a project-shipped `.mcp.json` server being started from the working
> directory: AAB-001 (CVE-2025-59536) and AAB-016 (claude-code-action, CVE-2026-47751). The decoy
> server is inert (stdio, loopback only); the detector records that it was started. With
> `--setting-sources user` no MCP server with source `project` was listed. Method and bundles:
> https://github.com/alisaosipova/lurekit
>
> Question for the group: is there a recommended client behaviour for project-scoped server configs
> in non-interactive mode, where there is nobody to answer a trust prompt?

## MCP Discord

Rules (verify): the official MCP contributors Discord is for spec and SDK work; promotion channels
may not exist. Do not drop a link in a working-group channel. If there is a showcase channel, post
two lines; otherwise skip.

> Measured headless Claude Code against project `.mcp.json` auto-start (CVE-2025-59536 class): the
> default started the project server; `--setting-sources user` did not. Inert fixtures, evidence:
> https://github.com/alisaosipova/lurekit

## Anthropic developer community (Discord / forum)

Rules (verify): find the current official venue (Claude Developers Discord or a forum); a
"share your project" channel may exist. Security issues in Claude Code go to Anthropic's
vulnerability disclosure channel, not a public post. Nothing here is a new vulnerability: all four
scenarios cite published, patched advisories or a public write-up.

> I measured which publicly disclosed repo lures headless Claude Code 2.1.317 takes with default
> settings: 4 of 21, all from project settings/hooks and `.mcp.json`. `--setting-sources user` took it
> to 0 of 21 in the same runs. Two questions for the team or anyone who knows: is
> `--setting-sources user` the recommended setting for CI and scripted runs over untrusted repos,
> and is there an interactive equivalent I should measure? Evidence:
> https://github.com/alisaosipova/lurekit

## Cursor developer forum (forum.cursor.com)

Rules (verify): categories for bugs, feature requests and discussion; security reports go to
Cursor's security contact, not the forum.

Same constraint as r/cursor: no Cursor result exists. Post only a methodology question or wait.

> Is there a supported way to run Cursor CLI headless with project MCP configs and rules files
> ignored, the way Claude Code's `--setting-sources user` does? I measure coding-agent setups
> against disclosed repo lures (inert fixtures, https://github.com/alisaosipova/lurekit) and want to
> test the right Cursor setting rather than guess. I have not published any Cursor result yet.
