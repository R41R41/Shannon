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
    mintty --hold error --title "$FRONTEND_SESSION" /bin/bash -l "$LAUNCH_SCRIPT" &
    MINTTY_PID=$!
    echo "$MINTTY_PID" > "$PID_FILE"
    echo "Frontend PID: $MINTTY_PID (saved to $PID_FILE)"
else
    if [ "$IS_DEV" = true ]; then
        tmux new-session -d -s "$FRONTEND_SESSION" "cd $SCRIPT_DIR && PORT=$PORT npm run dev:dev"
    else
        tmux new-session -d -s "$FRONTEND_SESSION" "cd $SCRIPT_DIR && PORT=$PORT npm run dev"
    fi
fi

echo "Frontend started in session: $FRONTEND_SESSION"

echo ""
if [ "$IS_WINDOWS" = true ]; then
    echo "Frontend running in terminal window: $FRONTEND_SESSION"
    [ -f "$PID_FILE" ] && echo "  PID: $(cat "$PID_FILE")"
else
    echo "Active tmux sessions:"
    tmux list-sessions
    echo ""
    echo "To attach to the session:"
    echo "  tmux attach -t $FRONTEND_SESSION"
fi
