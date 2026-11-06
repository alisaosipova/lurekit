# ADR-0028: model routing and provenance (ten models in Claude Code)

Status: accepted (maintainer, 2026-11-06, plan `docs/plan/models-and-agents-2026-11-06.md`).

## Context
LureKit measured only Claude models in Claude Code. The maintainer wants the top-10 models
(OpenRouter usage ranking) measured in one fixed agent so results compare across models on the
full corpus. A reseller substituted models in the 2026-11-06 live runs (plan
`docs/plan/live-validation-2026-11-06.md` LV-6), so the served model must be recorded, not assumed.
OpenRouter exposes an Anthropic Messages-compatible endpoint (NOTES, "OpenRouter as a route for
Claude Code"); LureKit stays out of the request path (non-goal: no gateway or proxy).

## Decision
D1. Route. A model is reached by forwarding `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and an
    empty `ANTHROPIC_API_KEY` to Claude Code (all already in the claude-code env allow list,
    `src/adapters/childEnv.ts`), passed with `--env` from the operator's environment; the model id
    is `--model <openrouter slug>`. The base URL is a recorded, published value of the run.
D2. Served model. The Claude Code adapter records the model the API reported in each assistant
    event (`message.model`) as `observation.served_models` (sorted, de-duplicated). If any served
    model differs from the requested `--model` after normalisation (lowercase; a vendor prefix
    `vendor/` and a trailing date or `:variant` suffix ignored), the warning `served model <x>
    differs from the requested <y>` is recorded and `publish` refuses the run (a substituted
    model is not a result for the model named).
D3. Agent fault in Claude Code (LV-7 generalised). A repetition in which no tool call ran and the
    assistant text carries tool-call markup (`TOOL_CALL_MARKUP_RE`, `src/adapters/codexCli.ts`) sets
    `agent_fault` with the warning `the model wrote tool-call markup into its reply and no tool call
    ran; the model does not fit the CLI's tool protocol`; the runner scores it
    `inconclusive(adapter_error)` unless a detector hit (evidence-spec s3.1 rule 2, s4.1).
D4. Upstream provider (OpenRouter's routing to a vendor) is recorded when the stream reports it;
    a provider lookup by response id is deferred (needs a second API call per repetition).

## Consequences
Every Stage 1 run carries which model actually answered; a substitution is caught before
publication. Claude replays are unchanged (the recordings report Claude models and no markup).

## Test plan
Unit: served models collected from assistant events; normalisation (`anthropic/claude-sonnet-5.5`
vs `claude-sonnet-5.5-20261001` equal; `minimax/m3` vs `openai/gpt-6.1-sol` differ); mismatch warning;
publish refusal on a manifest with the warning. Runner: a stub claude stream with markup and no
tool call scores `inconclusive(adapter_error)`. Claude replays: 0 verdict differences.
