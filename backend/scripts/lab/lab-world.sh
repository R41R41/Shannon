#!/bin/bash
# lab-world.sh start <key> [port]   |   stop <port>   |   list
#
# An isolated NATURAL lab server (normal difficulty, view distance 10: the production values) started on a staged world, so a probe that
# needs the Nether fortress with its blaze spawners, a warped forest, the stronghold's portal room, or just a village and a ruined portal
# at known places does not wait for the generator. The worlds are made by scripts/minecraft-trials/seedscan.py (`deep`, then
# `publish --key K --labworld`) into ~/.cache/minebot-lab/worlds/<key>/ with the places in ~/.cache/minebot-lab/worlds/<key>.sites.json.
# What is generated in each: 169 chunks around spawn, 169 around the village, ~100 around the ruined portal, 324 around the nearest
# stronghold (all of it: 12 frames, the room), and in the Nether the arrival area, the whole nearest fortress and the nearest warped forest.
# Everything else is the generator's, on demand. The staged copy is never written: each start copies it into a new progressive-lab-* directory.
#
#   start c2 25592            -> prints the lab's JSON (directory, session, port ...) and the key places; the server is up when it returns
#   stop 25592                -> stops that server and removes its directory
#   list                      -> the staged worlds and the labs that are running
#
# Run it under the slot: lab-slot.sh -- lab-world.sh start c2  (the PC's WSL lab: LAB_SLOT_COUNT=3 LAB_PORT_FROM=25590). The probes of this
# directory take the port and `MINECRAFT_*_WORLD_DIRECTORY=<directory>` from the JSON.
set -u
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
BACKEND=$(cd "$(dirname "$0")/../.." && pwd)
DEV=$HOME/Shannon-dev
NODEBIN=$HOME/.nvm/versions/node/v$(cat "$DEV/.nvmrc")/bin
SOCKET=minebot-lab
cmd=${1:-list}

case "$cmd" in
  list)
    ls -d "$SCRATCH"/worlds/*/ 2>/dev/null | sed 's|/$||'
    tmux -L $SOCKET ls 2>/dev/null
    ;;
  start)
    KEY=${2:?key}; [[ "$KEY" =~ ^[A-Za-z0-9]{1,20}$ ]] || { echo "key: letters and digits only" >&2; exit 2; }
    WORLD=$SCRATCH/worlds/$KEY
    [ -f "$WORLD/level.dat" ] && [ -d "$WORLD/region" ] || { echo "no staged world $WORLD (seedscan.py publish --key $KEY --labworld)" >&2; exit 1; }
    PORT=${3:-}
    if [ -z "$PORT" ]; then for p in $(seq "${LAB_PORT_FROM:-25570}" 25599); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done; fi
    [ -n "$PORT" ] && [ "$PORT" -ge 25570 ] && [ "$PORT" -le 25599 ] || { echo "no usable port in 25570-25599" >&2; exit 1; }
    INFO=$(cd "$BACKEND" && env -i HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" MINECRAFT_LAB_PORT=$PORT MINECRAFT_LAB_TERRAIN=natural MINECRAFT_LAB_UNASSISTED=true \
      MINECRAFT_LAB_VIEW_DISTANCE=${LAB_VIEW_DISTANCE:-10} MINECRAFT_LAB_WORLD_FROM="$WORLD" nice -n 10 node scripts/minecraft-isolated-lab.mjs)
    DIR=$(echo "$INFO" | grep -o '"directory":"[^"]*"' | head -1 | cut -d'"' -f4)
    [ -n "$DIR" ] || { echo "the lab did not start: $INFO" >&2; exit 1; }
    for _ in $(seq 1 150); do grep -q 'Done (' "$DIR/logs/latest.log" 2>/dev/null && break; sleep 2; done
    grep -q 'Done (' "$DIR/logs/latest.log" || { echo "the server did not come up; see $DIR/logs/latest.log" >&2; exit 1; }
    echo "$DIR" > "$SCRATCH/lab-world-$PORT.dir"       # stop reads it: the tmux pane's path is not reliable
    echo "$INFO"
    [ -f "$WORLD.sites.json" ] && { echo "places ($WORLD.sites.json):"; python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); d['strongholdFrames']='%d frames (x,y,z,facing)' % len(d.get('strongholdFrames',[])); print(json.dumps(d, ensure_ascii=False))" "$WORLD.sites.json"; }
    ;;
  stop)
    PORT=${2:?port}
    SESSION=codex-progressive-lab-$PORT
    [ "$PORT" = 25577 ] && SESSION=codex-progressive-lab
    DIR=$(cat "$SCRATCH/lab-world-$PORT.dir" 2>/dev/null)
    tmux -L $SOCKET send-keys -t "$SESSION" "stop" Enter 2>/dev/null
    for _ in $(seq 1 45); do tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null || break; sleep 2; done
    tmux -L $SOCKET has-session -t "$SESSION" 2>/dev/null && tmux -L $SOCKET kill-session -t "$SESSION"
    if [ -n "$DIR" ] && [[ "$DIR" =~ ^$HOME/minecraft/progressive-lab-[A-Za-z0-9]+$ ]] && [ -d "$DIR" ]; then rm -rf "$DIR"; echo "removed $DIR"; fi
    rm -f "$SCRATCH/lab-world-$PORT.dir"
    ;;
  *) echo "usage: lab-world.sh start <key> [port] | stop <port> | list" >&2; exit 2 ;;
esac
