# Talk abstract

DRAFT for the maintainer to rewrite. For BSides, OWASP chapter meetings and online events. Check
each CFP's word limit and whether it wants a "takeaways" list (verify per event).

## Title

What does your coding agent take from a cloned repo?

## Abstract (150 words max)

Coding agents load more than code from a repository: project settings, hooks, MCP configs, skills
and instruction files. Public advisories describe attacks through each of these. Which ones does the
agent you actually run take today?

This talk presents LureKit, an open-source benchmark that replays publicly disclosed lures as inert
scenarios (loopback-only canaries, decoy files, a decoy MCP tool) against a real, unmodified agent
CLI and its configuration, with detectors outside the agent that ship positive and negative
controls.

The first result: default headless Claude Code 2.1.317 took 4 of 21 lures, all through config
files in the project directory. One setting, `--setting-sources user`, took it to 0 of 21.

We cover the method, why "inconclusive" must never count as a pass, the vacuous "resisted" verdicts
we found and fixed, what the result does not show, and how to measure your own setup.

## Bio (placeholder, 2 lines)

<NAME> builds measurement tools for the agent era: LureKit (coding-agent setups) and mcp-review-check (MCP servers).
<One line: background, employer or independent, where to find you.>

## Notes for the maintainer

- Numbers: `reports/aab-20261103071018-88a78d8f/report.json` (4 of 21) and
  `reports/aab-20261103062614-49ac1ce7/report.json` (0 of 21); conditions in
  `docs/reports/2026-11-03-claude-code-2.1.317-k3.md` (headless `-p`, `sonnet`, k=3, one host).
- Say "headless" on the slide with the number; the interactive trust dialog was not measured.
- Re-run before the talk date and use the current agent version; the 2.1.317 number is dated
  2026-11-03.
- Demo plan: `lurekit demo` (offline) on stage, never a live run against the venue network.
