# Shannon 現状アーキテクチャ・機能サマリ

> **最終更新: 2026-03-29**
> 詳細設計の全文: [architecture-llm-minebot.md](./architecture-llm-minebot.md)

---

## 1. 一言で

Shannon は **複数チャネル**（Discord / Minecraft / X / Web / YouTube）から入力を受け、**統一グラフ**（ingest → classify → execute → format）で処理する自律エージェント基盤。**Minebot**（mineflayer）でマイクラ操作、**Routine Executor** (System 1) で定型手順を LLM 不要で高速実行、**SelfImprovementDaemon** で失敗からルール/コード/ルーチンの改善、**CodeAgentLoop**（Claude）でリポジトリ単位の自律修正が可能。

---

## 2. 実行パイプライン

```
Channel Adapters (Discord / Minecraft / X / YouTube / Web)
    ↓ RequestEnvelope
RequestExecutionCoordinator (レーン別直列化 + 緊急プリエンプション)
    ↓
Shannon Graph v2
    ingest → classify → execute → format
    ※緊急時: ingest → emergency_fastpath → execute → format
    ↓ ShannonActionPlan
Action Dispatcher → チャネル別配信
```

### 3 層実行モデル (System 2 / System 1 / Atomic)

```
System 2 (LLM: FCA)        高レベル判断・未知の状況対応
    │ tool_call: "routine:gather-wood" or "mine-block"
    ▼
System 1 (RoutineExecutor)  定型手順を LLM 不要で高速実行
    │ skill.run() 直接呼出
    ▼
Atomic (InstantSkills 70個)  原子操作
```

LLM は「ルーチンを呼ぶか、個別スキルを呼ぶか」を選択する。既知パターンはルーチンで高速化、未知の状況は個別スキルで柔軟に対応。

---

## 3. LLM サービス詳細

### 3.1 LLMService (`backend/src/services/llm/client.ts`)

シングルトン。全チャネルからの `invokeGraph(envelope)` を受け付ける統一エントリポイント。

**主要コンポーネント**:
- `ShannonGraph` (LangGraph) — 統一実行グラフ
- `FunctionCallingAgent` — メインエージェントループ
- `AgentOrchestrator` — Twitter/YouTube 等の特化エージェント群
- `EventRouter` — EventBus 経由のリクエストルーティング
- `VoiceProcessor` — STT → LLM → TTS パイプライン

### 3.2 Shannon Graph (`graph/shannonGraph.ts`)

8 ノードの LangGraph ステートマシン:

```
              ┌─────────┐
              │ ingest  │  inferInitialMode()
              └────┬────┘
                   │
          ┌── emergency tag? ──┐
          │YES                 │NO
          ▼                    ▼
  emergency_fastpath      classify (gpt-4.1-mini)
  (hardcoded, LLM skip)       │
          │              ┌─────┴──────┐
          │         Minecraft?    Other channel
          │              │            │
          │         recall only   emotion ∥ recall
          │              │            │
          └──────── execute ──────────┘
                      │
                   format
                      │
                   writeback (fire-and-forget memory persist)
```

**グラフ状態 (ShannonState)**:
- 入力: `envelope` (RequestEnvelope)
- 分類: `mode`, `intent`, `riskLevel`, `needsTools`, `needsPlanning`
- 認知: `emotion`, `memoryPrompt`, 各種メモリプロンプト
- 実行: `toolCalls[]`, `allowedTools`, `selectedModel`
- 出力: `actionPlan`, `finalAnswer`, `taskTree`

### 3.3 ClassifyNode (`graph/nodes/ClassifyNode.ts`)

gpt-4.1-mini + Structured Output。リクエストを以下に分類:

| フィールド | 値 |
|-----------|-----|
| `mode` | conversational / task_execution / planning / minecraft_action / minecraft_emergency / broadcast / self_reflection / voice_conversation |
| `riskLevel` | low / mid / high |
| `needsTools` | boolean |
| `needsPlanning` | boolean |

