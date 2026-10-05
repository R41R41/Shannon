#!/bin/bash
# usage: run-flee-trace.sh <label> <port> <worldDir> <x,z> [EXTRA_ENV=VALUE ...]
LABEL=$1; PORT=$2; D=$3; SITE=$4; shift 4
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p $S
cd /home/azureuser/Shannon-dev/backend
env -i HOME=$HOME PATH=/usr/bin:/bin OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_OUTAGE_PORT=$PORT MINECRAFT_OUTAGE_WORLD_DIRECTORY=$D MINECRAFT_FLEE_TRACE_SITE=$SITE "$@" TS_NODE_TRANSPILE_ONLY=true timeout 280 bash ../scripts/with-dev-node.sh node --loader ts-node/esm scripts/minecraft-flee-trace-probe.ts > $S/flee-trace-$LABEL.log 2>&1
echo EXIT=$?
grep -a "approach\|flee [0-9]\|FLEE_TRACE\|^{" $S/flee-trace-$LABEL.log | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-900
