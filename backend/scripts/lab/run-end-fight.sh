#!/bin/bash
# Runs on the VM. usage: run-end-fight.sh <label> <code.tar> [KEY=VALUE ...]
#
# The live check of the End fight parts of the body (scripts/minecraft-end-fight-probe.ts) against a real, isolated Minecraft server, with the body's code
# taken from <code.tar> (a tar of backend/src, backend/scripts, backend/package.json, backend/tsconfig.json, package.json from a worktree), not from
# Shannon-dev (which is old). One run does everything and leaves nothing behind but the logs under $MINEBOT_LAB_SCRATCH/end-<label>/ (default ~/.cache/minebot-lab):
#   (a) unpack the code into a directory of its own (END_CODE_DIR, default ~/Shannon-end-lab; Shannon-dev's node_modules are hard-linked in);
#   (b) start a new isolated flat-world server (scripts/minecraft-isolated-lab.mjs, the tmux socket minebot-lab, a free port in 25570-25599);
#   (c) run the probe (no model, no paid key: `env -i` with the offline placeholders) and print its ENDFIGHT lines and the result;
#   (d) stop the server, remove the world directory, the tmux session and the code directory.
# Never touches the production services, their env files or their ports (25565-25569 are never used). The caller takes the lab's slot first:
#   flock ~/.cache/minebot-lab/slot.lock bash run-end-fight.sh <label> <code.tar> ...
# and this script takes /tmp/hands-live.lock too (the VM has 2 cores: one lab run at a time).
#
# KEY=VALUE: END_SCENES=a,b (scene names or prefixes), END_TIMEOUT=<seconds, default 1500>, END_KEEP=1 (keep the code directory), END_PORT=<port>,
#            END_FLOOR=default|floor|off (the probe bot's floor reflexes, default `default`), END_VIEW=<5..12> (the server's view distance, default 6).
set -u
LABEL=${1:?label}; CODE_TAR=${2:?code tar}; shift 2
for pair in "$@"; do case "$pair" in END_*=*) export "$pair";; *) echo "bad argument: $pair" >&2; exit 2;; esac; done
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
OUT=$SCRATCH/end-$LABEL
mkdir -p "$OUT"
CODE=${END_CODE_DIR:-$HOME/Shannon-end-lab}
case "$CODE" in "$HOME"/Shannon-end-lab*) ;; *) echo "code dir must be ~/Shannon-end-lab*" >&2; exit 2;; esac
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
[ -x "$NODEBIN/node" ] || { echo "pinned node missing: $NODEBIN" >&2; exit 2; }
SOCKET=minebot-lab
DIR=""; SESSION=""; PORT=""; STATUS=1

exec 9>/tmp/hands-live.lock
flock -n 9 || { echo "another lab run holds /tmp/hands-live.lock (the VM has 2 cores: one at a time)" >&2; exit 3; }

log() { echo "[$(date +%H:%M:%S)] run-end-fight: $*"; }

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SESSION" ] && tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then
    log "stopping the server $SESSION"
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 60); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    if tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then log "the server did not stop in 120 s: killing the session"; tmux -L $SOCKET kill-session -t "$SESSION" 2>/dev/null; sleep 2; fi
  fi
  if [ -n "$DIR" ] && [ -f "$DIR/logs/latest.log" ]; then cp "$DIR/logs/latest.log" "$OUT/server-latest.log" 2>/dev/null; fi
  if [ -n "$DIR" ] && [[ "$DIR" =~ ^/home/azureuser/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ]; then rm -rf "$DIR"; log "removed the world directory"; fi
  if [ -z "${END_KEEP:-}" ] && [ -d "$CODE" ]; then rm -rf "$CODE"; log "removed the code directory $CODE"; fi
  if [ -n "$PORT" ] && ss -ltn | grep -q ":$PORT "; then log "WARNING: port $PORT is still listening"; fi
  if tmux -L $SOCKET ls 2>/dev/null | grep -q .; then log "WARNING: tmux sessions remain on the socket $SOCKET:"; tmux -L $SOCKET ls; fi
  exit "$STATUS"
}
trap cleanup EXIT INT TERM

