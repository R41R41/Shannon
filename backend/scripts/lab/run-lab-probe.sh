#!/bin/bash
# usage: run-lab-probe.sh <script.ts> <label> <port> <worldDir> [EXTRA_ENV=VALUE ...]
# Runs one model-free probe script against an isolated lab world; no paid API is reachable from it.
SCRIPT=$1; LABEL=$2; PORT=$3; D=$4; shift 4
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p "$S"
cd /home/azureuser/Shannon-dev/backend
env -i HOME=$HOME PATH=/usr/bin:/bin OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_OUTAGE_PORT=$PORT MINECRAFT_OUTAGE_WORLD_DIRECTORY=$D "$@" TS_NODE_TRANSPILE_ONLY=true timeout ${MINEBOT_LAB_PROBE_TIMEOUT:-300} bash ../scripts/with-dev-node.sh node --loader ts-node/esm "$SCRIPT" > "$S/$LABEL.log" 2>&1
echo "EXIT=$? log=$S/$LABEL.log"
grep -a -o "^[A-Z_]* {.*" "$S/$LABEL.log" | tail -3
