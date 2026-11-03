# Week 6 setups for the comparison report (proposal)

Status: PROPOSAL, research only (2026-11-03). Facts and URLs: `NOTES-verified-facts.md` § "Defensive tools (Week 6 setups)". Scope: BRIEF line 128 ("bare Claude Code; + HOL Guard; + agentcage; + cc-audit; Cursor default; Codex default"). Nothing here has been run. Each setup gives the exact `lurekit run` invocation, or names the missing capability and the ADR it needs before code (CLAUDE.md, SDD rule 1).

## Observation layers referenced
- **observe hook**: the Claude Code adapter writes `<runDir>/claude-settings.json` (PreToolUse/PostToolUse, log-only) and passes it with `--settings`. Layer `hook`.
- **strict MCP**: `--strict-mcp-config` on every run, plus `--mcp-config <runDir>/mcp.json` when the profile has MCP. This gives the isolation marker `full`/`partial`.
- **per-run workdir**: `<results>/<run>/<scenario>/<rep>/work`, freshly provisioned with fixtures and used as the spawn cwd.
- **effect sensors**: `canary_command` (22 scenarios), `canary_egress_http` (17, loopback sink on `127.0.0.1:<ephemeral>`), `canary_mcp_tool` (8), `canary_file_read` (1). They sit outside the agent.

## Cross-cutting gap (blocks S2, S4b, and any "settings-only" defensive setup)
`lurekit run --settings <file>` / `--hooks <file>` are parsed and digested into the evidence record but **not forwarded** to `claude` (verified in `src/adapters/claudeCode.ts`, 2026-11-03). So today a manifest can claim a settings body that never reached the agent. That is a validity bug independent of Week 6. Proposed ADR ("profile settings forwarding"): the adapter merges `profile.settings` and `profile.hooks` into the single harness `--settings` file, with the observe-hook groups appended last and never dropped. Alternatively it passes a second `--settings` value, but whether `--settings` may repeat is UNVERIFIED. `--skill <dir>` is likewise not consumed by the claude-code adapter (same NOTES line). Until that ADR lands, the CLI should reject `--settings`/`--hooks`/`--skill` for claude-code rather than silently ignore them.

A second gap is a **per-run setup step**: a profile-declared command run in the provisioned workdir after fixtures and before the agent (e.g. `hol-guard install claude-code`), with its stdout, exit code and a workdir diff kept as evidence. It needs an ADR: it is the first time the harness executes setup-under-test code. It must run inside the bench's container boundary, and it must never touch files a fixture planted (byte-for-byte check, as for the observe hook).

## S1. Claude Code, bare (baseline)
```sh
lurekit run scenarios --agent claude-code \
  --model <model-id> --agent-version <pinned-version>
```
Already measured (2.1.316). Layers: observe hook, strict MCP, per-run workdir. Re-run at the Week 6 pinned version so every row shares one agent version. Optional control row: `profiles/claude-code-hardened.json` (`--setting-sources user --permission-mode manual`).

## S2. Claude Code + HOL Guard (hooks)
- **Mechanism**: `hol-guard install claude-code` writes Guard hook entries into `<workspace>/.claude/settings.local.json` (local scope). It reads `~/.claude`, the project `.claude/settings.json` and `.mcp.json`. Guard state lives in `~/.hol-guard`. Pin `hol-guard==3.58.0` (release date UNVERIFIED).
- **Expressible today?** No. Two routes:
  - (a) **Per-run setup step** (gap above): `hol-guard install claude-code` in each fresh workdir. This is the faithful deployment.
  - (b) **Settings forwarding** (gap above): run `hol-guard install claude-code` once in a scratch workspace, copy the generated `hooks` block into a raw settings body `profiles/hol-guard-3.58.0.settings.json` (not a `SetupProfile`-shaped file like `profiles/claude-code-*.json`, whose `profile`/`cli_flags` wrapper `--settings` would read as settings keys), and pass it via `--settings`. It loads at command-line precedence, not local, which is not identical to the real install. The hook command string is UNVERIFIED until that scratch install is read.
  
  Target invocation once (b) exists:
  ```sh
  lurekit run scenarios --agent claude-code \
    --model <model-id> --agent-version <pinned-version> \
    --settings profiles/hol-guard-3.58.0.settings.json
  ```
