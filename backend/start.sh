#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- OS detection ---
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "mingw"* ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    IS_WINDOWS=true
fi

# --- Configuration ---
IS_DEV=false
PORT=5001
WS_PORTS=(5021 5022 5023 5024 5025 5026 5027 5028)  # OpenAI, Monitoring, Status, Schedule, Planning, Emotion, Skill, Auth
BACKEND_SESSION="shannon-backend-prod"
MINEBOT_PORT=8092

if [ "$1" = "--dev" ]; then
    IS_DEV=true
    PORT=15000
    WS_PORTS=(15010 15011 15013 15018 15019 15020 15016 15017)
    MINEBOT_PORT=18092
    BACKEND_SESSION="shannon-backend-dev"
    echo "Starting in dev mode..."
    echo "Starting backend in dev mode on port $PORT (WS: ${WS_PORTS[*]}, Minebot: $MINEBOT_PORT)..."
else
    echo "Starting backend on port $PORT (WS: ${WS_PORTS[*]}, Minebot: $MINEBOT_PORT)..."
fi

# --- Session / PID management ---
PID_DIR="$ROOT_DIR/.pids"
mkdir -p "$PID_DIR"
PID_FILE="$PID_DIR/${BACKEND_SESSION}.pid"

if [ "$IS_WINDOWS" = true ]; then
    echo "Cleaning up previous sessions..."
    # Shannon 関連の mintty ウィンドウを全て殺す (backend + frontend)
    taskkill //F //FI "WINDOWTITLE eq shannon-*" 2>/dev/null
    taskkill //F //FI "WINDOWTITLE eq $BACKEND_SESSION" 2>/dev/null

    # PID ファイルから前回のプロセスツリーを確実に殺す
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
            echo "Killing previous backend process tree (PID: $OLD_PID)..."
            # プロセスツリーごと殺す（子プロセス = tsc --watch, nodemon 等）
            taskkill //F //PID "$OLD_PID" //T 2>/dev/null
        fi
        rm -f "$PID_FILE"
    fi

    # Shannon が使うポートを占有している node プロセスを全て殺す
    for check_port in "$PORT" "$MINEBOT_PORT" "${WS_PORTS[@]}"; do
        port_pids=$(netstat -ano 2>/dev/null | grep ":${check_port} " | grep "LISTENING" | awk '{print $5}' | sort -u)
        for pid in $port_pids; do
            if [ -n "$pid" ] && [ "$pid" != "0" ]; then
                echo "Killing process on port ${check_port} (PID: ${pid})"
                taskkill //F //PID "$pid" //T 2>/dev/null
            fi
        done
    done
    sleep 2

    # 念のため Shannon 関連の残留 node プロセスを PID ファイル群から掃除
    for pid_file in "$PID_DIR"/*.pid; do
        [ -f "$pid_file" ] || continue
        OLD_PID=$(cat "$pid_file")
        if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
            taskkill //F //PID "$OLD_PID" //T 2>/dev/null
        fi
        rm -f "$pid_file"
    done
else
    tmux kill-session -t "$BACKEND_SESSION" 2>/dev/null
fi

# --- Port cleanup (cross-platform) ---
kill_port() {
    local port=$1
    if [ "$IS_WINDOWS" = true ]; then
        local pids
        pids=$(netstat -ano 2>/dev/null | grep ":${port} " | grep "LISTENING" | awk '{print $5}' | sort -u)
        for pid in $pids; do
            if [ -n "$pid" ] && [ "$pid" != "0" ]; then
                echo "Killing process using port ${port} (PID: ${pid})"
                taskkill //F //PID "$pid" 2>/dev/null
            fi
        done
    else
        local pid
        pid=$(lsof -t -i:"${port}")
        if [ -n "$pid" ]; then
            echo "Killing process using port ${port} (PID: ${pid})"
            kill -9 "$pid"
        fi
    fi
}

echo "Cleaning up ports..."
kill_port "$PORT"
kill_port "$MINEBOT_PORT"
for ws_port in "${WS_PORTS[@]}"; do
    kill_port "$ws_port"
done

sleep 2

# --- Detect tsc --noCheck support (TS >= 5.5) ---
TSC_NOCHECK=""
TSC_VER=$(cd "$SCRIPT_DIR" && npx tsc --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
TSC_MAJOR=${TSC_VER%%.*}
TSC_MINOR=${TSC_VER##*.}
if [ "${TSC_MAJOR:-0}" -ge 6 ] 2>/dev/null || \
   { [ "${TSC_MAJOR:-0}" -eq 5 ] && [ "${TSC_MINOR:-0}" -ge 5 ]; } 2>/dev/null; then
    TSC_NOCHECK="--noCheck"
fi

# --- Build common + backend ---
echo "Building common..."
cd "$ROOT_DIR" && npm run build -w common 2>&1 | tail -3
echo "Building backend..."
cd "$SCRIPT_DIR" && NODE_OPTIONS="--max-old-space-size=12288" npx tsc $TSC_NOCHECK --skipLibCheck 2>&1 | tail -5

# --- Node flags ---
NODE_OPTS="--unhandled-rejections=warn --experimental-specifier-resolution=node --es-module-specifier-resolution=node"

# --- Launch backend process ---
if [ "$IS_WINDOWS" = true ]; then
    LAUNCH_SCRIPT="$PID_DIR/${BACKEND_SESSION}-launch.sh"
    cat > "$LAUNCH_SCRIPT" << LAUNCH_EOF
#!/bin/bash
cd "$SCRIPT_DIR"
export npm_config_script_shell=/bin/bash
export PORT=$PORT
export MINEBOT_API_PORT=$MINEBOT_PORT
export WS_OPENAI_PORT=${WS_PORTS[0]}
export WS_MONITORING_PORT=${WS_PORTS[1]}
export WS_STATUS_PORT=${WS_PORTS[2]}
export WS_SCHEDULE_PORT=${WS_PORTS[3]}
export WS_PLANNING_PORT=${WS_PORTS[4]}
export WS_EMOTION_PORT=${WS_PORTS[5]}
export WS_SKILL_PORT=${WS_PORTS[6]}
export WS_AUTH_PORT=${WS_PORTS[7]}
LAUNCH_EOF
    if [ "$IS_DEV" = true ]; then
        # tsc-watch は OOM で落ちるため、tsc --watch + nodemon に分離
        # tsc --watch: ソース変更 → dist/ 自動更新
        # nodemon: dist/ 変更 → サーバー自動再起動
        echo "export NODE_OPTIONS=\"--max-old-space-size=12288\"" >> "$LAUNCH_SCRIPT"
        echo "# PID 記録 + 終了時に全子プロセスを確実に殺す" >> "$LAUNCH_SCRIPT"
        echo "echo \$\$ > \"$PID_DIR/${BACKEND_SESSION}-shell.pid\"" >> "$LAUNCH_SCRIPT"
        echo "cleanup() { kill \$TSC_PID 2>/dev/null; kill \$NODEMON_PID 2>/dev/null; rm -f \"$PID_DIR/${BACKEND_SESSION}-shell.pid\"; }" >> "$LAUNCH_SCRIPT"
        echo "trap cleanup EXIT INT TERM" >> "$LAUNCH_SCRIPT"
        echo "npx tsc --watch --skipLibCheck --preserveWatchOutput &" >> "$LAUNCH_SCRIPT"
        echo "TSC_PID=\$!" >> "$LAUNCH_SCRIPT"
        echo "sleep 3" >> "$LAUNCH_SCRIPT"
        echo "npx nodemon --watch dist --ext js --delay 3 --signal SIGKILL --exec 'node $NODE_OPTS dist/server.js --dev' &" >> "$LAUNCH_SCRIPT"
        echo "NODEMON_PID=\$!" >> "$LAUNCH_SCRIPT"
        echo "wait" >> "$LAUNCH_SCRIPT"
    else
        echo "exec node $NODE_OPTS dist/server.js" >> "$LAUNCH_SCRIPT"
    fi
    chmod +x "$LAUNCH_SCRIPT"
    mintty --hold error --title "$BACKEND_SESSION" /bin/bash -l "$LAUNCH_SCRIPT" &
    MINTTY_PID=$!
    echo "$MINTTY_PID" > "$PID_FILE"
    echo "Backend PID: $MINTTY_PID (saved to $PID_FILE)"
else
    if [ "$IS_DEV" = true ]; then
        tmux new-session -d -s "$BACKEND_SESSION" -n "server" \
            "cd $SCRIPT_DIR && PORT=$PORT MINEBOT_API_PORT=$MINEBOT_PORT WS_OPENAI_PORT=${WS_PORTS[0]} WS_MONITORING_PORT=${WS_PORTS[1]} WS_STATUS_PORT=${WS_PORTS[2]} WS_SCHEDULE_PORT=${WS_PORTS[3]} WS_PLANNING_PORT=${WS_PORTS[4]} WS_EMOTION_PORT=${WS_PORTS[5]} WS_SKILL_PORT=${WS_PORTS[6]} WS_AUTH_PORT=${WS_PORTS[7]} exec npx tsc-watch --onSuccess 'node $NODE_OPTS dist/server.js --dev'"
    else
        tmux new-session -d -s "$BACKEND_SESSION" \
            "cd $SCRIPT_DIR && PORT=$PORT MINEBOT_API_PORT=$MINEBOT_PORT WS_OPENAI_PORT=${WS_PORTS[0]} WS_MONITORING_PORT=${WS_PORTS[1]} WS_STATUS_PORT=${WS_PORTS[2]} WS_SCHEDULE_PORT=${WS_PORTS[3]} WS_PLANNING_PORT=${WS_PORTS[4]} WS_EMOTION_PORT=${WS_PORTS[5]} WS_SKILL_PORT=${WS_PORTS[6]} WS_AUTH_PORT=${WS_PORTS[7]} node $NODE_OPTS dist/server.js"
    fi
fi

echo "Backend started in session: $BACKEND_SESSION"
echo "  dev mode: tsc-watch with auto-restart on changes"
echo "  prod mode: Node.js server only"

echo ""
if [ "$IS_WINDOWS" = true ]; then
    echo "Backend running in terminal window: $BACKEND_SESSION"
    [ -f "$PID_FILE" ] && echo "  PID: $(cat "$PID_FILE")"
else
    echo "Active tmux sessions:"
    tmux list-sessions
    echo ""
    echo "To attach to the session:"
    echo "  tmux attach -t $BACKEND_SESSION"
fi
