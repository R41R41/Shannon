#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check before touching tmux sessions or occupied ports.
bash "$SCRIPT_DIR/../scripts/start-mode-guard.sh" "$SCRIPT_DIR/.." "$@" || exit $?
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- OS detection ---
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "mingw"* ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    IS_WINDOWS=true
fi

# Windows: 既定は mintty 別ウィンドウ。VS Code / Cursor 統合ターミナルなどでは親ターミナルにログを出す。
should_use_mintty_windows() {
    [ "$IS_WINDOWS" != true ] && return 1
    [ -n "${SHANNON_USE_MINTTY:-}" ] && [ "$SHANNON_USE_MINTTY" != "0" ] && return 0
    [ -n "${SHANNON_NO_MINTTY:-}" ] && [ "$SHANNON_NO_MINTTY" != "0" ] && return 1
    local tp
    tp=$(echo "${TERM_PROGRAM:-}" | tr '[:upper:]' '[:lower:]')
    case "$tp" in
        vscode|visual\ studio\ code|cursor) return 1 ;;
    esac
    return 0
}

# Windows 統合ターミナル: Linux と同様に tmux セッションに載せる（ログを別タブで attach して閲覧）
windows_use_tmux_for_integrated() {
    [ "$IS_WINDOWS" = true ] || return 1
    should_use_mintty_windows && return 1
    [ -n "${SHANNON_NO_TMUX:-}" ] && [ "$SHANNON_NO_TMUX" != "0" ] && return 1
    command -v tmux >/dev/null 2>&1
}

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
    BACKEND_SESSION="shannon-backend-prod-dev"
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
    echo "Cleaning up previous backend..."
    tmux kill-session -t "$BACKEND_SESSION" 2>/dev/null
    # 1. PID ファイルの Windows PID でプロセスツリーを殺す
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
            echo "Killing previous backend process (Windows PID: $OLD_PID)..."
            taskkill //F //PID "$OLD_PID" //T 2>/dev/null
        fi
        rm -f "$PID_FILE"
    fi
    # shell pid も殺す
    SHELL_PID_FILE="$PID_DIR/${BACKEND_SESSION}-shell.pid"
    if [ -f "$SHELL_PID_FILE" ]; then
        OLD_PID=$(cat "$SHELL_PID_FILE")
        if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
            taskkill //F //PID "$OLD_PID" //T 2>/dev/null
        fi
        rm -f "$SHELL_PID_FILE"
    fi
    sleep 2
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
export TWITTER_DISABLED=\${TWITTER_DISABLED:-true}
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
        # preserveWatchOutput はコンパイルのたびに画面が積み上がり「ログが止まらない」ように見えやすいので付けない
        echo "npx tsc $TSC_NOCHECK --watch --skipLibCheck --pretty false &" >> "$LAUNCH_SCRIPT"
        echo "TSC_PID=\$!" >> "$LAUNCH_SCRIPT"
        echo "sleep 3" >> "$LAUNCH_SCRIPT"
        echo "npx nodemon -q --watch dist --ext js --delay 3 --signal SIGKILL --exec 'node $NODE_OPTS dist/server.js --dev' &" >> "$LAUNCH_SCRIPT"
        echo "NODEMON_PID=\$!" >> "$LAUNCH_SCRIPT"
        echo "wait" >> "$LAUNCH_SCRIPT"
    else
        echo "exec node $NODE_OPTS dist/server.js" >> "$LAUNCH_SCRIPT"
    fi
    chmod +x "$LAUNCH_SCRIPT"
    if should_use_mintty_windows; then
        BEFORE_PIDS=$(tasklist //FI "IMAGENAME eq mintty.exe" //FO CSV //NH 2>/dev/null | cut -d',' -f2 | tr -d '"' | tr -d ' ')
        mintty --hold error --title "$BACKEND_SESSION" /bin/bash -l "$LAUNCH_SCRIPT" &
        sleep 2
        AFTER_PIDS=$(tasklist //FI "IMAGENAME eq mintty.exe" //FO CSV //NH 2>/dev/null | cut -d',' -f2 | tr -d '"' | tr -d ' ')
        MINTTY_WIN_PID=""
        for pid in $AFTER_PIDS; do
            if ! echo "$BEFORE_PIDS" | grep -q "^${pid}$"; then
                MINTTY_WIN_PID="$pid"
                break
            fi
        done
        if [ -n "$MINTTY_WIN_PID" ]; then
            echo "$MINTTY_WIN_PID" > "$PID_FILE"
            echo "Backend mintty Windows PID: $MINTTY_WIN_PID"
        else
            echo "Warning: Could not detect backend mintty PID"
        fi
    elif windows_use_tmux_for_integrated; then
        if tmux new-session -d -s "$BACKEND_SESSION" -n "server" "bash -l \"$LAUNCH_SCRIPT\"" 2>/dev/null; then
            rm -f "$PID_FILE"
            echo "Backend tmux session: $BACKEND_SESSION"
            echo "  Attach (別ターミナルタブ推奨): tmux attach -t $BACKEND_SESSION"
        else
            echo "tmux での起動に失敗したため、このターミナルでバックグラウンド実行にフォールバックします。"
            /bin/bash -l "$LAUNCH_SCRIPT" &
            echo $! > "$PID_FILE"
            echo "Backend shell PID: $(cat "$PID_FILE")"
        fi
    else
        echo "Backend: running in this terminal (no mintty). tmux があればセッション分離されます (pacman -S tmux)。SHANNON_USE_MINTTY=1 で別ウィンドウ。"
        /bin/bash -l "$LAUNCH_SCRIPT" &
        echo $! > "$PID_FILE"
        echo "Backend shell PID: $(cat "$PID_FILE")"
    fi
else
    if [ "$IS_DEV" = true ]; then
        # Windows と同様 tsc --watch + nodemon（tsc-watch は onSuccess が連発しやすくログ・再起動がうるさい）
        LAUNCH_SCRIPT="$PID_DIR/${BACKEND_SESSION}-launch.sh"
        cat > "$LAUNCH_SCRIPT" << LAUNCH_EOF
#!/bin/bash
cd "$SCRIPT_DIR"
export PORT=$PORT
export MINEBOT_API_PORT=$MINEBOT_PORT
export TWITTER_DISABLED=\${TWITTER_DISABLED:-true}
export WS_OPENAI_PORT=${WS_PORTS[0]}
export WS_MONITORING_PORT=${WS_PORTS[1]}
export WS_STATUS_PORT=${WS_PORTS[2]}
export WS_SCHEDULE_PORT=${WS_PORTS[3]}
export WS_PLANNING_PORT=${WS_PORTS[4]}
export WS_EMOTION_PORT=${WS_PORTS[5]}
export WS_SKILL_PORT=${WS_PORTS[6]}
export WS_AUTH_PORT=${WS_PORTS[7]}
export NODE_OPTIONS="--max-old-space-size=12288"
npx tsc $TSC_NOCHECK --watch --skipLibCheck --pretty false &
TSC_PID=\$!
sleep 3
npx nodemon -q --watch dist --ext js --delay 3 --signal SIGKILL --exec "node $NODE_OPTS dist/server.js --dev" &
wait
LAUNCH_EOF
        chmod +x "$LAUNCH_SCRIPT"
        tmux new-session -d -s "$BACKEND_SESSION" -n "server" "exec bash -l \"$LAUNCH_SCRIPT\""
    else
        tmux new-session -d -s "$BACKEND_SESSION" \
            "cd $SCRIPT_DIR && PORT=$PORT MINEBOT_API_PORT=$MINEBOT_PORT TWITTER_DISABLED=\${TWITTER_DISABLED:-true} WS_OPENAI_PORT=${WS_PORTS[0]} WS_MONITORING_PORT=${WS_PORTS[1]} WS_STATUS_PORT=${WS_PORTS[2]} WS_SCHEDULE_PORT=${WS_PORTS[3]} WS_PLANNING_PORT=${WS_PORTS[4]} WS_EMOTION_PORT=${WS_PORTS[5]} WS_SKILL_PORT=${WS_PORTS[6]} WS_AUTH_PORT=${WS_PORTS[7]} node $NODE_OPTS dist/server.js"
    fi
fi

echo "Backend started in session: $BACKEND_SESSION"
echo "  dev mode: tsc --watch + nodemon (dist 変更でサーバー再起動)"
echo "  prod mode: Node.js server only"

echo ""
if [ "$IS_WINDOWS" = true ]; then
    if should_use_mintty_windows; then
        echo "Backend running in terminal window: $BACKEND_SESSION"
    elif command -v tmux >/dev/null 2>&1 && tmux has-session -t "$BACKEND_SESSION" 2>/dev/null; then
        echo "Backend running in tmux session: $BACKEND_SESSION"
        tmux list-sessions 2>/dev/null | grep -F "$BACKEND_SESSION" || true
    else
        echo "Backend running in current terminal (background): $BACKEND_SESSION"
    fi
    [ -f "$PID_FILE" ] && echo "  PID: $(cat "$PID_FILE")"
else
    echo "Active tmux sessions:"
    tmux list-sessions
    echo ""
    echo "To attach to the session:"
    echo "  tmux attach -t $BACKEND_SESSION"
fi
