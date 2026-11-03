# Defensive-tool authors: outreach and third-party arms

DRAFT for the maintainer to rewrite. Nothing here has been sent or run. What is known about each tool
comes from `docs/design/setups-week6.md` (proposal, 2026-11-03), `docs/design/NOTES-verified-facts.md`
("Defensive tools (Week 6 setups)") and `docs/research/landscape.md` (tool table). Where those files
say UNVERIFIED, so does this one.

State of the harness that matters for these arms (2026-11-03):

- `--settings` / `--hooks` are now forwarded to Claude Code in the single `--settings` file, observe
  hooks appended last (`node dist/cli.js --help`; ADR-0020, status "proposed, implemented (2026-11-03);
  awaiting maintainer approval"). `setups-week6.md` was written before that and lists it as a gap.
- Still missing: a per-run setup step (for `hol-guard install`, `cc-audit check`), an exec wrapper
  with identity path mapping (agentcage), and fixture-endpoint templating for proxies. Each needs an
  ADR first (CLAUDE.md, SDD rule 1).
- Only 1 scenario uses an HTTP MCP fixture (AAB-023); 8 use `canary_mcp_tool`, none over HTTP
  (`setups-week6.md`, S4b). Network MCP proxies and gateways can therefore be measured on very
  little of the suite today.

## Outreach message (template)

Send as a GitHub Discussion or issue on the tool's repo if it has a "Q&A" or "ideas" category,
otherwise to the contact in its README. One message, no follow-up chasing. Adjust the two
tool-specific lines from the sections below.

> Subject: Measuring <TOOL> as an arm in LureKit
>
> I maintain LureKit (https://github.com/alisaosipova/lurekit), a benchmark that replays publicly
> disclosed coding-agent lures as inert scenarios against a real agent setup. On headless Claude
> Code 2.1.317 the default setup took 4 of 21 and `--setting-sources user` took 0 of 21
> (docs/reports/2026-11-03-claude-code-2.1.317-k3.md).
>
> I would like to add Claude Code + <TOOL> <VERSION> as a row. My current plan for running it:
> <ONE LINE: mechanism and invocation from the section below>. Open question I cannot answer from
> your docs: <ONE LINE>.
>
> Two things I would like from you, both optional: tell me if the plan misconfigures your tool, and,
> if you prefer, run it yourself and send the bundle `lurekit publish` writes (redacted, no raw
> transcripts). I will send you the result at least 14 days before it is published, with the
> bundle, and link any response you write. The row is published whatever the result.

Rules: no compliments, no "partnership" language, no request to share or star anything. Publication
of the result is not conditional on the author's approval; factual corrections are applied.

### HOL Guard (hashgraph-online/hol-guard, 3.58.0, Apache-2.0)

- Known: installs Claude Code hooks via `hol-guard install claude-code` into
  `<workspace>/.claude/settings.local.json`; state in `~/.hol-guard`; "ask" verdicts queue in an
  approval center, 120 s default wait, "A timeout leaves the request pending and is never approval".
  Its own benchmark says its results "must not be cited as independent third-party validation".
- Plan line: copy the hooks block from a scratch `hol-guard install claude-code` into a settings
  file and pass it with `--settings` (now forwarded), at command-line rather than local precedence.
- Open questions: where Guard's per-call decision record is written (needed to attribute a block
  to Guard); whether the home directory can be moved for run independence; behaviour of `claude -p`
  with "ask" verdicts.
- Do not combine with `--setting-sources user` (excludes `local`, where Guard installs).

### agentcage (agentcage/agentcage, v0.54.1, MIT)

- Known: wrapper plus rootless Podman/microVM; project at `/workspace`; `.claude/` and `.git/hooks/`
  tmpfs-masked; egress only through an inspecting proxy; host loopback "structurally rejected".
- Plan line: not runnable yet; needs an exec-wrapper ADR and an identity mount of the run directory.
- Open questions: does `agentcage cage exec <cage> -- claude -p ...` pass arguments through; host
  path of `audit.jsonl` / `capture.jsonl` (needed as a sensor input, since 17 `canary_egress_http`
  scenarios target a `127.0.0.1` sink the cage cannot reach).
- Reporting rule: masked `.claude/` = "vector removed by sandbox", shown apart from "agent declined".

### agent-sandbox (kubernetes-sigs/agent-sandbox, v1.0.9, Apache-2.0)

- Known: Kubernetes sandbox CRDs (gVisor/Kata). `landscape.md` lists it as a possible execution
  substrate, not a matrix row; it is not in `setups-week6.md`. Threat model UNVERIFIED.
- Recommendation: do not pitch it as a scoreboard row. If contacted, ask only whether the maintainers
  consider "Claude Code inside an agent-sandbox pod" a configuration they would want measured, and
  what default they would consider fair.

### cc-audit (ryo-ebata/cc-audit, 3.23.30, MIT)

- Known: static scanner of Claude Code artifacts (`cc-audit check`) plus an MCP proxy mode
  (`cc-audit proxy --target IP:PORT`, network only). The name is ambiguous: a PyPI `cc-audit`
  hook logger also exists (UNVERIFIED, excluded).
- Plan line: static row, `cc-audit check <workdir> --format sarif` on each provisioned workdir before
  the agent runs, reported as "would have flagged" next to the bare verdicts. Needs the per-run setup
  step.
- Open question: is the proxy mode meant for stdio servers at all; the proxy row covers at most
  AAB-023 as the suite stands.

### MCP gateways and proxies (glassport, tool-call-guard, mcp-leash; commercial gateways)

- Known: `landscape.md` lists glassport (MCP wire tap/gate, stdio and HTTP), tool-call-guard
  (taint-tracking hooks plus MCP proxy) and mcp-leash (fail-closed proxy skeleton, small or dormant);
  `docs/BRIEF.md` names commercial gateway vendors. None is in `setups-week6.md`.
- Recommendation: contact only tools that can wrap a stdio MCP server, because all 8
  `canary_mcp_tool` scenarios are stdio: 6 `mcp_stdio` fixtures and 2 project `.mcp.json` files with
  a stdio `command` (`setups-week6.md`, S4b). For HTTP-only gateways, say plainly
  that LureKit can measure them on one scenario today and ask whether that is worth doing.
- LureKit stays a measurement tool: it does not become or bundle a gateway (non-goal, `CLAUDE.md`).

## Proposal: `docs/results/` layout for third-party arms

Today published bundles live under `reports/<benchmark_run_id>/` (written with
`lurekit publish --out reports/<benchmark_run_id>`; the default `--out` is `<results>/<benchmark_run_id>/bundle`) and summaries under `docs/reports/`. `docs/results/` does not exist. Proposal (needs an
ADR before anything lands, since it adds a published-data contract):

```
docs/results/
  README.md                      the matrix (generated or hand-kept; see below)
  arms/
    <agent>--<tool>-<tool-version>--<profile-slug>/     e.g. claude-code--hol-guard-3.58.0--settings
      arm.md                     who ran it, date, host OS, exact lurekit command, setup steps,
                                 pinned versions, deviations from the tool's documented install
      setup/                     the settings/MCP/hooks files passed to lurekit (redacted), if any
      bundles/
        <benchmark_run_id>/      output of `lurekit publish <runDir> --out ...`, unmodified:
                                 index.md, manifest.json, report.md, report.json, report.sarif,
                                 <scenario>/<rep>/evidence.json
      VERIFY.md                  the maintainer's check record (below)
```

Naming: lowercase, `--` between agent, tool and profile; versions exact, never `latest`. A bare or
hardened baseline arm is `claude-code--none--bare` and must use the same agent version as the
third-party arms it is compared with.

Required files: `arm.md`, at least one bundle written by `lurekit publish` (the redaction gate must
have passed; bundles edited by hand are rejected), and `setup/` whenever `manifest.json`
`profile.settings_digest`, `profile.mcp` or `profile.hooks` is not the default.

Verification rule: either the maintainer re-runs the arm, or the submitter provides the bundle and
it is checked. Checks, recorded in `VERIFY.md`:

1. `manifest.json` `tool_version` is a released LureKit version and `corpus.corpus_digest` matches
   the scenarios of that release.
2. `profile.agent_version`, `profile.model`, `config.k`, `config.vulnerable_if`, `mode` are stated
   and match `arm.md`; k is at least 3 for a matrix row.
3. `profile.settings_digest` matches the digest of the files in `setup/` (how to recompute it from
   outside the harness: verify against ADR-0020 before relying on it).
4. `report.json` `score` agrees with the per-repetition `evidence.json` files (re-render with
   `lurekit report` if it accepts a bundle directory; verify).
5. Every detector's self-test passed in the run (otherwise the repetitions are inconclusive by
   design, `docs/launch/article-lurekit-2026-11.md`, Method).
6. Withheld and excluded scenario ids are listed and explained.

Status label per arm: `re-run by maintainer` (a maintainer bundle exists for the same versions) or
`bundle-checked` (checks 1 to 6 passed on the submitter's bundle only). A bundle that fails a check is
not listed; the reason goes to the submitter.

How it appears in the matrix (`docs/results/README.md`), one row per arm:

```
| arm | agent version | k | headline | inconclusive | excluded/withheld | status | bundle | date |
```

Headline is `score.headline` verbatim ("vulnerable to N of M"). No ranking, no colour, no
aggregate score across arms; rows with different agent versions or corpus digests are in separate
tables. A tool author's response, if any, is linked from the row.