**リスクベースモデル選択**: high → gpt-5, mid+planning → gpt-5-mini-fast, else → gpt-4.1-mini

### 3.4 FunctionCallingAgent (`graph/nodes/FunctionCallingAgent.ts`)

メインのツール実行ループ。1136 行。

| 設定 | 値 |
|------|-----|
| MAX_ITERATIONS | 50 (通常) / 15 (緊急) |
| MAX_TOTAL_TIME | 300,000 ms (5分) |
| LLM_TIMEOUT | モデル別 (15s〜120s) |

**実行フロー**:
1. ツールフィルタリング（チャネル別不要ツール除外）
2. 並列コンテキスト構築（Minecraft: WorldKnowledge + TaskEpisode + CraftDependency）
3. PromptBuilder でシステムプロンプト組立（感情 + メモリ + プロファイル + 動的ルール）
4. メインループ: LLM 呼び出し → ツール実行 → 結果追記 → 繰り返し
5. LoopDetector で同一ツール繰り返しを検知・ブロック

**サブコンポーネント**:
- `PromptBuilder` — 感情・メモリ・ルール・コンテキストの組立
- `ToolExecutor` — ツール呼び出し + エラーハンドリング
- `LoopDetector` — ツール繰り返し検知
- `TaskTreePublisher` — UI へのタスク状態更新
- `ThinkingManager` — 推論トレース蓄積

### 3.5 認知並列システム (`graph/cognitive/`)

`ParallelExecutor` が 3 つの認知ループを並列実行:

| ループ | 脳領域アナロジー | 役割 | 間隔 |
|--------|----------------|------|------|
| **EmotionLoop** | 扁桃体 | Plutchik 8次元感情更新 | 10s debounce |
| **MetaCognitionLoop** | DLPFC | 進捗監視・戦略介入・モデルエスカレーション | 3 iter / 5s min |
| **TaskExecutionLoop** | — | FCA メインループ | 連続 |

**CognitiveBlackboard** — 3 ループ間の共有状態:
- イベント: `emotion:updated`, `meta:updated`, `task:updated`, `loop:detected`, `completed`
- スナップショット: goal, emotionState, taskState, selfState (inventory/health/food), plan

**Minecraft 最適化**: `needsPlanning=false` なら EmotionLoop + MetaCognitionLoop をスキップ。

### 3.6 ModelSelector (`graph/cognitive/ModelSelector.ts`)

動的モデルエスカレーション:

```
gpt-4.1-mini (15s) → gpt-5-mini-fast (30s) → gpt-5-mini (60s) → gpt-5 (120s)
```

- ClassifyNode のリスク判定で初期モデル決定
- MetaCognitionLoop が `wrong_approach` 判定時にエスカレーション
- プラットフォーム上限: Minecraft = gpt-5-mini-fast (速度優先)

### 3.7 MemoryAgent (`graph/cognitive/MemoryAgent.ts`)

3 フェーズのプロアクティブメモリ管理:
1. **Initialize** — 人物情報 + 関連記憶の初回リコール
2. **Save-Check** (10 iter ごと) — ツール結果から保存判断
3. **Compress** (タスク完了時) — 古い記憶の統合

### 3.8 RequestExecutionCoordinator (`graph/requestExecutionCoordinator.ts`)

レーン別の直列化 + 緊急プリエンプション:

| レーンキー | 用途 |
|-----------|------|
| `self-mod:apply` | 自己改善適用 |
| `minecraft-world:{id}` | ワールド単位 |
| `thread:{threadId}` | 会話スレッド単位 |

緊急リクエスト (`tags.includes('emergency')`) は AbortController で現行タスクを中断・割り込み。

### 3.9 ツール一覧 (36 個)

