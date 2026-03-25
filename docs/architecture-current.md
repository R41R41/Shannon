# Shannon 現状アーキテクチャ・機能サマリ

> **最終更新: 2026-03-25**  
> 対象: 開発ブランチ（例: `claude/unified-shannon-graph-FC4pI`）。本番デプロイと差分がある場合あり。  
> **詳細設計の全文**: [architecture-llm-minebot.md](./architecture-llm-minebot.md)  
> **v2 当初設計（歴史）**: [architecture-shannon-v2.md](./architecture-shannon-v2.md)

---

## 1. 一言で

Shannon は **複数チャネル**（Discord / Minecraft / X / Web / YouTube 等）から入力を受け、**統一グラフ**（ingest → classify → execute → format）で処理する自律エージェント基盤。**Minebot**（mineflayer）でマイクラ操作、**SelfImprovementDaemon** で失敗・パターンからルール／コード改善、**CodeAgentLoop**（Claude）でリポジトリ単位の自律修正が可能。

---

## 2. 実行パイプライン（要約）

```
Adapters → RequestExecutionCoordinator → Shannon Graph (v2)
  ingest → classify → execute → format → Action Dispatcher
```

- **execute**: `ParallelExecutor` 上で TaskFCA / MetaCogFCA / EmotionLoop / MemoryAgent が並列協調（詳細は architecture-llm-minebot §5–6）。
- **緊急**: `emergency_fastpath` など分岐あり（同ドキュメント §2–3）。

---

## 3. Minebot（マイクラ）

- **高レベルスキル**: 移動・採掘・クラフト・精錬・設置・戦闘 等（`backend/src/services/minebot/instantSkills/` 等）。
- **タスクランタイム**: キュー、エンベロープ、環境イベント反応（`skillAgent.ts` 周辺）。
- **実装メモ（2026-03）**
  - `craft-one`: **3×3 レシピが必要なときだけ**作業台を探索・利用。2×2 はインベントリ内クラフト。
  - `place-block-at`: 設置座標にボット自身がいる場合は**隣へ退避**してから設置を試行。
- **プロトコル**: Minecraft 1.21.11 付近の `chat_command_signed` checksum は **`minecraft-data` の `u8` 定義**に合わせる（`patches/minecraft-data+*.patch`）。mineflayer / サーバ版と合わせて確認すること。

---

## 4. 自己改善（SelfImprovementDaemon）

**パス**: `backend/src/services/llm/graph/cognitive/selfImprove/`

| モード | 説明 |
|--------|------|
| **リアクティブ** | タスク失敗エピソードをバッファし、条件成立時に Analyzer → Generator → Applier（Tier1 ルール / Tier2 コード）。 |
| **プロアクティブ** | ツール呼び出しパターンから新スキル案を生成・検証・ホットロード。 |
| **CodeAgentLoop** | Anthropic（親 Opus / サブ Sonnet）。read_file / edit_file / semantic_search / web / shell / run_tsc 等の **ReAct**。`SkillPatcher.diagnoseAndFixWithAgent`・`ImprovementApplier.applyWithAgent`・チャット `..agent-fix` から起動可能。 |
| **SkillPatcher** | 自己テスト失敗時の小型 LLM 修正ループ。`chainContext`（チェーン手順の履歴）と **`skipFix`**（テスト都合の失敗はコードをいじらない）をサポート。 |

**Tier 2 適用**: `SELF_IMPROVE_AUTO_APPLY_TIER2` または dev 既定で検証通過後にファイルへ書き込み可。変更可能範囲は `mutableCodePolicy.ts`。

---

## 5. JSON 自己テスト（SelfTestRunner）

- **ケース置き場**: `backend/saves/minecraft/self_test_cases/*.json`
- **モード**
  - `default`: `globalSetup` を各ケース前に付与し、スキル名でグルーピング。
  - `chain`: `globalSetup` は **1 回だけ**、ケースを定義順に逐次実行（インベントリ等が引き継がれる）。
  - `goal`: 自然言語 `goal` + `successCriteria`。**MinecraftGoalExecutor** が InstantSkill をツールとして LLM に公開し、ゴール達成までループ。
- **レポート**: `backend/saves/minecraft/self_test_reports/`（リポジトリでは `.gitignore` 想定）。
- **マイクラチャット**: `..test` / `self_test_cases` 言及などで意図検知（`selfTestIntent.ts`）。

---

## 6. 夜間メンテナンス（課金抑止設計）

**目的**: 指定 UTC 時刻付近で **1 日 1 回**、`runNightlyMaintenance` を走らせ `saves/self_improve/morning_reports/` に **Markdown / JSON** を残す。朝の確認用。

**既定は LLM を呼ばない**（レポートに「スキップ」が並ぶだけ）。高コスト処理はすべて **明示 opt-in**。

| 環境変数 | 意味 |
|----------|------|
| `SELF_IMPROVE_NIGHTLY_ENABLED=true` | スケジューラ起動（`server` 起動時に `startNightlySelfImproveScheduler`） |
| `SELF_IMPROVE_NIGHTLY_HOUR_UTC` / `MINUTE_UTC` / `WINDOW_MINUTES` | 発火ウィンドウ |
| `SELF_IMPROVE_NIGHTLY_RUN_REACTIVE=true` | 失敗バッファ駆動の分析パイプライン（OpenAI 等・複数回） |
| `SELF_IMPROVE_NIGHTLY_CODE_AGENT=true` | CodeAgentLoop 実行（Anthropic） |
| `SELF_IMPROVE_NIGHTLY_CODE_AGENT_MAX_ITER` | 既定 8、上限 25 |
| `SELF_IMPROVE_NIGHTLY_MINECRAFT_SUITES` | カンマ区切りスイート名（例 `smoke-skills`） |
| `SELF_IMPROVE_NIGHTLY_MINECRAFT_AUTOFIX=true` | テスト失敗時の SkillPatcher（追加 LLM） |
| `SELF_IMPROVE_MORNING_WEBHOOK_URL` | Discord Incoming Webhook 等へ要約投稿 |

**状態ファイル**: `saves/self_improve/nightly_state.json`（同日再実行防止。`.gitignore` 推奨）。

**軽量テスト**: `backend/tests/selfImprove/nightlySchedule.test.ts`（時刻判定のみ、API 不要）。

---

## 7. 公開サイトとの対応

- [アイマイラボ `/architecture`](https://aiminelab.com/architecture): ハブページに「現状の主な機能」サマリ。
- `/architecture/llm` 下部（管理者認証後）: **Full Architecture Diagram** — ノード詳細に CodeAgent・goal テスト・夜間バッチ等を反映。

---

## 8. 関連ファイル（クイックリンク）

| 領域 | 主なパス |
|------|-----------|
| 自己改善コア | `backend/src/services/llm/graph/cognitive/selfImprove/` |
| 夜間スケジューラ | `NightlySelfImproveScheduler.ts`, `nightlySchedule.ts` |
| ゴール実行 | `MinecraftGoalExecutor.ts` |
| 設定 | `backend/src/config/env.ts` の `selfImprove` |
| エージェント運用 | リポジトリ直下 `AGENTS.md` |

---

## 9. 変更履歴（このファイル）

| 日付 | 内容 |
|------|------|
| 2026-03-25 | 初版。夜間バッチの課金既定、goal/chain テスト、CodeAgent、SkillPatcher skipFix、minebot 実装メモを反映。 |
