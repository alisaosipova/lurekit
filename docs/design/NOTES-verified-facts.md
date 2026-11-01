# Verified facts for the architecture (working notes)

Collected 2026-11-01 from primary documentation while preparing `architecture.md` and `evidence-spec.md`. Each line carries the URL it was read from. UNVERIFIED = the page does not say. These notes feed the ADRs; they are not a deliverable.

## mcp-review-check (reuse candidate)
- CI matrix: ubuntu-latest, macos-latest, windows-latest × Node 20.19 / 22 / 24. Source: local checkout `.github/workflows/ci.yml` and https://raw.githubusercontent.com/alisaosipova/mcp-review-check/main/.github/workflows/ci.yml
- Release: npm trusted publishing (OIDC), build job without write permissions, actions pinned by SHA, `npm audit --omit=dev`. Source: `.github/workflows/release.yml` in the checkout.
- Runtime deps: `@modelcontextprotocol/sdk ~1.32.1`, `ajv`, `zod`. Source: `package.json`.
- Reusable code: `src/protocol/*` (stdio / Streamable HTTP / legacy SSE client), `src/report/{json,markdown,sarif}.ts`, `test/fixtures/*-server.mjs` (compliant, rule-breaking, leaky, modern-protocol servers, HTTP bridge, OAuth metadata).

## Claude Code
- `claude -p` shows no trust dialog and still runs the project's `.claude/settings.json` hooks and connects `.mcp.json` servers. `--bare` skips that config and "will become the default for `-p`". Manual permission mode is the default for `-p` since v2.1.302. `--output-format json` includes `total_cost_usd` ("client-side estimate"); `stream-json` requires `--verbose`; `system/init` reports model and `mcp_servers`. Source: https://code.claude.com/docs/en/headless
- Consequence: trust-prompt scenarios (AAB-001, AAB-002) cannot be measured headless as disclosed.
- Hooks: every event receives `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. `PreToolUse` / `PostToolUse` carry `tool_use_id`; `PostToolUse` adds `duration_ms`; exit code 2 blocks the call; `PostToolUse` fires concurrently for parallel tool calls. Source: https://code.claude.com/docs/en/hooks
- Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`; format "internal to Claude Code and changes between versions"; 30-day retention. Source: https://code.claude.com/docs/en/sessions.md
- WebSearch runs on Anthropic's backend, so a local fixture page cannot enter its results. Source: https://code.claude.com/docs/en/tools-reference.md

## Cursor CLI
- Output stream: `tool_call` started/completed events linked by `call_id`; init gives only a model display name; shell and MCP tool-call shapes undocumented; no cost fields. Source: https://cursor.com/docs/cli/reference/output-format
- Hooks: `tool_use_id` only on `preToolUse`, `postToolUse`, `postToolUseFailure`; hooks fail open unless `failClosed`; whether hooks fire under `agent -p` is UNVERIFIED. Source: https://cursor.com/docs/agent/hooks
- `--approve-mcps` approves all MCP servers; no documented way to pin a version. Source: https://cursor.com/docs/cli/reference/parameters

## Codex CLI
- Non-interactive: documented event types; token usage on `turn.completed`; no USD cost; `--ephemeral` suppresses session files. Source: https://learn.chatgpt.com/docs/non-interactive-mode.md
- Hooks receive `tool_use_id` and `turn_id`; cover shell, `apply_patch`, MCP tools; "Hosted tools such as WebSearch are not covered"; non-managed hooks must be trusted by hash, unreviewed hooks are skipped; whether hooks fire under `codex exec` is UNVERIFIED. Untrusted projects skip their `.codex/` config. Source: https://learn.chatgpt.com/docs/hooks?surface=cli

## OpenHands
- Headless is always `always-approve`, not changeable. JSONL has action/observation events without tool-call ids; nothing documented about cost. Source: https://docs.openhands.dev/openhands/usage/cli/headless
- SDK events: `tool_call_id` appears only on `AgentErrorEvent`; storage of events not described, so the landscape's "one file per event" is UNVERIFIED. Source: https://docs.openhands.dev/sdk/arch/events.md

## Pricing pages opened (numbers not recorded here; re-read before the cost model)
- https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI API pricing (developers.openai.com), page opened, figures not captured.

## Draft ADR list reached before the stop
ADR-01 scenario format (YAML + JSON Schema) · ADR-02 setup-under-test as a separate profile · ADR-03 runner lifecycle and determinism · ADR-04 agent adapters · ADR-05 fixtures inert by construction (canary namespace: DECISION NEEDED) · ADR-06 detector layering · ADR-07..19 not written: scoring, run manifest, cost model, reporting, isolation, language/runtime (DECISION NEEDED), dependency and release policy, repository layout, contribution flow, weekly cadence, disclosure and licensing, mcp-review-check reuse, non-goal guardrails; threats-to-validity table.

## Reviewer guidance for the next author
- State detector false-negative handling as a design principle: verdicts come from effect sensors outside the agent; positive and negative control runs check the detectors. Do not enumerate evasion techniques.
- Write in smaller separate steps (one ADR group per step; schemas separately from detector list).