**画像**: create-image, describe-image, edit-image, describe-notion-image
**Twitter/X**: post-on-twitter, like-tweet, retweet-tweet, quote-retweet, get-x-post-content, generate-tweet-text
**Discord**: chat-on-discord, get-discord-recent-messages, get-server-emoji, react-by-server-emoji, get-discord-images
**検索**: google-search, search-by-wikipedia, search-weather, wolframalpha, fetch-url
**YouTube/Notion**: get-youtube-video-content, get-notion-page-content
**ユーティリティ**: update-plan, wait, task-complete, chat-on-web, plan-craft
**メモリ**: recall-memory, save-memory, recall-person, save-person, recall-knowledge, save-knowledge, recall-experience, save-experience

+ **Minebot InstantSkill 70 個**（LLM ツールとして動的登録）

### 3.10 Voice パイプライン (`voice/VoiceProcessor.ts`)

```
Discord 音声入力
  → STT (Groq Whisper-Large-V3-Turbo)
  → LLM (制限ツールセット)
  → TTS (Voicepeak, 感情パラメータ連動)
  → Discord 音声出力
```

フィラー音声で長時間ツール実行中の沈黙を防止。

### 3.11 特化エージェント (`agents/AgentOrchestrator.ts`)

PostAboutToday, PostWeather, PostFortune, PostNews, ReplyTwitterComment, QuoteTwitterComment, ReplyYoutubeComment, ReplyYoutubeLiveComment, AutoTweet, MemberTweet, RealtimeAPI の 11 エージェント。

---

## 4. Minebot 詳細

### 4.1 MinebotClient (`backend/src/services/minebot/client.ts`)

シングルトン。Mineflayer ボットの初期化・プラグイン読み込み・ライフサイクル管理。

**プラグイン**: pathfinder, collectBlock, projectile, pvp, toolPlugin, cmd, minecraftHawkEye

**ボット状態**:
- `selfState`: position, health, food, heldItem, lookingAt, inventory
- `environmentState`: senderName, senderPosition, weather, time, biome, dimension, bossbar

### 4.2 SkillAgent (`skillAgent.ts`, 838 行)

中核オーケストレーター。スキル読み込み・チャットイベント・コマンド処理・LLM グラフへのメッセージルーティング。

**チャットコマンド**:
| コマンド | 動作 |
|---------|------|
| `..` | InstantSkill 一覧表示 |
| `...` | ConstantSkill 一覧表示 |
| `.../` | インベントリ表示 |
| `./skillName` | InstantSkill 直接実行 |
| `../skillName` | ConstantSkill トグル |
| `..test <suite>` | 自己テスト実行 |
| `..agent-fix <desc>` | CodeAgentLoop 起動 |

**メッセージ処理フロー**:
```
ユーザーチャット "シャノン、<message>"
  → updateSenderInfo()
  → minebotAdapter で RequestEnvelope 生成
  → resumeAwaitingUserTask() or LLMService.invokeGraph()
  → ツール実行 → 結果をチャットで報告
```

### 4.3 InstantSkill (70 個)

即時実行スキル。LLM のツールとして公開。

```typescript
abstract class InstantSkill extends Skill {
  skillName: string
  description: string
  params: SkillParam[]
  maxDurationMs: number           // タイムアウト (0=無制限)

  async run(...args): Promise<SkillResult>   // ロック取得 → 割込み監視 → runImpl
  abstract runImpl(...args): Promise<SkillResult>
}
```

**カテゴリ別一覧** (詳細は [SKILLS_REFERENCE.md](../SKILLS_REFERENCE.md)):

| カテゴリ | 数 | 代表スキル |
|---------|-----|-----------|
| 情報取得 | 23 | get-bot-status, list-inventory-items, find-blocks, check-recipe, investigate-terrain |
| 移動 | 7 | move-to, follow-entity, flee-from, jump, stop-movement, look-at, enter-portal |
| 採掘 | 4 | dig-block-at, mine-block, stair-mine, fill-area |
| 戦闘 | 5 | attack-nearest, attack-continuously, combat, swing-arm, shoot-bow |
| クラフト/精錬 | 7 | craft-one, start-smelting, check-furnace, withdraw-from-furnace, enchant-item, repair-item, use-stonecutter |
| コンテナ | 3 | check-container, deposit-to-container, withdraw-from-container |
| 農業 | 4 | plant-crop, harvest-crop, use-bone-meal, breed-animal |
| インタラクション | 7 | place-block-at, activate-block, use-item, use-item-on-block, sleep-in-bed, trade-with-villager, fish |
| ユーティリティ | 10 | chat, drop-item, equip-item, set-sneak, set-sprint, wait-time, pickup-nearest-item, switch-constant-skill 等 |

