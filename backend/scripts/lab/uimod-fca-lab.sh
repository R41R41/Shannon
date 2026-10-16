#!/usr/bin/env bash
# A throwaway lab for ShannonUIMod v2 + the common FCA body, on the VM, touching nothing that already runs there.
#   uimod-fca-lab.sh setup <source-tarball>   build the lab under $LAB (default ~/uimod-fca-lab) from a `git archive` tarball
#   uimod-fca-lab.sh start | status | stop | clean | task "<goal>" [steps] | turns
# Everything lives under $LAB and in its own tmux server (-L uimod-fca-lab). All ports are loopback only: the world
# 25570, the mod's push server 38081, the body's HTTP server 38092, the fake mind 34329. Nothing is added to the VM's
# firewall; a person joins through `ssh -L 25570:127.0.0.1:25570 <vm>`.
set -euo pipefail
LAB="${LAB:-$HOME/uimod-fca-lab}"
T="tmux -L uimod-fca-lab"
GAME_PORT=25570; MOD_PORT=38081; BODY_PORT=38092; MIND_PORT=34329
SERVER_NAME=uimod-lab
FABRIC_SRC="$HOME/minecraft/1.21.11-fabric-test"          # read only: launcher, libraries, versions
JARS_SRC="$HOME/Shannon-dev/backend/saves/minecraft/uimod-test" # read only: fabric-api and shannonuimod 2.0.0
NODE_SRC="$HOME/Shannon-dev/node_modules"                 # read only: hard-linked into the lab

# The same Node the production bot runs on (v22); the shell's default on the VM is older.
[ -d "$HOME/.nvm/versions/node/v22.21.1/bin" ] && export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }

setup() {
  local tarball="${1:?source tarball (git archive of the branch)}"
  need java; need tmux; need node
  [ -d "$LAB" ] && { echo "$LAB exists; run clean first" >&2; exit 1; }
  mkdir -p "$LAB/server/mods" "$LAB/server/config" "$LAB/mind" "$LAB/logs" "$LAB/Shannon"
  tar -xzf "$tarball" -C "$LAB/Shannon"
  # Fabric server: copies of the launcher and libraries only; the world, mods and config are the lab's own.
  cp -r "$FABRIC_SRC/fabric-server-launch.jar" "$FABRIC_SRC/libraries" "$FABRIC_SRC/versions" "$LAB/server/"
  local fabric_api uimod
  fabric_api=$(ls "$JARS_SRC"/fabric-api-*.jar | head -1); uimod=$(ls "$JARS_SRC"/shannonuimod-2.0.0.jar | head -1)
  cp "$fabric_api" "$uimod" "$LAB/server/mods/"
  echo "eula=true" > "$LAB/server/eula.txt"
  cat > "$LAB/server/server.properties" <<EOF
server-ip=127.0.0.1
server-port=$GAME_PORT
online-mode=false
enforce-secure-profile=false
white-list=false
level-name=world
level-type=minecraft\:flat
gamemode=creative
force-gamemode=true
difficulty=peaceful
spawn-monsters=false
view-distance=6
simulation-distance=6
motd=ShannonUIMod FCA lab
max-players=4
EOF
  local token; token=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "$token" > "$LAB/mod.token"; chmod 600 "$LAB/mod.token"
  cat > "$LAB/server/config/shannonuimod.json" <<EOF
{ "backendHost": "127.0.0.1", "backendPort": $BODY_PORT, "backendToken": "$token",
  "httpServerPort": $MOD_PORT, "httpServerBindAddress": "127.0.0.1", "botPlayerName": "I_am_Shannon" }
EOF
  chmod 600 "$LAB/server/config/shannonuimod.json"
  # node_modules: hard links of the dev checkout's (no extra space, the originals are never written); the workspace
  # package @shannon/common points at the lab's own copy.
  cp -al "$NODE_SRC" "$LAB/Shannon/node_modules"
  rm -rf "$LAB/Shannon/node_modules/@shannon/common"
  ln -s "$LAB/Shannon/common" "$LAB/Shannon/node_modules/@shannon/common"
  (cd "$LAB/Shannon/common" && "$LAB/Shannon/node_modules/.bin/tsc" -b) >"$LAB/logs/build-common.log" 2>&1 || { tail -20 "$LAB/logs/build-common.log"; exit 1; }
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$LAB/mind/mind.token"; chmod 600 "$LAB/mind/mind.token"
  cat > "$LAB/body.env" <<EOF
# dummy values only: the lab never calls a model, a database or Discord
OPENAI_API_KEY=lab-not-used
MONGODB_URI=mongodb://127.0.0.1:1/lab-not-used
MINECRAFT_BOT_USER_NAME=I_am_Shannon
MINEBOT_COMMON_FCA=on
MINEBOT_LAB_OFFLINE_AUTH=on
MINEBOT_API_PORT=$BODY_PORT
MINEBOT_API_TOKEN=$token
MINEBOT_COMPANION_BODY_URL=http://127.0.0.1:$MIND_PORT
MINEBOT_COMPANION_BODY_TOKEN_FILE=$LAB/mind/mind.token
MINEBOT_COMPANION_SERVER_ID=$SERVER_NAME
MINEBOT_COMPANION_SERVER_NAME=$SERVER_NAME
MINEBOT_COMPANION_SERVER_PORT=$GAME_PORT
MINEBOT_COMPANION_SERVER_VERSION=1.21.11
MINEBOT_COMPANION_UI_MOD_BASE_URL=http://127.0.0.1:$MOD_PORT
MINECRAFT_HOST=127.0.0.1
EOF
  chmod 600 "$LAB/body.env"
  echo "lab ready in $LAB; next: $0 start"
}

