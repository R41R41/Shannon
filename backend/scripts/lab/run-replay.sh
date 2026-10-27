#!/bin/bash
# Runs on the VM. usage: run-replay.sh <label> <code.tar> <cases.json> [KEY=VALUE ...]
#
# A paid run's acts replayed on its own ground (scripts/minecraft-replay-probe.ts), in an isolated lab:
#   (a) the world the run left is staged: level.dat and region/ of REPLAY_SOURCE (default: shannon-home's world, read only, and only
#       while shannon-home is stopped) are copied to $MINEBOT_LAB_SCRATCH/replay-world-<label>; the live world is never opened by a server;
#   (b) the code from <code.tar> into its own directory (HANDS_CODE_DIR, default ~/Shannon-hands-lab-replay), Shannon-dev's node_modules
#       hard-linked in (Shannon-dev is not touched);
#   (c) a new isolated server (scripts/minecraft-isolated-lab.mjs, natural terrain, the run's seed for any chunk not in the copy, view
#       distance 10 as shannon-home, loopback, a free port in 25570-25599, the tmux socket minebot-lab) started from the staged copy;
#   (d) the probe (no model, no paid key: `env -i` with the offline placeholders): each case puts the ground back to the moment of its
#       act (/setblock of the cells lab/run-ground.py found), places the body (position, pack, armour, health), sends the run's own act
#       through the production body's road, and compares what it says with what the run's act said;
#   (e) the server stopped, the lab world, the staged copy and the code directory removed. The logs stay in $MINEBOT_LAB_SCRATCH/replay-<label>/.
# Never touches the production services, their env files or their ports (25565-25569, shannon-home's 25560). One lab run at a time (flock).
#
# KEY=VALUE: REPLAY_SOURCE=<world dir>, REPLAY_SEED=<seed>, REPLAY_ONLY=c1220,c135, REPLAY_TIMEOUT=<seconds, default 1800>, REPLAY_KEEP=1,
#   REPLAY_FLOOR=default (the body's floor reflexes as production loads them, melee and flee too; default: floor, the probe's retreat/eat/armor),
#   REPLAY_SCENES=on (a heavy failure of a replayed act also saves the scene of the lab's world under $OUT/scenes; the black box is always under $OUT/blackbox).
#   A scene as REPLAY_SOURCE (<scene>/world): its region, entities and poi are staged, and its case (scene-case.py) keeps the creatures.
# The cases file is made on the PC with lab/run-ground.py and lab/replay-case.py from the run's dump (ops.jsonl, samples, equip).
set -u
LABEL=${1:?label}; CODE_TAR=${2:?code tar}; CASES=${3:?cases.json}; shift 3
for pair in "$@"; do case "$pair" in REPLAY_*=*) export "$pair";; *) echo "bad argument: $pair" >&2; exit 2;; esac; done
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
OUT=$SCRATCH/replay-$LABEL; mkdir -p "$OUT"
STAGE=$SCRATCH/replay-world-$LABEL
SOURCE=${REPLAY_SOURCE:-$HOME/minecraft/shannon-home/shannon_home}
CODE=$HOME/Shannon-hands-lab-replay
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
SOCKET=minebot-lab
DIR=""; SESSION=""; PORT=""; STATUS=1
exec 9>/tmp/hands-live.lock
flock -n 9 || { echo "another lab run holds /tmp/hands-live.lock (the VM has 2 cores: one at a time)" >&2; exit 3; }
log() { echo "[$(date +%H:%M:%S)] run-replay: $*"; }
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SESSION" ] && tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then
    log "stopping the server $SESSION"
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null && { log "killing the session"; tmux -L $SOCKET kill-session -t "$SESSION" 2>/dev/null; }
  fi
  if [ -n "$DIR" ] && [ -f "$DIR/logs/latest.log" ]; then cp "$DIR/logs/latest.log" "$OUT/server-latest.log" 2>/dev/null; fi
  if [ -n "$DIR" ] && [[ "$DIR" =~ ^/home/azureuser/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ] && [ -z "${REPLAY_KEEP:-}" ]; then rm -rf "$DIR"; log "removed the world directory"; fi
  [ -d "$STAGE" ] && [ -z "${REPLAY_KEEP:-}" ] && rm -rf "$STAGE"
  [ -d "$CODE" ] && [ -z "${REPLAY_KEEP:-}" ] && rm -rf "$CODE"
  if [ -n "$PORT" ] && ss -ltn | grep -q ":$PORT "; then log "WARNING: port $PORT is still listening"; fi
  exit "$STATUS"
}
trap cleanup EXIT INT TERM

