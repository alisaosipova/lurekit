#!/usr/bin/env sh
# =============================================================================
# examples/run-live.sh - a budgeted LIVE run against a real Claude Code binary.
#
# THIS SCRIPT IS A REFERENCE AND IS NOT EXECUTED BY CI OR BY run-offline.sh.
# A live run launches the real agent: it spends money and needs the agent's own
# auth. Every command below is intentionally left commented. Read it, adjust the
# pins, uncomment, and run it yourself once you are ready.
#
# Prereqs:
#   - npm ci && npm run build
#   - a Claude Code binary you control, pinned by absolute path (see below)
#   - the agent's own credentials configured in your environment
# =============================================================================
set -eu

# --- Pin the exact agent binary ---------------------------------------------
# AAB_CLAUDE_BIN tells the claude-code adapter which executable to launch, so the
# run records a known, reproducible binary instead of whatever is first on PATH.
# Use an absolute path to the specific version you want to measure.
#
#   export AAB_CLAUDE_BIN="/opt/claude-code/2.1.316/bin/claude"

# --- Pin the model and the reported agent version ---------------------------
# --model is required (it is written into the manifest). --agent-version should
# match the binary above so the evidence is self-describing.
#
#   MODEL="claude-sonnet-4-6"
#   AGENT_VERSION="2.1.316"

# --- Keep it cheap and small -------------------------------------------------
# --mode smoke + --k 1 is one repetition per scenario. --budget caps total spend
# in USD; the runner stops once the cap would be exceeded. Point the positional
# at a single scenario directory (e.g. a one-file corpus) while you are dialing
# things in, rather than the full catalogue.
#
#   mkdir -p .aab-runs/live-one/scenarios
#   cp examples/scenario-template.yaml .aab-runs/live-one/scenarios/AAB-900.yaml
#
#   node dist/cli.js run .aab-runs/live-one/scenarios \
#     --agent claude-code \
#     --model "$MODEL" \
#     --agent-version "$AGENT_VERSION" \
#     --mode smoke --k 1 \
#     --budget 1.00 \
#     --results .aab-runs/live-one \
#     --format markdown --output .aab-runs/live-one/report.md

# --- Compare a hardened profile (optional) -----------------------------------
# The example profiles mirror ../profiles/. They have no --profile flag; pass the
# flags from each file's "cli_flags". Hardened = narrowed setting sources, strict
# MCP isolation, manual permission mode (see profiles/README.md).
#
#   node dist/cli.js run .aab-runs/live-one/scenarios \
#     --agent claude-code --model "$MODEL" --agent-version "$AGENT_VERSION" \
#     --setting-sources user --permission-mode manual \
#     --mode smoke --k 1 --budget 1.00 \
#     --results .aab-runs/live-hardened \
#     --format markdown --output .aab-runs/live-hardened/report.md

# --- Netread variant (optional) ---------------------------------------------
# The only loosening profile (profiles/claude-code-netread.json): allow curl so
# the headless agent can read loopback feed/web fixture content.
#
#   node dist/cli.js run .aab-runs/live-one/scenarios \
#     --agent claude-code --model "$MODEL" --agent-version "$AGENT_VERSION" \
#     --settings profiles/settings/allow-loopback-curl.json \
#     --mode smoke --k 1 --budget 1.00 \
#     --results .aab-runs/live-netread \
#     --format markdown --output .aab-runs/live-netread/report.md

# --- Record the run for later offline replay ---------------------------------
# To replay this run later with no agent and no spend (run-offline.sh), copy the
# raw stream and the observation hook log out of a repetition's run directory and
# strip any secrets or home paths before sharing (see README "Record once,
# replay offline").
#
#   REP=.aab-runs/live-one/<run_id>/AAB-900/0
#   mkdir -p .aab-runs/my-recording
#   cp "$REP/claude-stream.jsonl" "$REP/claude-hooks.jsonl" .aab-runs/my-recording/

# --- Publish a redacted, shareable bundle ------------------------------------
# The redaction gate rejects raw transcripts, live-credential shapes and leaked
# home paths. --redact-home rewrites YOUR home dir to <HOME> in the copies.
#
#   node dist/cli.js publish .aab-runs/live-one/<run_id> \
#     --out reports/<run_id> --redact-home

echo "run-live.sh is a reference only; open it and uncomment the steps you want." >&2
exit 0
