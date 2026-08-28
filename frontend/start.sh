#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check before touching tmux sessions or occupied ports.
bash "$SCRIPT_DIR/../scripts/start-mode-guard.sh" "$SCRIPT_DIR/.." "$@" || exit $?
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# VM dev pins its own runtime; the global Node and production processes are untouched.
DEV_NODE_BIN=""
if [ "$(basename "$ROOT_DIR")" = "Shannon-dev" ]; then
    DEV_NODE_BIN="$HOME/.nvm/versions/node/v$(cat "$ROOT_DIR/.nvmrc")/bin"
    [ -x "$DEV_NODE_BIN/node" ] || { echo "Pinned development Node is missing" >&2; exit 4; }
    export PATH="$DEV_NODE_BIN:$PATH"
fi


# --- OS detection ---
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "mingw"* ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    IS_WINDOWS=true
fi

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

windows_use_tmux_for_integrated() {
    [ "$IS_WINDOWS" = true ] || return 1
    should_use_mintty_windows && return 1
    [ -n "${SHANNON_NO_TMUX:-}" ] && [ "$SHANNON_NO_TMUX" != "0" ] && return 1
    command -v tmux >/dev/null 2>&1
}

# --- Configuration ---
IS_DEV=false
PORT=3001
FRONTEND_SESSION="shannon-frontend-prod"

if [ "$1" = "--dev" ]; then
    IS_DEV=true
    PORT=13001
    FRONTEND_SESSION="shannon-frontend-prod-dev"
    echo "Starting frontend in dev mode on port $PORT..."
else
    echo "Starting frontend on port $PORT..."
fi

# --- Session / PID management ---
PID_DIR="$ROOT_DIR/.pids"
mkdir -p "$PID_DIR"
PID_FILE="$PID_DIR/${FRONTEND_SESSION}.pid"

if [ "$IS_WINDOWS" = true ]; then
    tmux kill-session -t "$FRONTEND_SESSION" 2>/dev/null
    taskkill //F //FI "WINDOWTITLE eq $FRONTEND_SESSION" 2>/dev/null
    # PID ファイルから前回のプロセスツリーを殺す
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
            echo "Killing previous frontend (PID: $OLD_PID)..."
            taskkill //F //PID "$OLD_PID" //T 2>/dev/null
        fi
        rm -f "$PID_FILE"
    fi
else
    tmux kill-session -t "$FRONTEND_SESSION" 2>/dev/null
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

echo "Cleaning up port ${PORT}..."
kill_port "$PORT"

sleep 2

# --- Launch frontend process ---
if [ "$IS_WINDOWS" = true ]; then
    LAUNCH_SCRIPT="$PID_DIR/${FRONTEND_SESSION}-launch.sh"
    if [ "$IS_DEV" = true ]; then
        cat > "$LAUNCH_SCRIPT" << LAUNCH_EOF
#!/bin/bash
cd "$SCRIPT_DIR"
export PORT=$PORT
export npm_config_script_shell=/bin/bash
exec npm run dev:dev
LAUNCH_EOF
    else
        cat > "$LAUNCH_SCRIPT" << LAUNCH_EOF
#!/bin/bash
cd "$SCRIPT_DIR"
export PORT=$PORT
export npm_config_script_shell=/bin/bash
exec npm run dev
LAUNCH_EOF
    fi
    chmod +x "$LAUNCH_SCRIPT"
    if should_use_mintty_windows; then
        BEFORE_PIDS=$(tasklist //FI "IMAGENAME eq mintty.exe" //FO CSV //NH 2>/dev/null | cut -d',' -f2 | tr -d '"' | tr -d ' ')
        mintty --hold error --title "$FRONTEND_SESSION" /bin/bash -l "$LAUNCH_SCRIPT" &
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
            echo "Frontend mintty Windows PID: $MINTTY_WIN_PID"
        fi
    elif windows_use_tmux_for_integrated; then
        if tmux new-session -d -s "$FRONTEND_SESSION" -n "vite" "bash -l \"$LAUNCH_SCRIPT\"" 2>/dev/null; then
            rm -f "$PID_FILE"
            echo "Frontend tmux session: $FRONTEND_SESSION"
            echo "  Attach (別ターミナルタブ推奨): tmux attach -t $FRONTEND_SESSION"
        else
            echo "tmux での起動に失敗したため、このターミナルでバックグラウンド実行にフォールバックします。"
            /bin/bash -l "$LAUNCH_SCRIPT" &
            echo $! > "$PID_FILE"
            echo "Frontend shell PID: $(cat "$PID_FILE")"
        fi
    else
        echo "Frontend: running in this terminal (no mintty). tmux があればセッション分離されます (pacman -S tmux)。SHANNON_USE_MINTTY=1 で別ウィンドウ。"
        /bin/bash -l "$LAUNCH_SCRIPT" &
        echo $! > "$PID_FILE"
        echo "Frontend shell PID: $(cat "$PID_FILE")"
    fi
else
    if [ "$IS_DEV" = true ]; then
        tmux new-session -d -s "$FRONTEND_SESSION" "cd $SCRIPT_DIR && PATH=$DEV_NODE_BIN:\$PATH PORT=$PORT npm run dev:dev"
    else
        tmux new-session -d -s "$FRONTEND_SESSION" "cd $SCRIPT_DIR && PORT=$PORT npm run dev"
    fi
fi

echo "Frontend started in session: $FRONTEND_SESSION"

echo ""
if [ "$IS_WINDOWS" = true ]; then
    if should_use_mintty_windows; then
        echo "Frontend running in terminal window: $FRONTEND_SESSION"
    elif command -v tmux >/dev/null 2>&1 && tmux has-session -t "$FRONTEND_SESSION" 2>/dev/null; then
        echo "Frontend running in tmux session: $FRONTEND_SESSION"
        tmux list-sessions 2>/dev/null | grep -F "$FRONTEND_SESSION" || true
    else
        echo "Frontend running in current terminal (background): $FRONTEND_SESSION"
    fi
    [ -f "$PID_FILE" ] && echo "  PID: $(cat "$PID_FILE")"
else
    echo "Active tmux sessions:"
    tmux list-sessions
    echo ""
    echo "To attach to the session:"
    echo "  tmux attach -t $FRONTEND_SESSION"
fi
