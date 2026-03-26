#!/bin/bash

# スクリプトのディレクトリを動的に取得（どの環境でも正しく動作する）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# テストモードフラグをチェック
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

# 既存のセッションを確認・終了
tmux kill-session -t $BACKEND_SESSION 2>/dev/null

# 使用中のポートをチェックして解放
kill_port() {
    local port=$1
    local pid=$(lsof -t -i:${port})
    if [ ! -z "$pid" ]; then
        echo "Killing process using port ${port} (PID: ${pid})"
        kill -9 $pid
    fi
}

# 使用するポートをすべて解放
echo "Cleaning up ports..."
kill_port $PORT
kill_port $MINEBOT_PORT
for ws_port in "${WS_PORTS[@]}"; do
    kill_port $ws_port
done

# 少し待機して、プロセスが確実に終了するのを待つ
sleep 2

# バックエンドを起動
if [ "$IS_DEV" = true ]; then
    # 事前にビルド（common → backend）
    echo "Building common..."
    cd "$SCRIPT_DIR/.." && npm run build -w common 2>&1 | tail -3
    echo "Building backend..."
    cd "$SCRIPT_DIR" && NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck 2>&1 | tail -5
    
    # tmuxでセッションを作成（tsc-watchでコンパイル＋サーバー自動再起動）
    tmux new-session -d -s $BACKEND_SESSION -n "server" "cd $SCRIPT_DIR && PORT=$PORT MINEBOT_API_PORT=$MINEBOT_PORT WS_OPENAI_PORT=${WS_PORTS[0]} WS_MONITORING_PORT=${WS_PORTS[1]} WS_STATUS_PORT=${WS_PORTS[2]} WS_SCHEDULE_PORT=${WS_PORTS[3]} WS_PLANNING_PORT=${WS_PORTS[4]} WS_EMOTION_PORT=${WS_PORTS[5]} WS_SKILL_PORT=${WS_PORTS[6]} WS_AUTH_PORT=${WS_PORTS[7]} exec npx tsc-watch --onSuccess 'node --unhandled-rejections=warn --experimental-specifier-resolution=node --es-module-specifier-resolution=node dist/server.js --dev'"
else
    # 事前にビルド（common → backend）
    echo "Building common..."
    cd "$SCRIPT_DIR/.." && npm run build -w common 2>&1 | tail -3
    echo "Building backend..."
    cd "$SCRIPT_DIR" && NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck 2>&1 | tail -5
    
    # tmuxでセッションを作成（ビルド済みJSをnodeで直接起動）
    tmux new-session -d -s $BACKEND_SESSION "cd $SCRIPT_DIR && PORT=$PORT MINEBOT_API_PORT=$MINEBOT_PORT WS_OPENAI_PORT=${WS_PORTS[0]} WS_MONITORING_PORT=${WS_PORTS[1]} WS_STATUS_PORT=${WS_PORTS[2]} WS_SCHEDULE_PORT=${WS_PORTS[3]} WS_PLANNING_PORT=${WS_PORTS[4]} WS_EMOTION_PORT=${WS_PORTS[5]} WS_SKILL_PORT=${WS_PORTS[6]} WS_AUTH_PORT=${WS_PORTS[7]} node --unhandled-rejections=warn --experimental-specifier-resolution=node --es-module-specifier-resolution=node dist/server.js"
fi
echo "Backend started in tmux session: $BACKEND_SESSION"
echo "  dev mode: tsc-watch with auto-restart on changes"
echo "  prod mode: Node.js server only"

# セッション情報を表示
echo -e "\nActive tmux sessions:"
tmux list-sessions

echo -e "\nTo attach to the session:"
echo "  tmux attach -t $BACKEND_SESSION"
