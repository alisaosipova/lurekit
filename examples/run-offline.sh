#!/usr/bin/env sh
# =============================================================================
# examples/run-offline.sh - the whole LureKit pipeline, fully offline.
#
# No live agent, no API spend, no network beyond loopback. It validates a
# scenario, runs every detector's self-test, plans, replays a recorded Claude
# Code run (ADR-0015), re-renders the report, and publishes a redacted bundle.
# All output lands in a scratch directory under .aab-runs/ that is wiped first.
#
# Prereqs: `npm ci && npm run build` (the script prefers the built dist/; if it
# is missing it falls back to `npx tsx` on the TypeScript source). Run it from
# anywhere; it resolves the repo root from its own location.
# =============================================================================
set -eu

HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
ROOT=$(CDPATH= cd "$HERE/.." && pwd)
cd "$ROOT"

# Pick a runner: the built CLI when present, else tsx on the source.
if [ -f dist/cli.js ]; then
  CLI="node dist/cli.js"
  VALIDATE="node dist/tools/validate-scenarios.js"
else
  CLI="npx --no-install tsx src/cli.ts"
  VALIDATE="npx --no-install tsx src/tools/validate-scenarios.ts"
fi

# Any model id works offline; the replay adapter reports its own recorded model.
MODEL="claude-sonnet-4-6"
RECORDING="test/fixtures/recordings/claude-sample"
SCRATCH=".aab-runs/examples-offline"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/scenarios"

# The example template cannot pass the directory loader under its descriptive
# name (loader enforces id == filename stem). Copy it in as AAB-900.yaml so the
# stem matches its id, giving a one-scenario corpus to drive.
cp examples/scenario-template.yaml "$SCRATCH/scenarios/AAB-900.yaml"

echo "== 1. validate (schema + loader invariants) =="
$VALIDATE "$SCRATCH/scenarios"

echo "== 2. selftest (every detector's positive/negative control) =="
$CLI selftest

echo "== 3. plan (which scenarios would run for this profile) =="
$CLI plan "$SCRATCH/scenarios" --model "$MODEL" --agent claude-code

echo "== 4. run --replay (offline; re-drives the recorded run) =="
$CLI run "$SCRATCH/scenarios" --model "$MODEL" --agent claude-code \
  --replay "$RECORDING" \
  --results "$SCRATCH/runs" \
  --format markdown --output "$SCRATCH/report.md"

# The run id is the single directory the run created under $SCRATCH/runs.
RUN_DIR=$(find "$SCRATCH/runs" -maxdepth 1 -mindepth 1 -type d | head -1)
echo "run dir: $RUN_DIR"

echo "== 5. report (re-render a completed run) =="
$CLI report "$RUN_DIR" --format json --output "$SCRATCH/report.json"

echo "== 6. publish (redaction gate; shareable bundle) =="
$CLI publish "$RUN_DIR" --out "$SCRATCH/bundle" --redact-home

echo
echo "done. artifacts under $SCRATCH :"
echo "  report.md / report.json   rendered reports"
echo "  runs/<run_id>/            manifest.json + per-scenario evidence.json"
echo "  bundle/                   published, redacted bundle"
