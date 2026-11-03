# Contributing

The main contribution is a new scenario derived from a public security disclosure. This file is the
submission path defined in [ADR-0012](docs/design/architecture.md#adr-0012-contribution-model) and the
disclosure policy in [ADR-0014](docs/design/architecture.md#adr-0014-ethics-and-coordinated-disclosure).

Code changes follow the project's spec-driven workflow: a PR that adds behaviour cites the ADR or SDD
section that authorises it (see [docs/design/](docs/design/)). If no spec covers it, open an issue first.

## Before you start

- Open a [scenario submission issue](.github/ISSUE_TEMPLATE/scenario-submission.yml) if you are unsure
  the disclosure fits (surface, effect, fixture). This is optional for a scenario that only reuses
  existing fixtures and detectors.
- If the issue is **not yet fixed** by the vendor, do not open a public issue or PR. See
  [Unpatched issues](#unpatched-issues-coordinated-disclosure).

## What a scenario PR contains

1. **Exactly one new file**, `scenarios/AAB-NNN.yaml`, using the next free number. No other changes in
   the same PR, unless a new fixture is needed (see below).
2. **It validates** against [schemas/scenario.schema.json](schemas/scenario.schema.json).
3. **A public disclosure citation** in `source.primary_url` (required by the schema), with
   `source.date`. Add `cve`, `secondary_urls`, `fix_status` and `verification` when known. A scenario
   without a public disclosure is out of scope.
4. **Fixture reuse.** Use an existing fixture type (`fixtures[].type`) and detector
   (`forbidden_effect.detector`). Look at existing `scenarios/AAB-*.yaml` for the `params` each fixture
   accepts; a fixture rejects unknown params at run time. A scenario that needs a new fixture type or
   detector is a code change: it needs a spec (ADR) first and lands separately, before the scenario.
5. **A benign task** (`benign_task`) that a correctly configured setup still completes, so a setup that
   blocks everything does not score as perfect.
6. **The reproducibility checklist** in the PR template, filled in.

Use [AAB-001](scenarios/AAB-001.yaml) (patched CVE, `tier: regression`) and
[AAB-020](scenarios/AAB-020.yaml) (unpatched class, `tier: class`) as references for the shape.

## Reproducibility checklist

- [ ] `node dist/cli.js validate` passes.
- [ ] `node dist/cli.js plan --model <model-id> --agent <id>` lists the scenario as `KEEP`.
- [ ] The scenario was run against at least one agent, either live (`run`) or offline via
      `run --replay <recording>`. State which. A replay checks observation and reporting only; it is not
      a benchmark result, and the maintainer does the live run before merge.
- [ ] The run's `manifest.json` (in `<results>/<run_id>/`) was kept and its agent version, model and
      verdict are stated in the PR.
- [ ] Any evidence attached to the PR was produced with `publish` (redaction gate, no raw transcripts),
      not copied from the run directory.

## Review rules

A scenario is rejected if any of these fail:

- **No speculative attacks.** It reproduces a publicly disclosed issue, cited in `source.primary_url`.
- **Inert by construction.** Fixtures bind only to loopback or the harness canary host and carry only
  canary values. Inertness is enforced in the fixture base class; a scenario must not try to work around
  it (no real hosts, real credentials or real packages).
- **Disclosure-level wording only.** `name`, `task` and `notes` describe the attack at the level of the
  public disclosure. No working-exploit, evasion or obfuscation detail beyond it. `forbidden_effect` is a
  detector assertion, never attack steps.
- **Attribution.** Payload text derived from third-party research carries an attribution note in `notes`.
- **Pure ASCII.** The YAML file contains ASCII characters only (no invisible or look-alike Unicode).

## Unpatched issues (coordinated disclosure)

A scenario citing an issue with `fix_status: unpatched` is published in the public catalog only after
the fix ships or 90 days after the disclosure, whichever comes first. Until then it is held in a private
tier and is not listed publicly. The repository has no in-tree private tier yet: the maintainer keeps
such a scenario out of the public `scenarios/` directory, and published run bundles leave it out with
`publish --withhold <id>`.

To submit one, do not open a public issue or PR. Use GitHub private vulnerability reporting on this
repository (Security tab, "Report a vulnerability") and include the same fields as the issue template.

## Licensing of contributions

LureKit is licensed under the [MIT License](LICENSE) and stays MIT.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO 1.1). Add a sign-off line to every commit, using your real name and email:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. By signing off you certify the DCO for that commit and also agree that the
maintainer may relicense your contribution, in a future version of LureKit, under an OSI-approved or
source-available license. Versions already released under MIT stay MIT.
You keep the copyright in your contribution: this is a permission to relicense, not a copyright
assignment.

Why: this keeps dual licensing possible later without having to track down every past contributor.

## How CI validates

On every push and pull request, CI (`.github/workflows/ci.yml`) runs on Linux, macOS and Windows:

- `npm run typecheck` and `npm test` (offline, stub adapter);
- `node dist/tools/validate-scenarios.js scenarios` (schema, including the required `source.primary_url`);
- `node dist/cli.js selftest` (each detector's positive and negative control).

A second job (Linux) drives the corpus through the replay adapter on the recorded claude-code run
in `test/fixtures/recordings/claude-sample` and checks that every planned scenario (runnable and
applicable to claude-code) wrote an evidence file, that nothing is vulnerable or degraded, and that
nothing is inconclusive except MCP scenarios (the recording has no MCP server connected). It
then runs `node dist/cli.js publish --redact-home` on that run, which must pass the redaction gate.
Replayed results are marked as replays: this proves the pipeline, parser, reporters and publish gate,
not how an agent behaves on your scenario.

CI does not launch a live agent. The live run against at least one agent is a manual step performed by
the maintainer before merge (ADR-0012).

## Running the offline commands

```bash
npm ci
npm run build

node dist/cli.js validate                    # schema-validate every scenario
node dist/cli.js selftest                    # detector positive/negative controls
node dist/cli.js plan --model <model-id>     # which scenarios would run for this profile

# Replay a recorded Claude Code run against only your scenario (no agent, no cost, no network).
# --replay supports only --agent claude-code (the default).
mkdir -p .aab-runs/one && cp scenarios/AAB-NNN.yaml .aab-runs/one/
node dist/cli.js run .aab-runs/one --model <model-id> --replay test/fixtures/recordings/claude-sample

# Bundle a run for sharing (redaction gate)
node dist/cli.js publish .aab-runs/<run_id> --redact-home
```

`run` without `--replay` launches the real agent, costs money and needs the agent's own auth. See
[README.md](README.md#record-once-replay-offline) for how to record a run.
