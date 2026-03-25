#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COSYVOICE_DIR="$SCRIPT_DIR/CosyVoice"

if [ -d "$COSYVOICE_DIR" ]; then
  echo "[INFO] CosyVoice already cloned at $COSYVOICE_DIR"
else
  echo "[INFO] Cloning CosyVoice..."
  git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git "$COSYVOICE_DIR"
fi

cd "$COSYVOICE_DIR"
git submodule update --init --recursive

echo "[INFO] Installing CosyVoice dependencies..."
pip install -r requirements.txt

echo "[INFO] Downloading Fun-CosyVoice3-0.5B model..."
python3 -c "
from modelscope import snapshot_download
snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B', local_dir='pretrained_models/Fun-CosyVoice3-0.5B')
"

echo ""
echo "=== Setup complete ==="
echo "Model location: $COSYVOICE_DIR/pretrained_models/Fun-CosyVoice3-0.5B"
