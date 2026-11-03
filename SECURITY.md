# Security policy

This file covers two different things:

1. a vulnerability in LureKit itself (the harness, fixtures, detectors, reporters, CLI);
2. a finding about a coding agent that LureKit measures.

## Reporting a vulnerability in LureKit

Report it privately through GitHub private vulnerability reporting:
https://github.com/alisaosipova/lurekit/security/advisories/new
(Security tab, "Report a vulnerability").

Do not open a public issue, PR or discussion for a finding that is not yet fixed.

Useful content for a report:

- the LureKit version or commit, Node version and OS;
- the command that triggers the issue and what you expected instead;
- the impact (for example: a fixture reaching a non-loopback host, a canary value leaking into a
  published bundle, the redaction gate passing a raw transcript, a detector that misses its own signal).

The project is maintained by one person. Reports are acknowledged and fixed on a best-effort basis; there
is no bug bounty. Only the latest release (or `main` before the first release) receives fixes.

## Findings about agents LureKit measures

LureKit runs scenarios against third-party coding agents. A run can show that an agent configuration is
vulnerable. The project handles such findings by coordinated disclosure
([ADR-0014](docs/design/architecture.md#adr-0014-ethics-and-coordinated-disclosure)):

- **Vendor first.** A new or still-unpatched issue in an agent is reported to that agent's vendor through
  the vendor's own security channel before anything is published.
- **Withheld from published bundles.** Results for a scenario covering an unpatched issue are left out of
  published run bundles with `publish --withhold <id>` until the fix ships or 90 days after the disclosure,
  whichever comes first.
- **Kept out of the public catalog.** A scenario for an unpatched issue is kept out of `scenarios/` for the
  same window. To submit one, use the private reporting link above, not a public issue or PR (see
  [CONTRIBUTING.md](CONTRIBUTING.md#unpatched-issues-coordinated-disclosure)).
- **Disclosure-level wording.** Scenarios describe an attack at the level of the public disclosure only:
  no working-exploit, evasion or obfuscation detail beyond it.

If you found a vulnerability in an agent (not in LureKit), report it to that agent's vendor. LureKit is not
a disclosure intermediary for third-party products.

## Inert by construction

Enforced in the fixture base class, not per scenario:

- fixtures bind only to loopback (`127.0.0.1`, `localhost`, `::1`) or to a harness-provided canary host;
- fixtures carry only canary values (random per-run markers), never a real credential or real host;
- a fixture never calls a canary itself, so a canary hit can only come from the agent under test;
- detectors are control sensors outside the agent, each with a positive and a negative control
  (`node dist/cli.js selftest`).

A way to make a fixture reach a real host or carry a real secret is a vulnerability in LureKit; report it
as above.

## Non-goals

LureKit is not, and does not accept changes that turn it into:

- a gateway, proxy, credential broker or runtime firewall;
- a static scanner of MCP servers or skills;
- a model-level jailbreak benchmark;
- a SaaS, dashboard, multi-tenant or auth service;
- a source of speculative attacks: every scenario cites a public disclosure (`source.primary_url`, required
  by the scenario schema).
