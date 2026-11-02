#!/bin/bash
# run-end-check.sh <label> [seed] [--survival] [--seconds N]   (VM or the PC's WSL lab; under lab-slot.sh)
#
# Does a lab world start the dragon fight when someone is sent to The End? A new isolated NATURAL lab server (normal difficulty, the
# production setting: MINECRAFT_LAB_UNASSISTED=true, and the given seed), the bare client scripts/lab/end-check.mjs as the op, the answer
# in $MINEBOT_LAB_SCRATCH/end-check-<label>/ (end-check.json, server-latest.log), then the server is stopped and its directory removed.
# No model, no key, no production service. The code comes from this script's own worktree (backend/scripts), node_modules from
# $HOME/Shannon-dev (the VM's checkout, or what wsl-lab-setup.sh built).
set -u
LABEL=${1:?label}; shift
SEED=""; if [[ "${1:-}" =~ ^-?[0-9]{1,20}$ ]]; then SEED=$1; shift; fi
EXTRA=("$@")
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
OUT=$SCRATCH/end-check-$LABEL
mkdir -p "$OUT"
BACKEND=$(cd "$(dirname "$0")/../.." && pwd)
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
[ -x "$NODEBIN/node" ] || { echo "pinned node missing: $NODEBIN" >&2; exit 2; }
SOCKET=minebot-lab
DIR=""; SESSION=""; PORT=""; STATUS=1
log() { echo "[$(date +%H:%M:%S)] run-end-check: $*"; }

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SESSION" ] && tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null && tmux -L $SOCKET kill-session -t "$SESSION" 2>/dev/null
  fi
  [ -n "$DIR" ] && [ -f "$DIR/logs/latest.log" ] && cp "$DIR/logs/latest.log" "$OUT/server-latest.log" 2>/dev/null
  if [ -n "$DIR" ] && [[ "$DIR" =~ ^$HOME/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ]; then rm -rf "$DIR"; log "removed the world directory"; fi
  exit "$STATUS"
}
trap cleanup EXIT INT TERM

# LAB_PORT_FROM: the PC's WSL lab keeps 25570-25589 for seedscan.py's servers (25570 + slot), so its labs start at 25590
for p in $(seq "${LAB_PORT_FROM:-25570}" 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
[ -n "$PORT" ] || { log "no free port in ${LAB_PORT_FROM:-25570}-25599"; exit 1; }
log "starting an isolated natural world (normal difficulty) on port $PORT${SEED:+, seed $SEED}"
# the view distance is 10 chunks, as on the production server (the lab default of 5 hides a dragon that circles 100 blocks out)
INFO=$(cd "$BACKEND" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=natural MINECRAFT_LAB_UNASSISTED=true \
  MINECRAFT_LAB_VIEW_DISTANCE=${LAB_VIEW_DISTANCE:-10} ${SEED:+MINECRAFT_LAB_SEED=$SEED} nice -n 10 node scripts/minecraft-isolated-lab.mjs 2>"$OUT/lab-start.err")
echo "$INFO" > "$OUT/lab-info.json"
DIR=$(echo "$INFO" | grep -o '"directory":"[^"]*"' | head -1 | cut -d'"' -f4)
SESSION=$(echo "$INFO" | grep -o '"session":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$DIR" ] && [ -n "$SESSION" ] || { log "the lab did not start: $INFO $(cat "$OUT/lab-start.err")"; exit 1; }
ready=0
for _ in $(seq 1 150); do
  grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null && { ready=1; break; }
  tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break
  sleep 2
done
[ $ready = 1 ] || { log "the server did not come up"; tail -20 "$DIR/logs/latest.log" 2>/dev/null; exit 1; }
log "server is up: $(grep -o 'Done ([0-9.]*s)' "$DIR/logs/latest.log" | head -1)"

( cd "$BACKEND" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" BODY_NODE_MODULES="$DEV/node_modules" \
  timeout 400 node scripts/lab/end-check.mjs "$PORT" "${EXTRA[@]}" ) > "$OUT/end-check.log" 2>&1
STATUS=$?
grep -a '^END_CHECK ' "$OUT/end-check.log" | sed 's/^END_CHECK //' > "$OUT/end-check.json"
log "end-check exit $STATUS; $(wc -c < "$OUT/end-check.json") bytes of result in $OUT/end-check.json"
cat "$OUT/end-check.json"
grep -a -E 'WARN|ERROR|Exception|Can.t keep up|Disconnect|kicked' "$DIR/logs/latest.log" | grep -a -v 'issued server command' | head -15 > "$OUT/server-notable.txt"
exit "$STATUS"
