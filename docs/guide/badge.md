# A LureKit badge for your repository

A static [shields.io](https://shields.io/) badge that states one published LureKit result, for
example the hardened Claude Code arm of 2026-11-03:

[![LureKit claude-code 2.1.317 sonnet 2026-11-03: vulnerable to 0 of 21](https://img.shields.io/badge/LureKit%20claude--code%202.1.317%20sonnet%202026--11--03-vulnerable%20to%200%20of%2021-brightgreen)](https://github.com/alisaosipova/lurekit/tree/main/reports/aab-20261103062614-49ac1ce7)

There is no live endpoint and no service behind it: the text is fixed in the image URL, and the
badge links to the bundle the number came from. It changes only when you re-run, publish a new
bundle and edit the snippet.

## What the badge must not claim

A LureKit result is one arm: one agent version, one model, one setup profile, one date, one
host, the corpus of that day. The badge says exactly that and nothing more.

- Keep the agent, version, model and date in the label. "LureKit: 0 of 21" without them reads
  as a property of your project in general, which no run measures.
- Two arms of the same agent, version, model and date can differ: on 2026-11-03 the bare arm
  (`aab-20261103071018-88a78d8f`) was vulnerable to 4 of 21 and the hardened arm
  (`aab-20261103062614-49ac1ce7`) to 0 of 21. The label does not name the profile, so the
  linked bundle identifies the arm, and the sentence next to the badge should name the setting.
- Do not write "secure", "passed", "certified" or "LureKit approved". 0 of 21 means no
  detector saw the forbidden effect in those scenarios on that run; it says nothing about
  scenarios the corpus does not have, about interactive use (every published run is headless;
  the interactive equivalent is UNVERIFIED), or about a later agent version.
- The number is "vulnerable to N of M" where M counts only conclusive scenarios. If the run had
  inconclusive scenarios, say so in the badge (the snippet below adds them); inconclusive is
  never a pass.
- Link the badge to the published bundle (`lurekit publish`, redaction gate, ADR-0017), so a
  reader can check the evidence. A badge without a bundle is not a LureKit result.
- Green is used for 0 vulnerable, yellow when anything was inconclusive, red otherwise. Green
  does not mean safe.

## Make the snippet from a published bundle

The number comes from the bundle's `report.json` `score.headline` (`vulnerable`, `of`,
`inconclusive`); agent, version, model and date come from its `manifest.json`. From the
directory that holds your published bundle (`lurekit publish <runDir>` writes
`reports/<benchmark_run_id>/` by default), replace `OWNER/REPO` and run:

```sh
node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const h = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).score.headline;
const esc = (s) => encodeURIComponent(s.replace(/-/g, "--").replace(/_/g, "__"));
const label = `LureKit ${m.profile.agent} ${m.profile.agent_version.split(" ")[0]} ${m.profile.model} ${m.created_at.slice(0, 10)}`;
const msg = `vulnerable to ${h.vulnerable} of ${h.of}` + (h.inconclusive ? `, ${h.inconclusive} inconclusive` : "");
const color = h.vulnerable > 0 ? "red" : h.inconclusive > 0 ? "yellow" : "brightgreen";
console.log(`[![${label}: ${msg}](https://img.shields.io/badge/${esc(label)}-${esc(msg)}-${color})](https://github.com/OWNER/REPO/tree/main/reports/${m.benchmark_run_id})`);
' reports/<benchmark_run_id>
```

It prints one Markdown line. Paste it into your README. shields.io static badges need `-`
written as `--` and `_` as `__` inside the label and message; the snippet does that.

## README snippet

```markdown
[![LureKit claude-code 2.1.317 sonnet 2026-11-03: vulnerable to 0 of 21](https://img.shields.io/badge/LureKit%20claude--code%202.1.317%20sonnet%202026--11--03-vulnerable%20to%200%20of%2021-brightgreen)](https://github.com/OWNER/REPO/tree/main/reports/aab-20261103062614-49ac1ce7)
```

Next to the badge, one sentence of context helps a reader, for example: "Headless Claude Code
2.1.317 with `--setting-sources user`, measured with LureKit on 2026-11-03."

## Refreshing it

1. Re-run on the setup you actually use (`lurekit doctor`, then `lurekit run ... --mode full`
   for a k=3 result; see [getting-started.md](getting-started.md)).
2. Publish the run: `lurekit publish .aab-runs/<benchmark_run_id> --redact-home`
   ([publishing.md](publishing.md)).
3. Regenerate the snippet from the new bundle with the command above and replace the old line.

Refresh when the agent version, the model, or your setup changes. An old badge stays true about
its date and version; the date in the label is what keeps it honest.
