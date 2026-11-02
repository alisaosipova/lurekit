# Setup profiles

Reference Claude Code setup profiles for `agent-attack-bench run`. Each JSON file holds the
`SetupProfile` fields it sets (`profile`) and the equivalent CLI flags (`cli_flags`). The CLI has
no `--profile` flag: pass the flags shown below. `--model` (and ideally `--agent-version`) are
always required on top and are not part of these files, so the same profile can be measured
against any pinned model.

Both profiles are hardening-only: neither loosens anything the adapter does by default
(evidence-spec §4.1, §4.3).

## `claude-code-bare.json` — no overrides

```sh
agent-attack-bench run scenarios --agent claude-code \
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
agent-attack-bench run scenarios --agent claude-code \
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

Measured comparison of the two profiles (claude-code 2.1.316, k=1): [Configuration comparison: bare vs hardened](../docs/reports/2026-11-02-claude-code-2.1.316.md#configuration-comparison-bare-vs-hardened).