### 4.4 ConstantSkill (15 個)

バックグラウンド常駐スキル。優先度キューで実行。

```typescript
abstract class ConstantSkill extends Skill {
  priority: number              // 高い = 先に実行
  interval: number | null       // 100 / 1000 / 5000 ms
  containMovement: boolean      // InstantSkill 実行中は抑制
  isCritical: boolean           // true なら InstantSkill 中も実行 (溺死/ドラゴンブレス)
}
```

| スキル | 間隔 | 用途 |
|--------|------|------|
| autoEat | 1000ms | 食料自動消費 (food<18 or health<18) |
| autoRunFromHostiles | 1000ms | 敵モブから自動逃走 |
| autoSwim | 100ms | 溺死防止 (critical) |
| autoAvoidDragonBreath | 100ms | ドラゴンブレス回避 (critical) |
| autoAvoidProjectileRange | 1000ms | 飛翔体回避 |
| autoPickUpItem | 1000ms | 近くのアイテム自動拾得 |
| autoFollow | 1000ms | プレイヤー追従 |
| autoFaceSpeaker | 1000ms | 話者の方を向く |
| autoFaceNearestEntity / MovedEntity / UpdatedBlock | 1000ms | 注目対象に向く |
| autoDetectBlockOrEntity | 5000ms | 環境変化検知 |
| autoUpdateState | 5000ms | ボット状態更新 |
| autoUpdateLookingAt | 1000ms | 視線先更新 |
| autoSleep | 5000ms | 夜間自動就寝 |

### 4.5 SkillExecutor (`execution/SkillExecutor.ts`)

カテゴリ別ロックシステム:

| カテゴリ | 競合カテゴリ |
|---------|-------------|
| query | なし（常時実行可） |
| movement | movement, mining |
| mining | movement, mining |
| combat | movement, mining, combat, interaction |
| interaction | combat |
| other | なし |

30 秒のタイムアウト付き。競合時はキューで待機。

### 4.6 MinebotTaskRuntime (`runtime/MinebotTaskRuntime.ts`)

キューベースのタスク管理。緊急プリエンプション対応。

**タスク状態遷移**:
```
pending → planning → executing → completed
executing → paused (緊急割込み) → planning (復帰)
executing → failed/timeout → retrying → planning
```

**緊急割込みフロー**:
```
ダメージ検知 (health≤10 / 連続攻撃≥3 / 大ダメージ)
  → EventReactionSystem.handleDamage()
  → taskRuntime.interruptForEmergency()
    → 実行中タスクを paused
    → AbortController.abort()
  → setEmergencyTask() → 緊急タスク実行
  → 完了後 resumePreviousTask()
```

### 4.7 EventReactionSystem (`eventReaction/EventReactionSystem.ts`)

環境イベント → 自動反応:
- **CombatEventHandler** — 敵モブ検知・攻撃
- **EnvironmentEventHandler** — 天候・バイオーム変化
- **StatusEventHandler** — HP・空腹・効果
- **PlayerEventHandler** — プレイヤー接近

確率ベースの反応設定（イベントごとに有効/無効・確率を設定可能）。

### 4.8 HTTP エンドポイント (`http/MinebotHttpServer.ts`)

ポート 8092。UI Mod との通信:

**受信**: `/throw_item`, `/constant_skill_switch`, `/chat`
**送信**: `${UI_MOD_BASE_URL}/constant_skills`, `/reaction_settings`, `/task_list`, `/bot_chat`

