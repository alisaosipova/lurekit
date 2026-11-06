# Examples

Worked, copy-pasteable starting points for authoring and running LureKit scenarios. For the
concepts behind them, read [docs/guide/scenarios.md](../docs/guide/scenarios.md) and
[docs/guide/fixtures-and-detectors.md](../docs/guide/fixtures-and-detectors.md).

## Contents

| Path | What it is |
| --- | --- |
| `scenario-template.yaml` | A fully annotated scenario. Every field explained inline; schema-valid and runnable offline. |
| `profiles/README.md` | A pointer: the setup profiles live in [`../profiles/`](../profiles/) (one directory, no copies). |
| `run-offline.sh` | The whole pipeline with no agent and no spend. Safe to run; execute it. |
| `run-live.sh` | A reference for a budgeted LIVE run against a pinned binary. Commented out; not executed. |
| `run-models.sh` | Run the corpus in Claude Code against the top-10 model families through OpenRouter (ADR-0028); needs `OPENROUTER_API_KEY`, spends money, `--budget 5` per model. |

## scenario-template.yaml

A complete scenario with a comment on every field, derived from the issue-feed walkthrough in
[docs/guide/scenarios.md](../docs/guide/scenarios.md#walkthrough-a-new-scenario). It uses the
`issue_feed` fixture (`ask: command`) and the `canary_command` detector, and shows an `{{env.*}}`
task placeholder and the `SUMMARY:` benign marker.

It lives here, not in `scenarios/`, on purpose. The scenario loader enforces `id == filename stem`
and `id` must match `^AAB-[0-9]{3,}$`, so a file named `scenario-template.yaml` cannot pass the
directory loader as-is:

```sh
$ node dist/tools/validate-scenarios.js examples
FAIL  scenario-template.yaml  id AAB-900 does not match filename stem scenario-template
0 valid, 1 error in examples
```

That error is expected and is *only* the filename-stem invariant - the YAML body itself is
schema-valid. To validate it as a real scenario, copy it in under its id first:

```sh
mkdir -p .aab-runs/ex/scenarios
cp examples/scenario-template.yaml .aab-runs/ex/scenarios/AAB-900.yaml
node dist/tools/validate-scenarios.js .aab-runs/ex/scenarios   # OK AAB-900 ...
```

`run-offline.sh` does exactly this copy step for you. To author a real scenario, copy the template
into `scenarios/`, rename it to the next free `AAB-NNN.yaml`, and set `id: AAB-NNN` to match.
(`AAB-900` is a reserved example number, deliberately outside the real catalogue range.)

## profiles/

The setup profiles live in one directory, [`../profiles/`](../profiles/); `examples/` keeps no
copies (they drifted). The scripts here reference `profiles/` directly. See
[../profiles/README.md](../profiles/README.md) for what each knob excludes. There is no `--profile`
flag - pass the flags listed in each file's `cli_flags`.

## run-offline.sh

Runs the full offline pipeline against a one-scenario corpus built from the template:

```
validate -> selftest -> plan -> run --replay -> report -> publish
```

No live agent, no API spend, no network beyond loopback. It replays the bundled recording in
`test/fixtures/recordings/claude-sample` and writes everything into a scratch directory under
`.aab-runs/examples-offline/` (wiped at the start of each run). Prereqs: `npm ci && npm run build`
(the script prefers the built `dist/`; if it is absent it falls back to `npx tsx` on the source).

```sh
sh examples/run-offline.sh
```

The replay produces a `resisted` verdict for the template (the recorded run does the benign task
and touches no canary) and every published `evidence.json` is marked as a replay in
`observation.warnings` - a replay proves the pipeline, parser, reporters and publish gate, not how
an agent behaves.

## run-live.sh

A reference only - every command is commented out and the script exits without doing anything.
It shows a budgeted live run against a version-pinned binary (`AAB_CLAUDE_BIN`), an optional
hardened-profile comparison, how to record the run for later offline replay, and how to publish a
redacted bundle. Read it, adjust the pins, and uncomment the steps you want. A live run spends
money and needs the agent's own auth.
