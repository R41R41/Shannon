# Shannon - Multi-Channel Autonomous AI Agent

LLM ベースのマルチチャネル自律 AI エージェントプラットフォーム

---

## ドキュメント

**設計・運用資料は [`docs/`](./docs/README.md) に集約。** 最短で全体像を掴むには:

1. **[docs/architecture-current.md](./docs/architecture-current.md)** - 現行アーキテクチャサマリ（2026-03）
2. **[docs/architecture-llm-minebot.md](./docs/architecture-llm-minebot.md)** - LLM グラフ・Minebot 詳細設計
3. **[AGENTS.md](./AGENTS.md)** - 開発環境セットアップ・CI/CD・注意事項

その他:

- **[SKILLS_REFERENCE.md](./SKILLS_REFERENCE.md)** - InstantSkill 70 個 + ConstantSkill 15 個の一覧
- `docs/archive/` - 過去の計画書・レポート類（現行仕様の根拠には使わない）

---

## クイックスタート

### 環境変数

```bash
# backend/.env
OPENAI_API_KEY=sk-...
MONGODB_URI=mongodb://localhost:27017/shannon
DISCORD_TOKEN=...          # Discord Bot（任意）
MINECRAFT_BOT_USER_NAME=bot_name
```

### 起動

```bash
# 依存インストール（ネイティブモジュール対応）
npm install --ignore-scripts && npx patch-package

# 共通型ビルド
npm run build -w common

# 開発モード（backend + frontend 並列起動）
npm run dev

# backend のみ
npm run dev-backend
```

### Minecraft Mod (ShannonUIMod)

```
1. Fabric 1.21.4 をインストール
2. ShannonUIMod.jar を mods/ に配置
3. Minecraft を起動 → サーバー接続
4. 'L' キーで UI 表示
```

---

## 主な機能

### マルチチャネル統一グラフ

```
Discord / Minecraft / X / YouTube / Web
    ↓ RequestEnvelope
Shannon Graph (ingest → classify → execute → format)
    ↓ ActionPlan
Channel-specific dispatch
```

### Minebot - 自律 Minecraft エージェント

```
「原木を10個集めて」
→ ClassifyNode → FunctionCallingAgent → 70個のスキルで実行 → 完了報告
```

- 70 個の InstantSkill（移動/採掘/クラフト/戦闘/農業/探索...）
- 15 個の ConstantSkill（自動食事/敵回避/水泳/追従...）
- 緊急対応（ダメージ検知 → タスク中断 → LLM 判断 → 復帰）
- 自己改善（失敗分析 → ルール/コード自動生成 → テスト → 適用）

### Discord Bot

- テキスト + ボイス対応（STT → LLM → TTS）
- 感情パラメータ連動の音声合成（Voicepeak）

### X/Twitter エージェント

- 自動投稿・エンゲージメント監視
- ウォッチリスト追跡

---

## システム構成

```
Shannon2/  (npm workspaces monorepo)
├── backend/      Node.js + TypeScript
│   ├── LLM Service     LangGraph 統一グラフ + 認知並列処理
│   ├── Minebot          Mineflayer + 70 InstantSkills + 15 ConstantSkills
│   ├── Discord          discord.js + Voice
│   ├── Twitter/X        twitter-api-v2
│   ├── YouTube          googleapis
│   ├── Web              Express + Firebase
│   └── Self-Improve     SelfImprovementDaemon + CodeAgentLoop (Claude)
├── frontend/     React 18 + Vite + MobX + MUI
├── common/       共有 TypeScript 型定義
└── karioki/      Minecraft Mod (Java/Fabric 1.21.4)
```

### 主要モデル

| 役割 | モデル |
|------|--------|
| 分類 (ClassifyNode) | gpt-4.1-mini |
| タスク実行 (FCA) | gpt-4.1-mini → gpt-5-mini-fast → gpt-5 (動的エスカレーション) |
| 自己改善 (CodeAgent) | Claude Opus / Sonnet |

### データストア

- **MongoDB** - メモリ、ワールド知識、ユーザー管理
- **Langfuse** - LLM 呼び出しトレーシング

---

## 開発

```bash
# テスト実行
cd backend && npx vitest run

# Minecraft 自己テスト（ゲーム内チャット）
..test smoke-skills          # スモークテスト
..test-all                   # 全スイート
..agent-fix <description>    # CodeAgentLoop で自動修正
```

### CI/CD

GitHub Actions (`deploy-production.yml`) → Azure VM (SSH + tmux)

---

## License

MIT

## Contributing

Issues, PRs welcome!