# (a) the staged copy of the world the run left
case "$SOURCE" in "$HOME"/minecraft/shannon-home/shannon_home|"$HOME"/minecraft/shannon-home/shannon_home.before-regen-*|"$SCRATCH"/*|"$HOME"/Shannon/backend/saves/minecraft/scenes/*/world) ;; *) log "REPLAY_SOURCE must be shannon-home's world, one of its backups, a scene (saves/minecraft/scenes/<id>/world), or a copy under $SCRATCH"; exit 2;; esac
if [ "$SOURCE" = "$HOME/minecraft/shannon-home/shannon_home" ] && systemctl is-active --quiet shannon-home; then log "shannon-home is running: its world is not copied while a server writes it"; exit 2; fi
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$SOURCE/level.dat" "$STAGE/" && cp -r "$SOURCE/region" "$STAGE/region" || { log "staging failed"; exit 1; }
# A scene (2026-10-28) also has the creatures and items (entities/) and the points of interest (poi/): the replay starts with them.
for kind in entities poi; do [ -d "$SOURCE/$kind" ] && cp -r "$SOURCE/$kind" "$STAGE/$kind"; done
log "staged $(ls "$STAGE/region" | wc -l) region files of $SOURCE"
SEED=${REPLAY_SEED:-$(python3 -I -c "import gzip,struct;d=gzip.open('$STAGE/level.dat').read();i=d.find(b'\x04\x00\x04seed');print(struct.unpack('>q',d[i+7:i+15])[0] if i>=0 else '')")}

# (b) the code
rm -rf "$CODE"; mkdir -p "$CODE"
tar -xf "$CODE_TAR" -C "$CODE" || { log "tar failed"; exit 1; }
cp -al "$DEV/node_modules" "$CODE/node_modules" || { log "node_modules link failed"; exit 1; }
[ -d "$DEV/backend/node_modules" ] && cp -al "$DEV/backend/node_modules" "$CODE/backend/node_modules"
cp "$DEV/.nvmrc" "$CODE/.nvmrc"; touch "$CODE/.shannon-development"; mkdir -p "$CODE/backend/saves/minecraft"
cp "$CASES" "$OUT/cases.json"
( cd "$CODE" && sha1sum backend/src/services/minebot/utils/primitives/go.ts backend/src/services/minebot/utils/primitives/pillarUp.ts backend/scripts/minecraft-replay-probe.ts ) | tee "$OUT/code-sums.txt"

# (c) the server
for p in $(seq 25570 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
[ -n "$PORT" ] || { log "no free port"; exit 1; }
INFO=$(cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=natural MINECRAFT_LAB_SEED="$SEED" \
  MINECRAFT_LAB_WORLD_FROM="$STAGE" MINECRAFT_LAB_VIEW_DISTANCE=10 nice -n 10 node scripts/minecraft-isolated-lab.mjs 2>"$OUT/lab-start.err")
echo "$INFO" > "$OUT/lab-info.json"
DIR=$(echo "$INFO" | grep -o '"directory":"[^"]*"' | head -1 | cut -d'"' -f4)
SESSION=$(echo "$INFO" | grep -o '"session":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$DIR" ] && [ -n "$SESSION" ] || { log "the lab did not start: $INFO $(cat "$OUT/lab-start.err")"; exit 1; }
log "world $DIR (from the staged copy, seed $SEED) port $PORT"
for _ in $(seq 1 150); do grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null && break; tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null || { log "the server did not come up"; tail -20 "$DIR/logs/latest.log" 2>/dev/null; exit 1; }
log "server is up: $(grep -o 'Done ([0-9.]*s)' "$DIR/logs/latest.log" | head -1)"

# (d) the probe
log "running the probe (limit ${REPLAY_TIMEOUT:-1800} s); full log: $OUT/probe.log"
START=$(date +%s)
( cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used \
  SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_REPLAY_NO_LLM=true \
  MINECRAFT_REPLAY_PORT=$PORT MINECRAFT_REPLAY_WORLD_DIRECTORY="$DIR" MINECRAFT_REPLAY_CASES="$OUT/cases.json" MINECRAFT_REPLAY_REPORT="$OUT/report.json" \
  MINECRAFT_REPLAY_ONLY="${REPLAY_ONLY:-}" MINECRAFT_PROBE_FLOOR="${REPLAY_FLOOR:-floor}" MINEBOT_BLACKBOX_DIR="$OUT/blackbox" MINECRAFT_REPLAY_OUT="$OUT" \
  MINECRAFT_REPLAY_SCENES="${REPLAY_SCENES:-off}" TS_NODE_TRANSPILE_ONLY=true nice -n 5 timeout "${REPLAY_TIMEOUT:-1800}" node --loader ts-node/esm scripts/minecraft-replay-probe.ts ) > "$OUT/probe.log" 2>&1
STATUS=$?
log "probe exit $STATUS after $(( $(date +%s) - START )) s"
grep -a -E '^\[..:..:..\] (CASE|GROUND|ACT|BODY|SEARCHES|SEARCH_AGAIN|ACTOR_DEATH|FATAL)' "$OUT/probe.log" | cut -c1-400
grep -a '^REPLAY_RESULT ' "$OUT/probe.log" | tail -1
grep -a -E 'WARN|ERROR|Exception|moved wrongly|moved too quickly|Can.t keep up|I_am_Shannon (was|fell|drowned|hit|burned|tried|died|starved|suffocated)' "$DIR/logs/latest.log" \
  | grep -a -v 'issued server command' > "$OUT/server-notable.txt" 2>/dev/null
log "server notable lines: $(wc -l < "$OUT/server-notable.txt")"; head -20 "$OUT/server-notable.txt"
