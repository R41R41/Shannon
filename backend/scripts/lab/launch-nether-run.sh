#!/bin/bash
# 計画器の既定は Claude Sonnet 5.5・推論 low（2026-10-02、ユーザー決定）。比較用に gpt-5.6-luna / claude-opus-5-5 も指定できる。
# 使い方: launch-nether-run.sh <port> <label> [window_ms] [learning_mode] [reasoning_effort: none|low|medium|high] [planner_model: gpt-5.6-luna|claude-sonnet-5-5|claude-opus-5-5] [budget_profile]
set -euo pipefail
PORT=$1; LABEL=$2; WINDOW=${3:-2700000}; LEARNING=${4:-feedback}; EFFORT=${5:-low}; MODEL=${6:-claude-sonnet-5-5}; PROFILE=${7:-actual-5000-20261002-morning}
# Logs live outside /tmp: this is a Spot VM, stopped by the platform now and then, and /tmp is emptied with it.
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p "$S"
cd /home/azureuser/Shannon-dev/backend
# MINECRAFT_LAB_VIEW_DISTANCE (5..12, default 10) is passed through to the lab server: how far the body sees.
# MINECRAFT_CAMPAIGN_MILESTONE (default blaze_rod): where the run ends. With `nether` it ends on arrival; with
# blaze_rod it goes on through the portal (arrival is logged as CAMPAIGN_NETHER_REACHED) until a rod is held.
# MINECRAFT_LAB_PUBLIC=true（2026-10-05、ユーザー依頼）: 外から普通のマルチと同じく入れるサーバー。正規ログイン＋
# MINECRAFT_LAB_WHITELIST の名前だけ。ボットは MINECRAFT_LAB_ACCOUNT_EMAIL のアカウント（先に scripts/lab/minecraft-account-login.mjs）。
# ポートは 25500〜25600（VM のファイアウォールが開けている範囲）。入ってきた人は観戦モードになる。
# MINECRAFT_LAB_WATCHERS=free で入ってきた人のゲームモードを変えない（一緒に遊べる。その実走は受入に数えない）。
# MINECRAFT_LAB_UI_MOD=true（公開ラボのみ）: ShannonUIMod と Fabric API を入れ、シャノンと UI Mod で話せる
# （ポートはゲーム+3600/+3800、loopback のみ。scripts/lab/lab-ui-mod.mjs）。MINECRAFT_LAB_BOT_NAME・MINECRAFT_LAB_MODS_DIR も渡す。
PUBLIC=${MINECRAFT_LAB_PUBLIC:-false}
# MINECRAFT_LAB_COMPANION_URL / _TOKEN_FILE: シャノンの心（開発用アプリ版、例 http://127.0.0.1:4329）と、その体として登録した端末トークンのファイル。
#   公開ラボだけ。ゲーム内で話しかけられたら返事は心が書き、頼まれた仕事だけ体がやる。死んだことも心へ送る。
# MINECRAFT_LAB_OPS（公開時の既定 Rai1241）: ホワイトリストのうち op にする人。ユーザーの希望で常に op（2026-10-05）。ボットは不可。
OUT=$(MINECRAFT_LAB_PUBLIC=$PUBLIC MINECRAFT_LAB_WHITELIST=${MINECRAFT_LAB_WHITELIST:-} MINECRAFT_LAB_OPS=${MINECRAFT_LAB_OPS-Rai1241} MINECRAFT_LAB_UI_MOD=${MINECRAFT_LAB_UI_MOD:-false} \
  MINECRAFT_LAB_BOT_NAME=${MINECRAFT_LAB_BOT_NAME:-I_am_Shannon} MINECRAFT_LAB_MODS_DIR=${MINECRAFT_LAB_MODS_DIR:-/home/azureuser/Shannon-dev/backend/saves/minecraft/uimod-test} MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=natural MINECRAFT_LAB_UNASSISTED=true MINECRAFT_LAB_VIEW_DISTANCE=${MINECRAFT_LAB_VIEW_DISTANCE:-10} bash ../scripts/with-dev-node.sh node scripts/minecraft-isolated-lab.mjs)
D=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['directory'])")
READY="Done ("; [ "$PUBLIC" = true ] && READY="RCON running"
for i in $(seq 1 300); do grep -q "$READY" $D/logs/latest.log 2>/dev/null && break; sleep 1; done
L=$S/nether-$LABEL.log
( env -i HOME=$HOME PATH=/usr/bin:/bin OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used \
  MINECRAFT_LAB_COMPANION_URL=${MINECRAFT_LAB_COMPANION_URL:-} MINECRAFT_LAB_COMPANION_TOKEN_FILE=${MINECRAFT_LAB_COMPANION_TOKEN_FILE:-} MINECRAFT_LAB_COMPANION_SERVER_ID=${MINECRAFT_LAB_COMPANION_SERVER_ID:-} \
  MINECRAFT_LAB_PUBLIC=$PUBLIC MINECRAFT_LAB_BOT_NAME=${MINECRAFT_LAB_BOT_NAME:-I_am_Shannon} MINECRAFT_LAB_ACCOUNT_EMAIL=${MINECRAFT_LAB_ACCOUNT_EMAIL:-} MINECRAFT_LAB_WATCHERS=${MINECRAFT_LAB_WATCHERS:-spectator} \
  SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_PROBE_PORT=$PORT MINECRAFT_CAMPAIGN_WORLD_DIRECTORY=$D \
  MINECRAFT_CAMPAIGN_PAID_AUTHORIZED=true MINECRAFT_CAMPAIGN_BUDGET_PROFILE=$PROFILE MINECRAFT_CAMPAIGN_FULL_RUNTIME=true \
  MINECRAFT_CAMPAIGN_MILESTONE=${MINECRAFT_CAMPAIGN_MILESTONE:-blaze_rod} MINECRAFT_LEARNING_MODE=$LEARNING MINECRAFT_PLANNER_REASONING_EFFORT=$EFFORT MINECRAFT_PLANNER_MODEL=$MODEL MINECRAFT_CAMPAIGN_WINDOW_MS=$WINDOW MINECRAFT_CAMPAIGN_SEGMENTS=64 TS_NODE_TRANSPILE_ONLY=true \
  timeout $(( WINDOW / 1000 + 600 )) bash ../scripts/with-dev-node.sh node --loader ts-node/esm scripts/minecraft-campaign-live-probe.ts > $L 2>&1; \
  echo "NETHER_${LABEL}_EXIT=$?" >> $L ) > /dev/null 2>&1 &
echo "{\"label\":\"$LABEL\",\"port\":$PORT,\"world\":\"$D\",\"log\":\"$L\",\"startedAt\":\"$(date +%H:%M:%S)\"}"
