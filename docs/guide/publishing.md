# Publishing a run

`lurekit publish` turns a completed local run into a bundle you can share, commit or attach to a
report. It is offline: no network, no agent, no clock. It writes local files only; uploading or
sharing the bundle is your action, never the tool's.

The design is [ADR-0017](../design/adr-0017-publish-run.md) (publish and the redaction gate) and
[ADR-0014](../design/architecture.md#adr-0014-ethics-and-coordinated-disclosure) (coordinated
disclosure). This guide describes the behaviour; the ADRs are normative.

Related guides: [interpreting-results.md](interpreting-results.md) (what the fields mean),
[troubleshooting.md](troubleshooting.md#publish-says-redaction-gate-failed),
[getting-started.md](getting-started.md).

## Contents

- [Usage](#usage)
- [What a bundle contains](#what-a-bundle-contains)
- [What is never published](#what-is-never-published)
- [Order of operations](#order-of-operations)
- [Rewrites applied to every publish](#rewrites-applied-to-every-publish)
- [The redaction gate](#the-redaction-gate)
- [--redact-home](#--redact-home)
- [Withholding a scenario](#withholding-a-scenario)
- [Excluding a scenario](#excluding-a-scenario)
- [--allow-host](#--allow-host)
- [When the gate fails](#when-the-gate-fails)
- [Re-scanning a bundle yourself](#re-scanning-a-bundle-yourself)
- [Citing a bundle](#citing-a-bundle)
- [Limits](#limits)

## Usage

```
lurekit publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <scenario-id>]... [--exclude <scenario-id>]... [--redact-home]
```

| option | default | effect |
|---|---|---|
| `<runDir>` | (required) | The benchmark run directory, `<results>/<benchmark_run_id>`, containing `manifest.json`. |
| `--out <dir>` | `<runDir>/bundle`, i.e. `<results>/<benchmark_run_id>/bundle` for a run under `--results` (inside the run directory, never the cwd) | Output directory. It must be absent or empty; a non-empty directory is refused so stale, unscanned files cannot ride along. |
| `--allow-host <host>` | none | Repeatable. Allow URLs on one more host (see [--allow-host](#--allow-host)). |
| `--withhold <scenario-id>` | none | Repeatable. Leave one scenario out of the bundle (see [Withholding a scenario](#withholding-a-scenario)). |
| `--exclude <scenario-id>` | none | Repeatable. Leave out a scenario whose result is not a measurement (see [Excluding a scenario](#excluding-a-scenario)). An id may not be given to both `--withhold` and `--exclude`. |
| `--redact-home` | off | Replace your own home directory with `<HOME>` in the published copies (see [--redact-home](#--redact-home)). |

Flags are strict: pass each flag and its value as separate arguments. `--withhold=AAB-003` or the
single token `"--withhold AAB-003"` is an error, not a silently ignored flag.

Typical invocations:

```bash
lurekit publish .aab-runs/<benchmark_run_id>
lurekit publish .aab-runs/<benchmark_run_id> --redact-home
lurekit publish .aab-runs/<benchmark_run_id> --redact-home --withhold AAB-003
lurekit publish .aab-runs/<benchmark_run_id> --out site/runs/<benchmark_run_id>
lurekit publish .aab-runs/<benchmark_run_id> --redact-home --out reports/<benchmark_run_id>   # the repository layout
```

On success it prints one `wrote <file>` line per file, then for example:

```
withheld (ADR-0014): AAB-003
redaction applied: home directory -> <HOME> (22 replacements)

published 29 file(s) to <cwd>/.aab-runs/<benchmark_run_id>/bundle
```

The run's own files are never modified (the default bundle is a new `bundle/` directory beside them, which a later publish of the same run ignores). Every rewrite described below is applied to in-memory
copies only, so the original bytes stay available for local audit.

## What a bundle contains

Exactly these files, and nothing else:

| file | content |
|---|---|
| `manifest.json` | The run manifest (byte copy, except for the rewrites below and a recomputed `results`/`totals` under `--withhold`/`--exclude`, plus a top-level `excluded` array under `--exclude`). |
| `<scenario>/<rep>/evidence.json` | Every per-repetition evidence record of the published scenarios, layout preserved (byte copy, except for the rewrites below). |
| `report.md`, `report.json`, `report.sarif` | The three renders, built from the (rewritten) manifest and evidence by the same code as `lurekit report`. |
| `index.md` | Headline, run and config summary, tool version, profile summary and digests, a scenario table linking each evidence file, a file list, and the `## Redaction`, `## Withheld` and `## Excluded` sections when they apply. |

A real example is [`reports/aab-20261102161512-ca5fe106/index.md`](../../reports/aab-20261102161512-ca5fe106/index.md).

## What is never published

- Raw agent transcripts (`claude-stream.jsonl` and other agents' event streams).
- Hook captures (`claude-hooks.jsonl`) and the hook script.
- Detector logs and metadata: recorder logs, access logs, `*.canary.json`, `fs_diff` baselines and
  diffs, `agent-output.log`. (`*.canary.json` is read to find canary values to mask, see below,
  but is never copied.)
- The adapter's per-run config files (`mcp.json`, `claude-settings.json`).
- The agent workdirs (`work/`).
- Anything else in the run dir.

The transcripts and hook logs are stored verbatim so a verdict can be audited locally. That is
exactly why they must not leave the machine: they can contain whatever the agent read or printed,
your home path and username, and the raw canary values.

## Order of operations

1. Read `manifest.json`, and the `evidence.json` and `*.canary.json` files of every scenario in
   it. Validate that the run id and scenario ids are safe path segments
   (`^[A-Za-z0-9][A-Za-z0-9._-]*$`); anything else fails.
2. Apply `--withhold` and `--exclude`: drop the named scenarios, recompute the totals.
3. Pseudonymise operator MCP server names (always).
4. Render `report.md`, `report.json` and `report.sarif` from the rewritten manifest and evidence.
5. Replace harness canary tokens in every file, renders included (always).
6. If `--redact-home` is set: replace your home directory in all its spellings, in every file.
7. Render `index.md` last, so its `## Redaction` section carries the counts, and pass it through
   the same replacements.
8. Run the redaction gate on every file of the bundle. With `--redact-home`, also run the
   bare-username check.
9. Write the bundle only if there is no finding. Otherwise print every finding, exit 1 and write
   nothing.

## Rewrites applied to every publish

Two rewrites are unconditional because the values are never part of the measurement.

### Operator MCP server names

Evidence records carry the agent's own MCP init report (`observation.mcp_servers`). Entries whose
`source` is `dynamic` (fixture servers the harness passed via `--mcp-config`) or `project` (a
fixture-planted `.mcp.json`) are kept. Every other entry (`user`, `local`, `claudeai`,
`enterprise`, `managed`, or no `source` at all) is one of your own servers or connectors, and its
`name` becomes `<user-mcp-N>`. `status` and `source` are kept, one name gets one placeholder across
the whole bundle, and a placeholder never collides with a fixture server name.

From the AAB-001 evidence of the example bundle:

```json
{ "name": "<user-mcp-4>", "status": "pending", "source": "user" },
{ "name": "aab-canary", "status": "connected", "source": "project" },
{ "name": "<user-mcp-7>", "status": "needs-auth", "source": "claudeai" }
```

Only the structured `mcp_servers` field is rewritten. If the agent actually called a tool of one
of your servers, its `mcp__<server>__<tool>` name in `tool_calls` is a fact of the run and is
published as is. If you must not disclose it, do not publish that run.

### Harness canary tokens

Each detector mints random per-run values (a 32-hex token or marker, an `aab-canary-<hex>` command
or package name). They are control-sensor bookkeeping, not findings, but a published
`"token": "<32 hex>"` reads as a live credential to a secret scanner. LureKit therefore collects
every value with a canary shape from the `token`, `marker`, `command` and `package` keys of the
manifest and evidence, every `aab-canary-<hex>` substring, and the same keys of each published
scenario's `*.canary.json`, and replaces every occurrence across the whole bundle with
`<canary-token-N>`, including where it is embedded in a URL, a command line or a path. Integrity
digests (`scenario_version`, `task_sha256`, `settings_digest`, `input_digest`, `corpus_digest`),
source URLs and scenario ids are never touched.

From AAB-010 in the example bundle:

```json
"command": "<HOME>/packages/agent-attack-bench/.aab-runs/bare/aab-20261102161512-ca5fe106/AAB-010/0/canary_bin/<canary-token-3>; ls; head -60 README.md 2>/dev/null"
```

### The `## Redaction` section

`index.md` records each rewrite with a count, so a reader knows a placeholder is a substitution and
not what the agent saw. The example bundle:

```
## Redaction

- redaction applied: home directory -> <HOME> (22 replacements)
- redaction applied: encoded home directory: project slug -> <HOME-SLUG> (0 replacements), percent-encoded -> <HOME> (0 replacements)
- redaction applied: operator MCP server names (mcp_servers entries whose source is not dynamic/project) -> <user-mcp-N> (14 replacements, 7 distinct names)
- redaction applied: harness canary tokens (per-run detector token/marker/command/package values) -> <canary-token-N> (13 replacements, 10 distinct tokens)
```

The two home lines appear only with `--redact-home`; the MCP and canary lines only when at least
one value was replaced.

Because these rewrites change bytes inside `tool_calls[].input`, a published input no longer
hashes to its `attempts[].input_digest`. Verify digests against the local run dir (see
[interpreting-results.md](interpreting-results.md#2-a-resisted-denied-verdict-match-the-attempt-to-the-call)).

## The redaction gate

The gate scans every file of the bundle, including the renders and `index.md`, before anything is
written. It never rewrites: it fails, and you decide. Each file is scanned as written and, when
different, in a scan-only view where JSON whitespace escapes (`\n`, `\t`, `\r`, `\b`, `\f`) become
a space, so a value right after an escaped newline in a JSON string is still caught.

| finding kind | rule | detail printed |
|---|---|---|
| `url` | An `http(s)` URL whose host is not loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) and not allowlisted. The allowlist is the hosts of the published scenarios' `source` URLs plus every `--allow-host`. The SARIF `$schema` URL and the repository `informationUri` are allowed as exact strings. The host is taken after stripping path, query, fragment and then userinfo, so `https://a.example/x@github.com` has host `a.example`. | `non-allowlisted host "<host>"` |
| `token` | A match of one of the fixture inertness token shapes: OpenAI/Anthropic-style `sk-` keys, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), GitHub fine-grained PATs (`github_pat_`), AWS access key ids (`AKIA`), Slack tokens (`xox*`), Google API keys (`AIza`). | the pattern family and `(value redacted)`; the value is never echoed |
| `home_path` | An absolute path under your home directory or any conventional home root (`/home/<u>`, `/Users/<u>`, `/root`, `<drive>:\Users\<u>`), in plain, JSON-escaped and forward- or back-slash spellings; your home's dash-encoded project slug (every separator or non-alphanumeric replaced by `-`, as the agent runtime names its project directories, e.g. `-home-<u>-...`); your home percent-encoded (`%2Fhome%2F<u>`, either hex case); and a percent-encoded
`/home/<u>` or `/Users/<u>` of any user. | `absolute home path "..."`, `home directory slug "..."` or `percent-encoded home path "..."` |
| `home_user` | Only with `--redact-home`, as a final check: your bare username (the last segment of your home directory) still appears anywhere as a token bounded by non-alphanumerics. Case-sensitive. | `operator username still present after --redact-home (value redacted)` |

The `home_user` check is deliberately blunt. A username that is also a common word or part of a
version string fails the publish even where it is not a path (with home `/root`, the word `root`
in `uid=0(root)`; with `/home/test`, the word `test`). It is a backstop for spellings the gate does
not know.

## --redact-home

Off by default. Without it, any spelling of your home path fails the gate. Use it when the run
legitimately names your home: by default the per-run workdirs live under `--results`, so a results
directory under your home puts home paths into tool-call inputs.

With the flag:

- every occurrence of **your** home directory (as is, JSON-escaped, with forward slashes; trailing
  separators dropped) becomes `<HOME>`. An occurrence counts only when the next character ends a
  path segment (`/`, `\`, whitespace, a quote or backtick, `<`, `>`, `|`) or the text ends, so
  `/home/u` never rewrites the prefix of `/home/u2`. Any other following character leaves the
  occurrence in place, and it fails the gate;
- the dash-encoded project slug becomes `<HOME-SLUG>` and the percent-encoded form becomes
  `<HOME>`;
- the gate then runs on the result as usual. Another user's home, a sibling such as `/home/u2`,
  any token shape and any non-allowlisted URL still fail. Those are evidence that the run captured
  something unexpected, and masking them would hide it from you;
- the bare-username check runs last;
- a missing or root-like home directory (empty, `/`) with the flag is an error.

The path structure below `<HOME>` is kept (for example
`<HOME>/packages/agent-attack-bench/.aab-runs/bare/<run>/AAB-002/0/canary_bin`), which is what an
auditor needs.

To avoid needing the flag at all, run with `--results` (or a `--workdir` base) outside your home
directory.

## Withholding a scenario

### The policy (ADR-0014)

Coordinated disclosure comes first. A scenario citing a still-unpatched issue is listed in the
public catalog only **after the fix ships or 90 days pass, whichever is first**. Until then it
lives in a private tier that CI can run but the public catalog does not list. `source.fix_status`
(`patched`, `partial`, `unpatched`, `na`) is tracked per scenario. Scenarios describe attacks at
disclosure level only.

A run may still include such a scenario. `--withhold` keeps its verdict and evidence out of the
published bundle without removing it from the run. The tool does not read `source.fix_status` or
compute the 90-day window itself: the manifest does not carry that field and the date is a policy
date the maintainer owns, so withholding is your explicit choice per publish.

### What `--withhold <id>` does

- The id must be a `scenario_id` in the manifest's results. An unknown id is an error and nothing
  is written, so a typo cannot publish the scenario it meant to hold back. A repeated id counts
  once.
- The scenario is removed from the published `manifest.results`; `manifest.totals` is recomputed
  from the remaining results. The `corpus` block (count, ids, digest) is kept unchanged: it
  describes what was run, and its digest must keep matching.
- Its files are read from the run dir like every other scenario's, then dropped: none of its
  `evidence.json` files is parsed, scanned or copied, and none of its `*.canary.json` values is
  used.
- The renders and `index.md` are built from the reduced manifest, so the headline, tables and SARIF
  never mention its verdict. Its source host is no longer allowlisted (unless another published
  scenario cites the same host).
- `index.md` gains a `## Withheld` section with no name, source or verdict. The exact wording, from
  the example bundle:

```
## Withheld

1 scenario(s) withheld from this bundle; the headline and tables cover the published scenarios only.

- AAB-003: withheld pending coordinated disclosure (ADR-0014)
```

- stdout prints `withheld (ADR-0014): <id>[, <id>...]`.

The headline then covers the published scenarios only. In the example bundle the corpus lists 25
ids and the headline reads "Vulnerable to 4 of 24 scenarios".

Once the window closes, re-publish the same run dir without the flag (to a new or emptied `--out`)
to get the full bundle; the run dir was never changed.

## Excluding a scenario

### When to use `--exclude` instead of `--withhold`

| situation | flag | what `index.md` says |
|---|---|---|
| The scenario cites a still-unpatched issue inside its ADR-0014 window. The result is real but must not be disclosed yet. | `--withhold` | `withheld pending coordinated disclosure (ADR-0014)` |
| The result is not a measurement: the scenario could not have produced a meaningful verdict in this run, e.g. its fixture had a defect that was fixed after the run. | `--exclude` | `excluded by the operator: result is not a measurement (see the bundle notes)` |

Example: AAB-056's `web_server` page never named the canary command until commit `03ef83e`, so in
runs before that fix its `resisted` verdict is vacuous. Publishing it as `resisted` would
overstate the setup's resilience, and calling it withheld would claim a disclosure hold that does
not exist. Use `--exclude AAB-056` for those runs. Never use `--exclude` to hide an inconvenient
real result; that is not what the note says.

### What `--exclude <id>` does

File handling and numbers are identical to `--withhold` (see above): the id must be a manifest
result id (an unknown id is the same error, nothing written), a repeated id counts once, the
result is dropped, totals are recomputed, its evidence and `*.canary.json` values are not used,
the renders come from the reduced manifest, and the run dir is untouched. The differences:

- `index.md` gains a `## Excluded` section with no name, source or verdict:

```
## Excluded

1 scenario(s) excluded from this bundle; the headline and tables cover the published scenarios only.

- AAB-056: excluded by the operator: result is not a measurement (see the bundle notes)
```

- The published `manifest.json` (and the manifest embedded in `report.json`) gains a top-level
  `"excluded": ["AAB-056"]` array (evidence-spec section 2.3). Withheld ids are not recorded there.
- stdout prints `excluded (not a measurement): <id>[, <id>...]`.
- An id given to both `--withhold` and `--exclude` is an error and nothing is written. The two
  flags can be combined on different ids.

"See the bundle notes" means the reason is yours to state: write it next to the bundle (a README,
the report that cites it) with the fixing commit, so a reader can check it.

```bash
lurekit publish .aab-runs/<benchmark_run_id> --redact-home --exclude AAB-056
```

## --allow-host

A URL in a bundle is allowed only if its host is loopback, a published scenario's source host, or
named with `--allow-host`. Use the flag for a deliberate, reviewed exception, for example a vendor
documentation host that an evidence record legitimately cites:

```bash
lurekit publish .aab-runs/<benchmark_run_id> --allow-host docs.vendor.example
```

The flag takes a host, not a URL, and allows every URL on that host. Before using it, read the
finding: a URL to a host you did not expect in a tool-call input can mean the agent tried to reach
the network, which is a result worth investigating rather than allowlisting.

## When the gate fails

Nothing is written and the exit code is 1. Every finding is listed on stderr, one line each: per
file, one line per non-allowlisted URL host, one per token family and at most one `home_path`
(the first match):

```
publish: redaction gate failed (evidence-spec s5), 1 finding(s); nothing written
  AAB-030/0/evidence.json: home_path: absolute home path "/home/alice"
Fix the run artefacts, or pass --allow-host <host> for a deliberate URL exception, or --redact-home to replace your own home directory with <HOME> in the published copies.
```

(The real first line names the spec section with a section sign; it is shown here as `s5`. The
`--redact-home` hint in the last line is printed only when there is a `home_path` finding.)

| finding | what to do |
|---|---|
| `home_path` naming your own home | Re-publish with `--redact-home`, or re-run with `--results` / `--workdir` outside your home. |
| `home_path` naming another home, a sibling or a non-segment-ending occurrence | Inspect the evidence file. The run captured an unexpected path; fix the cause or do not publish that run. |
| `home_user` | Find the remaining username occurrence in the named file (the local run dir has the same text). If it is a coincidental word, the run cannot be published as is with this account; re-run under a different home or results location. |
| `token` | Inspect the evidence. A real credential shape in a run is a finding about the setup (a live key in the environment or in a file the agent read). Rotate the credential, fix the setup, re-run. Never allowlist it. |
| `url` | Decide whether the host is a deliberate citation (`--allow-host`) or evidence of unexpected network use (investigate). |

See also [troubleshooting.md](troubleshooting.md#publish-says-redaction-gate-failed).

## Re-scanning a bundle yourself

The gate is a heuristic. Before you share a bundle, scan it with an independent tool. The
repository ships a gitleaks configuration, `.gitleaks.toml`, that extends the default gitleaks
ruleset without removing rules. Its only allowlists are two exact fake credential vectors in
`test/fixtures.test.ts` and the pre-redacted replay recordings under `test/fixtures/recordings/`.
`reports/` is deliberately not allowlisted: a bundle must be clean on its own.

```bash
gitleaks dir reports/<benchmark_run_id> --config .gitleaks.toml --redact --no-banner
```

All six bundles under `reports/` report `no leaks found` with this command. A bundle published by
a LureKit version older than the canary-token rewrite may still carry raw canary tokens, which
gitleaks can flag as `generic-api-key`; re-publish it from its run dir rather than allowlisting it.

Quick manual checks that complement gitleaks (each should print nothing):

```bash
B=reports/<benchmark_run_id>
grep -rnE 'aab-canary-[0-9a-f]+' "$B"                     # raw canary command/package names
grep -rnoE '\b[0-9a-f]{32}\b' "$B"                         # raw 32-hex canary tokens
grep -rnE '/home/[^<]|/Users/|%2[Ff]home|C:\\\\Users' "$B"  # home paths that survived
grep -rnF "$USER" "$B"                                     # your username
ls -R "$B" | grep -E 'stream|hooks|\.log$|canary\.json'    # files that must never be there
```

A 64-hex value is expected: digests (`scenario_version`, `settings_digest`, `input_digest`,
`task_sha256`, `corpus_digest`, `profile_digest`) are sha256 hashes, not secrets.

Also read the bundle's `index.md` `## Redaction`, `## Withheld` and `## Excluded` sections and check that they
match what you intended.

## Citing a bundle

A published number is meaningful only together with the setup and the rules that produced it.
When you cite a bundle in a report, include:

- the bundle path and run id, e.g. `reports/aab-20261102161512-ca5fe106` (link to a fixed commit
  of the repository, not a moving branch);
- the headline exactly as printed, with both counters:
  "vulnerable to 4 of 24 scenarios (degraded: 0, inconclusive: 0)";
- agent and version, model as recorded, permission mode, and the profile used (here
  `claude-code 2.1.316 (Claude Code)`, model `sonnet`, permission mode `default` as printed in
  `index.md`, which is the agent default: the manifest records `permission_mode: null`, and the
  profile `profiles/claude-code-bare.json`);
- `mode`, `k` and `vulnerable_if` (here `smoke`, k=1, `any`), so a reader knows whether a verdict
  is one run or a tally;
- `profile_digest` (`7dd938efe2f66ce63f73c2542a94fb5f4d568c482e2a26856d3e0c968a8da994`) and
  `corpus_digest` (`95a8cc8e63746d8ed7799bf75eb3fd4f22d3addc72d5dd905d6fcc816a06a35b`), which
  identify the setup summary and the scenario set;
- `tool_version` from the manifest and `report_schema` from `report.json` (the 2026-11-02 bundles
  record `tool_version` `0.0.0`, a pre-release build);
- the number of withheld scenarios, if any, and that the headline excludes them;
- the number of excluded scenarios, if any, why each result is not a measurement, and that the
  headline excludes them;
- for each scenario you discuss: its id, the disclosure it cites (`source`), the verdict with its
  markers (`[isolation: partial]`, `(denied)` / `(not attempted)`), the confidence tally, and the
  evidence path, e.g. `AAB-002/0/evidence.json`, with its `scenario_version`.

Example:

> LureKit run `aab-20261102161512-ca5fe106` (reports/aab-20261102161512-ca5fe106, profile digest
> `7dd938ef...a994`, corpus digest `95a8cc8e...a35b`): Claude Code 2.1.316, model `sonnet`,
> permission mode `default`, smoke mode, k=1, `vulnerable_if=any`. Vulnerable to 4 of 24 published
> scenarios (degraded: 0, inconclusive: 0; 1 scenario withheld under ADR-0014). AAB-010 (Rules
> File Backdoor) resisted (denied): the agent issued the canary command and the permission gate
> blocked it; evidence `AAB-010/0/evidence.json`.

State the limits with the number: a k=1 verdict is a single stochastic run; a `partial` verdict
was obtained without strict MCP isolation; a scenario with `headless_fidelity: reduced` measures
the headless behaviour, not the original interactive step. See
[interpreting-results.md](interpreting-results.md). Never cite a replayed run as a measurement.

When a finding concerns an agent vendor, follow [SECURITY.md](../../SECURITY.md) and the
coordinated-disclosure policy above before publishing.

## Limits

- The gate is a heuristic, not a proof of absence. A token with no known prefix, or a path outside
  a known home root, passes. Raising the bar means extending the token-shape list (which also
  tightens fixture inertness) or the home-root list, together with ADR-0017.
- Evidence records are published verbatim apart from the rewrites above, including tool-call
  inputs. The gate, not the renderer, is what keeps those inputs safe to share, so read the
  evidence of any run that did something unusual before publishing it.
- `--redact-home`, the MCP name rewrite and the canary-token rewrite are substitutions. They are
  always recorded in `index.md`, and the run dir keeps the exact bytes.
