#!/bin/bash
# usage: run-hunt-lab.sh <label> <worktree> <world-key> [KEY=VALUE ...]      (HOME=/home/azureuser: the PC's WSL lab, or the VM)
#
# The live check of the hunts (scripts/minecraft-hunt-probe.ts: the blaze camp, the enderman's roofed hole, bartering, the thrown eye against /locate, the portal room's frames)
# on a STAGED natural world (scripts/lab/lab-world.sh: ~/.cache/minebot-lab/worlds/<key> and <key>.sites.json: the fortress with its blaze spawners, a warped forest, the stronghold),
# with the body's code of <worktree> (what is on disk: backend/src, backend/scripts, the two package files; node_modules are hard-linked from ~/Shannon-dev). No model, no paid key.
# One run: (a) copy the code, (b) start an isolated server on a copy of the staged world, (c) run the probe, (d) stop the server and remove the copy, the world and the code.
# Take the slot first:  lab-slot.sh --label hunt -- run-hunt-lab.sh ...   (the PC's WSL lab: LAB_SLOT_COUNT=3 LAB_PORT_FROM=25590; the VM only when no production run is going).
#
# KEY=VALUE: HUNT_SCENES=a,b (names or prefixes)  HUNT_SECONDS=<n> (the timed scenes' length)  HUNT_PORT=<port>  HUNT_VIEW=<chunks, default 10>  HUNT_TIMEOUT=<seconds, default 2400>  HUNT_KEEP=1
set -u
LABEL=${1:?label}; WORKTREE=${2:?worktree}; KEY=${3:?world key}; shift 3
for pair in "$@"; do case "$pair" in HUNT_*=*) export "$pair";; *) echo "bad argument: $pair" >&2; exit 2;; esac; done
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
[[ "$KEY" =~ ^[A-Za-z0-9]{1,20}$ ]] || { echo "bad world key" >&2; exit 2; }
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
OUT=$SCRATCH/hunt-$LABEL
mkdir -p "$OUT"
CODE=$HOME/Shannon-hunt-lab-$LABEL
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
[ -x "$NODEBIN/node" ] || { echo "pinned node missing: $NODEBIN" >&2; exit 2; }
WORLD=$SCRATCH/worlds/$KEY
[ -f "$WORLD/level.dat" ] && [ -d "$WORLD/region" ] || { echo "no staged world $WORLD" >&2; exit 2; }
SOCKET=minebot-lab
DIR=""; SESSION=""; PORT=""; STATUS=1
log() { echo "[$(date +%H:%M:%S)] run-hunt-lab: $*"; }

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SESSION" ] && tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then
    log "stopping the server $SESSION"
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    if tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then log "the server did not stop in 90 s: killing the session"; tmux -L $SOCKET kill-session -t "$SESSION" 2>/dev/null; sleep 2; fi
  fi
  if [ -n "$DIR" ] && [ -f "$DIR/logs/latest.log" ]; then cp "$DIR/logs/latest.log" "$OUT/server-latest.log" 2>/dev/null; fi
  if [ -n "$DIR" ] && [[ "$DIR" =~ ^$HOME/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ]; then rm -rf "$DIR"; log "removed the world directory"; fi
  if [ -z "${HUNT_KEEP:-}" ] && [ -d "$CODE" ]; then rm -rf "$CODE"; log "removed the code directory $CODE"; fi
  if [ -n "$PORT" ] && ss -ltn | grep -q ":$PORT "; then log "WARNING: port $PORT is still listening"; fi
  exit "$STATUS"
}
trap cleanup EXIT INT TERM

# (a) the code
log "copying the code of $WORKTREE to $CODE"
rm -rf "$CODE"; mkdir -p "$CODE/backend"
for item in backend/src backend/scripts backend/package.json backend/tsconfig.json package.json; do
  rsync -a --exclude='*.test.ts' --exclude='node_modules' "$WORKTREE/$item" "$CODE/$(dirname "$item")/" || { log "rsync of $item failed"; exit 1; }
done
cp -al "$DEV/node_modules" "$CODE/node_modules" || { log "node_modules link failed"; exit 1; }
[ -d "$DEV/backend/node_modules" ] && cp -al "$DEV/backend/node_modules" "$CODE/backend/node_modules"
cp "$DEV/.nvmrc" "$CODE/.nvmrc"; touch "$CODE/.shannon-development"
mkdir -p "$CODE/backend/saves/minecraft"
cp -r "$WORKTREE/backend/saves/minecraft/structures" "$CODE/backend/saves/minecraft/" 2>/dev/null
( cd "$CODE" && sha1sum backend/src/services/minebot/utils/primitives/fight.ts backend/scripts/minecraft-hunt-probe.ts ) | tee "$OUT/code-sums.txt"

