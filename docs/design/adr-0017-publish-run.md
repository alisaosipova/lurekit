# ADR-0017: Publishing a run (`publish` subcommand and redaction gate)

Status: proposed, implemented (2026-11-02); awaiting maintainer approval. Amended 2026-11-02:
opt-in operator home redaction (`--redact-home`, see "Operator home redaction"). Amended
2026-11-02: unconditional pseudonymisation of operator MCP server names (see "Operator MCP
server names"). Amended 2026-11-02: `--withhold <scenario-id>` (repeatable) to keep a
scenario out of the published copy under the ADR-0014 disclosure policy (see "Withholding a
scenario"). Amended 2026-11-02: encoded spellings of the operator home (dash-encoded project
slug, percent-encoded path) fail the gate and are rewritten by `--redact-home`, followed by a
bare-username check (see "Encoded home spellings").
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

`lurekit publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <scenario-id>]... [--redact-home]`

- Default output dir: `reports/<benchmark_run_id>` (relative to the cwd). A non-empty output
  dir is refused, so stale unscanned files cannot ride along.
- Bundle contents, and nothing else:
  - `manifest.json` (byte copy, except for operator MCP server names and `--redact-home`
    replacements);
  - every `<scenario>/<rep>/evidence.json` for the manifest's scenarios (byte copy, layout kept,
    except for operator MCP server names and `--redact-home` replacements);
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
- **Encoded home spellings.** A live run (AAB-016) published after `--redact-home` still named
  the operator: the agent read a transcript under the runtime's project dir
  (`<HOME>/.claude/projects/-home-<u>-<rest>/...`), whose name is the home path with every
  separator replaced by `-`, so the plain-path rewrite left the username in place. Therefore:
  - the gate also fails, like a plain home path (`home_path` finding), on the operator home's
    **dash-encoded slug**: the home with every `/` or `\` replaced by `-` (and, as the runtime
    actually does, every non-alphanumeric replaced by `-`), not preceded or followed by an
    alphanumeric. The leading `-` is optional for a multi-segment home (`/home/<u>`). For a
    single-segment home (`/root`) the slug core is a bare word, so the leading `-` is required
    and must not follow another `-` (`-root` matches; `running as root` and `--root` do not); on the operator home **percent-encoded**
    (`encodeURIComponent` of the raw and forward-slash forms, e.g. `%2Fhome%2F<u>`, either hex
    case); and on any percent-encoded home root (`%2Fhome%2F<u>`, `%2FUsers%2F<u>`). The
    JSON-escaped and forward/back-slash spellings stay as above;
  - with `--redact-home`, after the plain rewrite, a slug occurrence becomes `<HOME-SLUG>` and a
    percent-encoded one becomes `<HOME>`. A slug counts only when followed by `-`, a separator,
    whitespace, a quote or backtick, `<`, `>`, `|` or the end; a percent spelling only when
    followed by `%`, a separator, whitespace, a quote or backtick, `<>|&?#` or the end. Gate
    detection ends at any non-alphanumeric, wider than these sets, so whatever is not rewritten
    still fails (fail closed);
  - `index.md`'s `## Redaction` section gains the line
    `redaction applied: encoded home directory: project slug -> <HOME-SLUG> (S replacements),
    percent-encoded -> <HOME> (P replacements)`. The plain-path line and its stdout copy keep
    their meaning (plain spellings only);
  - the gate then re-runs on the redacted bundle as usual. As a final check, if the operator's
    bare username (the last path segment of the home dir) still appears anywhere in the bundle
    as a token bounded by non-alphanumerics (or the text ends), the publish fails with a
    `home_user` finding per file. The finding names the file, never the value. The check is
    case-sensitive and runs only with `--redact-home`. Without the flag, any spelling of the home
    path already fails.
