#!/bin/bash
# Runs on the VM. usage: run-incident-lab.sh <label> <code.tar> [KEY=VALUE ...]
#
# The fix run's hold end to end (scripts/minecraft-incident-lab-probe.ts, 2026-10-28): a held act's heavy failure, the black box, the scene,
# the frozen world, a body restarted while held, the resume. Made from run-hands-live.sh (same isolation, same clean-up; the box, the scene and the
# hold file are kept under $MINEBOT_LAB_SCRATCH/incident-<label>/). The rest of this header is run-hands-live's:
#
# The live check of the act hands (scripts/minecraft-hands-live-probe.ts) against a real, isolated Minecraft server, with the body's code
# taken from <code.tar> (a tar of backend/src, backend/scripts, backend/package.json, backend/tsconfig.json, package.json from a worktree),
# not from Shannon-dev (which is old). One run does everything and leaves nothing behind but the logs under
# $MINEBOT_LAB_SCRATCH/hands-<label>/ (default ~/.cache/minebot-lab):
#   (a) unpack the code into a directory of its own (HANDS_CODE_DIR, default ~/Shannon-run40-lab; Shannon-dev's node_modules are
#       hard-linked in, Shannon-dev itself is not touched), then the overlay tar if there is one (a file swapped in for a comparison);
#   (b) start a new isolated flat-world server (scripts/minecraft-isolated-lab.mjs, the tmux socket minebot-lab, a free port in 25570-25599);
#   (c) run the probe (no model, no paid key: `env -i` with the offline placeholders) and print its table;
#   (d) stop the server, remove the world directory, the tmux session and the code directory.
# Never touches the production services, their env files or their ports (25565-25569 are never used). One run at a time (flock).
#
# KEY=VALUE: HANDS_SCENES=a,b (scene names or prefixes), HANDS_SCENE_SECONDS=<n>, HANDS_REPEAT=<n> (the scenes n times over), HANDS_TIMEOUT=<seconds, default 1500>,
#            HANDS_OVERLAY=<tar extracted over the code>, HANDS_KEEP=1 (keep the code directory), HANDS_PORT=<port>.
set -u
LABEL=${1:?label}; CODE_TAR=${2:?code tar}; shift 2
for pair in "$@"; do case "$pair" in HANDS_*=*) export "$pair";; *) echo "bad argument: $pair" >&2; exit 2;; esac; done
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
OUT=$SCRATCH/incident-$LABEL
mkdir -p "$OUT"
CODE=${HANDS_CODE_DIR:-$HOME/Shannon-hands-lab-incident}
case "$CODE" in "$HOME"/Shannon-run40-lab*|"$HOME"/Shannon-hands-lab*) ;; *) echo "code dir must be ~/Shannon-run40-lab* or ~/Shannon-hands-lab*" >&2; exit 2;; esac
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
[ -x "$NODEBIN/node" ] || { echo "pinned node missing: $NODEBIN" >&2; exit 2; }
SOCKET=minebot-lab
DIR=""; SESSION=""; PORT=""; STATUS=1

exec 9>/tmp/hands-live.lock
flock -n 9 || { echo "another hands-live run holds /tmp/hands-live.lock (the VM has 2 cores: one at a time)" >&2; exit 3; }

log() { echo "[$(date +%H:%M:%S)] run-hands-live: $*"; }

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SESSION" ] && tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then
    log "stopping the server $SESSION"
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    if tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null; then log "the server did not stop in 90 s: killing the session"; tmux -L $SOCKET kill-session -t "$SESSION" 2>/dev/null; sleep 2; fi
  fi
  if [ -n "$DIR" ] && [ -f "$DIR/logs/latest.log" ]; then cp "$DIR/logs/latest.log" "$OUT/server-latest.log" 2>/dev/null; fi
  if [ -n "$DIR" ] && [[ "$DIR" =~ ^/home/azureuser/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ]; then rm -rf "$DIR"; log "removed the world directory"; fi
  if [ -z "${HANDS_KEEP:-}" ] && [ -d "$CODE" ]; then rm -rf "$CODE"; log "removed the code directory $CODE"; fi
  # Nothing of this run is left listening or in tmux.
  if [ -n "$PORT" ] && ss -ltn | grep -q ":$PORT "; then log "WARNING: port $PORT is still listening"; fi
  if tmux -L $SOCKET ls 2>/dev/null | grep -q .; then log "WARNING: tmux sessions remain on the socket $SOCKET:"; tmux -L $SOCKET ls; fi
  exit "$STATUS"
}
trap cleanup EXIT INT TERM

