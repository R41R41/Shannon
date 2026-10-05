#!/bin/bash
# usage: run-outage.sh <scenario> <label> <port> <worldDir> [EXTRA_ENV=VALUE ...]
SCEN=$1; LABEL=$2; PORT=$3; D=$4; shift 4
# Logs live outside /tmp: this is a Spot VM, stopped by the platform now and then, and /tmp is emptied with it.
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p "$S"
cd /home/azureuser/Shannon-dev/backend
# A stage of its own for every run: 96 blocks further along x each time, high in the open air.
N=$(( $(cat "$S/stage-counter" 2>/dev/null || echo 0) + 1 )); echo $N > "$S/stage-counter"
STAGE=${MINECRAFT_OUTAGE_STAGE:-$(( 2000 + N * 96 )),180,2000}
env -i HOME=$HOME PATH=/usr/bin:/bin OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_OUTAGE_PORT=$PORT MINECRAFT_OUTAGE_WORLD_DIRECTORY=$D MINECRAFT_OUTAGE_SCENARIO=$SCEN MINECRAFT_OUTAGE_STAGE=$STAGE "$@" TS_NODE_TRANSPILE_ONLY=true timeout 400 bash ../scripts/with-dev-node.sh node --loader ts-node/esm scripts/minecraft-planner-outage-flee-probe.ts > $S/$SCEN-$LABEL.log 2>&1
echo EXIT=$?
R=$(grep -o "OUTAGE_FLEE_REPORT .*" $S/$SCEN-$LABEL.log | cut -d' ' -f2)
[ -n "$R" ] && python3 -c "import json;r=json.load(open('$R'));print({k:r.get(k) for k in ['scenario','passed','guardEnabled','deaths','lowestY','platformTop','edgeGuardStops','blind','result','sealed','feet','start','killed','counterattacks','reflexEngagements','floating','lowestOxygen','iceLevel','bareHands','swam','breathedAt','airAfterMs','under','stoneStillThere','placed','highestY','failureType','overhead','refusedDigs','survived','enteredLava','inLavaMs','reflexEngagements','floated','placedBlocks','escaped','length','reached','carriesWater','douse','bucketAfter','minHealth','final','error'] if k in r})"
