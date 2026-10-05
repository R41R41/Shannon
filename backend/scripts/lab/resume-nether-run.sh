#!/bin/bash
# 終わった実走を、同じ隔離ワールド・同じ身体（所持品もそのまま）で続行する。新しいワールドは作らない。
# 支給・テレポート・時刻の変更はしない（45分の枠を延ばすだけ。結果は「続行」として元の実走と分けて記録する）。
# 使い方: resume-nether-run.sh <port> <label> <worldDir> [window_ms=1200000] [planner_model=claude-sonnet-5-5] [budget_profile] [reasoning_effort=low]
set -euo pipefail
PORT=$1; LABEL=$2; D=$3; WINDOW=${4:-1200000}; MODEL=${5:-claude-sonnet-5-5}; PROFILE=${6:-actual-5000-20261002-morning}; EFFORT=${7:-low}
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p "$S"
cd /home/azureuser/Shannon-dev/backend
[[ "$D" =~ ^/home/azureuser/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] || { echo "isolated lab world required"; exit 1; }
grep -q "^server-port=$PORT$" "$D/server.properties" || { echo "port does not match the world"; exit 1; }
ss -ltn | grep -q ":$PORT " || { echo "the world's server is not running on $PORT"; exit 1; }
L=$S/nether-$LABEL.log
( env -i HOME=$HOME PATH=/usr/bin:/bin OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used \
  SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_PROBE_PORT=$PORT MINECRAFT_CAMPAIGN_WORLD_DIRECTORY=$D \
  MINECRAFT_CAMPAIGN_PAID_AUTHORIZED=true MINECRAFT_CAMPAIGN_BUDGET_PROFILE=$PROFILE MINECRAFT_CAMPAIGN_FULL_RUNTIME=true MINECRAFT_CAMPAIGN_RESUME=true \
  MINECRAFT_CAMPAIGN_MILESTONE=${MINECRAFT_CAMPAIGN_MILESTONE:-blaze_rod} MINECRAFT_LEARNING_MODE=feedback MINECRAFT_PLANNER_REASONING_EFFORT=$EFFORT MINECRAFT_PLANNER_MODEL=$MODEL MINECRAFT_CAMPAIGN_WINDOW_MS=$WINDOW MINECRAFT_CAMPAIGN_SEGMENTS=64 TS_NODE_TRANSPILE_ONLY=true \
  timeout $(( WINDOW / 1000 + 600 )) bash ../scripts/with-dev-node.sh node --loader ts-node/esm scripts/minecraft-campaign-live-probe.ts > $L 2>&1; \
  echo "NETHER_${LABEL}_EXIT=$?" >> $L ) > /dev/null 2>&1 &
echo "{\"label\":\"$LABEL\",\"port\":$PORT,\"world\":\"$D\",\"log\":\"$L\",\"resumed\":true,\"startedAt\":\"$(date +%H:%M:%S)\"}"