# (a) the code
log "unpacking $CODE_TAR into $CODE"
rm -rf "$CODE"; mkdir -p "$CODE"
tar -xf "$CODE_TAR" -C "$CODE" || { log "tar failed"; exit 1; }
if [ -n "${HANDS_OVERLAY:-}" ]; then tar -xf "$HANDS_OVERLAY" -C "$CODE" || { log "overlay failed"; exit 1; }; log "overlay applied: $(tar -tf "$HANDS_OVERLAY" | grep -v '/$' | tr '\n' ' ')"; fi
cp -al "$DEV/node_modules" "$CODE/node_modules" || { log "node_modules link failed"; exit 1; }
mkdir -p "$CODE/backend"
[ -d "$DEV/backend/node_modules" ] && cp -al "$DEV/backend/node_modules" "$CODE/backend/node_modules"
cp "$DEV/.nvmrc" "$CODE/.nvmrc"; touch "$CODE/.shannon-development"
mkdir -p "$CODE/backend/saves/minecraft"
cp "$CODE_TAR" "$OUT/code.tar" 2>/dev/null
( cd "$CODE" && sha1sum backend/src/services/minebot/utils/primitives/go.ts backend/scripts/minecraft-incident-lab-probe.ts ) | tee "$OUT/code-sums.txt"

# (b) the server
if [ -n "${HANDS_PORT:-}" ]; then PORT=$HANDS_PORT; else
  for p in $(seq 25570 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
fi
[ -n "$PORT" ] && [ "$PORT" -ge 25570 ] && [ "$PORT" -le 25599 ] || { log "no free port in 25570-25599"; exit 1; }
if ss -ltn | grep -q ":$PORT "; then log "port $PORT is in use"; exit 1; fi
log "starting an isolated flat world on port $PORT"
INFO=$(cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=flat nice -n 10 node scripts/minecraft-isolated-lab.mjs 2>"$OUT/lab-start.err")
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
log "running the probe (limit ${HANDS_TIMEOUT:-900} s); full log: $OUT/probe.log"
START=$(date +%s)
mkdir -p "$OUT/blackbox" "$OUT/run"
( cd "$CODE/backend" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used   SHANNON_ISOLATED_MINEBOT_PROBE=true MINECRAFT_COGNITION_MODE=off MINECRAFT_OUTAGE_NO_LLM=true MINECRAFT_INCIDENT_NO_LLM=true   MINECRAFT_INCIDENT_PORT=$PORT MINECRAFT_INCIDENT_WORLD_DIRECTORY="$DIR" MINECRAFT_INCIDENT_OUT="$OUT/run" MINECRAFT_INCIDENT_REPORT="$OUT/report.json"   MINEBOT_BLACKBOX_DIR="$OUT/blackbox" TS_NODE_TRANSPILE_ONLY=true nice -n 5 timeout "${HANDS_TIMEOUT:-900}" node --loader ts-node/esm scripts/minecraft-incident-lab-probe.ts ) > "$OUT/probe.log" 2>&1
CODE_STATUS=$?
log "probe exit $CODE_STATUS after $(( $(date +%s) - START )) s"
grep -a -E '^\[..:..:..\] (PASS|FAIL|ACT) |^INCIDENT_RESULT ' "$OUT/probe.log" | cut -c1-400
if ! grep -q '^INCIDENT_RESULT ' "$OUT/probe.log"; then log "no INCIDENT_RESULT: the probe did not finish; its last lines:"; tail -25 "$OUT/probe.log"; fi
STATUS=$CODE_STATUS

# what the server said while the probe ran: warnings and anything about the actor, without the operator's own setup commands
LOG=$DIR/logs/latest.log
grep -a -E 'WARN|ERROR|Exception|moved wrongly|moved too quickly|Can.t keep up|lost connection|Disconnect|kicked|MinebotTrial (was|fell|drowned|hit|burned|tried|died|starved|suffocated|blew)' "$LOG" \
  | grep -a -v 'issued server command' > "$OUT/server-notable.txt" 2>/dev/null
log "server notable lines: $(wc -l < "$OUT/server-notable.txt") (kept in $OUT/server-notable.txt)"
head -40 "$OUT/server-notable.txt"
exit "$STATUS"
