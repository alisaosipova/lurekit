# LureKit: top-10 models and a universal agent axis

## Context
LureKit measures deployed coding-agent setups (agent CLI + tools + permissions + model) against
disclosure-cited lures. Today only Claude Code + Claude models is measured and published; Codex and
OpenHands adapters are live-validated (LV-1..LV-7 fixed, 2026-11-06) but only through resellers,
and klinch was caught substituting models (LV-6), so none of that is publishable. The maintainer
wants LureKit as universal as possible: the top-10 models (Claude, GPT, DeepSeek, GLM, MiniMax,
Kimi, Qwen, Gemini, Grok, Step/Hunyuan; OpenRouter usage ranking, data to 2026-11-05) measured
honestly, and the agents people actually use them in.

Decisions taken with the maintainer (2026-11-06):
- **Access: OpenRouter**, one key for all models; the served provider and model are recorded per
  repetition. Resellers (klinch, nexus) only for adapter plumbing, never for results.
- **Two axes:** Stage 1 = every model inside one fixed agent (Claude Code) so results compare
  across models on the full 25-scenario corpus; Stage 2 = models in their native agents.
- Cursor is deferred (the maintainer's account is refused by Cursor's server).

Hard constraints that shape the design: LureKit is **not a gateway/proxy** (project non-goal), so
any protocol translation is an external, recorded component; every change is spec first (ADR or
evidence-spec amendment), one block at a time, builder + reviewer per block, live check after.

## Stage 1: ten models in Claude Code (model axis)

**M1. Spec: model routing and provenance (ADR-0028).**
- Route: Claude Code speaks the Anthropic Messages API. A model is reached through
  `ANTHROPIC_BASE_URL` (already forwarded by `src/adapters/childEnv.ts`) pointing at either
  OpenRouter's Anthropic-compatible endpoint (UNVERIFIED: check the primary docs first, record in
  NOTES) or a local LiteLLM proxy on loopback that forwards to OpenRouter. The route is part of the
  measured setup and is recorded, never hidden.
- Provenance per repetition: the model the API reported (`message.model` in Claude Code's
  assistant events; extend `src/adapters/claudeCode.ts` near `state.effectiveModel`) and, for
  OpenRouter, the upstream provider (generation lookup by response id). New evidence fields
  `served_model`, `served_provider`; a mismatch with the requested model is a warning and makes the
  run unpublishable (publish gate check in `src/report/publish.ts`).
- Generalise LV-7 to Claude Code: a run where the model never produced a tool call that ran, but
  wrote tool-call markup or the API reported a tool-format error, is `inconclusive(adapter_error)`
  with `agent_fault` (reuse `TOOL_CALL_MARKUP_RE`, `src/adapters/codexCli.ts`).

**M2. Model profiles.** `profiles/models/<vendor>-<model>.json` per model (same shape as
`profiles/claude-code-hardened.json`: profile + env names, no secrets), composable with the
existing bare/hardened profiles via `--profile` (check `src/cli.ts` PROFILE_FILE_KEYS; extend to
merge two profiles if needed). Key passed by name with `--env`.

**M3. Doctor pre-flight per model.** `lurekit doctor --agent claude-code --model <id>` with a
base URL: route reachable, model listed, and one cheap tool-call round trip (does this model
actually call a tool through this route?). A model that fails is reported before any spend
(`src/doctor.ts`, pattern of `checkAuth`/`checkModel`).

**M4. Cross-model reporting.** Matrix (`scripts/matrix.mjs`, `docs/verified-against.md`) gains
served model/provider columns; a "by model" comparison (extend `src/report/diff.ts` from 2 to N
runs or a `lurekit compare` command, own ADR); README results table per model.

**M5. Live runs** (inside the bwrap sandbox used on 2026-11-06, key from a token file):
smoke k=1 for all 10 (budget about 5 USD) -> drop or flag models that do not fit (agent_fault,
substitution) -> full k=3, bare and hardened arms (about 20-40 USD total). Record one stream per
model as a CI replay fixture (pattern: `test/codex-sensor-blind.test.ts`). Bundles built locally;
publishing to `reports/` only with the maintainer's go-ahead.

## Stage 2: native agents (agent axis)

Per agent, one block each: NOTES facts from the CLI's own help and docs (flags, headless mode,
stream format, sandbox/approval knobs) -> ADR -> adapter (pattern: `src/adapters/codexCli.ts`,
`openhands.ts`) + stub (`test/fixtures/agents/stub-*.mjs`) -> live smoke via OpenRouter ->
recording in CI.

Order: **Gemini CLI** (Gemini), **Qwen Code** (Qwen; a Gemini CLI fork, so it shares most of that
adapter), then the model-agnostic agents people use with any model: **OpenCode**, **Aider**
(popularity UNVERIFIED, check before starting). Codex and OpenHands are re-measured on OpenRouter
models in the same round.

Corpus: extend `applies_to` only where the lure's surface exists in that agent AND a public
disclosure covers that agent (rules files GEMINI.md/QWEN.md/AGENTS.md, project MCP config,
settings hooks). Each extension cites its disclosure (schema requires `source.primary_url`); no
speculative scenarios.

## Order and cost control
1. Stage 1: M1 -> M2 -> M3 -> M5 smoke -> M4 -> M5 full.
2. Stage 2: Gemini CLI -> Qwen Code -> OpenCode -> Aider, each with live smoke.

One block at a time: spec by the lead, implementation by builder, adversarial review by reviewer,
live check by the lead. Release minor (1.7.0) after Stage 1, next minor after Stage 2, each only
with the maintainer's "publish".

## Verification (every block)
- Both tsc configs, `npm run build`, full `npx vitest run` (rerun load-flaky timing tests alone),
  `npm run docs:check`.
- Claude replays unchanged: `run --replay` of `claude-sample` and `claude-mcp-sample` vs
  `.aab-runs/b9cmp/base-*.json`, 0 differences.
- A new test built on a recorded live stream through the real scenario and fixtures.
- Live smoke through OpenRouter inside bwrap; every verdict checked against its evidence
  (tool calls, content_seen, served model) before it is reported.
- CI green on 3 OS after each push.

## What the maintainer provides
- An OpenRouter key saved to `/home/kali/packages/openrouter.token` (mode 600) and a top-up of
  about 25-45 USD for Stage 1 plus Stage 2 smoke runs.
- The go-ahead to publish bundles once Stage 1 runs are verified.
