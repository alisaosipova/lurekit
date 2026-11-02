# ADR-0017: Publishing a run (`publish` subcommand and redaction gate)

Status: proposed, implemented (2026-11-02); awaiting maintainer approval. Amended 2026-11-02:
opt-in operator home redaction (`--redact-home`, see "Operator home redaction").
Authorises `src/report/publish.ts`, the `publish` subcommand in `src/cli.ts`, the exported
`findSecretShape()` / `extractHost()` helpers in `src/fixtures/fixture.ts` (and the
path-before-userinfo order of `extractHost()`), and
`test/publish.test.ts`. Builds on evidence-spec §2.1 (run dir layout), §2.3 (manifest),
§5 (redaction and reproducibility) and §6 (reporting).

## Context
A run dir (§2.1) mixes two kinds of artefact. The manifest and the per-repetition
`evidence.json` records are the facts a verdict rests on and are designed to be shareable
(§2.2 stores config bodies as digests, §5). The raw agent stream (`claude-stream.jsonl`) and
the hook capture are stored verbatim (§5) so a verdict can be audited locally; they can carry
whatever the agent read or printed. §6.3 says sharing a report is the maintainer's explicit
action, never the tool's. Until now there was no way to produce a shareable bundle short of
copying the run dir by hand, which would carry the raw transcripts along and offers no check
that the evidence is free of local paths, tokens or third-party URLs.

## Options
1. **Document a manual copy.** No code; relies on the maintainer to pick files and inspect them.
   Rejected: the failure mode (a raw transcript or a home path in a public report) is silent.
2. **Publish with automatic redaction** (rewrite home paths to `~`, mask tokens, drop URLs).
   Rejected: rewriting evidence changes the published facts (§6: a reporter adds or alters no
   facts), and a masked leak hides from the maintainer that the run itself captured something
   it should not have.
3. **Publish with a fail-closed gate.** Build the whole bundle in memory, scan it, and write
   nothing unless the scan is clean. Deliberate exceptions are explicit flags.

## Decision
Option 3.

`agent-attack-bench publish <runDir> [--out <dir>] [--allow-host <host>]... [--redact-home]`

- Default output dir: `reports/<benchmark_run_id>` (relative to the cwd). A non-empty output
  dir is refused, so stale unscanned files cannot ride along.
- Bundle contents, and nothing else:
  - `manifest.json` (byte copy, except for `--redact-home` replacements);
  - every `<scenario>/<rep>/evidence.json` for the manifest's scenarios (byte copy, layout kept,
    except for `--redact-home` replacements);
  - `report.md`, `report.json`, `report.sarif`, rendered by `report()` (§6.1). The Markdown
    evidence excerpt uses the same selection rule as `report` (first vulnerable repetition,
    else repetition 0; `selectEvidence()` is shared);
  - `index.md`: headline, run/config summary, tool version, profile summary (agent + version,
    model, permission mode, mcp/hooks/settings digests, profile digest), a scenario table with
    a link to each evidence file, and a file list.
- Never copied: raw transcripts, hook logs, detector logs, or any other file in the run dir.
- Redaction gate (§5), applied to every bundle file, including the renders, before any write.
  Any finding: exit 1, every finding listed on stderr, nothing written.
  - **URL:** an `http(s)` URL whose host is not loopback (`localhost`, `*.localhost`,
    `127.0.0.0/8`, `::1`) and not in the allowlist. The allowlist is the set of hosts of the
    manifest results' `source` URLs plus each `--allow-host`. The two URLs the renders always
    contain (the SARIF `$schema` URL and the repository `informationUri`) are allowed as exact
    strings, not as hosts.
  - **Token shape:** any match of the fixture inertness patterns (`SECRET_PATTERNS` in
    `src/fixtures/fixture.ts`, via `findSecretShape()`), so there is one list of token shapes.
    The message names the pattern family and never echoes the value.
  - **Home path:** an absolute path under the publishing user's home dir (`os.homedir()`,
    injectable via `CliDeps.homeDir`) or under a conventional home root (`/home/<u>`,
    `/Users/<u>`, `/root`, `<drive>:\Users\<u>`). It is not rewritten to `~`.
  - Each file is scanned as written and, when it differs, in a scan-only view where JSON
    whitespace escapes (`\n`, `\t`, `\r`, `\b`, `\f`) become a space (an escaped backslash
    `\\` is kept). Without it a value right after an escaped newline in `evidence.json`
    (`"ls\n/home/u"`) sits next to a word character and the patterns' `\b` / lookbehind
    anchors would not fire. The published bytes are never rewritten.
  - A URL's host is taken after stripping path, query and fragment, then userinfo
    (`extractHost()`), so `https://evil.example/x@github.com` has host `evil.example`, not an
    allowlisted source host. The same fix tightens fixture invariant (a) (`assertLoopback`).
