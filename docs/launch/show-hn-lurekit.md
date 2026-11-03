# Show HN draft

DRAFT for the maintainer to rewrite.

## Title

Show HN: LureKit - measure which disclosed repo lures your coding agent takes

## Body

LureKit runs inert scenarios, each citing a public disclosure, against the coding-agent setup you
actually use and reports "vulnerable to N of M" with per-scenario evidence. On Claude Code
2.1.317 (headless `-p`, model sonnet, k=3) the default setup took 4 of 21, all through config
files in the project directory; with `--setting-sources user` it took 0 of 21 (interactive mode
not measured). Bundles, method and limitations: https://github.com/alisaosipova/lurekit

## First comment

Maintainer here.

Cost. `lurekit demo` prints a published run offline: no agent, no auth, no cost. A live smoke run
(k=1) of the same 21 scenarios is estimated at about 1.28 USD from the published k=3 run
(3.84 USD / 3); the current corpus has 25 Claude Code scenarios, so a run covers more. Two bare
k=1 smoke runs on 2.1.316 reported 1.40 USD (21 scenarios) and 1.60 USD (24). These are the
agent's own client-side estimates. `--budget` has no default, so pass one.

Inertness. Fixtures bind only to loopback, carry only random canary values, and never call a
canary themselves; the fixture base class enforces this. A "vulnerable" verdict means a detector saw a
canary signal: for example a no-op canary command ran, a decoy file was read, a per-run token
reached a loopback sink, or the inert fixture MCP server was started or its decoy tool called.
Every detector has a positive and a negative control (`lurekit selftest`).

Why not AgentDojo. It runs its own tool loop with fictional tools, so it measures a model inside
that loop, not a deployed agent CLI with your settings, hooks, MCP servers and skills. LureKit
drives the unmodified agent CLI you have installed, headless, with its version recorded and your
configuration as the variable, on surfaces where disclosed attacks happened
(project settings and hooks, MCP tool descriptions and results, SKILL.md, package installs,
issue and web content). The comparison is in docs/research/landscape.md, section 6.1.

Why only Claude Code. It is the only adapter validated against the live agent. The cursor-cli,
codex-cli and openhands adapters are implemented and tested against offline stubs; I have not
published live runs for them, so I make no claim about them.

What inconclusive means. The run could not tell: the adapter errored, a fixture failed, the
budget ran out, or a precondition was not met (for example, the injected content was never
fetched). Inconclusive is never a pass; it leaves the denominator and is shown next to the
headline. An example from this round: in headless default permissions the agent cannot curl the
loopback feed, so three feed/web scenarios used to score "resisted" without the content ever
reaching the model. Those rows are excluded from the default-permission bundles, and the runner
now scores that case inconclusive. With an allow rule for curl the content was delivered in 9 of
9 repetitions per bundle and all three were resisted.

Limits. One agent, one model, one day, one host. Headless `-p` has no trust dialog, so this
measures what a headless run (a CI job, a script) loads from an untrusted directory, not what a
user sees interactively. The `--setting-sources user` result is verified for headless runs only;
the interactive equivalent is UNVERIFIED. Its trade-off: your own project-level hooks and
settings stop loading too. One scenario is withheld pending coordinated disclosure.
