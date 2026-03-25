# TTS Model Evaluation Scripts

ローカルPC（RTX 4070）でTTSモデルの品質・速度を比較評価するためのスクリプト集。

## セットアップ

```bash
# 1. Conda環境を作成
conda create -n tts-eval python=3.10 -y
conda activate tts-eval

# 2. 依存関係インストール
pip install -r requirements.txt

# 3. CosyVoice リポジトリをクローン（初回のみ）
./setup_cosyvoice.sh

# 4. システム依存（Ubuntu）
sudo apt-get install -y sox libsox-dev
```

## テストスクリプト

### CosyVoice 3 テスト
```bash
python test_cosyvoice3.py
```

### Kokoro TTS テスト
```bash
python test_kokoro.py
```

### 全モデル比較
```bash
python benchmark_all.py
```

## 出力

`output/` ディレクトリに以下が生成される:
- WAVファイル（各モデル × 各テスト文）
- `benchmark_results.json`（レイテンシ計測結果）