start() {
  [ -d "$LAB" ] || { echo "run setup first" >&2; exit 1; }
  $T has-session -t lab 2>/dev/null && { echo "already running"; return; }
  $T new-session -d -s lab -n server -c "$LAB/server" "java -Xms512M -Xmx1G -jar fabric-server-launch.jar nogui 2>&1 | tee $LAB/logs/server.log"
  $T new-window -d -t lab -n mind -c "$LAB/mind" "node $LAB/Shannon/backend/scripts/lab/fake-fca-mind.mjs $MIND_PORT $LAB/mind/mind.token 2>&1 | tee $LAB/logs/mind.log"
  echo "waiting for the world..."
  for _ in $(seq 1 90); do grep -q 'Done (' "$LAB/logs/server.log" 2>/dev/null && break; sleep 2; done
  grep -q 'Done (' "$LAB/logs/server.log" || { echo "server did not start; see $LAB/logs/server.log" >&2; exit 1; }
  $T new-window -d -t lab -n body -c "$LAB/Shannon/backend" \
    "set -a; . $LAB/body.env; set +a; TS_NODE_TRANSPILE_ONLY=true node --max-old-space-size=2048 --loader ts-node/esm scripts/lab/uimod-fca-lab.ts 2>&1 | tee $LAB/logs/body.log"
  echo "started. join through: ssh -L $GAME_PORT:127.0.0.1:$GAME_PORT <vm>   then connect to localhost:$GAME_PORT"
}

status() {
  $T ls 2>&1 | head -3
  ss -ltnH | awk '{print $4}' | grep -E ":($GAME_PORT|$MOD_PORT|$BODY_PORT|$MIND_PORT)\$" || echo "(no lab port listening)"
  [ -f "$LAB/logs/body.log" ] && grep -E 'LAB_BOT|COMPANION|Mod|UI Mod|ERROR|SkillAgent' "$LAB/logs/body.log" | tail -8 || true
  curl -s "http://127.0.0.1:$MIND_PORT/admin/state" 2>/dev/null | head -c 900; echo
}
stop() { $T kill-server 2>/dev/null && echo stopped || echo "not running"; }
clean() {
  # Only a folder named for this lab is ever removed.
  case "$LAB" in */uimod-fca-lab|*/uimod-fca-lab-*) ;; *) echo "refusing to remove $LAB" >&2; exit 1;; esac
  stop; [ -d "$LAB" ] && rm -rf "$LAB" && echo "removed $LAB" || true
}
task() { curl -s -X POST "http://127.0.0.1:$MIND_PORT/admin/task" -d "{\"goal\":\"${1:-検証用のタスク}\",\"steps\":${2:-8}}"; echo; }
turns() { curl -s "http://127.0.0.1:$MIND_PORT/admin/state"; echo; }

cmd="${1:-}"; shift || true
case "$cmd" in setup|start|status|stop|clean|task|turns) "$cmd" "$@";; *) sed -n '2,8p' "$0"; exit 2;; esac