# (a) the code
log "unpacking $CODE_TAR into $CODE"
rm -rf "$CODE"; mkdir -p "$CODE"
tar -xf "$CODE_TAR" -C "$CODE" || { log "tar failed"; exit 1; }
cp -al "$DEV/node_modules" "$CODE/node_modules" || { log "node_modules link failed"; exit 1; }
mkdir -p "$CODE/backend"
[ -d "$DEV/backend/node_modules" ] && cp -al "$DEV/backend/node_modules" "$CODE/backend/node_modules"
cp "$DEV/.nvmrc" "$CODE/.nvmrc"; touch "$CODE/.shannon-development"
mkdir -p "$CODE/backend/saves/minecraft"
cp "$CODE_TAR" "$OUT/code.tar" 2>/dev/null

# (b) the server
if [ -n "${END_PORT:-}" ]; then PORT=$END_PORT; else
  for p in $(seq 25570 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
fi
[ -n "$PORT" ] && [ "$PORT" -ge 25570 ] && [ "$PORT" -le 25599 ] || { log "no free port in 25570-25599"; exit 1; }
if ss -ltn | grep -q ":$PORT "; then log "port $PORT is in use"; exit 1; fi
log "starting an isolated flat world on port $PORT"
INFO=$(cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=flat MINECRAFT_LAB_VIEW_DISTANCE=${END_VIEW:-6} nice -n 10 node scripts/minecraft-isolated-lab.mjs 2>"$OUT/lab-start.err")
echo "$INFO" > "$OUT/lab-info.json"
DIR=$(echo "$INFO" | grep -o '"directory":"[^"]*"' | head -1 | cut -d'"' -f4)
SESSION=$(echo "$INFO" | grep -o '"session":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$DIR" ] || [ -z "$SESSION" ]; then log "the lab did not start: $INFO $(cat "$OUT/lab-start.err")"; exit 1; fi
log "world $DIR session $SESSION"
ready=0
for _ in $(seq 1 120); do
  grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null && { ready=1; break; }
  tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break
  sleep 2
done
if [ $ready != 1 ]; then log "the server did not come up in 240 s"; tail -20 "$DIR/logs/latest.log" 2>/dev/null; exit 1; fi
log "server is up: $(grep -o 'Done ([0-9.]*s)' "$DIR/logs/latest.log" | head -1)"

# (c) the probe
SCENES_ENV=""; [ -n "${END_SCENES:-}" ] && SCENES_ENV="MINECRAFT_END_SCENES=$END_SCENES"
log "running the probe (limit ${END_TIMEOUT:-1500} s); full log: $OUT/probe.log"
START=$(date +%s)
( cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used \
  SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_PROBE_FLOOR=${END_FLOOR:-default} \
  MINECRAFT_END_PORT=$PORT MINECRAFT_END_WORLD_DIRECTORY="$DIR" MINECRAFT_END_REPORT="$OUT/report.json" $SCENES_ENV \
  TS_NODE_TRANSPILE_ONLY=true nice -n 5 timeout "${END_TIMEOUT:-1500}" node --loader ts-node/esm scripts/minecraft-end-fight-probe.ts ) > "$OUT/probe.log" 2>&1
CODE_STATUS=$?
log "probe exit $CODE_STATUS after $(( $(date +%s) - START )) s"
grep -a ' ENDFIGHT ' "$OUT/probe.log" | grep -a -v 'ENDFIGHT_RESULT' | cut -c1-900
grep -a '^ENDFIGHT_RESULT ' "$OUT/probe.log" | tail -1 | cut -c1-6000
if ! grep -q '^ENDFIGHT_RESULT ' "$OUT/probe.log"; then log "no ENDFIGHT_RESULT: the probe did not finish; its last lines:"; tail -25 "$OUT/probe.log"; fi
STATUS=$CODE_STATUS

LOG=$DIR/logs/latest.log
grep -a -E 'WARN|ERROR|Exception|moved wrongly|moved too quickly|Can.t keep up|lost connection|Disconnect|kicked|MinebotTrial (was|fell|drowned|hit|burned|tried|died|starved|suffocated|blew)' "$LOG" \
  | grep -a -v 'issued server command' > "$OUT/server-notable.txt" 2>/dev/null
log "server notable lines: $(wc -l < "$OUT/server-notable.txt") (kept in $OUT/server-notable.txt)"
head -30 "$OUT/server-notable.txt"
exit "$STATUS"
