#!/bin/bash
# Runs on the VM. usage: world-pristine.sh <label> <code.tar> <seed> <x0> <z0> <x1> <z1>
#
# The ground of a seed as the generator made it, before anybody dug or built: a new isolated natural-world lab server
# (scripts/minecraft-isolated-lab.mjs from <code.tar>, its own port in 25570-25599, the tmux socket minebot-lab) with the seed,
# the box of columns x0..x1, z0..z1 force-loaded (generated in full), saved, the server stopped, and the region files copied to
# $MINEBOT_LAB_SCRATCH/pristine-<label>/region (with level.dat). The lab world and the code directory are removed afterwards.
# lab/run41-ground.py compares this with the world a paid run left, to find what the body changed (and put it back).
# No model, no key, no production service or port (25565-25569, shannon-home's 25560) is touched. One run at a time (the hands lock).
set -u
LABEL=${1:?label}; CODE_TAR=${2:?code tar}; SEED=${3:?seed}; X0=${4:?}; Z0=${5:?}; X1=${6:?}; Z1=${7:?}
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
[[ "$SEED" =~ ^-?[0-9]{1,20}$ ]] || { echo "bad seed" >&2; exit 2; }
for v in "$X0" "$Z0" "$X1" "$Z1"; do [[ "$v" =~ ^-?[0-9]{1,6}$ ]] || { echo "bad box" >&2; exit 2; }; done
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
OUT=$SCRATCH/pristine-$LABEL
CODE=$HOME/Shannon-hands-lab-pristine
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
SOCKET=minebot-lab
DIR=""; SESSION=""; STATUS=1
exec 9>/tmp/hands-live.lock
flock -n 9 || { echo "another lab run holds /tmp/hands-live.lock" >&2; exit 3; }
log() { echo "[$(date +%H:%M:%S)] world-pristine: $*"; }
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SESSION" ] && tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null && tmux -L $SOCKET kill-session -t "$SESSION" 2>/dev/null
  fi
  if [ -n "$DIR" ] && [[ "$DIR" =~ ^/home/azureuser/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ]; then rm -rf "$DIR"; log "removed the world directory"; fi
  [ -d "$CODE" ] && rm -rf "$CODE"
  exit "$STATUS"
}
trap cleanup EXIT INT TERM
rm -rf "$CODE"; mkdir -p "$CODE" "$OUT/region"
tar -xf "$CODE_TAR" -C "$CODE" backend/scripts/minecraft-isolated-lab.mjs backend/scripts/lab/lab-ui-mod.mjs || { log "tar failed"; exit 1; }
PORT=""
for p in $(seq 25570 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
[ -n "$PORT" ] || { log "no free port"; exit 1; }
INFO=$(cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=natural MINECRAFT_LAB_SEED=$SEED nice -n 10 node scripts/minecraft-isolated-lab.mjs)
DIR=$(echo "$INFO" | grep -o '"directory":"[^"]*"' | head -1 | cut -d'"' -f4)
SESSION=$(echo "$INFO" | grep -o '"session":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$DIR" ] && [ -n "$SESSION" ] || { log "the lab did not start: $INFO"; exit 1; }
log "world $DIR port $PORT seed $SEED"
for _ in $(seq 1 150); do grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null && break; sleep 2; done
grep -q 'Done (' "$DIR/logs/latest.log" || { log "the server did not come up"; exit 1; }
tmux -L $SOCKET send-keys -t "$SESSION" "forceload add $X0 $Z0 $X1 $Z1" Enter
sleep 5
for _ in $(seq 1 60); do grep -q -E 'Marked [0-9]+ chunks|chunk .* marked|force loaded' "$DIR/logs/latest.log" && break; sleep 2; done
grep -a -E 'Marked|forceload|force loaded' "$DIR/logs/latest.log" | tail -2
sleep 30
tmux -L $SOCKET send-keys -t "$SESSION" "save-all flush" Enter
for _ in $(seq 1 60); do grep -q 'Saved the game' "$DIR/logs/latest.log" && break; sleep 2; done
tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter
for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
SESSION=""
cp "$DIR/progressive_world/level.dat" "$OUT/" && cp "$DIR"/progressive_world/region/*.mca "$OUT/region/" && STATUS=0
ls -la "$OUT/region" | head
log "pristine region files in $OUT"
