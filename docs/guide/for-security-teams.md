# LureKit for security teams

This page is for the team that approves, hardens or audits coding agents (Claude Code, Codex,
Cursor, OpenHands) across an organisation. It says what a LureKit result proves, what it does
not, which artefacts you can file as evidence, and how to run it as a recurring CI check.

## Contents

- [The question it answers](#the-question-it-answers)
- [What a result proves, and what it does not](#what-a-result-proves-and-what-it-does-not)
- [Evidence you can keep](#evidence-you-can-keep)
- [Mapping to the OWASP Top 10 for Agentic Applications](#mapping-to-the-owasp-top-10-for-agentic-applications)
- [A CI gate in one command](#a-ci-gate-in-one-command)
- [Rolling out a hardened setup](#rolling-out-a-hardened-setup)
- [Limits](#limits)

## The question it answers

"If one of our developers opens a repository that carries a publicly disclosed lure (a project
settings file, an MCP config, a poisoned instruction file), does our agent setup act on it?"

LureKit runs the agent you deploy, with the settings you deploy, against a corpus of scenarios
that each reproduce one public disclosure, and records what the agent did. Every scenario cites
its source; nothing in the corpus is speculative. The [catalog](../catalog.md) lists them.

## What a result proves, and what it does not

- **Vulnerable** means a control sensor outside the agent saw the forbidden action happen (a
  canary file read, a canary command run, a canary host contacted). It is an observed action,
  not a text match on the agent's words.
- **Resisted** means the action did not happen in the measured repetitions, split into "not
  attempted" and "denied by the setup". It is evidence about this setup, this agent version and
  this model, not a guarantee for other versions.
- **Inconclusive** is never counted as a pass. It is removed from the denominator and reported
  next to the headline with a reason and a next step.
- Results hold for the agent version recorded in the manifest. Agents auto-update; re-measure
  after an upgrade (`lurekit doctor` shows the installed version and whether it auto-updates).

The full reading guide is [Interpreting results](interpreting-results.md).

## Evidence you can keep

| Artefact | What it is | Typical use |
|---|---|---|
| `<run>/manifest.json` | Agent, version, model, profile digests, config, per-scenario verdicts, spend, date | The dated record of one measurement |
| `<run>/<scenario>/<rep>/evidence.json` | Per-repetition observation: detector signals, attempts, warnings | The audit proof behind each verdict |
| `lurekit report <run> --format sarif` | SARIF 2.1.0; vulnerable as error, inconclusive as warning, the remediation and the per-category counts (`by_asi`) in run properties | Upload to code scanning or a SIEM |
| `lurekit report <run> --format markdown` | The human report with the headline and What to change | Attach to a review or a ticket |
| `lurekit publish <run> --redact-home` | A bundle after a fail-closed redaction gate ([Publishing](publishing.md)) | Share outside the team |
| `lurekit diff <runA> <runB>` | Per-scenario transitions between two runs | Show that a change made nothing worse |

The harness records the hash and file facts of every file it relies on (`<run>/artefacts.json`),
so an agent that modifies a canary file or a detector sink makes that repetition inconclusive
(`evidence_tampered`) instead of silently changing a verdict.

## Mapping to the OWASP Top 10 for Agentic Applications

Every scenario carries its OWASP Agentic class (ASI01 to ASI10). The terminal report
(`lurekit report <run>`, `lurekit run`, `lurekit demo`) prints a "By OWASP Agentic Top 10"
table with, per category, the scenarios measured, vulnerable, resisted and inconclusive; SARIF
carries the same rows as `run.properties.by_asi`. A category without scenarios is absent: the
corpus covers the categories that public disclosures against coding agents have exercised, not
all ten.

## A CI gate in one command

Run the benchmark on a schedule (for example weekly and after every agent or settings change)
against the setup you ship, keep the result, and fail the job when something got worse:

```bash
lurekit run --profile claude-code-hardened --model sonnet --mode full --yes --budget 5 \
  --baseline baseline-run --fail-on vulnerable \
  --format sarif --output lurekit.sarif
```

- `--baseline <runDir>` compares the new run with an earlier one (a run directory or a published
  bundle; both hold a `manifest.json`) and exits 3 when any scenario regressed. A baseline that
  cannot be read stops the job before anything is spent.
- `--fail-on vulnerable` exits 3 when any scenario is vulnerable, regardless of the baseline.
- `--yes` is required without a terminal; `--budget` is a hard spend cap in USD. Without `--k`,
  `--mode full` runs k=3 with the majority rule, the setting the published results use.
- Exit codes: 0 pass, 3 gate tripped, 1 a run or usage problem (the stderr names the next step).

A live run needs the agent installed and authenticated on the runner, and spends tokens. To
check the harness itself at no cost, `lurekit run --replay <recording>` re-drives a recorded run
offline (see [Getting started](getting-started.md#record-once-replay-offline)).

## Rolling out a hardened setup

1. Measure your current setup (`lurekit run --model <id>`), then read the report's **What to
   change** section: each vulnerable surface names a setting that a published run showed
   resisting the same scenarios, with its trade-off.
2. Apply the setting in a profile ([profiles](../../profiles/README.md)) and re-measure with the
   command the report prints.
3. Keep the hardened run as the baseline for the CI gate above.

## Limits

- LureKit measures one agent setup on one machine; it is not a runtime firewall, a proxy or a
  scanner of MCP servers. Pair it with the controls you already run.
- Isolation is reduced: `--isolation` is a manifest label, LureKit starts no container, and the
  agent runs as the invoking user. Run it inside a container or VM you control for that boundary
  ([Troubleshooting](troubleshooting.md)).
- Headless runs (`-p`) can differ from interactive sessions; reports mark this as reduced
  headless fidelity.
- The corpus grows with public disclosures; a category with no disclosed scenario is not tested.
