# ADR-0020: Profile settings forwarding (Claude Code)

Status: proposed, implemented (2026-11-03); awaiting maintainer approval. Authorises the
settings-file builder in `src/adapters/claudeCode.ts` (`harnessSettings()`), the
`RunObservation.forwarded_settings` field in `src/adapters/adapter.ts`, the CLI rejection of
`--settings` / `--hooks` for agents that do not forward them (`src/cli.ts`), and the matching
tests. Builds on evidence-spec §4.2 (observe hook), §4.3 (recorded flags) and §2.2
(`settings_digest`, `hooks`). Origin: `docs/design/setups-week6.md` § "Cross-cutting gap".

## Context
`lurekit run --settings <file>` and `--hooks <file>` are parsed into `profile.settings` and
`profile.hooks`, and the runner digests them into the evidence record (`settings_digest`,
`hooks`). Before this ADR the Claude Code adapter never passed either body to `claude`: it wrote
only its own observe-hook file (`<runDir>/claude-settings.json`) and passed that with
`--settings`. A manifest could therefore describe a configuration the agent never received.
That is a validity bug in the evidence, independent of any particular setup.

`claude --help` (2.1.317, offline) documents `--settings <file-or-json>` "Path to a settings JSON
file or a JSON string to load additional settings from". It does not say whether the flag may be
repeated, so this design must not depend on passing it twice (UNVERIFIED).

## Decision
The adapter builds **one** harness settings file per repetition and passes it with the existing
single `--settings <runDir>/claude-settings.json`. The body is built in this order:

1. `profile.settings` (must be a JSON object; anything else is rejected before spawn; see
   "Rejected keys" below).
2. `profile.hooks` merged in as the `hooks` section. The `--hooks` file is either a bare event
   map (`{ "PreToolUse": [...] }`) or a settings-shaped body (`{ "hooks": { ... } }`); both
   forms are accepted, and each event value must be an array of hook groups. For an event that
   both `profile.settings.hooks` and `profile.hooks` define, the arrays are concatenated
   (settings groups first, then hooks-file groups). Other keys are deep-merged as plain objects;
   a later non-object value replaces an earlier one.
3. The harness observe-hook groups (§4.2) are appended **last** to `hooks.PreToolUse` and
   `hooks.PostToolUse`. They are never dropped or reordered. Profile groups on the same events
   are kept: both arrays coexist in the one file.

When neither `profile.settings` nor `profile.hooks` is set, the file is byte-identical to the
previous observe-only body (`observeHookSettings()`), so existing runs do not change.

The profile bodies are never mutated; the runner keeps digesting them unchanged, so
`settings_digest` = sha256(canonical(`profile.settings`)) and `hooks` = sha256(canonical(
`profile.hooks`)) describe exactly the profile portion of the forwarded file.

**Recorded.** `observation.forwarded_settings` is set whenever a profile body was forwarded:
`{ keys, hook_events, harness_hook_events }` — the top-level keys that came from the profile
(sorted), the hook events the profile contributed groups to (sorted), and the events the
harness appended its observe group to. Absent when nothing was forwarded.

**Rejected keys.** The merged body may not switch off the observe hook or move the permission
mode off argv. The adapter rejects, before anything is written or spawned, a body that sets
`disableAllHooks` or `allowManagedHooksOnly` to anything but `false` (either would disable the
non-managed observe group), or that sets `permissions.defaultMode` (the mode stays
`profile.permission_mode` → `--permission-mode`, §4.1 invariant 1, never loosened by a body).
`--strict-mcp-config`, `--setting-sources` and `--bare` remain argv-only; a body cannot remove
them. Other keys (e.g. `permissions.allow` / `deny`) are part of the setup under test and are
forwarded as given. A JSON `"__proto__"` key is kept as an own key and forwarded verbatim; it
cannot re-prototype the merged body.

**Other agents.** Cursor CLI, Codex CLI and OpenHands adapters do not forward these bodies. The
CLI rejects `--settings` / `--hooks` for any agent other than `claude-code` instead of accepting
and digesting a body that never reaches the agent.

## Consequences
- Settings-based setups (setups-week6 S2 route (b), "settings-only" defensive setups) can be
  measured. A forwarded body loads at command-line precedence, which is not identical to a
  project- or local-scope install; the manifest records the digest, not the scope.
- Whether hook groups from a `--settings` file merge with project-scope groups on a live
  `claude` is still UNVERIFIED (NOTES § Claude Code); the offline stub models a merge.
- `--skill <dir>` is still not consumed by the claude-code adapter; out of scope here.

## Amendment (2026-11-04, block 3): fixture `profilePatch` allow-list

Status: specced before the code (block 3, verdict arithmetic); normative text in evidence-spec
s4.3 "profilePatch merging note"; test plan evidence-spec s3.3 B3-T7.

This ADR made `profile.settings` and `profile.hooks` reach the agent. That raised the stakes of
the fixture patch merge in `src/runner/runner.ts` (`mergeProfilePatch`), which was `{ ...base,
...patch }` followed by per-key corrections: a fixture could introduce a `settings` or `hooks`
body that the adapter then forwarded as part of the setup under test, and a patch key carrying
an explicit `undefined` deleted the operator's value (`{ permission_mode: undefined }` cleared the
mode because the loosening check only looked at defined values; `{ settings: undefined }` and
`{ hooks: undefined }` likewise). The existing rule "a patch may only tighten" was therefore
enforceable only for the keys that had an explicit check.

Decision. `mergeProfilePatch()` is allow-list based:
1. Patchable keys, and only these: `env` (key by key, string values only), `mcp`
   (an object only; `mergeMcpConfig`, key by key over `mcpServers`, which must itself be an
   object in the patch: a non-object `mcp` or `mcpServers` is ignored with a warning, review
   finding 2026-11-04), `skills` (append after the profile's list,
   duplicates dropped, never removes an operator entry) and `permission_mode` (accepted only at
   the profile's rank or stricter, per the existing `MODE_RANK`; a looser or unknown value keeps
   the existing warning).
2. Any other key present in the patch is ignored whatever its value. The keys with existing
   warnings (`agent`, `agent_version`, `model`, `workdir`, `strict_mcp_config`, `setting_sources`)
   keep their warning texts and behaviour; any further key (`settings`, `hooks`, `used_bare`, an
   unknown key) records `fixture profilePatch may not set <key>; ignored`.
3. An allow-listed key whose value is `undefined` or `null` is a clear attempt: ignored with
   `fixture profilePatch tried to clear <key>; ignored`; the profile's value stays. The same
   applies to a single `env` entry whose value is not a string.
4. The merge never deletes a base key and never adds a key outside the allow-list; the
   `settings_digest`, `hooks` and `setting_sources` recorded in evidence therefore always
   describe operator input, which is what this ADR's "Recorded" paragraph assumed.

Consequences. The shipped fixtures only patch `env`, `mcp` and `skills` (contentFeed,
localRegistry, webServer, mcpServerFixture, skillPackage), so no scenario changes behaviour; a
third-party fixture that relied on replacing `skills` wholesale now gets the union and a
warning-free merge. Every existing `mergeProfilePatch` test keeps its expectations.
