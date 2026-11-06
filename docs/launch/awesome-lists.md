# Awesome-list entries

DRAFT for the maintainer to rewrite. One PR per list, opened by the maintainer, following that
list's CONTRIBUTING file. List names, section names and entry formats below are from memory and were
not checked offline: each is marked (verify). Read the list's README and CONTRIBUTING before opening
the PR, copy the exact format of a neighbouring entry, and keep alphabetical order if the list uses
it. Do not ask anyone to approve or react to the PR.

One-line description used everywhere (fits a list line; derived from the positioning sentence):

> Measures which publicly disclosed repo, skill and MCP-tool lures a deployed coding-agent setup takes, using inert, disclosure-cited scenarios.

Facts behind it: `README.md` (intro, Inertness, Status), `package.json` (MIT, repository URL).

## awesome-mcp (punkpeye/awesome-mcp-servers and similar)

Fit: LureKit is not an MCP server and does not provide one to users. `awesome-mcp-servers` lists
servers, so LureKit does not belong there; do not submit it (verify that the list has no
"security tools" section for non-servers).

Possible fit: a developer-tools list such as `punkpeye/awesome-mcp-devtools` (verify the name and
that it has a testing or security section). LureKit is still a weak fit there: it tests coding-agent
setups, of which MCP servers are one surface (8 `canary_mcp_tool` scenarios per
`docs/design/setups-week6.md`). Recommendation: submit **mcp-review-check** to the MCP devtools list
(it lints MCP servers, which is the list's subject) and leave LureKit out of MCP lists.

## awesome-security (sbilly/awesome-security)

Fit: weak (verify). The list is organised by classic categories (network, web, endpoint,
threat intelligence...), and may have no AI/agent section. If there is a "Testing" or
"Web/Application" area for benchmarks, use it; otherwise do not submit.

Entry (verify format, which is usually `- [Name](url) - Description.`):

```markdown
- [LureKit](https://github.com/alisaosipova/lurekit) - Benchmark that measures which publicly disclosed repo, skill and MCP-tool lures a deployed coding agent takes, using inert scenarios and out-of-band detectors.
```

PR title: `Add LureKit`

PR body:

> Adds LureKit (MIT) to <section>. It is a measurement tool for coding-agent setups: each scenario
> cites a published advisory or write-up, fixtures are inert by construction, and every detector
> has a positive and a negative control. Published results and evidence bundles are in the repo.
> I am the author.

## awesome-llm-security (corca-ai/awesome-llm-security)

Fit: good (verify). The list has a "Tools" section and sections for papers/benchmarks (verify the
names). LureKit fits under a benchmark or tools section.

Entry (verify format):

```markdown
- [LureKit](https://github.com/alisaosipova/lurekit): Disclosure-traced benchmark for deployed coding agents (Claude Code; Cursor CLI, Codex CLI and OpenHands adapters stub-tested). Inert lures in project settings, hooks, `.mcp.json`, skills, package installs and issue/web content.
```

PR title: `Add LureKit, a disclosure-traced benchmark for coding-agent setups`

PR body:

> Adds LureKit to <section>. It drives the unmodified agent CLI you have installed, headless, with
> your settings, hooks, MCP servers and skills as the variable, and reports "vulnerable to N of M"
> with per-scenario evidence. Every scenario cites a public disclosure (required by the schema).
> First published result: default headless Claude Code 2.1.317 took 4 of 21; `--setting-sources user`
> took it to 0 of 21 (k=3, one model, one host; bundles in `reports/`). Only the Claude Code adapter
> is live-validated. I am the author.

Sources: `README.md` Status (adapters, live-validated), `docs/reports/2026-11-03-claude-code-2.1.317-k3.md`
(4 of 21, 0 of 21), `docs/launch/show-hn-lurekit.md` (surfaces list).

## Agent-security lists (for example "awesome-ai-agent-security", "awesome-agent-security")

Several small lists with names like these exist (verify each: last commit date, whether PRs are
merged, the section layout). Submit only to lists with a merge in the last three months.

Entry (adapt to the list's format):

```markdown
- [LureKit](https://github.com/alisaosipova/lurekit) - Measures which disclosed coding-agent lures (poisoned repo config, skills, MCP tools) your setup takes, with inert fixtures and the one setting that stopped them in published runs.
```

PR title: `Add LureKit (coding-agent setup benchmark)`

PR body:

> Adds LureKit under <benchmarks/evaluation section>. MIT, Node CLI, offline demo
> (`npx lurekit demo`). Scenarios cite public disclosures; fixtures bind to
> loopback only and carry only canary values. I am the author.

Note: `lurekit demo` is on npm since 1.2.0 (current release 1.6.0, 2026-11-05). Nothing here is posted without the maintainer's approval.

## Rules for all of these

- One PR per list; no bulk PRs from scripts.
- State "I am the author" in each PR body.
- No adjectives the list would have to edit out ("best", "first", "comprehensive").
- If a maintainer says it does not fit, close the PR and do not resubmit.