- **Operator home redaction (`--redact-home`, opt-in).** Off by default; without it the
  behaviour above is unchanged and an operator home path fails the gate. When set:
  - every occurrence of the operator home dir (`CliDeps.homeDir()`, else `os.homedir()`;
    spelled as is, with JSON-escaped backslashes, and with forward slashes; trailing separators
    dropped) in the **published copies** (manifest, evidence, the three renders, `index.md`) is
    replaced by the literal `<HOME>`. An occurrence counts only when the next character ends a
    home segment in the gate's own patterns (`/`, `\`, whitespace, a quote or backtick, `<`,
    `>`, `|`) or the text ends, so `/home/u` never rewrites the prefix of a sibling such as
    `/home/u2`, `/home/u@old`, `/home/u+bak` or `/home/uü`. Any other following character
    (`)`, `,`, `:`) leaves the occurrence as is, and it fails the gate (fail closed);
  - the run dir is never modified: the replacement is applied to the in-memory copies only;
  - `index.md` gains a `## Redaction` section with the line
    `redaction applied: home directory -> <HOME> (N replacements)`, N being the total over the
    bundle (the same line is printed on stdout);
  - the gate then runs on the redacted bundle exactly as without the flag: any other home-style
    path (another user's `/home/<u>`, `/Users/<u>`, `/root`, `<drive>:\Users\<u>`), any token
    shape and any non-allowlisted URL still fail, and nothing is written;
  - a missing or root-ish home dir (empty, `/`) with the flag is an error, not a silent no-op.
- Ids that become path segments (`benchmark_run_id`, scenario ids) must match
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`; anything else fails the publish.
- Offline: no network, no agent, no clock. The command writes local files only; uploading or
  sharing the bundle remains the maintainer's action (§6.3).

## Usage
```sh
agent-attack-bench publish .aab-runs/<benchmark_run_id>
agent-attack-bench publish .aab-runs/<id> --out site/runs/<id>
# a deliberate exception, e.g. a vendor docs host cited in an evidence record
agent-attack-bench publish .aab-runs/<id> --allow-host docs.vendor.example
# the run legitimately names the operator's own home (e.g. the agent listed the memory dir
# the agent runtime announced); publish it as <HOME>
agent-attack-bench publish .aab-runs/<id> --redact-home
```
A failing gate prints, for example:
```
publish: redaction gate failed (evidence-spec §5), 1 finding(s); nothing written
  AAB-030/0/evidence.json: home_path: absolute home path "/home/alice"
```

## Consequences
- A published number always ships with its manifest and evidence, and never with transcripts.
- The gate is a heuristic, not a proof of absence: a token with no known prefix, or a path
  outside a home root, passes. Raising the bar means extending `SECRET_PATTERNS` (which also
  tightens fixture inertness) or the home-root list here, in the same change as this ADR.
- Runs whose workdir sits under the home dir will fail the gate when evidence tool-call inputs
  name workdir paths. Since ADR-0002 "Per-run workdir", workdirs live under `--results` by
  default (never the OS temp dir), so a results dir under home triggers this. That is intended:
  the maintainer decides, by re-running with `--results` or a `--workdir` base outside home,
  using `--redact-home`, or fixing the evidence.
- `--redact-home` is a narrow, explicit exception to "the gate never rewrites" (Option 2 stays
  rejected as a default). It is opt-in because rewriting changes published bytes (§6: a
  reporter alters no facts), so the maintainer must ask for it per publish, and the bundle
  says so (`index.md` note with the count) so a reader knows `<HOME>` is a substitution, not
  what the agent saw. The rewrite is a pure substitution of one known string: the path
  structure below it (e.g. `<HOME>/.claude/projects/<slug>/memory/`) is kept, which is what an
  auditor needs, and the source run dir keeps the exact bytes for local audit.
- It covers only the operator's own home because that is the one value the tool knows to be
  the publisher's, and the case it exists for (a live run naming the home the agent runtime
  itself announced) is always that home. Another user's home, a macOS/Windows home that is not
  the operator's, or a sibling such as `/home/u2` or `/home/u@old` is evidence the run captured something
  unexpected; masking it would hide that from the maintainer, so it keeps failing the gate.
- Evidence records are published verbatim (save for `--redact-home`), including tool-call inputs. The gate, not the
  renderer, is what keeps those inputs safe to share.
