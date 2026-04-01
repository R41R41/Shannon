#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- OS detection ---
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "mingw"* ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    IS_WINDOWS=true
fi

# --- Session names ---
FRONTEND_SESSION="shannon-frontend-prod"
BACKEND_SESSION="shannon-backend-prod"

IS_DEV=false
if [ "$1" = "--dev" ]; then
    IS_DEV=true
    BACKEND_SESSION="$BACKEND_SESSION-dev"
    FRONTEND_SESSION="$FRONTEND_SESSION-dev"
    echo "Starting in dev mode..."
fi

# --- Kill existing sessions ---
if [ "$IS_WINDOWS" = true ]; then
    # 前回の全 Shannon プロセスを PID ファイルから確実に殺す
    PID_DIR="$SCRIPT_DIR/.pids"
    if [ -d "$PID_DIR" ]; then
        for pid_file in "$PID_DIR"/*.pid; do
            [ -f "$pid_file" ] || continue
            OLD_PID=$(cat "$pid_file")
            if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
                echo "Killing previous process (PID: $OLD_PID, file: $(basename $pid_file))"
                taskkill //F //PID "$OLD_PID" //T 2>/dev/null
            fi
            rm -f "$pid_file"
        done
    fi
    sleep 1
else
    tmux kill-session -t "$FRONTEND_SESSION" 2>/dev/null
    tmux kill-session -t "$BACKEND_SESSION" 2>/dev/null
fi

# --- Start backend ---
cd "$SCRIPT_DIR/backend"
if [ "$IS_DEV" = true ]; then
    ./start.sh --dev
else
    ./start.sh
fi

# --- Start frontend ---
cd "$SCRIPT_DIR/frontend"
if [ "$IS_DEV" = true ]; then
    ./start.sh --dev
else
    ./start.sh
fi

# --- Status ---
echo ""
if [ "$IS_WINDOWS" = true ]; then
    echo "Active sessions (mintty windows):"
    echo "  backend:  $BACKEND_SESSION"
    echo "  frontend: $FRONTEND_SESSION"
    PID_DIR="$SCRIPT_DIR/.pids"
    for session in "$BACKEND_SESSION" "$FRONTEND_SESSION"; do
        pid_file="$PID_DIR/${session}.pid"
        [ -f "$pid_file" ] && echo "  $session PID: $(cat "$pid_file")"
    done
else
    echo "Active tmux sessions:"
    tmux list-sessions
    echo ""
    echo "To attach to a session:"
    echo "  frontend: tmux attach -t $FRONTEND_SESSION"
    echo "  backend:  tmux attach -t $BACKEND_SESSION"
fi
