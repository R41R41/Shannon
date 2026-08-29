# Shannon System Architecture — LLM & Minebot 設計書

> 最終更新: 2026-03-25（§11 末尾に CodeAgent / 自己テスト JSON / 夜間バッチの追記）  
> **短い現状サマリのみ必要な場合**: [architecture-current.md](architecture-current.md)  
> 対象ブランチ（例）: `claude/unified-shannon-graph-FC4pI`  
> v2 設計書: [architecture-shannon-v2.md](architecture-shannon-v2.md)

---

## 目次

1. [システム全体概要](#1-システム全体概要)
2. [統一グラフ (Shannon Graph)](#2-統一グラフ-shannon-graph)
3. [ノード詳細](#3-ノード詳細)
4. [LLM モデル選択 (ModelSelector)](#4-llm-モデル選択-modelselector)
5. [認知並列システム (Cognitive Parallel)](#5-認知並列システム-cognitive-parallel)
6. [FunctionCallingAgent (FCA) メインループ](#6-functioncallingagent-fca-メインループ)
7. [ツール一覧と情報渡し](#7-ツール一覧と情報渡し)
8. [PromptBuilder — LLM に渡す情報の全体像](#8-promptbuilder--llm-に渡す情報の全体像)
9. [メモリシステム (ScopedMemoryService)](#9-メモリシステム-scopedmemoryservice)
10. [Minebot アーキテクチャ](#10-minebot-アーキテクチャ)
11. [自己改善システム (SelfImprovementDaemon)](#11-自己改善システム-selfimprovementdaemon)
12. [リクエスト実行コーディネーター](#12-リクエスト実行コーディネーター)
13. [フロントエンド連携](#13-フロントエンド連携)
14. [全 LLM 呼び出し一覧表](#14-全-llm-呼び出し一覧表)
15. [ファイルパス索引](#15-ファイルパス索引)

---

## 1. システム全体概要

### アーキテクチャ図

```
┌──────────────────────────────────────────────────────────────────┐
│                        Channel Adapters                         │
│  Discord │ Minecraft │ X/Twitter │ YouTube │ Web (Public Chat)  │
└─────────────────────────┬────────────────────────────────────────┘
                          │ RequestEnvelope
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              RequestExecutionCoordinator                        │
│  ・レーン別直列化 (minecraft-world:*, thread:*, self-mod:apply) │
│  ・緊急プリエンプション (AbortController)                       │
└─────────────────────────┬───────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Shannon Unified Graph (v2)                    │
│                                                                 │
│  ingest → classify → execute → format                           │
│                                                                 │
│  ※緊急時: ingest → emergency_fastpath → execute → format       │
│  ※旧ノード (recall/emotion/craft_preflight/writeback) は廃止   │
│    → MemoryAgent, EmotionLoop初回tick, plan-craftツールに移行   │
└─────────────────────────┬───────────────────────────────────────┘
                          │ ShannonActionPlan
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Action Dispatcher                            │
│  ・Discord: reply / react / voice_speak                        │
│  ・Minecraft: move_to / mine / craft / attack / ...            │
│  ・X: post / reply / quote                                     │
│  ・Web: SSE stream (reply / emotion / task_update)             │
└─────────────────────────────────────────────────────────────────┘
```

### RequestEnvelope (全チャネル共通入力)

```typescript
interface RequestEnvelope {
  requestId: string;          // UUID v4
  channel: ShannonChannel;    // 'discord' | 'minecraft' | 'x' | 'youtube' | 'web'
  sourceUserId: string;
  sourceDisplayName?: string;
  conversationId: string;     // 論理スレッドID
  threadId: string;           // チェックポインタスコープID
  text?: string;
  attachments?: RequestAttachment[];
  minecraft?: MinecraftContext;   // position, health, inventory, nearbyEntities, nearbyInfrastructure
  discord?: DiscordContext;       // guildId, channelId, isVoiceChannel, isDM
  x?: XContext;                   // tweetId, isReply, isQuote, isMention
  youtube?: YoutubeContext;       // videoId, liveId
  tags: string[];                 // ルーティング・リコール用タグ
  timestampIso: string;
}
```

---

## 2. 統一グラフ (Shannon Graph)

**ファイル**: `backend/src/services/llm/graph/shannonGraph.ts`

### グラフフロー

```
                    ┌─────────┐
                    │ ingest  │
                    └────┬────┘
                         │
              ┌──────────┴──────────┐
              │ Router              │
              │ emergency tag?      │
              └──┬───────────────┬──┘
          Yes    │               │  No
     ┌───────────▼───┐    ┌─────▼─────┐
     │ emergency_    │    │ classify   │
     │ fastpath      │    └─────┬─────┘
     └───────┬───────┘          │
             │         ┌────────┴────────┐
             │         │ Router          │
             │         │ minecraft?      │
             │         └──┬───────────┬──┘
             │      Yes   │           │  No
             │    ┌───────▼───────┐ ┌─▼──────────────────┐
             │    │ PARALLEL:     │ │ PARALLEL:           │
             │    │ ・recall      │ │ ・emotion_step      │
             │    │ ・craft_      │ │ ・recall             │
             │    │   preflight   │ │                     │
             │    └───────┬───────┘ └──┬──────────────────┘
             │            │            │
             │            └──────┬─────┘
             │                   │
             ▼                   ▼
        ┌─────────┐        ┌─────────┐
        │ execute │        │ execute │
        └────┬────┘        └────┬────┘
             │                   │
             ▼                   ▼
        ┌─────────┐        ┌─────────┐
        │ format  │        │ format  │
        └────┬────┘        └────┬────┘
             │                   │
             ▼                   ▼
       ┌──────────┐       ┌──────────┐
       │writeback │       │writeback │
       └────┬─────┘       └────┬─────┘
            │                   │
            ▼                   ▼
           END                 END
```

### ShannonState (グラフ全体を流れる状態)

| カテゴリ | フィールド | 説明 |
|---------|-----------|------|
| **入力** | `envelope` | RequestEnvelope |
| **分類** | `mode` | ShannonMode (minecraft_action, minecraft_emergency, conversational, task_execution, planning, etc.) |
| | `intent` | 短い意図記述 |
| | `riskLevel` | 'low' / 'mid' / 'high' |
| | `needsTools` | boolean |
| | `needsPlanning` | boolean |
| **感情** | `emotion` | EmotionType (emotion名 + Plutchik 8次元パラメータ) |
| **記憶** | `memoryPrompt` | フォーマット済み記憶テキスト |
| | `userProfile, selfModel, relationshipModel` | 構造化記憶データ |
| | `strategyUpdates, internalState, worldModelPatterns` | 戦略・内部状態・世界モデル |
| | `*Prompt` (relationship, selfModel, strategy, internalState, worldModel) | 各記憶のプロンプト文字列 |
| **実行** | `selectedModel` | 選択されたLLMモデル名 |
| | `craftPlan` | CraftPlan (決定論的クラフト分析) |
| | `allowedTools` | フィルタ済みツールリスト |
| | `toolCalls` | 蓄積されたツール呼び出し記録 |
| **出力** | `actionPlan` | ShannonActionPlan |
| | `finalAnswer` | ユーザー向け応答テキスト |
| | `trace` | デバッグログパス |
| **コールバック** | `_onToolStarting, _onTaskTreeUpdate, _onRequestSkillInterrupt` | リアルタイムUI更新用 |
| | `_abortSignal` | キャンセルシグナル |
| | `_emotionState` | 共有感情オブジェクト |

---

## 3. ノード詳細

### 3.1 Ingest Node

**LLM呼び出し**: なし (決定論的)

```
入力: envelope
処理: inferInitialMode(envelope) でモード推定
出力: { mode, trace: ['node:ingest'] }

ルーター:
  envelope.tags.includes('emergency') → emergency_fastpath
  else → classify
```

### 3.2 Emergency Fastpath Node

**LLM呼び出し**: なし (分類をスキップ)

```
入力: envelope
処理:
  - mode = 'minecraft_emergency'
  - riskLevel = 'high'
  - needsTools = true
  - needsPlanning = false
  - selectedModel = ModelSelector.selectInitialModel('high', false, 'minecraft_emergency')
出力: 上記の分類結果
効果: -7〜18秒の短縮 (classify/emotion/recall 全スキップ)
```

### 3.3 Classify Node

#### Minecraft チャネル (ヒューリスティック、LLM不使用)

```
緊急キーワード検出: /緊急|emergency|attack|死|help|助けて|hostile|ゾンビ|スケルトン|クリーパー/i
  → mode='minecraft_emergency', riskLevel='high', needsPlanning=false

クラフトキーワード検出: /作って|craft|ツルハシ|pickaxe|剣|sword|鎧|armor|精錬|smelt|建て|build/i
  → needsPlanning=true (テキスト長 > 50 でも true)

モデル選択:
  minecraft_emergency + !needsPlanning → gpt-4.1-mini
  minecraft_action + needsPlanning    → gpt-5-mini-fast
  minecraft_action + !needsPlanning   → gpt-4.1-mini
```

#### 他チャネル (LLM使用)

```
LLMモデル: gpt-4.1-mini
入力: envelope.text + チャネルコンテキスト
スキーマ: ClassifySchema { mode, intent, riskLevel, needsTools, needsPlanning }
出力: 分類結果

モデル選択:
  riskLevel='high'                     → gpt-5
  riskLevel='mid' + needsPlanning=true → gpt-5-mini-fast
  default                              → gpt-4.1-mini
```

#### Classify ルーター

```
channel === 'minecraft' → ['recall', 'craft_preflight']  (並列、emotion スキップ)
else                     → ['emotion_step', 'recall']     (並列)
```

### 3.4 Emotion Node

**LLMモデル**: `gpt-5-mini`

```
入力:
  - userMessage: ユーザーメッセージ
  - emotionState (optional): 現在の感情状態
  - environmentState: 環境情報

スキーマ: EmotionSchema
出力:
  - emotion: string (例: "喜び", "期待", "不安", "驚き")
  - parameters: {
      joy, trust, fear, surprise, sadness, disgust, anger, anticipation
    } (各 0-100)

基盤: Plutchik の感情の輪モデル (8次元)
```

### 3.5 Recall Node

#### Minecraft (軽量モード)

```
呼び出し: scopedMemory.recall({ lightweightMode: true })
スキップ: person/selfModel/relationship プロファイル, セマンティック検索
取得: strategyUpdates + worldModelPatterns のみ
効果: -1〜4秒の短縮
```

#### 他チャネル (フルリコール)

```
呼び出し: scopedMemory.recall({ lightweightMode: false })
取得:
  - userProfile (PersonMemory DB)
  - selfModel (自己モデル)
  - relationshipModel (関係性モデル)
  - strategyUpdates (戦略更新)
  - internalState (内部状態: curiosity, caution, confidence, warmth, focus, load)
  - worldModelPatterns (世界モデルパターン)
  - memories (セマンティック + タグベース検索)

Webチャネル追加: loadPublicKnowledge(userText) でキーワードベースRAG
```

### 3.6 Craft Preflight Node

**LLM呼び出し**: なし (完全に決定論的)

```
処理:
  1. テキストからクラフト対象を正規表現で抽出 (snake_case + JP アイテム名マッピング)
  2. RecipeDependencyResolver で依存関係ツリー構築
  3. インベントリ照合で実際の不足素材を計算
  4. 近傍インフラ検出 (crafting_table, furnace) ← 8m 半径
  5. 即時クラフト可否判定

出力: CraftPlan {
  target, count, canCraftImmediately,
  materialStatus: 'sufficient' | 'partial' | 'missing',
  missingMaterials, steps, nearbyInfra,
  promptInjection: string   ← FCA システムプロンプトに注入
}

PlanState 生成 (craftPlanToPlanState):
  CraftPlan → PlanState 変換 (canCraftImmediately=false の場合):
  1. 不足素材 → mine サブタスク (例: "cobblestoneを8個入手する")
  2. インフラ設置 → setup サブタスク (crafting_table, furnace)
  3. 精錬 → smelt サブタスク
  4. 最終クラフト → craft サブタスク
  → ParallelExecutor 経由で blackboard.updatePlan() に注入

効果: LLM の「素材がないのにクラフト」等のエラーを予防 (5-10 イテレーション節約)
```

### 3.7 Execute Node

→ [5. 認知並列システム](#5-認知並列システム-cognitive-parallel) で詳述

### 3.8 Format Node

```
処理: actionFormatterNode() でチャネル別にフォーマット
  - Minecraft: finalAnswer + taskTree → MinecraftAction[] (move_to, mine, craft, etc.)
  - Discord: reply / react / send_embed / voice_speak
  - X: reply / post / quote / draft
  - Web: テキスト応答

※ Minecraft の chat は FCA 実行中に既に送信済み (重複防止のため format では追加しない)
```

### 3.9 Writeback Node

```
処理: ScopedMemoryService に会話エクスチェンジを保存
  - Fire-and-forget (応答をブロックしない)
  - { role, content, timestamp }
```

---

## 4. LLM モデル選択 (ModelSelector)

**ファイル**: `backend/src/services/llm/graph/cognitive/ModelSelector.ts`

### エスカレーションチェーン

| Tier | モデル | Temperature | MaxTokens | Timeout | 備考 |
|------|--------|-------------|-----------|---------|------|
| 0 | `gpt-4.1-mini` | 1 | 1024 | 15s | 最軽量・最速 |
| 1 | `gpt-5-mini-fast` | — | — | 30s | reasoning_effort='low', verbosity='low' |
| 2 | `gpt-5-mini` | — | — | 60s | reasoning_effort='medium', verbosity='medium' |
| 3 | `gpt-5` | — | 4096 | 120s | 最高性能 |

### 初期選択ロジック

```typescript
selectInitialModel(riskLevel, needsPlanning, mode):
  minecraft_emergency or minecraft_action → gpt-4.1-mini (Tier 0)
  riskLevel='high'                        → gpt-5 (Tier 3)
  riskLevel='mid' + needsPlanning=true    → gpt-5-mini-fast (Tier 1)
  default                                 → gpt-4.1-mini (Tier 0)
```

### エスカレーション/デエスカレーション

```
エスカレーション条件:
  - MetaCognitionLoop: assessment='struggling'/'stuck'/'wrong_approach' → escalate
  - LoopDetector: 70%+ 失敗率 → needsEscalation=true → escalate
  - 自動: consecutiveFailures >= 5 → escalate

デエスカレーション条件:
  - MetaCognitionLoop: modelAction='deescalate'
  - 自動: consecutiveSuccesses >= 8 → deescalate

Minecraft プラットフォーム制限:
  setMaxEscalationLevel('gpt-5-mini-fast')
  → gpt-5 へのエスカレーションをブロック (レイテンシ優先)
```

---

## 5. 認知並列システム (Cognitive Parallel) — v2

**ファイル**: `backend/src/services/llm/graph/cognitive/`

### アーキテクチャ

```
┌───────────────────────────────────────────────────────────────┐
│                    CognitiveBlackboard                         │
│                (共有ワーキングメモリ)                           │
│                                                               │
│  Events: emotion:updated, meta:updated, task:updated,         │
│          plan:updated, loop:detected, emotion:shifted,        │
│          completed                                            │
│                                                               │
│  State: emotionState, metaState, taskState, selfState,        │
│         planState (再帰サブタスク + journalSummary),           │
│         initialMemoryContext                                  │
└──────┬──────────────┬──────────────┬──────────────┬───────────┘
       │              │              │              │
┌──────▼──────┐ ┌─────▼──────┐ ┌────▼──────┐ ┌────▼──────────┐
│ EmotionLoop │ │ MetaCog    │ │ TaskFCA   │ │ MemoryAgent   │
│ (扁桃体)    │ │ FCA(DLPFC) │ │ (運動野)  │ │ (海馬)        │
│             │ │            │ │           │ │               │
│ gpt-5-mini  │ │ gpt-4.1-  │ │ Dynamic   │ │ gpt-4.1-mini  │
│             │ │ mini       │ │(Selector) │ │               │
    └─────────────┘ └────────────┘ └───────────────────┘
         │                │                │
         └────────────────┴────────────────┘
                   Promise.all()
```

### ParallelExecutor

```typescript
// MemoryAgent を初期化 (非同期で初期記憶を取得開始)
const memoryAgent = new MemoryAgent(blackboard, envelope);
const initialMemoryPromise = memoryAgent.initialize(goal);

// MemoryAgent をツールに注入 (recall-memory, save-memory, plan-craft)
for (const tool of fca.getTools()) {
  if ('setMemoryAgent' in tool) tool.setMemoryAgent(memoryAgent);
  if ('setBlackboard' in tool) tool.setBlackboard(blackboard);
}

// 初期プラン注入 (CraftPreflight 結果がある場合、後方互換)
if (state.craftPlan) {
  const planState = craftPlanToPlanState(state.craftPlan, goal);
  blackboard.updatePlan(planState);  // → 'plan:updated' イベント発火
}

// 4プロセスを並列起動
await Promise.all([
  fca.run(wrappedState, blackboard.signal),       // タスク実行
  emotionLoop?.run() || Promise.resolve(),         // 感情評価 (初回 tick 即座)
  metaLoop?.run() || Promise.resolve(),            // メタ認知評価 (FCA化)
  memoryAgent.run(blackboard.signal),              // 記憶エージェント
]);
// → 3秒タイムアウトで emotion/meta/memory の完了を待つ
```

**Minecraft 最適化**:
- `skipEmotionLoop = true` (常にスキップ)
- `skipMetaCognition = !needsPlanning && !isEmergency` (単純タスクはスキップ)
- 代替: 軽量自動エスカレーション (5連続失敗 → escalate)

### 5.1 EmotionLoop (扁桃体)

**LLMモデル**: `gpt-5-mini`

```
トリガー:
  - task:updated イベント (デバウンス 10秒)
  - meta:updated イベント (即座)

LLM入力:
  - messages: 会話履歴
  - recentResults: 直近5件のツール実行結果
  - currentEmotion: 現在の感情状態

LLM出力: EmotionSchema { emotion, parameters }

更新: blackboard.emotionState → 'emotion:updated' イベント発火
```

### 5.2 MetaCognitionLoop (DLPFC — 前頭前皮質)

**LLMモデル**: `gpt-4.1-mini` (ハードコード)

```
トリガー:
  - task:updated イベント (3イテレーションごと)
  - loop:detected イベント (即座)
  - emotion:shifted イベント (即座)

LLM入力:
  - goal: タスクゴール
  - taskState: { iteration, recentToolCalls, thinking }
  - inventory: 現在のインベントリ
  - metaState: 前回の評価結果
  - plan: 現在のプラン状態 (存在する場合)
    - 各サブタスクのステータス・イテレーション数
    - 現在のサブタスクID

LLM出力: MetaOutputSchema {
  assessment: 'on_track' | 'struggling' | 'stuck' | 'wrong_approach',
  suggestion: string,       // FCA へのフィードバック
  modelAction: 'escalate' | 'deescalate' | 'hold',
  shouldStop: boolean,
  // プラン管理 (plan 存在時のみ有効):
  currentSubtaskId: string | null,   // 現在のサブタスクID切り替え
  subtaskUpdates: [{                 // サブタスクステータス更新
    id: string,
    status: 'completed' | 'error' | 'skipped',
    result?: string,
    failureReason?: string,
  }]
}

プラン評価ルール:
  - サブタスク 5iter 以上 in_progress + 成功率 50% 以下 → status='error' + 代替提案
  - 完了したサブタスクは status='completed' に更新
  - currentSubtaskId を実際の進捗に合わせて更新

アクション:
  assessment='wrong_approach' or 'stuck' → onRequestSkillInterrupt()
  modelAction='escalate'                 → modelSelector.escalate()
  modelAction='deescalate'               → modelSelector.deescalate()
  consecutiveFailures >= 5               → 強制エスカレーション
  consecutiveSuccesses >= 8              → 強制デエスカレーション
  suggestion あり + assessment != 'on_track' → FCA.addFeedback(suggestion)
  shouldStop=true                        → blackboard.complete()
  subtaskUpdates あり                    → blackboard.patchPlanSubtask() で個別更新
  currentSubtaskId 変更                  → 前サブタスク pending に戻す + 新サブタスク in_progress に
```

### 5.3 PlanState (前頭前皮質 — 計画管理)

CognitiveBlackboard 上の一級状態。感情やメタ認知と同列に管理される。

```
データ構造:
  PlanState {
    goal: string,
    strategy: string,
    subtasks: PlanSubtask[],
    currentSubtaskId: string | null,
    lastUpdatedBy: 'craft_preflight' | 'meta_cognition' | 'fca',
    createdAt: number,
    updatedAt: number,
  }

  PlanSubtask {
    id: string,              // "st_1", "st_2", ...
    goal: string,            // "cobblestoneを8個入手する"
    status: 'pending' | 'in_progress' | 'completed' | 'error' | 'skipped',
    result?: string,
    failureReason?: string,
    iterationsSpent: number, // このサブタスクに費やしたイテレーション数
  }

ライフサイクル:
  1. CraftPreflightNode → craftPlanToPlanState() → 初期プラン生成
  2. ParallelExecutor → blackboard.updatePlan() → プラン注入
  3. 毎イテレーション → blackboard.incrementSubtaskIteration()
  4. MetaCognitionLoop → patchPlanSubtask() で進捗更新・stuck 検出
  5. 'plan:updated' イベント → 他プロセスに通知

データフロー:
  CraftPreflight ─→ blackboard.updatePlan(initialPlan)
                             │
                             ▼  'plan:updated' event
                    ┌─── CognitiveBlackboard ───┐
                    │  emotion  meta  plan  task │
                    └────────────────────────────┘
                             │
               ┌─────────────┼──────────────┐
               ▼             ▼              ▼
          EmotionLoop  MetaCognitionLoop   FCA
                             │
                    reads plan + task
                    evaluates subtask progress
                    updates plan via patchPlanSubtask()
                    feedback: "サブタスクX失敗→代替Y実行"
```

---

## 6. FunctionCallingAgent (FCA) メインループ

**ファイル**: `backend/src/services/llm/graph/nodes/FunctionCallingAgent.ts`

### 初期化

```
1. ModelSelector(selectedModel) — 初期モデル設定
2. Minecraft: setMaxEscalationLevel('gpt-5-mini-fast')
3. ツールフィルタリング:
   - allowedTools 指定時 → 許可リストのみ
   - Minecraft チャネル → 非MC ツール除外
   - チャネル別無効出力ツール除外
4. modelSelector.bindTools(effectiveTools)
```

### システムプロンプト構築

```
Phase 1: PromptBuilder.buildSystemPrompt()
  ├── Shannon プロフィール (web/discord のみ)
  ├── 感情情報 + パラメータ
  ├── 環境状態 (Minecraft: position, weather 等)
  ├── 記憶セクション (relationship, selfModel, strategy, internalState, worldModel)
  ├── プラットフォーム別ルール
  ├── ツール使用ガイドライン
  ├── 動的ルール (self_improvement_rules.json, target='prompt', 60秒キャッシュ)
  └── 応答フォーマットルール

Phase 2 (並列注入):
  ├── WorldKnowledgeService (Minecraft: ボット周辺の世界コンテキスト)
  ├── TaskEpisodeMemory (関連する過去エピソードをフォーマット)
  └── CraftPlan.promptInjection OR RecipeDependency プロンプト

会話履歴: 直近10メッセージ (最新9件はhuman のみフィルタ)
ユーザーメッセージ: HumanMessage として末尾に追加
```

### メインループ (最大50イテレーション)

```
for iteration = 0..50:

  ┌─ 1. アボートチェック ─────────────────────────────────┐
  │  signal?.aborted → throw                              │
  │  5分超過 → break                                      │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 2. フィードバック注入 ───────────────────────────────┐
  │  pendingFeedback[] → HumanMessage として注入          │
  │  [メタ認知] プレフィクスで重複排除                    │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 3. コンテキストトリミング ───────────────────────────┐
  │  trimContext(messages, maxContextTokens=16000)         │
  │  システムプロンプト + 最新メッセージを制限内に保持     │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 4. エフェメラルメッセージ注入 ───────────────────────┐
  │  ThinkingManager コンテキスト (最近の思考の要約)       │
  │  感情更新 (joy, trust, anticipation 値)               │
  │  ※ LLM 応答後に削除 (蓄積防止)                       │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 5. LLM 呼び出し ★ ──────────────────────────────────┐
  │  モデル: modelSelector.currentModel (動的)            │
  │  タイムアウト: modelSelector.timeoutMs                │
  │  入力: messages 配列 (system + history + user + ephemeral) │
  │  出力: AIMessage (text and/or tool_calls)             │
  │  トークン記録: tokenTracker.record()                  │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 6. ツール呼び出し判定 ──────────────────────────────┐
  │  tool_calls なし:                                     │
  │    needsTools=false + text あり → 即完了 return       │
  │    consecutiveTextOnly >= 3 → break                   │
  │    else → ナッジメッセージ注入, continue              │
  │  tool_calls あり:                                     │
  │    → 次のステップへ                                   │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 7. ForwardModel 予測ブロック ────────────────────────┐
  │  各ツール呼び出しに対して ForwardModel.predict()      │
  │  (task-complete, update-plan は除外)                  │
  │                                                       │
  │  予測ソース:                                          │
  │  a) 学習済みパターン (同条件2回以上失敗)              │
  │  b) ルールベースチェック:                             │
  │     - activate-block: move-to なしで距離エラー後      │
  │     - start-smelting: 距離エラー後                    │
  │     - craft-one: crafting_table 未アクティベート      │
  │     - move-to: 同一地点でスタック                     │
  │                                                       │
  │  LoopDetector.isCallBlocked():                        │
  │     3回連続同一呼び出し失敗 → ブロック                │
  │                                                       │
  │  ブロック時: ToolMessage で理由注入, ツール実行スキップ │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 8. LoopDetector 警告 ───────────────────────────────┐
  │  3+ 同一呼び出し失敗                                  │
  │  5+ ツール失敗                                        │
  │  70%+ 失敗率                                          │
  │  → ツールブロック + 脱出プロンプト注入                │
  │  → モデルエスカレーション (非 Minecraft)              │
  │                                                       │
  │  永久ブロック防止:                                    │
  │  - pardonedAfterIndex: 成功後のインデックスを記録     │
  │  - settled set: ストリーク計算で成功済みツールを除外  │
  │  - detect() 内で既にブロック中のツールをスキップ      │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 9. ツール実行 ──────────────────────────────────────┐
  │  ToolExecutor.executeToolCalls(toolCalls, toolMap)    │
  │  → iterationResults (ExecutionResult[])               │
  │  → onToolsExecuted() 非同期発火 (EmotionLoop トリガー) │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 10. task-complete チェック ──────────────────────────┐
  │  task-complete が含まれる → summary 抽出              │
  │  awaitingUser 判定 (回復失敗 + "?" 含む)             │
  │  → return { taskTree: completed/in_progress }        │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 11. ForwardModel 学習 ──────────────────────────────┐
  │  成功 → learnedPatterns クリア                        │
  │  失敗 → learnedPatterns に追加                        │
  │  move-to 成功 → 距離関連パターンもクリア              │
  └───────────────────────────────────────────────────────┘
          │
  ┌─ 12. UI 更新 ────────────────────────────────────────┐
  │  TaskTreePublisher.publishTaskTree()                  │
  │  metaState, emotionState を含む                       │
  └───────────────────────────────────────────────────────┘
          │
          ▼
       次のイテレーションへ
```

### 終了条件

| 条件 | 結果 |
|------|------|
| `task-complete` ツール呼び出し | status='completed' で return |
| MAX_ITERATIONS (50) 到達 | status='error' で return |
| consecutiveTextOnly >= 3 | break → error |
| MetaCognition `shouldStop=true` | blackboard.complete() |
| signal aborted | throw |
| 5分超過 | break |

---

## 7. ツール一覧と情報渡し

### 7.1 汎用ツール (全チャネル共通)

| ツール名 | 説明 | LLM に渡される主要パラメータ |
|---------|------|---------------------------|
| `task-complete` | タスク完了宣言 | summary: string |
| `update-plan` | ゴール・戦略・サブタスク更新 | goal, strategy, subTasks |
| `wait` | 指定秒数待機 | seconds (希望-5秒) |

### 7.2 Discord ツール

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `chat-on-discord` | メッセージ送信 | message, imageUrl? |
| `get-discord-recent-messages` | 履歴取得 | limit (1-30) |
| `get-discord-images` | 画像URL抽出 | — |
| `get-server-emoji-on-discord` | カスタム絵文字一覧 | — |
| `react-by-server-emoji-on-discord` | 絵文字リアクション | emojiId |

### 7.3 画像ツール

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `create-image` | AI画像生成 | prompt |
| `describe-image` | 画像分析 | imageUrl |
| `edit-image` | 画像編集 | imagePath, editPrompt |
| `describe-notion-image` | Notion画像分析 | imageUrl |

### 7.4 X/Twitter ツール

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `post-on-twitter` | ツイート投稿/返信 | text, inReplyTo? |
| `like-tweet` | いいね | tweetId |
| `retweet-tweet` | リツイート | tweetId |
| `quote-retweet` | 引用リツイート | tweetId, comment |
| `get-x-or-twitter-post-content-from-url` | ツイート内容取得 | url |
| `generate-tweet-text` | ツイート文生成 | topic |

### 7.5 Web 検索・情報ツール

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `google-search` | Google Custom Search | query, dateRestrict?, siteSearch? |
| `fetch-url` | URL コンテンツ取得 | url |
| `search-by-wikipedia` | Wikipedia 検索 | query, lang (ja/en) |
| `search-weather` | 天気データ | location |
| `wolfram-alpha-tool` | 数学・科学クエリ | query |

### 7.6 コンテンツ取得ツール

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `get-youtube-video-content-from-url` | YouTube 動画情報 | url |
| `get-notion-page-content-from-url` | Notion ページ | url |
| `chat-on-web` | ShannonUI へメッセージ | message |

### 7.7 メモリツール

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `save-experience` | 体験記憶保存 | content |
| `recall-experience` | 体験記憶検索 | query |
| `save-knowledge` | 知識記憶保存 | content |
| `recall-knowledge` | 知識記憶検索 | query |
| `recall-person` | 人物情報検索 | personName |

### 7.8 Minecraft ツール (Minebot プラットフォーム専用)

| ツール名 | 説明 | 主要パラメータ |
|---------|------|---------------|
| `move-to` | 指定座標へ移動 | x, y, z, range?, goalType? |
| `mine-block` | ブロック採掘 | blockName, count, searchRadius? |
| `dig-block-at` | 指定座標のブロック破壊 | x, y, z, collect? |
| `craft-one` | アイテムクラフト | itemName, count |
| `start-smelting` | 精錬開始 | x, y, z, inputItem, fuelItem, count |
| `drop-item` | アイテム投棄 | itemName, count |
| その他生成スキル | SkillHotLoader で動的追加 | スキル定義による |

### ツールフィルタリングルール

```
1. allowedTools 指定時 → 許可リストのみ使用可能
2. Minecraft チャネル → 非 MC ツール除外 (Discord/X/Web/Image 等)
3. チャネル別に特定出力ツール無効化
4. ボイスチャネル → さらに制限されたツールセット
```

---

## 8. PromptBuilder — LLM に渡す情報の全体像

**ファイル**: `backend/src/services/llm/graph/nodes/prompt/PromptBuilder.ts`

### システムプロンプト構成

```
┌─────────────────────────────────────────────────────────┐
│ 1. イントロ & レスポンス指示                            │
│    - "You are AGI 'Shannon'"                            │
│    - プラットフォーム別出力ルール                        │
│    - needsTools 分類ヒント                              │
├─────────────────────────────────────────────────────────┤
│ 2. 思考 & 行動ルール                                    │
│    - ツール呼び出し前に1-2文の推論を述べる              │
│    - task-complete は完了時のみ呼ぶ                      │
├─────────────────────────────────────────────────────────┤
│ 3. 現在の状態                                           │
│    - 時刻 (JST)                                         │
│    - プラットフォーム情報                                │
│      Discord: guild/channel/user                        │
│      Minecraft: position/inventory/health/nearby        │
│    - 感情状態 (joy/trust/anticipation パラメータ)       │
│    - 環境情報 (非 Minecraft のみ)                       │
├─────────────────────────────────────────────────────────┤
│ 4. 記憶 & 関係性コンテキスト                            │
│    - relationshipPrompt (関係性モデル)                   │
│    - selfModelPrompt (自己モデル)                       │
│    - strategyPrompt (戦略更新)                          │
│    - internalStatePrompt (内部状態)                     │
│    - worldModelPrompt (世界モデルパターン)              │
│    - memoryPrompt (検索された経験/知識)                 │
├─────────────────────────────────────────────────────────┤
│ 5. 静的ルール (Minecraft 専用)                          │
│    - 30+ 行の行動ルール                                 │
│    - 採掘/クラフト/精錬/ツール取扱い                    │
│    - 座標処理, ツール要件, 失敗回復パターン             │
│    - かまどワークフロー (find → check → smelt → withdraw)│
├─────────────────────────────────────────────────────────┤
│ 6. 動的ルール ★ (自己改善注入)                          │
│    - self_improvement_rules.json から読込               │
│    - target='prompt' && enabled=true のルールのみ       │
│    - 60秒キャッシュ TTL                                 │
│    - 例: "石のツルハシ使用前に棒の在庫確認"             │
├─────────────────────────────────────────────────────────┤
│ 7. 応答フォーマットガイドライン                          │
│    - Discord Markdown                                    │
│    - URL 参照ルール                                     │
│    - 画像添付ルール                                     │
├─────────────────────────────────────────────────────────┤
│ 8. メモリガイドライン                                    │
│    - save-experience/save-knowledge の使用条件           │
│    - recall-* の使用条件                                │
│    - プライバシー制約                                    │
├─────────────────────────────────────────────────────────┤
│ 9. 画像編集ガイドライン                                  │
│    - get-discord-images → edit-image フロー             │
│    - describe-image で内容確認                           │
└─────────────────────────────────────────────────────────┘
```

### 追加注入 (FCA 初期化時に並列)

```
┌─ WorldKnowledgeService ────────────────────────────────┐
│  Minecraft: ボット位置周辺の世界コンテキスト            │
│  (地形, 近傍ブロック, エンティティ)                     │
└────────────────────────────────────────────────────────┘

┌─ TaskEpisodeMemory ────────────────────────────────────┐
│  過去の関連エピソードをフォーマット                      │
│  (同種のタスクの成功/失敗パターン)                      │
└────────────────────────────────────────────────────────┘

┌─ CraftPlan.promptInjection ────────────────────────────┐
│  決定論的クラフト分析結果                                │
│  "【クラフト分析】" セクション                           │
│  OR RecipeDependency フォールバック                     │
└────────────────────────────────────────────────────────┘
```

### イテレーション中のエフェメラル注入 (毎回)

```
- ThinkingManager サマリー (最近の思考の要約)
- 感情更新 (joy, trust, anticipation 値)
- MetaCognition フィードバック (suggestion テキスト)
※ LLM 応答後に即削除 (コンテキスト蓄積防止)
```

---

## 9. メモリシステム (ScopedMemoryService)

**ファイル**: `backend/src/services/memory/scopedMemoryService.ts`

### リコールフロー

```
┌─ ScopedRecallQuery ────────────────────────────────────┐
│  envelope: RequestEnvelope                              │
│  text: string                                           │
│  lightweightMode?: boolean                              │
└───────────────┬────────────────────────────────────────┘
                │
    ┌───────────┴──────────────┐
    │ lightweightMode = true   │ (Minecraft fast path)
    │                          │
    │ 取得: strategyUpdates,   │
    │       worldModelPatterns │
    │ スキップ: person,        │
    │   selfModel, relationship│
    │   semantic search        │
    │ 時間: < 4秒              │
    └──────────────────────────┘

    ┌───────────────────────────┐
    │ lightweightMode = false   │ (Full recall)
    │                           │
    │ 並列クエリ:               │
    │  - recallPerson()         │
    │  - selfModel              │
    │  - strategyUpdates        │
    │  - internalState          │
    │  - worldModelPatterns     │
    │  - semantic + tag search  │
    │                           │
    │ 後処理:                   │
    │  - 重複排除               │
    │  - プライバシーフィルタ   │
    │  - ランキング:            │
    │    semantic similarity    │
    │    + same_user bonus      │
    │    + same_channel bonus   │
    │    + recency bonus        │
    │                           │
    │ Web チャネル追加:         │
    │  + loadPublicKnowledge()  │
    └───────────────────────────┘

出力: ScopedRecallResult {
  person, memories, userProfile,
  relationshipModel, selfModel,
  strategyUpdates, internalState, worldModelPatterns,
  formattedPrompt,
  *Prompt (各記憶のプロンプト文字列)
}
```

### Public Knowledge (Web チャネル RAG)

**ファイル**: `backend/src/data/public_knowledge.json`

```
カテゴリ:
  - about_aiminelab: チーム情報, メンバー
  - member_*: 個人プロフィール
  - shannon_identity: 自己認識
  - shannon_personality: 性格特性
  - shannon_capabilities_*: スキル, 制限事項
  - shannon_emotion_system: Plutchik 8次元モデル
  - tech_stack: 技術スタック
  - architecture_*: アーキテクチャ情報

検索: キーワードベース (タグマッチ重み3, コンテンツキーワード重み2, カテゴリマッチ重み1)
上限: 最大6エントリ
```

### ライトバック

```
非同期キュー: processPendingWritebacks() で3秒ごとに統合書き込み
スコープメタデータ: channel, user, visibility
AutonomyUpdater: 自律性トラッキング (独立性の許可度合い)
```

---

## 10. Minebot アーキテクチャ

### システム構成

```
┌──────────────────────────────────────────────────────────────┐
│                        SkillAgent                            │
│                    (オーケストレーションハブ)                  │
├──────────┬───────────────┬────────────┬──────────────────────┤
│          │               │            │                      │
│  SkillLoader      SkillRegistrar   MinebotTask     EventReaction │
│  SkillCompiler    SkillHotLoader   Runtime         System        │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ InstantSkills    │  │ ConstantSkills   │                 │
│  │ - moveTo         │  │ - autoEat        │                 │
│  │ - mineBlock      │  │ - (generated)    │                 │
│  │ - digBlockAt     │  │                  │                 │
│  │ - craftOne       │  │                  │                 │
│  │ - startSmelting  │  │                  │                 │
│  │ - (generated)    │  │                  │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ MinebotHttp      │  │ RecipeDependency │                 │
│  │ Server           │  │ Resolver         │                 │
│  └──────────────────┘  └──────────────────┘                 │
└──────────────────────────────────────────────────────────────┘
```

### 10.1 SkillAgent (メインオーケストレーター)

**ファイル**: `backend/src/services/minebot/skillAgent.ts`

```
初期化フロー:
  1. SkillLoader, SkillRegistrar, MinebotTaskRuntime, EventReactionSystem, MinebotHttpServer 作成
  2. initSkills() → InstantSkills + ConstantSkills をディスクから読み込み
  3. registerInstantSkills() → EventBus に登録
  4. registerConstantSkills() → 定期イベント (100ms, 1000ms, 5000ms) にアタッチ
  5. registerEventBusSubscriptions() → ボイスチャット・スキルリロード

チャット処理:
  "シャノン、" プレフィクス → processMessage() → TaskRuntime.invoke()

コマンド:
  ".."  → スキル一覧
  "..." → コンスタントスキル一覧
  "./skill" → InstantSkill 実行
  "../skill" → ConstantSkill トグル
```

### 10.2 MinebotTaskRuntime (タスク実行エンジン)

**ファイル**: `backend/src/services/minebot/runtime/MinebotTaskRuntime.ts`

```
コアアーキテクチャ:
  - executor: LLMService.invokeGraph() を呼ぶ UnifiedExecutor 関数
  - taskQueue: FIFO キュー (pause/resume 対応)
  - emergencyTask: 単一スロット緊急タスク
  - currentState: アクティブタスク実行状態

タスク状態遷移:
  pending → executing → success/failure/awaiting_user/paused

  awaiting_user: グラフ一時停止、人間のフィードバック待ち
  failed_terminal: 回復不可能な失敗
  emergency: 現在タスクをプリエンプト

Envelope 生成:
  各 invoke() で新鮮なデータを使用:
  - 現在のボット位置, 体力, 食料, インベントリ
  - nearbyInfrastructure: 8m 半径スキャン (crafting_table, furnace, chest 等)
  - tags: ['minecraft'] + ['emergency'] (緊急時)
```

### 10.3 EventReactionSystem (自律イベントハンドラ)

**ファイル**: `backend/src/services/minebot/eventReaction/EventReactionSystem.ts`

```
10 イベントタイプ:
  player_facing, player_speak, hostile_approach, item_obtained,
  time_change, weather_change, biome_change, teleported, damage, suffocation

反応タイプ:
  'immediate' → コンスタントスキル直接実行
  'task'      → TaskRuntime キューに追加
  'emergency' → プリエンプト実行
  'info'      → ログのみ

ポーリング間隔:
  environmentCheck: 1秒 (time, weather, biome, teleport)
  statusCheck: 1秒 (inventory 変化)
  hostileCheck: 500ms (mob 近接検知)

緊急応答フロー:
  1. damage イベント検出
  2. executeReflexiveFlee(): 最も近い敵と反対方向にスプリントジャンプ (LLM 待たない)
  3. interruptForEmergency(): 現在タスク一時停止、isExecuting クリア待ち (2秒)
  4. invoke(): 緊急コンテキストで LLM 実行
  5. resumePreviousTask(): 緊急完了後に元タスク復帰
```

### 10.4 スキルシステム

#### InstantSkill (アトミックアクション)

```
基底クラス: InstantSkill
実行: runImpl() 内で同期的
中断: bot.interruptExecution フラグ (100ms ポーリング)
タイムアウト: maxDurationMs (デフォルト 120秒)
結果キャッシュ: クエリ型スキル用 (位置認識)
```

| スキル | 説明 | 主要ロジック |
|--------|------|-------------|
| **moveTo** | 座標移動 | pathfinder 統合, スタック検出 (1.5秒ポーリング×7回), 段階的解除試行 (jump→back+jump→strafe→reroute), 30秒タイムアウト, 1000m距離制限 |
| **mineBlock** | ブロック採掘 | move-to + dig-block-at ループ, ブロック存在検証, ピッケル有無チェック |
| **digBlockAt** | 座標ブロック破壊 | 距離チェック (≤5m), ツール選択・装備, 遅い採掘検出 (>5s), ユーティリティブロック保護 |
| **craftOne** | アイテムクラフト | crafting_table 検出・アクティベート, 素材検証, 部分成功サポート |
| **startSmelting** | 精錬 | かまどオープン, スロット確認, 再開モード, 燃料計算 (FUEL_SMELTS テーブル), 完成品自動回収 |

#### ConstantSkill (バックグラウンドタスク)

```
基底クラス: ConstantSkill
優先度ベース実行 (高優先度が低優先度をブロック)
containMovement フラグ: InstantSkill 実行中は実行抑制
isCritical フラグ: サバイバルスキル (autoEat) はブロック回避
ロック: 同時実行防止
```

| スキル | 間隔 | 説明 |
|--------|------|------|
| **autoEat** | 1000ms | health < 18 で最高栄養食品を消費 |
| (生成スキル) | 動的 | SelfImprovementDaemon が生成 |

### 10.5 スキル読み込み & ホットリロード

```
SkillLoader:
  - instantSkillDir + generated/ サブディレクトリを読み込み
  - constantSkillDir + generated/ サブディレクトリを読み込み
  - ES6 import() + キャッシュバスティング (?v=Date.now())

SkillRegistrar:
  - registerInstantSkills(): EventBus 'minebot:{skillName}' に登録
  - registerConstantSkills(): 定期イベント (taskPer{interval}ms) にアタッチ
  - ホットリロード対応: registerSingleInstantSkill(), registerSingleConstantSkill()

SkillCompiler:
  - TypeScript → JavaScript コンパイル
  - 一時 tsconfig 生成 → npx tsc 実行
  - 生成スキルの自己改善用

SkillHotLoader:
  - loadAndRegisterInstantSkill(): import → create → add to bot → register EventBus → register LLM tool
  - マニフェスト管理: 名前, タイプ, ソース, コンパイルパス, 作成日, 理由, 有効/無効, 使用回数
  - 上限: 20 生成スキル
```

### 10.6 HTTP サーバー

**ファイル**: `backend/src/services/minebot/http/MinebotHttpServer.ts`

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/throw_item` | POST | アイテム投棄 |
| `/constant_skill_switch` | POST | スキルトグル |
| `/reaction_setting_update` | POST | イベント設定更新 |
| `/reaction_settings_reset` | POST | 設定リセット |
| `/reaction_settings` | GET | 設定取得 |
| `/chat_message` | POST | チャットルーティング |
| `/task_list` | GET | タスク状態取得 |
| `/task_delete` | POST | タスク削除 |
| `/task_prioritize` | POST | タスク優先度変更 |
| `/voice_mode` | POST | ボイスモードトグル |
| `/voice_ptt` | POST | PTT コントロール |

---

## 11. 自己改善システム (SelfImprovementDaemon)

**ファイル**: `backend/src/services/llm/graph/cognitive/selfImprove/`

### アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                  SelfImprovementDaemon                      │
│                     (シングルトン)                           │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ FailureAnalyzer │ Improvement  │ SkillIdeator │ Effectiveness │
│ (失敗分析)      │ Generator    │ (スキル生成) │ Tracker       │
│                 │ (改善生成)   │              │ (効果追跡)    │
├─────────────────┴──────────────┴──────────────┴────────────────┤
│ ImprovementApplier │ SkillCodeGenerator │ CodeValidator      │
│ (改善適用)         │ (コード生成)       │ (安全性検証)       │
└──────────────────────────────────────────────────────────────┘
```

### リアクティブモード (失敗駆動)

```
トリガー条件 (全て AND):
  - failureBuffer >= 3 (MIN_FAILURE_BUFFER)
  - クールダウン経過 (10分: MIN_COOLDOWN_MS)
  - 1時間あたり3回未満 (MAX_RUNS_PER_HOUR)
  - 実行中でない
  - 以下のいずれか (OR):
    - MetaCognition シグナル (wrong_approach/stuck が直近5件に含む)
    - 同一失敗タイプ3回以上繰り返し
    - 同一スキル失敗3回以上繰り返し

パイプライン:
  1. FailureAnalyzer (gpt-4.1-mini)
     入力: FailureRecord[] (最大50件)
     出力: FailureCluster[] {
       rootCause: 'skill_bug' | 'missing_precondition' | 'prompt_rule_missing' |
                  'recipe_missing' | 'forward_model_gap' | 'unknown',
       suggestedTier: 1 | 2
     }

  2. ImprovementGenerator (gpt-4.1-mini)
     Tier 1: プロンプトルール / forward_model ルール → JSON パッチ (自動適用)
     Tier 2: TypeScript コード修正 → pending_review (手動レビュー待ち)

  3. ImprovementApplier
     Tier 1: self_improvement_rules.json に追記 (重複チェック付き)
     Tier 2: CodeValidator → 保存 (将来的に git コミット)

  4. EffectivenessTracker
     次の10タスクで効果測定
     50%悪化 → 自動ロールバック (enabled=false)
     改善 → 確認ログ
```

### プロアクティブモード (パターン検出)

```
トリガー: エピソード蓄積後自動
クールダウン: 30分, 1時間あたり2回まで

パイプライン:
  1. ToolCall シーケンスをスライディングウィンドウで抽出 (長さ 3-6)
  2. 頻度 >= 3 のパターンを特定
  3. SkillIdeator (gpt-4.1-mini): スキル仕様生成
  4. SkillCodeGenerator (gpt-4.1-mini): TypeScript コード生成
  5. CodeValidator: セキュリティチェック
     禁止: process.exit, eval, child_process, fs, __dirname, global
     許可 import: relative, minecraft-data, vec3, @shannon/common
     制限: 200行まで
  6. SkillCompiler: TS → JS コンパイル
  7. SkillHotLoader: ランタイム登録 (再起動不要)
```

### 動的ルールの注入先

```
target='prompt':
  → PromptBuilder がシステムプロンプトに注入 (60秒キャッシュ)
  → FCA の全イテレーションで有効

target='forward_model':
  → ForwardModel のルールベースチェックに追加
  → ツール呼び出しの予測ブロックに使用
```

### CodeAgentLoop・JSON 自己テスト・夜間バッチ（2026-03 追記）

**CodeAgentLoop**（`CodeAgentLoop.ts`）: Anthropic SDK 直接使用。ファイル読取・編集・semantic_search・web・shell・`run_tsc` 等をツールとしてループ。`ImprovementApplier.applyWithAgent`・`SkillPatcher.diagnoseAndFixWithAgent`・マイクラチャットの `..agent-fix` から起動。

**SelfTestRunner**（`SelfTestRunner.ts`）: `saves/minecraft/self_test_cases/*.json`。`mode`: `default` | `chain` | `goal`。goal は **MinecraftGoalExecutor** が全 InstantSkill をツール化し自然言語ゴールを達成。**SkillPatcher**: チェーン失敗時に `chainContext` を渡し、原因がテスト側なら **`skipFix: true`** でコード変更を避ける。

**夜間**: `NightlySelfImproveScheduler` + `SelfImprovementDaemon.runNightlyMaintenance` → `saves/self_improve/morning_reports/`。**既定は LLM なし**；`SELF_IMPROVE_NIGHTLY_RUN_REACTIVE` / `SELF_IMPROVE_NIGHTLY_CODE_AGENT` / `SELF_IMPROVE_NIGHTLY_MINECRAFT_*` で opt-in。環境変数一覧は [architecture-current.md §6](./architecture-current.md#6-夜間メンテナンス課金抑止設計) およびリポジトリ `AGENTS.md`。

**Minebot 実装メモ**: `craft-one` は 3×3 必須時のみ作業台を探す。`place-block-at` は自身が設置マスにいるとき隣へ退避を試みる。

---

## 12. リクエスト実行コーディネーター

**ファイル**: `backend/src/services/llm/graph/requestExecutionCoordinator.ts`

### レーン決定

```
self_mod_apply → 'self-mod:apply' (グローバル単一レーン)
minecraft      → 'minecraft-world:{worldId|serverId|serverName|threadId}'
other          → 'thread:{threadId}'
```

### 実行モード

```
通常モード:
  - 同一レーンの前タスク完了を待機
  - AbortController を返す (緊急リクエストがアボート可能)

緊急モード:
  - envelope.tags.includes('emergency') を検出
  - 現在タスクの AbortController を即座にアボート
  - キューをバイパスして即時実行
  - 効果: 0〜30秒のキュー待ち解消
```

---

## 13. フロントエンド連携

### データフロー

```
Backend EventBus
  │
  ├── 'web:emotion'  ──→ WebSocket ──→ Emotion.tsx (レーダーチャート)
  ├── 'web:planning' ──→ WebSocket ──→ TaskTree.tsx (タスクツリー)
  ├── 'web:log'      ──→ WebSocket ──→ ActivityLog.tsx (ログ一覧)
  └── 'web:status'   ──→ WebSocket ──→ StatusTab.tsx (サービス状態)
```

### Public Chat (Web チャネル SSE)

**エンドポイント**: `POST /api/public/chat`

```
入力: { text (max 500), sessionId?, history? (max 10) }
レート制限: IP 毎/日 (デフォルト3回, PUBLIC_CHAT_DAILY_LIMIT で設定)

SSE イベント:
  thinking  → { phase: 'classify' | 'execute' | 'format' }
  emotion   → EmotionType
  task_update → TaskTreeState
  tool_start → { toolName, args }
  reply     → { text: string }
  meta      → { phases: string[], model: string }
  rate_limit → { remaining, isAdmin }
  error     → { message }
  done      → {}
```

### UI コンポーネント

| コンポーネント | 表示内容 |
|---------------|---------|
| **Emotion** | Plutchik 8次元レーダーチャート + 感情バッジ + タイムラインヒストリー (直近20件) |
| **TaskTree** | ゴール + 進捗バー + 戦略 + サブタスクリスト (階層的) |
| **ActivityLog** | フィルタ付きログ (All/ShannonUI/Minecraft/Twitter/YouTube/Discord) + 検索 |
| **KPICards** | 稼働サービス / 本日の投稿 / トークン消費 / 接続状態 |
| **StatusTab** | サービス別トグル (Social/Minecraft/Minebot) |

---

## 14. 全 LLM 呼び出し一覧表

| # | コンポーネント | モデル | トリガー | LLM への入力 | LLM の出力 | 判断内容 |
|---|--------------|--------|---------|-------------|-----------|---------|
| 1 | **ClassifyNode** | `gpt-4.1-mini` | リクエスト着信時 (全チャネル統一 LLM 分類) | envelope.text + チャネルコンテキスト | ClassifySchema | mode, riskLevel, needsTools, needsPlanning |
| 2 | **EmotionLoop (初回)** | `gpt-5-mini` | execute 開始直後 (初回 tick) | userMessage, context | EmotionSchema | 初期感情 + Plutchik 8次元パラメータ |
| 3 | **EmotionLoop (継続)** | `gpt-5-mini` | タスク更新 (デバウンス10秒) | messages, recentResults[5], currentEmotion | EmotionSchema | 更新された感情パラメータ |
| 4 | **MemoryAgent (初期取得)** | `gpt-4.1-mini` | execute 開始直後 | goal + envelope + DB 検索結果 | 整理された初期記憶テキスト | FCA に初期コンテキストとして注入 |
| 5 | **MemoryAgent (クエリ応答)** | `gpt-4.1-mini` | recall-memory ツール呼出時 | question + DB 検索結果 | 回答テキスト | 記憶に基づく質問応答 |
| 6 | **MemoryAgent (保存判断)** | `gpt-4.1-mini` | 10iter 毎 / タスク完了時 | recentToolCalls | 保存すべき記憶 (or なし) | 何を覚えるべきか判断 |
| 7 | **MetaCogFCA (サマリー)** | `gpt-4.1-mini` | 3iter 毎 | prevSummary + recentToolCalls | journalSummary (500字) | 旅程のローリング要約 |
| 8 | **MetaCogFCA (ツールループ)** | `gpt-4.1-mini` | 3iter 毎 | snapshot + plan + summary | assess + プラン操作 (9ツール) | assessment, サブタスクCRUD, フィードバック |
| 9 | **TaskFCA メインループ** | 動的 (ModelSelector) | メインタスク実行 (最大50イテレーション) | system prompt + history + エフェメラル (journalSummary, サブタスク, 初期記憶) | tool_calls or text | 次のアクション or タスク完了 |
| 10 | **plan-craft** | `gpt-4.1-mini` | TaskFCA から呼出時 | レシピ依存 + インベントリ + 近傍インフラ + 記憶 | PlanState | クラフト計画 (サブタスク一覧) |
| 11 | **FailureAnalyzer** | `gpt-4.1-mini` | 失敗バッファ >= 3 + クールダウン | FailureRecord[] (最大50件) | FailureCluster[] | rootCause, suggestedTier |
| 12 | **ImprovementGenerator** | `gpt-4.1-mini` | FailureAnalyzer 完了後 | FailureCluster + コンテキスト | Tier1: JSON ルール / Tier2: コードパッチ | プロンプトルール or コード修正 |
| 13 | **SkillIdeator** | `gpt-4.1-mini` | ツールシーケンスパターン検出 | 頻出パターン + コンテキスト | SkillIdeation | スキル名, 型, パラメータ |
| 14 | **SkillCodeGenerator** | `gpt-4.1-mini` | SkillIdeator 完了後 | SkillIdeation + テンプレート | TypeScript コード | 完全なスキルクラス |

### LLM 呼び出しの条件分岐まとめ

```
リクエスト着信
  │
  ├─ emergency タグ → emergency_fastpath (LLM #1 スキップ)
  │   └─ execute (LLM #5 のみ、#2/#3/#4 は条件次第)
  │
  ├─ Minecraft チャネル
  │   ├─ ヒューリスティック分類 (LLM #1 スキップ)
  │   ├─ emotion スキップ (LLM #2 スキップ)
  │   ├─ 軽量 recall (セマンティック検索スキップ)
  │   ├─ craft_preflight (決定論的)
  │   └─ execute:
  │       ├─ EmotionLoop スキップ (LLM #3 スキップ)
  │       ├─ !needsPlanning && !emergency → MetaCognition スキップ (LLM #4 スキップ)
  │       └─ FCA のみ (LLM #5)
  │
  └─ 他チャネル
      ├─ ClassifyNode (LLM #1)
      ├─ EmotionNode (LLM #2) ─┐ 並列
      ├─ recall (full)         ─┘
      └─ execute:
          ├─ EmotionLoop (LLM #3) ─┐
          ├─ MetaCognition (LLM #4)─┤ Promise.all()
          └─ FCA (LLM #5)         ─┘

自己改善 (バックグラウンド):
  ParallelExecutor 完了後 → onEpisodeSaved()
  → 条件満たす → LLM #6 → LLM #7
  → パターン検出 → LLM #8 → LLM #9
```

---

## 15. ファイルパス索引

### LLM Graph

| ファイル | 説明 |
|---------|------|
| `backend/src/services/llm/client.ts` | LLMService シングルトン、グラフ初期化・実行 |
| `backend/src/services/llm/graph/shannonGraph.ts` | 統一グラフ定義 (ノード接続・ルーター) |
| `backend/src/services/llm/graph/requestExecutionCoordinator.ts` | レーン別直列化・緊急プリエンプション |
| `backend/src/services/llm/graph/cognitive/CognitiveBlackboard.ts` | 共有ワーキングメモリ (emotion, meta, task, selfState, plan, initialMemoryContext) |
| `backend/src/services/llm/graph/cognitive/EmotionLoop.ts` | 感情評価ループ (扁桃体) — 初回 tick 即座実行 |
| `backend/src/services/llm/graph/cognitive/MemoryAgent.ts` | **v2 新規**: 記憶エージェント (海馬) — 取得・保存・圧縮 |
| `backend/src/services/llm/graph/cognitive/MetaCognitionLoop.ts` | メタ認知 FCA (DLPFC) — 9ツール + サマリー LLM + mini-FCA ループ |
| `backend/src/services/llm/graph/cognitive/ModelSelector.ts` | モデルエスカレーションチェーン |
| `backend/src/services/llm/graph/cognitive/ParallelExecutor.ts` | 4並列プロセス実行 (TaskFCA + EmotionLoop + MetaCogFCA + MemoryAgent) |
| `backend/src/services/llm/graph/cognitive/TaskEpisodeMemory.ts` | エピソード記憶 (タスク結果の保存) |
| `backend/src/services/llm/graph/cognitive/selfImprove/` | 自己改善サブシステム全体 |
| `backend/src/services/llm/graph/nodes/FunctionCallingAgent.ts` | FCA メインループ |
| `backend/src/services/llm/graph/nodes/CraftPreflightNode.ts` | クラフト分析 (決定論的) + PlanState 初期生成 |
| `backend/src/services/llm/graph/nodes/execution/ForwardModel.ts` | 予測ブロック (小脳) |
| `backend/src/services/llm/graph/nodes/execution/LoopDetector.ts` | ループ検出 (前帯状皮質, pardonedAfterIndex 対応) |
| `backend/src/services/llm/graph/nodes/execution/TaskTreePublisher.ts` | タスクツリー UI 更新 |
| `backend/src/services/llm/graph/nodes/prompt/PromptBuilder.ts` | システムプロンプト構築 |
| `backend/src/services/llm/tools/utility/taskComplete.ts` | task-complete ツール定義 |
| `backend/src/services/llm/tools/utility/planCraft.ts` | **v2 新規**: plan-craft ツール (CraftPreflight 後継) |
| `backend/src/services/llm/tools/memory/recallMemory.ts` | **v2 新規**: recall-memory ツール (統合版) |
| `backend/src/services/llm/tools/memory/saveMemory.ts` | **v2 新規**: save-memory ツール (統合版) |

### Minebot

| ファイル | 説明 |
|---------|------|
| `backend/src/services/minebot/skillAgent.ts` | メインオーケストレーター |
| `backend/src/services/minebot/runtime/MinebotTaskRuntime.ts` | タスク実行エンジン |
| `backend/src/services/minebot/eventReaction/EventReactionSystem.ts` | 自律イベントハンドラ |
| `backend/src/services/minebot/eventReaction/types.ts` | イベント型定義 |
| `backend/src/services/minebot/http/MinebotHttpServer.ts` | HTTP API サーバー |
| `backend/src/services/minebot/skills/SkillLoader.ts` | ディスク読み込み |
| `backend/src/services/minebot/skills/SkillRegistrar.ts` | EventBus 登録 |
| `backend/src/services/minebot/skills/SkillCompiler.ts` | TS→JS コンパイル |
| `backend/src/services/minebot/skills/SkillHotLoader.ts` | ランタイム登録 |
| `backend/src/services/minebot/instantSkills/moveTo.ts` | 移動スキル |
| `backend/src/services/minebot/instantSkills/mineBlock.ts` | 採掘スキル |
| `backend/src/services/minebot/instantSkills/digBlockAt.ts` | ブロック破壊スキル |
| `backend/src/services/minebot/instantSkills/craftOne.ts` | クラフトスキル |
| `backend/src/services/minebot/instantSkills/startSmelting.ts` | 精錬スキル |
| `backend/src/services/minebot/constantSkills/autoEat.ts` | 自動食事スキル |
| `backend/src/services/minebot/knowledge/RecipeDependencyResolver.ts` | レシピ依存解決 |

### Common / Frontend / Other

| ファイル | 説明 |
|---------|------|
| `common/src/types/graph/envelope.ts` | RequestEnvelope 型定義 |
| `backend/src/services/memory/scopedMemoryService.ts` | スコープ付きメモリ |
| `backend/src/services/common/adapters/actionFormatter.ts` | アクションフォーマット |
| `backend/src/server.ts` | サーバー起動・サービス初期化 |
| `backend/src/routes/publicRoutes.ts` | Public Chat SSE エンドポイント |
| `backend/src/utils/logger.ts` | 構造化ロギング |
| `frontend/src/components/StatusLog/Emotion/Emotion.tsx` | 感情レーダーチャート |
| `frontend/src/components/StatusLog/TaskTree/TaskTree.tsx` | タスクツリー表示 |
| `frontend/src/components/ActivityLog/ActivityLog.tsx` | アクティビティログ |
| `frontend/src/components/KPICards/KPICards.tsx` | KPI ダッシュボード |
| `frontend/src/components/Sidebar/StatusTab/StatusTab.tsx` | サービス状態管理 |

---

## 付録: パフォーマンス最適化一覧

| 最適化 | 効果 | 適用条件 |
|--------|------|---------|
| Emergency fastpath | -7〜18秒 | emergency タグ |
| Minecraft ヒューリスティック分類 | -2〜5秒 | channel='minecraft' |
| 軽量 recall | -1〜4秒 | channel='minecraft' |
| 並列メモリクエリ (WorldKnowledge + TaskEpisodeMemory) | -0.5〜1.5秒 | 全プラットフォーム |
| CraftPreflight (決定論的) | 5-10 失敗イテレーション防止 | Minecraft クラフトリクエスト |
| Emotion スキップ | -2〜3秒/イテレーション | Minecraft (常に) |
| MetaCognition スキップ | -1〜2秒/評価間隔 | Minecraft + !planning + !emergency |
| 非MC ツール除外 | -1600〜3200 入力トークン | channel='minecraft' |
| コンテキストトリミング | 入力トークン削減 | 毎 FCA イテレーション (max 16k) |
| 思考要約 | コンテキスト膨張防止 | 複数思考蓄積後 |