### 4.9 設定 (`config/MinebotConfig.ts`)

| 設定 | 値 |
|------|-----|
| MINEBOT_API_PORT | 8092 |
| UI_MOD_PORT | 8091 |
| SKILL_TIMEOUT_MS | 120,000 |
| MAX_RETRY_COUNT | 10 |
| MAX_QUEUE_SIZE | 10 |
| LANGGRAPH_RECURSION_LIMIT | 64 |

### 4.10 Routine Executor — System 1 層 (`backend/src/services/minebot/routines/`)

#### 問題: LLM ボトルネック（実測ログ 2026-03-29）

| タスク | LLM 反復 | 実時間 | スキル呼出 | LLM 時間比 |
|--------|---------|--------|-----------|-----------|
| 単純（インベントリ確認） | 1 | 2-4.4秒 | 1 | 100% |
| 中規模（精錬+クラフト） | 50 | 184秒 | 15 | 92% |
| 複雑（食料収集チェーン） | 25 | 63秒 | 10-12 | 95% |

15 秒で終わるべきゲームプレイに 50-184 秒かかる。**時間の 92-95% は LLM の「次に何をするか考える」に消費**。カーネマンの二重過程理論でいう System 1（速い思考 = 手続き記憶）が欠如していた。

#### 解決: RoutineExecutor

JSON で定義された手続き（ルーチン）を **LLM 呼び出しなし** で InstantSkill を直接実行する中間層。

```
FCA (System 2)
  │ tool_call: "routine:gather-wood" {count: 10}
  ▼
RoutineWrapperTool (LangChain StructuredTool)
  │
  ▼
RoutineExecutor
  │ mine-block.run("oak_log", 10, 64)    ← LLM 呼出なし
  │ pickup-nearest-item.run("oak_log", 8) ← LLM 呼出なし
  │
  ▼ 結果サマリを FCA に返却
```

**期待効果**: 精錬+クラフトの 10 回 LLM 呼出 → 1 ルーチン呼出。184 秒 → 推定 20-30 秒。

#### ルーチン定義フォーマット

```jsonc
// backend/saves/minecraft/routines/gather-wood.routine.json
{
  "name": "gather-wood",
  "description": "近くの原木を指定個数採掘して拾う",
  "params": [
    { "name": "count", "type": "number", "default": 4 },
    { "name": "woodType", "type": "string", "default": "oak_log" }
  ],
  "steps": [
    { "skill": "mine-block", "args": { "blockName": "${woodType}", "count": "${count}" } },
    { "skill": "pickup-nearest-item", "args": { "itemName": "${woodType}" }, "onFailure": "skip" }
  ],
  "failureEscalation": "system2",  // 失敗時は FCA に返す
  "source": "manual",              // manual | shannon | self-improve | recorded
  "stats": { "runs": 0, "successes": 0, "failures": 0, "avgDurationMs": 0 }
}
```

- `${param}` テンプレートでパラメータ伝搬（型保持）
- `repeat` / `loop` で繰り返し
- `onFailure`: `abort`（FCA にフォールバック）/ `skip` / `continue`
- `outputVar` で中間結果を変数に格納
- `stats` で実行統計を自動追跡

#### 安全策

- **AbortSignal 対応**: 緊急割込み (`bot.interruptExecution`) や FCA タイムアウト時に各ステップ前でチェック → 即座に中断
- **executingSkill フラグ**: ルーチン実行中は `bot.executingSkill = true` を維持し、`containMovement` な ConstantSkill（autoFollow, autoRunFromHostiles 等）の干渉を防止
- **isCritical スキルは動作**: autoSwim, autoAvoidDragonBreath は executingSkill 中も動作

#### Shannon によるルーチン自己管理

`manage-routine` ツールでシャノン自身がルーチンを CRUD:

