#!/usr/bin/env bash
# Run the LureKit corpus in Claude Code against several models through OpenRouter (ADR-0028).
# OpenRouter's Anthropic-compatible endpoint: docs/design/NOTES-verified-facts.md.
# Usage: OPENROUTER_API_KEY=... examples/run-models.sh [smoke|full] [model-slug ...]
# Spends real money on your OpenRouter account; --budget caps each run.
set -euo pipefail
mode="${1:-smoke}"; shift || true
# Top-10 families (OpenRouter usage ranking and catalog, checked 2026-11-06). Slugs change: check
# https://openrouter.ai/models before a run.
models=("$@")
if [ ${#models[@]} -eq 0 ]; then
  models=(
    anthropic/claude-sonnet-5.5
    openai/gpt-6.1-sol
    deepseek/deepseek-v4.1-flash
    z-ai/glm-5.3
    minimax/minimax-m3.1-flash
    moonshotai/kimi-k3
    qwen/qwen3.8-max-0902
    google/gemini-3.8-flash
    x-ai/grok-4.7
    stepfun/step-5-preview
    tencent/hy4
  )
fi
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY}"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
for m in "${models[@]}"; do
  out=".aab-runs/models/$(echo "$m" | tr '/:' '__')"
  echo "== $m ($mode)"
  npx lurekit run --agent claude-code --model "$m" --mode "$mode" --yes --budget 5 \
    --env ANTHROPIC_BASE_URL --env ANTHROPIC_AUTH_TOKEN --env ANTHROPIC_API_KEY \
    --results "$out" --format json > "$out.json" || echo "   exit $? (see $out)"
done