# (b) the server, on a copy of the staged world
if [ -n "${HUNT_PORT:-}" ]; then PORT=$HUNT_PORT; else
  for p in $(seq "${LAB_PORT_FROM:-25570}" 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
fi
[ -n "$PORT" ] && [ "$PORT" -ge 25570 ] && [ "$PORT" -le 25599 ] || { log "no free port in 25570-25599"; exit 1; }
if ss -ltn | grep -q ":$PORT "; then log "port $PORT is in use"; exit 1; fi
log "starting the staged world $KEY on port $PORT (view distance ${HUNT_VIEW:-10})"
INFO=$(cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=natural MINECRAFT_LAB_UNASSISTED=true \
  MINECRAFT_LAB_VIEW_DISTANCE=${HUNT_VIEW:-10} MINECRAFT_LAB_WORLD_FROM="$WORLD" nice -n 10 node scripts/minecraft-isolated-lab.mjs 2>"$OUT/lab-start.err")
echo "$INFO" > "$OUT/lab-info.json"
DIR=$(echo "$INFO" | grep -o '"directory":"[^"]*"' | head -1 | cut -d'"' -f4)
SESSION=$(echo "$INFO" | grep -o '"session":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$DIR" ] || [ -z "$SESSION" ]; then log "the lab did not start: $INFO $(cat "$OUT/lab-start.err")"; exit 1; fi
log "world $DIR session $SESSION"
ready=0
for _ in $(seq 1 150); do
  grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null && { ready=1; break; }
  tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break
  sleep 2
done
if [ $ready != 1 ]; then log "the server did not come up in 300 s"; tail -20 "$DIR/logs/latest.log" 2>/dev/null; exit 1; fi
log "server is up: $(grep -o 'Done ([0-9.]*s)' "$DIR/logs/latest.log" | head -1)"

# (c) the probe
SCENES_ENV=""; [ -n "${HUNT_SCENES:-}" ] && SCENES_ENV="MINECRAFT_HUNT_SCENES=$HUNT_SCENES"
SECONDS_ENV=""; [ -n "${HUNT_SECONDS:-}" ] && SECONDS_ENV="MINECRAFT_HUNT_SECONDS=$HUNT_SECONDS"
SITES_ENV=""; [ -f "$WORLD.sites.json" ] && SITES_ENV="MINECRAFT_HUNT_SITES=$WORLD.sites.json"
log "running the probe (limit ${HUNT_TIMEOUT:-2400} s); full log: $OUT/probe.log"
START=$(date +%s)
( cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used \
  SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_HUNT_NO_LLM=true MINECRAFT_PROBE_FLOOR=default \
  MINECRAFT_HUNT_PORT=$PORT MINECRAFT_HUNT_WORLD_DIRECTORY="$DIR" MINECRAFT_HUNT_REPORT="$OUT/report.json" $SITES_ENV $SCENES_ENV $SECONDS_ENV \
  TS_NODE_TRANSPILE_ONLY=true nice -n 5 timeout "${HUNT_TIMEOUT:-2400}" node --loader ts-node/esm scripts/minecraft-hunt-probe.ts ) > "$OUT/probe.log" 2>&1
CODE_STATUS=$?
log "probe exit $CODE_STATUS after $(( $(date +%s) - START )) s"
grep -a '^HUNT_SCENE ' "$OUT/probe.log" | cut -c1-1800
grep -a '^HUNT_RESULT ' "$OUT/probe.log" | tail -1
if ! grep -q '^HUNT_RESULT ' "$OUT/probe.log"; then log "no HUNT_RESULT: the probe did not finish; its last lines:"; tail -25 "$OUT/probe.log"; fi
STATUS=$CODE_STATUS
LOG=$DIR/logs/latest.log
grep -a -E 'WARN|ERROR|Exception|moved wrongly|moved too quickly|Can.t keep up|lost connection|Disconnect|kicked|MinebotTrial (was|fell|drowned|hit|burned|tried|died|starved|suffocated|blew)' "$LOG" \
  | grep -a -v 'issued server command' > "$OUT/server-notable.txt" 2>/dev/null
log "server notable lines: $(wc -l < "$OUT/server-notable.txt") (kept in $OUT/server-notable.txt)"
head -30 "$OUT/server-notable.txt"
exit "$STATUS"