| アクション | 動作 |
|-----------|------|
| `list` | 登録済みルーチン一覧（成功率・実行回数つき） |
| `get` | ルーチン定義の詳細表示 |
| `create` | 新規ルーチンを JSON で定義・即座に使用可能 |
| `edit` | 既存ルーチンのステップ・説明を変更 |
| `delete` | ルーチンを削除 |

作成されたルーチンは即座に FCA のツールマップに登録され、次のツール呼び出しから使用可能。

#### 初期ルーチン (7 個)

| ルーチン | ステップ数 | 代替する LLM 反復数 (推定) |
|---------|-----------|------------------------|
| `gather-wood` | 2 | 3-5 |
| `make-wooden-tools` | 8 | 15-20 |
| `make-stone-tools` | 5 | 10-15 |
| `smelt-ore` | 4 | 8-10 |
| `find-and-mine-ore` | 2 | 5-8 |
| `store-items` | 2 | 3-5 |
| `equip-full-armor` | 4 | 5-8 |

#### コンポーネント構成

| ファイル | 役割 |
|---------|------|
| `routines/types.ts` | RoutineDefinition, RoutineStepDef 等の型定義 |
| `routines/RoutineExecutor.ts` | JSON ルーチン実行エンジン（テンプレート解決・ループ・中断制御） |
| `routines/RoutineManager.ts` | ルーチン JSON の CRUD + インメモリインデックス + 統計更新 |
| `routines/RoutineWrapperTool.ts` | LangChain StructuredTool ラッパー（FCA から呼び出し可能に） |
| `routines/RoutineRecorder.ts` | パターン検知→自動ルーチン生成（System 2 → System 1 への学習経路） |
| `llm/tools/utility/manageRoutine.ts` | Shannon がルーチンを管理する LLM ツール |

#### LLM がルーチンを優先する仕組み

3つのメカニズムで LLM をルーチン利用に誘導:

1. **プロンプトガイダンス** (`PromptBuilder.formatRoutineGuidance()`) — Minecraft タスク時にルーチン一覧と「ルーチン優先」指示をシステムプロンプトに動的注入
2. **description 短縮** (`FCA.buildRoutineCoverageMap()`) — ルーチンがカバーするスキルの description を短縮し、ルーチンへの参照を追加。トークン削減 + 誘導
3. **統計表示** — ルーチンの description に成功率・実行回数を表示し、LLM が信頼性を判断できるようにする

#### 自動ルーチン生成 (RoutineRecorder)

```
成功したタスクのツール呼出シーケンス
  ↓ onEpisodeCompleted()
パターンバッファに記録 (スライディングウィンドウ, 長さ 2-5)
  ↓ count >= 3 (ROUTINE_MIN_OCCURRENCES)
RoutineDefinition を自動生成 → saves/minecraft/routines/ に保存
  ↓ FCA.addTools()
次回から routine:auto-xxx として使用可能
```

**設定**: `ROUTINE_AUTO_GENERATE_ENABLED` (dev: デフォルト true, prod: false)

---

## 5. 自己改善 (SelfImprovementDaemon)

**パス**: `backend/src/services/llm/graph/cognitive/selfImprove/`

| モード | 説明 |
|--------|------|
| **リアクティブ** | 失敗エピソードをバッファ → Analyzer → Generator → Applier (Tier1 ルール / Tier2 コード) |
| **プロアクティブ** | ツール呼び出しパターンから新スキル案を生成・検証・ホットロード |
| **CodeAgentLoop** | Anthropic (Opus/Sonnet) の ReAct ループ。read_file / edit_file / semantic_search / run_tsc 等 |
| **SkillPatcher** | 自己テスト失敗時の小型 LLM 修正ループ。`chainContext` + `skipFix` サポート |

### JSON 自己テスト (SelfTestRunner)

- **ケース**: `backend/saves/minecraft/self_test_cases/*.json`
- **モード**: `default` (スキル単体), `chain` (逐次・状態引継ぎ), `goal` (自然言語ゴール)
- **レポート**: `backend/saves/minecraft/self_test_reports/`
- **チャット起動**: `..test` / `..test-smoke` / `..test-all [--fix]`

