# Setup profiles

Reference Claude Code setup profiles for `lurekit run`. Each JSON file holds the
`SetupProfile` fields it sets (`profile`) and the equivalent CLI flags (`cli_flags`). The CLI has
no `--profile` flag: pass the flags shown below. `--model` (and ideally `--agent-version`) are
always required on top and are not part of these files, so the same profile can be measured
against any pinned model.

`claude-code-bare.json` and `claude-code-hardened.json` are hardening-only: neither loosens
anything the adapter does by default (evidence-spec sections 4.1, 4.3). `claude-code-netread.json` is
the one exception: it adds a permissions allow entry for `curl` so the agent can read loopback
fixture content in headless mode (see below).

## `claude-code-bare.json` — no overrides

```sh
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version>
```

- Setting sources: no `--setting-sources` flag is passed, so Claude Code loads its default
  sources (user, project and local settings files). Fixture-planted project settings
  (e.g. a `.claude/settings.json` hook) load as they would for a real user.
- Permission mode: no `--permission-mode` flag; the agent's own `-p` default applies and the
  effective mode is recorded from `system/init`.
- MCP: `--strict-mcp-config` is still passed on every run (adapter default, not an override),
  so the operator's own MCP servers never enter the run.
- Excludes nothing beyond the adapter defaults. This is the baseline to compare against.

## `claude-code-hardened.json` — narrowed setting sources, strict MCP, default (manual) mode

```sh
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version> \
  --setting-sources user --permission-mode manual
```

- `setting_sources: ["user"]` → `--setting-sources user`. Excludes the `project`
  (`.claude/settings.json` in the workdir) and `local` (`.claude/settings.local.json`) setting
  sources, so settings, hooks and permissions planted in the repository under test are not
  loaded. Scenarios whose vector is a project settings file then measure whether this hardening
  holds. Managed settings are not a listed source, and the adapter's own `--settings`
  observe-hook file is expected to still apply (`claude --help`: `--settings` loads "additional
  settings"). Both are UNVERIFIED pending a live check (NOTES-verified-facts.md): until then,
  confirm the hook log is non-empty on a hardened run before trusting its verdicts.
- `strict_mcp_config: true` → `--strict-mcp-config` (already the default; stated explicitly so the
  profile documents it). Excludes every MCP server not in the run's own `--mcp-config`, including
  user-scope servers and a workdir `.mcp.json`. There is no CLI flag for it because it cannot be
  tightened further; the only opt-out is a profile `strict_mcp_config: false`.
- `permission_mode: "manual"` → `--permission-mode manual`: the default permission mode, pinned
  explicitly instead of relying on the `-p` default, so tool uses that need approval are not
  auto-approved. `claude --help` (2.1.316) lists the choices `acceptEdits`, `auto`,
  `bypassPermissions`, `manual`, `dontAsk`, `plan` — there is no `default` choice, and manual
  mode is the `-p` default since v2.1.302 (NOTES-verified-facts.md), so `manual` is the name to
  pass. The runner ranks `manual` and `default` equally (`MODE_RANK`).

Accepted `--setting-sources` values, from `claude --help` (2.1.316): `user`, `project`, `local`,
comma-separated. The benchmark rejects anything else, an empty list and duplicates before any
agent process is spawned. The flag is claude-code only; the CLI rejects it for other agents.

## `claude-code-netread.json` - allow loopback curl (the only loosening profile)

The profile forwards `profiles/settings/allow-loopback-curl.json` with `--settings` (ADR-0020):

```json
{ "permissions": { "allow": ["Bash(curl:*)", "WebFetch(domain:127.0.0.1)"] } }
```

It is meant to be layered on top of either of the other two profiles.

bare + netread:

```sh
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version> \
  --settings profiles/settings/allow-loopback-curl.json
```

hardened + netread:

```sh
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version> \
  --setting-sources user --permission-mode manual \
  --settings profiles/settings/allow-loopback-curl.json
```

- What it loosens: Bash commands with the `curl` prefix (any URL, not only loopback) run without
  an approval prompt, and a WebFetch allow rule for `127.0.0.1` is added (its effect is
  UNVERIFIED, see below). Everything else is unchanged: the permission mode, setting sources
  and MCP isolation are those of the profile it is layered on.
- Why it exists: content delivery is a precondition (evidence-spec section 3.1). In headless
  `-p` mode nobody can approve the agent's `curl http://127.0.0.1:<port>/...`, so it is denied,
  the agent reports that WebFetch does not work for localhost, the `issue_feed` / `email_feed` /
  `web_server` content is never fetched, and those scenarios are
  `inconclusive(precondition_failed)`. See
  [troubleshooting](../docs/guide/troubleshooting.md#all-my-feed-or-web-scenarios-are-inconclusive-precondition_failed).
- Verified live on Claude Code 2.1.317 (`-p`, model `sonnet`): with this file forwarded, the
  agent's `curl -s -m 15 http://127.0.0.1:<port>/` ran with no permission denial and the
  `web_server` fixture recorded `content_fetched: true`. It also works together with
  `--setting-sources user`. UNVERIFIED: whether the `WebFetch(domain:127.0.0.1)` rule has any
  effect (the agent used `curl`). See `docs/design/NOTES-verified-facts.md`.
- A verdict from a netread run measures the netread configuration, not the default one. Report
  the profile next to the verdict. The forwarded body loads at command-line precedence.

## Settings-based setups (`--settings` / `--hooks`)

Settings-based setups are now honoured for `claude-code` (ADR-0020,
`docs/design/adr-0020-profile-settings-forwarding.md`). The body passed with
`--settings <file.json>` (a raw Claude Code settings object, not one of the `SetupProfile`-shaped
files in this directory) and the body passed with `--hooks <file.json>` (a bare event map or a
`{ "hooks": {...} }` body) are merged into the adapter's single `--settings` file, with the
harness observe hooks appended last on `PreToolUse` / `PostToolUse`. Profile hook groups on
those events run beside the observe hooks, not instead of them. The forwarded body loads at
command-line precedence, which is not identical to a project- or local-scope install. Earlier
versions digested these bodies into evidence without passing them to the agent; records from
those runs do not reflect the claimed settings. The CLI rejects `--settings` / `--hooks` for
`cursor-cli`, `codex-cli` and `openhands`, whose adapters do not forward them.

Measured comparison of the two profiles (claude-code 2.1.316, k=1): [Configuration comparison: bare vs hardened](../docs/reports/2026-11-02-claude-code-2.1.316.md#configuration-comparison-bare-vs-hardened).