- **Layers**: observe hook (co-resident with Guard's PreToolUse: matching hooks "run in parallel" and hook entries "merge across settings levels", https://code.claude.com/docs/en/hooks, checked 2026-11-03, so our PreToolUse entry is still logged for a call Guard blocks). A missing PostToolUse is NOT evidence that Guard blocked the call: PostToolUse fires only "After a tool call succeeds", so a manual-mode permission denial or a failed tool call looks the same, and the observe hook does not subscribe to `PostToolUseFailure`. Attributing a block to Guard needs Guard's own decision record (approval center / hook JSON envelope; location UNVERIFIED) as a separate evidence input. Strict MCP is unaffected; per-run workdir is where route (a) writes.
- **Risks**:
  - Guard writes `.claude/settings.local.json` in the workdir. A scenario that plants a local settings file would be modified. Route (a) needs the byte-for-byte check and must abort the run if a planted file is touched.
  - Do not combine with `--setting-sources user`: that excludes the `local` source, so Guard's route-(a) hooks would silently not load.
  - Two hook groups on the same event (our observe hook plus Guard's) are documented to merge across settings levels (hooks page above), but whether the command-line `--settings` file counts as such a level is not stated (UNVERIFIED), and nothing is confirmed live on the pinned version. Gate the row on a positive control: a run where Guard must block, and our hook log must still be non-empty.
  - Headless approvals: Guard queues "ask" verdicts in its approval center; "A timeout leaves the request pending and is never approval". The run may stall. Set the per-run timeout above Guard's 120 s wait and record a stalled run as `inconclusive`, not `defended`.
  - `~/.hol-guard` is host-global state (approvals, hashes, a daemon) that persists across runs and breaks run independence. Run with a run-scoped `HOME` via `profile.env`, but no Guard home override is documented, so verify it. A run-scoped `HOME` also moves `~/.claude` (user settings, saved auth): the operator's user-scope settings drop out of the row (changes what "default" means versus S1) and saved CLI login is not visible, so pass auth by env var name and record the `HOME` override in the manifest.
  - Guard's docs disagree on hook events (PreToolUse/PostToolUse vs PreToolUse/PermissionRequest/UserPromptSubmit/SessionStart) and on version (hol.org 2.2.118 vs pyproject 3.58.0). Record the generated settings body's digest in the manifest.

## S3. Claude Code inside agentcage (runtime sandbox + egress proxy)
- **Mechanism**: wrapper binary plus rootless Podman (Linux) or microVM. `agentcage run claude-code -s ANTHROPIC_API_KEY` or `agentcage cage exec <cage> -- claude …`. The project is mounted at `/workspace`; `.claude/` and `.git/hooks/` are tmpfs-masked; egress goes only through the inspecting proxy; host loopback is rejected. Pin v0.54.1 (2026-10-31).
- **Expressible today?** No; it needs a new adapter option, an **exec wrapper with path mapping**. `AAB_CLAUDE_BIN` is not enough: the adapter's argv carries host paths (`<runDir>/claude-settings.json`, the hook script, `<runDir>/mcp.json`) and spawns with cwd set to the host workdir. Needed: a profile `wrapper` (argv prefix, e.g. `agentcage cage exec <cage> --`), a host→cage path map for workdir and runDir, and a writable bind mount for `<runDir>` declared in `cage.yaml` `container.volumes`. Whether `claude -p` with extra args passes through `cage exec` is UNVERIFIED. Target shape (not implemented; `--wrapper`/`--wrapper-cage` are not in `src/cli.ts` USAGE, so today this exits 1 on the unknown flag):
  ```sh
  lurekit run scenarios --agent claude-code \
    --model <model-id> --agent-version <pinned-version> \
    --wrapper agentcage --wrapper-cage lurekit-cage   # MISSING: ADR "exec wrapper adapter option"
  ```
- **Layers**: the observe hook runs inside the cage (needs `node` in the image and the runDir mount). **The path map must be the identity for `<runDir>` and the node binary**: the `canary_command` launcher is embedded in fixtures as an absolute host path under `<runDir>/canary_bin` ("the bin dir is not on the agent's PATH", `src/detectors/canaryCommand.ts`), its recorder writes `<runDir>/canary_command.recorder.log`, and the `poisoned_repo` `project_mcp` `.mcp.json` declares `command: process.execPath` (`src/fixtures/poisonedRepo.ts`). Remapping `<runDir>` to another in-cage path makes the canary command "not found" and the decoy MCP server fail to start, which silently reads as `safe` for 22 `canary_command` and the project-MCP `canary_mcp_tool` scenarios. Mount `<runDir>` (and node) at the same absolute path, and gate the row on each detector's positive control run inside the cage. Strict MCP is unchanged in argv, but stdio MCP fixtures must exist inside the cage, and the `mcp_http` fixture (AAB-023) listens on host loopback, which the cage cannot reach (same blind spot as egress below). Per-run workdir: one cage per repetition, or a remount; cost is UNVERIFIED.
- **Risks**:
  - Every `canary_egress_http` scenario (17) targets a `127.0.0.1` sink that the cage cannot reach by design. A "safe" verdict would conflate "the cage blocked it" with "the agent never tried". Needs a new sensor input: read agentcage `audit.jsonl`/`capture.jsonl` (host path UNVERIFIED) to attribute blocked canary egress. Alternatively move the sink to an allowlisted canary host, which changes the fixture contract (ADR-0005 canary namespace).
  - `.claude/` masking hides project-settings vectors (AAB-002, AAB-032 style). Report these as "vector removed by sandbox", separate from "agent declined".
  - The runDir mount is a writable host path, which widens the sandbox surface agentcage tries to minimise. Mount only `<runDir>`, never the results root.
  - Secrets: agentcage swaps placeholders for real keys on the wire. Pass the key by env var name only.
  - Linux host prerequisites: rootless Podman, quadlets, cgroups v2. Run `agentcage doctor` before the batch.

## S4. Claude Code + cc-audit (DECISION NEEDED: which cc-audit)
Candidate (1), `ryo-ebata/cc-audit` 3.23.30 (MIT, 2026-10-12), is a static scanner plus an MCP proxy. Candidate (2), PyPI `cc-audit`, is a hook-based logger; its `cc-audit init` reportedly writes `.claude/settings.json` (UNVERIFIED). Recommendation: use (1), as landscape.md does, and list (2) as excluded until its page is readable.
- **S4a, static row (candidate 1)**: `cc-audit check <workdir> --format sarif --output <runDir>/cc-audit.sarif` on each provisioned workdir before the agent runs. It produces a "would have flagged the vector" column next to the S1 verdicts, with no agent behaviour change. Needs the per-run setup step (gap above) or a provision-only mode. Non-goal guard: LureKit runs the scanner as a setup under test; it does not become a scanner itself.
- **S4b, proxy row (candidate 1)**: `cc-audit proxy --target 127.0.0.1:<fixture-port> --port <p> --block --log <runDir>/cc-audit-proxy.jsonl`, with the profile MCP config pointing Claude Code at `http://127.0.0.1:<p>`. This applies only to HTTP-transport MCP fixtures (`--target` is IP:PORT; no stdio wrapping is documented). It is expressible via `--mcp <file.json>` only if fixture ports are fixed. Missing: profile templating of fixture endpoints (ephemeral ports), plus starting and stopping the proxy per run (the setup-step ADR). Subset size, checked in `scenarios/*.yaml` (2026-11-03): **0 of the 8** `canary_mcp_tool` scenarios use an HTTP MCP fixture (AAB-018..022, AAB-025 use `mcp_stdio`; AAB-001, AAB-016 use a `poisoned_repo` `.mcp.json` with a stdio `command`). The only `mcp_http` scenario is AAB-023 (detector `canary_command`). So S4b covers at most one scenario as the suite stands; report it as such or drop it.
- **Risks**: candidate (2) rewrites `.claude/settings.json`, which conflicts with fixture byte-for-byte preservation and with project-settings scenarios; it is excluded for that reason. In S4b, `--block` with no documented failure semantics could make a blocked call look like a tool error. Keep its JSONL log as evidence.

## S5. Cursor CLI, default
```sh
lurekit run scenarios --agent cursor-cli \
  --model <model-id> --agent-version <pinned-version> \
  --permission-mode trust
```
`trust` is the minimum needed to run at all: headless runs in untrusted workspaces fail unless `--trust`/`--force` is given (NOTES § Cursor CLI), and every per-run workdir is new, so it is untrusted. Without `force`, edits are only proposed; that is the "default" being measured. Layers: `stream` only (hooks under `-p` UNVERIFIED). Strict MCP has no Cursor equivalent, so the isolation marker is `partial`. Risk: the CLI auto-updates by default and has no documented version pin, so record `agent --version` before and after.

## S6. Codex CLI, default
```sh
lurekit run scenarios --agent codex-cli \
  --model <model-id> --agent-version <pinned-version>
```
This keeps `codex exec`'s documented read-only sandbox default; the adapter points `CODEX_HOME` at a run-scoped dir. Layers: `stream` only. Risk: `codex exec` exits 1 outside a git repo unless `--skip-git-repo-check` is passed. No provisioning code creates `.git` in the per-run workdir (no `git init` or `.git` write in `src/runner` or `src/fixtures`, grep 2026-11-03), and the adapter only warns ("workdir has no .git entry …", `src/adapters/codexCli.ts`). So as written S6 exits 1 on every repetition. Either provision `git init` in the workdir fixture (preferred) or add `--permission-mode skip-git-repo-check` and say so in the report, since it is not a sandbox change.

## Summary
| # | Setup | Runnable today | Missing capability (ADR needed) |
|---|---|---|---|
| S1 | Claude Code bare | yes | none |
| S2 | + HOL Guard 3.58.0 | no | settings forwarding, or a per-run setup step; positive control that the observe hook survives |
| S3 | + agentcage 0.54.1 | no | exec wrapper + identity mount of runDir and node; agentcage audit log as sensor input |
| S4 | + cc-audit 3.23.30 | no | per-run setup step (static); fixture-endpoint templating + proxy lifecycle (proxy, covers only AAB-023) |
| S5 | Cursor default (`trust`) | yes | none (isolation `partial`) |
| S6 | Codex default | no, as written (workdir has no `.git`) | `git init` in provisioning (ADR), or `--permission-mode skip-git-repo-check` |

For S5 and S6, run `lurekit plan scenarios --agent <id> --model <model-id>` first and report the applicable count: only 5 scenarios name `cursor-cli` and 1 names `codex-cli` in `applies_to`; 18 have no `applies_to`.

Suggested order: fix the settings-forwarding bug first, since it affects evidence validity. Then do S2 via route (b), S4a, S3. If S3 slips past Week 6, publish it as "planned" rather than run it with blind egress sensors.