- **Operator MCP server names (unconditional).** Evidence records carry the agent's own init
  report `observation.mcp_servers` (`name`/`status`/`source`, evidence-spec §4.3). Entries whose
  `source` is `user`, `local`, `claudeai`, `enterprise`, `managed` or anything else not
  configured by the harness describe the operator's own MCP servers and connectors: a
  configuration disclosure the §5 gate does not catch (a server name is neither a URL, a token
  nor a home path). Before `--redact-home` and before the gate:
  - every `mcp_servers` array anywhere in the manifest and in each evidence record is walked;
    an entry whose `source` is `dynamic` (the harness's `--mcp-config` fixture servers) or
    `project` (a fixture-planted `.mcp.json`) is kept as is; every other entry, including one
    with no `source` at all (fail closed), has its `name` replaced by `<user-mcp-N>`;
  - `N` is assigned per distinct original name in first-seen order (manifest, then evidence in
    bundle order), with one map for the whole publish, so the same server gets the same
    placeholder in every file; `status` and `source` are kept; a placeholder that equals the
    name of any kept (`dynamic`/`project`) entry anywhere in the run is skipped (all files are
    parsed before the first placeholder is assigned), so a placeholder never collides with a
    fixture server name;
  - the rewrite is applied to the parsed objects; only files with at least one replacement are
    re-serialised (indentation detected from the original, trailing newline kept), every other
    file stays a byte copy; the three renders are built from the rewritten objects;
  - when at least one entry was rewritten, `index.md`'s `## Redaction` section gains the line
    `redaction applied: operator MCP server names (mcp_servers entries whose source is not
    dynamic/project) -> <user-mcp-N> (R replacements, D distinct names)`;
  - the run dir is never modified.
- **Withholding a scenario (`--withhold <scenario-id>`, repeatable, opt-in).** ADR-0014 keeps
  a scenario citing a still-unpatched issue out of the public catalog until the fix ships or 90
  days pass. A run may still include it (CI runs the private tier), so its verdict and evidence
  must be keepable out of a published bundle without deleting it from the run. For each named
  id:
  - the id must be the `scenario_id` of a manifest result; an unknown id is an error and
    nothing is written (a typo must not publish the scenario it meant to hold back); a repeated
    id counts once;
  - the scenario's entry is removed from the published copy of `manifest.results`, and
    `manifest.totals` is recomputed from the remaining results with the runner's rule (one per
    verdict, `spend_usd` summed and rounded to 6 decimals), so the vulnerable count drops when a
    vulnerable scenario is withheld. The `corpus` block (count, ids, digest) is kept as is: it
    describes what was run, its digest must keep matching, and the id is listed openly anyway;
  - none of its `<scenario>/<rep>/evidence.json` files is copied, parsed or scanned;
  - `report.md`, `report.json`, `report.sarif` and `index.md` are rendered from the reduced
    manifest, so the headline, scenario tables and SARIF results never mention its verdict;
    its source URL is no longer in the gate's allowlist (it is not in the bundle either);
  - `index.md` gains a `## Withheld` section with the count and one line per id:
    `<id>: withheld pending coordinated disclosure (ADR-0014)` (no name, source or verdict);
  - it applies first: operator MCP name pseudonymisation (numbering, reserved names) and
    `--redact-home` see only the reduced bundle, and the gate runs on the reduced bundle as
    usual;
  - the run dir is never modified.
- Ids that become path segments (`benchmark_run_id`, scenario ids) must match
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`; anything else fails the publish.
- Offline: no network, no agent, no clock. The command writes local files only; uploading or
  sharing the bundle remains the maintainer's action (§6.3).

## Usage
```sh
lurekit publish .aab-runs/<benchmark_run_id>
lurekit publish .aab-runs/<id> --out site/runs/<id>
# a deliberate exception, e.g. a vendor docs host cited in an evidence record
lurekit publish .aab-runs/<id> --allow-host docs.vendor.example
# the run legitimately names the operator's own home (e.g. the agent listed the memory dir
# the agent runtime announced); publish it as <HOME>
lurekit publish .aab-runs/<id> --redact-home
# keep a scenario citing a still-unpatched issue out of the bundle (ADR-0014)
lurekit publish .aab-runs/<id> --withhold AAB-030
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
- The bare-username check is deliberately blunt. A username that is also a common word or
  part of a version string (e.g. a distribution name that matches the login) fails the publish
  even where it is not a path (with home `/root`, the word `root` in `uid=0(root)`; with
  `/home/test`, the word `test`). The slug match is not blunt in this way: it needs the
  separator-joined form, or the leading `-` for a single-segment home. The maintainer then sees the file and decides (fix the evidence,
  or do not publish that run). It is a backstop for spellings the gate does not know, not a
  substitute for them, which is why the encoded forms are matched and rewritten explicitly.
- Operator MCP server names are rewritten unconditionally, not opt-in, unlike `--redact-home`.
  The two differ in what the value is to the measurement. A home path can be evidence (what the
  agent touched), so rewriting it alters a published fact and the maintainer must ask. The names
  of the operator's own servers are never part of the measurement: a scenario's precondition
  (`expect: mcp_server`, §4.3) names a fixture server, which arrives as `dynamic` or `project`
  and is kept. What the published record still needs from operator entries (that they existed,
  how many, their status and their source class, e.g. to see that strict MCP isolation was not
  in effect) survives the rewrite. Making it opt-in would publish the operator's connector list
  by default, which no reader needs. The bytes in the run dir are unchanged for local audit.
- The rewrite covers only the structured `mcp_servers` field. If the agent actually called a
  tool of an operator server, its `mcp__<server>__<tool>` name in `tool_calls` is a fact of the
  run and is published as is; a maintainer who must not disclose it should not publish that run.
- Evidence records are published verbatim (save for operator MCP server names and `--redact-home`), including tool-call inputs. The gate, not the
  renderer, is what keeps those inputs safe to share.
- `--withhold` changes the published numbers on purpose: the bundle's headline is over the
  published scenarios only, and the `## Withheld` section says how many were held back, so a
  reader does not mistake the reduced totals for the whole run. It is the maintainer's choice
  per publish, like every other exception here; the tool does not read `source.fix_status` to
  decide it, because the manifest does not carry it and the 90-day clock is a policy date the
  maintainer owns (ADR-0014). Once the window closes, re-publishing the same run without the
  flag yields the full bundle, since the run dir was never changed.