### 夜間メンテナンス (課金抑止設計)

**既定は LLM を呼ばない** (レポートに「スキップ」が並ぶだけ)。高コスト処理はすべて明示 opt-in。

| 環境変数 | 意味 |
|----------|------|
| `SELF_IMPROVE_NIGHTLY_ENABLED=true` | スケジューラ起動 |
| `SELF_IMPROVE_NIGHTLY_RUN_REACTIVE=true` | 失敗分析パイプライン |
| `SELF_IMPROVE_NIGHTLY_CODE_AGENT=true` | CodeAgentLoop (Anthropic) |
| `SELF_IMPROVE_NIGHTLY_MINECRAFT_SUITES` | テストスイート (例: `smoke-skills`) |
| `SELF_IMPROVE_MORNING_WEBHOOK_URL` | Discord Webhook へ要約投稿 |

---

## 6. メモリシステム

### ScopedMemoryService (recall ノード)

チャネル・ユーザー別のスコープドリコール:
- userProfile, selfModel, relationshipModel
- strategyUpdates, internalState, worldModelPatterns

Minecraft は軽量モード (person/self/relationship スキップ)。

### TaskEpisodeMemory

タスク実行エピソードの保存・類似検索。新タスク開始時に類似エピソードをプロンプトに注入。

### MongoDB コレクション

| モデル | 用途 |
|--------|------|
| ShannonMemory | experience, knowledge, self_model, strategy_update, internal_state, world_pattern |
| WorldKnowledge | ブロック・構造物・チェスト・バイオーム・危険地帯 (2dsphere インデックス, 24h TTL) |
| PersonMemory | ユーザー別記憶 |
| User | アカウント・ロール |

---

## 7. 公開サイトとの対応

- [アイマイラボ `/architecture`](https://aiminelab.com/architecture): ハブページ
- `/architecture/llm` 下部（管理者認証後）: Full Architecture Diagram

---

## 8. 関連ファイル（クイックリンク）

| 領域 | 主なパス |
|------|-----------|
| LLM サービス | `backend/src/services/llm/client.ts` |
| Shannon Graph | `backend/src/services/llm/graph/shannonGraph.ts` |
| FCA | `backend/src/services/llm/graph/nodes/FunctionCallingAgent.ts` |
| 認知並列 | `backend/src/services/llm/graph/cognitive/ParallelExecutor.ts` |
| 自己改善コア | `backend/src/services/llm/graph/cognitive/selfImprove/` |
| **ルーチンシステム** | `backend/src/services/minebot/routines/` |
| **ルーチン定義** | `backend/saves/minecraft/routines/*.routine.json` |
| **manage-routine ツール** | `backend/src/services/llm/tools/utility/manageRoutine.ts` |
| Minebot クライアント | `backend/src/services/minebot/client.ts` |
| SkillAgent | `backend/src/services/minebot/skillAgent.ts` |
| InstantSkills | `backend/src/services/minebot/instantSkills/` |
| ConstantSkills | `backend/src/services/minebot/constantSkills/` |
| TaskRuntime | `backend/src/services/minebot/runtime/MinebotTaskRuntime.ts` |
| 設定 | `backend/src/config/env.ts`, `backend/src/services/minebot/config/MinebotConfig.ts` |
| エージェント運用 | `AGENTS.md` |

---

## 9. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-29 | **Routine Executor (System 1) 完成版**: 3層実行モデル + PromptBuilder ルーチンガイダンス + FCA description 短縮 + RoutineRecorder 自動生成。実測ログ分析 (LLM 92-95% ボトルネック) に基づく設計。LLM/Minebot 詳細 (§3-4)・メモリシステム (§6) 大幅追記。ルートドキュメント整理。 |
| 2026-03-25 | 初版。夜間バッチの課金既定、goal/chain テスト、CodeAgent、SkillPatcher skipFix、minebot 実装メモを反映。 |
