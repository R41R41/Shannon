#!/bin/bash
# Shannon SSH Tunnel — ローカル開発 ↔ Azure VM (Minecraft Server) 双方向接続
#
# 使い方: ./tunnel.sh
#
# -R 18092: VM(Mod) → ローカル(Backend Minebot API)
# -L 8085:  ローカル(Backend) → VM(Mod HTTP Server)

SSH_KEY="$HOME/.ssh/vm-constant-key.pem"
VM_USER="azureuser"
VM_HOST="20.243.208.67"

echo "🔗 Shannon SSH Tunnel starting..."
echo "   -R 18092 (VM→Local: Mod→Backend)"
echo "   -L 28085 → VM:8085 (Local→VM: Backend→Mod, with UI_MOD_PORT_OFFSET=20000)"
echo "   Press Ctrl+C to disconnect"
echo ""

exec ssh -i "$SSH_KEY" \
    -R 18092:localhost:18092 \
    -L 28085:localhost:8085 \
    -o ServerAliveInterval=60 \
    -o ServerAliveCountMax=3 \
    "$VM_USER@$VM_HOST"
