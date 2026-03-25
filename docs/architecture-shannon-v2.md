# Shannon v2 アーキテクチャ設計書

> **現状の実装サマリ**（短く最新だけ知りたい場合）: [architecture-current.md](./architecture-current.md)  
> 本書は v2 への再設計当時の**設計メモ・アーキテクチャ図**として参照用に残す。

## Context

Shannon のコア実行エンジンを再設計する。現状の問題:

1. **recall が事前全取得方式** — 不要な記憶もプロンプトに詰め込む、5-8秒のレイテンシ
2. **CraftPreflight がグラフノード** — FCA から呼べない、クラフト時のみ発動、チェスト/かまどの中身を見れない
3. **emotion が classify と execute の間で1回 + ループ** — 中途半端な位置
4. **記憶の書き込みがタスク終了後** — タスク中に学んだことが即保存されない
5. **記憶の圧縮/整理が受動的** — 容量超過時のみ eviction、能動的な整理がない
6. **classify のハードコード正規表現** — 多様な表現に対応できない (修正済み)

---

## 新アーキテクチャ概要

```
┌──────────────────────────────────────────────────────────────┐
│                   Shannon Graph (簡素化)                      │
│                                                              │
│  ingest → classify → execute → format                        │
│                                                              │
│  ※ recall, emotion, craft_preflight ノードを廃止             │
│  ※ writeback も廃止 (MemoryAgent が担当)                     │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              execute (ParallelExecutor)                       │
│                                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌────────────┐ ┌─────────┐│
│  │  TaskFCA     │ │ MetaCogFCA  │ │ EmotionLoop│ │ Memory  ││
│  │  (運動皮質)  │ │ (DLPFC)     │ │ (扁桃体)   │ │ Agent   ││
│  │             │ │             │ │            │ │ (海馬)   ││
│  │ ツール:     │ │ ツール:     │ │            │ │          ││
│  │ plan-craft  │ │ assess      │ │ gpt-5-mini │ │ 取得     ││
│  │ recall-mem  │ │ send-fb     │ │            │ │ 保存     ││
│  │ mine-block  │ │ update-st   │ │            │ │ 圧縮     ││
│  │ craft-one   │ │ create-st   │ │            │ │          ││
│  │ move-to     │ │ delete-st   │ │            │ │          ││
│  │ ...         │ │ ...         │ │            │ │          ││
│  └──────┬──────┘ └──────┬──────┘ └─────┬──────┘ └────┬─────┘│
│         │               │              │              │      │
│         └───────────────┴──────────────┴──────────────┘      │
│                    CognitiveBlackboard                        │
└──────────────────────────────────────────────────────────────┘
```

### 変更前 → 変更後

| 項目 | 変更前 | 変更後 |
|------|--------|--------|
| グラフノード | ingest → classify → [emotion ∥ recall] → [craft_preflight] → execute → format → writeback | ingest → classify → execute → format |
| 並列プロセス | 3 (TaskFCA, EmotionLoop, MetaCogLoop) | 4 (TaskFCA, MetaCogFCA, EmotionLoop, MemoryAgent) |
| 記憶取得 | recall ノードで事前全取得 | MemoryAgent にオンデマンドで問い合わせ |
| 記憶保存 | writeback ノードで事後一括 | MemoryAgent がタスク中に随時保存 |
| クラフト計画 | CraftPreflight ノード (決定論的) | TaskFCA のツール `plan-craft` (情報収集 + LLM) |
| 感情初期評価 | emotion ノード (classify後) | EmotionLoop の初回 tick (execute 開始直後) |

---

## 1. MemoryAgent (海馬)

### 役割

CognitiveBlackboard 上で動作する4番目の並列プロセス。
記憶の **取得・保存・圧縮** を能動的に行う。

### 3つの機能

#### A. 取得 (on-demand)

他のプロセスから問い合わせを受けて、記憶を検索・整理して返す。

```
呼び出し元 → MemoryAgent.query(question) → 回答テキスト

呼び出し元:
  - TaskFCA: recall-memory ツール経由
    例: "鉄鉱石はどこで見つけた？"
    例: "(10,64,20)のチェストに何が入ってた？"
  - plan-craft ツール: 情報収集フェーズで
    例: "近くのかまどに何か入ってた？"
  - MetaCogFCA: 評価時に
    例: "前に同じタスクで失敗した時の対処法は？"
```

**実装**:
```typescript
class MemoryAgent {
  /** 同期的に記憶を検索して回答を返す */
  async query(question: string, context?: QueryContext): Promise<string> {
    // 1. キーワード + 座標 + タグで DB 検索
    // 2. セマンティック検索 (embedding)
    // 3. 取得した記憶を LLM に渡して整理・回答生成
    //    「以下の記憶から質問に関連する情報を整理して答えてください」
    // 4. 回答テキストを返す
  }
}
```

**QueryContext**:
```typescript
interface QueryContext {
  platform?: string;
  position?: { x: number; y: number; z: number };
  userId?: string;
  tags?: string[];
}
```

**LLM**: `gpt-4.1-mini` (検索結果の整理・回答生成)

#### B. 保存 (event-driven)

blackboard の `task:updated` を監視し、覚えるべき情報を自律的に保存。

```
トリガー:
  - 外部からの明示的な保存指令 (save-memory ツール呼び出し) → 強制保存
  - task:updated (10 iter 毎) → 保存すべきものがあるかチェック、あれば保存
  - blackboard.complete() 時 (タスク終了) → 最終チェック + 保存

処理:
  - 強制保存 (save-memory): 内容を整形して MongoDB に即保存 (LLM 不要)
  - 定期チェック (10iter毎): blackboard.snapshot() から直近のツール実行結果を取得
    → LLM に「この中で覚えるべき情報はあるか？」をチェックさせる
    → あれば整形して保存、なければスキップ

覚える対象の例:
  - チェスト/かまどの中身 (座標紐付き)
  - 新しい場所の発見 (鉱脈、村、建造物)
  - 有用なアイテムの入手・消費
  - 失敗から学んだこと
  - ユーザーの発言で重要なもの

覚えない対象:
  - ルーティンの成功 (move-to 成功など)
  - 一時的な状態 (現在位置など)
```

**保存のスキーマ**: 既存の ShannonMemoryService を活用

```typescript
await memoryService.saveWithDedup({
  category: 'knowledge',  // or 'experience'
  content: "チェスト(10,64,20): raw_iron x5, coal x8",
  source: 'memory_agent',
  importance: 6,
  tags: ['minecraft', 'chest', 'location:10_64_20', 'iron', 'coal'],
  worldTags: ['minecraft:server:xxx'],
});
```

#### C. 圧縮 (periodic)

記憶が溜まってきたら整理を行う。

```
トリガー:
  - タスク完了時 (blackboard.complete)
  - 1時間毎のバックグラウンドタイマー

処理:
  1. カテゴリ別に記憶件数をチェック
  2. 閾値超過 (90% of max) なら:
     a. アクセスされない記憶を特定 (lastAccessedAt)
     b. 類似記憶を統合 (embedding 近傍、LLM で要約)
     c. 重要度の低い古い記憶を削除
  3. 既存の ShannonMemoryService.consolidateOldMemories() を拡張

※ 既存の eviction/consolidation ロジックを MemoryAgent が能動的に呼ぶ形
```

### blackboard との連携

```
MemoryAgent は blackboard を直接読み書きしない (記憶はブラックボードの外に保存)。
ただし以下のイベントを監視:
  - task:updated: 保存判断のトリガー
  - completed: 最終保存 + 圧縮トリガー

他のプロセスとの通信:
  - TaskFCA → recall-memory ツール → MemoryAgent.query() (同期)
  - plan-craft ツール → MemoryAgent.query() (同期)
  - MetaCogFCA → (直接呼ばず、journalSummary 経由で十分)
```

### 初期コンテキスト注入 (recall ノードの代替)

現状の recall ノードが担っていた「初期記憶注入」は以下に分散:

| 現状 (recall ノード) | 新設計 |
|---------------------|--------|
| userProfile (人物情報) | execute 開始時に MemoryAgent が自動取得 → エフェメラルで FCA に注入 |
| selfModel (自己モデル) | PromptBuilder に静的に埋め込み (頻繁に変わらない) |
| relationshipModel | execute 開始時に MemoryAgent が自動取得 → エフェメラルで FCA に注入 |
| strategyUpdates | 動的ルール (self_improvement_rules.json) で既にカバー |
| worldModelPatterns | MemoryAgent が task 開始時に関連パターンを検索 → エフェメラル注入 |
| memoryPrompt (全体) | 不要。必要な時に recall-memory ツールで取得 |

**execute 開始直後の初期注入フロー**:
```
ParallelExecutor.run() 開始
  │
  ├── MemoryAgent.initialize(envelope, goal)
  │     → 非同期で人物情報 + 関連記憶を取得
  │     → blackboard に initialMemoryContext としてセット
  │
  ├── 同時に TaskFCA, EmotionLoop, MetaCogFCA も開始
  │
  └── TaskFCA の最初のイテレーション:
        → initialMemoryContext をエフェメラルで注入 (1回だけ)
        → 以降は recall-memory ツールでオンデマンド取得
```

---

## 2. plan-craft ツール (CraftPreflight の後継)

### 現状との違い

| | CraftPreflight (現状) | plan-craft (新設計) |
|--|-----|------|
| 位置 | グラフノード (classify 後に自動実行) | TaskFCA のツール (必要な時に FCA が呼ぶ) |
| レシピ解決 | minecraft-data (正確) | minecraft-data (同じ) |
| チェスト/かまどの中身 | 不明 | MemoryAgent に問い合わせ |
| 計画生成 | ハードコードされたステップ | LLM が状況に応じて柔軟に |
| 発動条件 | クラフトキーワード検出時のみ | FCA が必要と判断した時 |
| 出力 | CraftPlan (promptInjection テキスト) | PlanState (blackboard に直接注入) |

### 処理フロー

```typescript
name: "plan-craft"
description: "アイテムのクラフト・精錬計画を立てる"
params: { target: string, count: number }

async execute({ target, count }):
  // ① 情報収集 (決定論的、高速)
  const recipe = RecipeDependencyResolver.resolve(target);
  const inventory = bot.inventory.items();
  const nearbyInfra = scanNearbyInfrastructure(8); // crafting_table, furnace, chest 等

  // ② 記憶問い合わせ (MemoryAgent 経由)
  const memoryQueries = [];
  for (const infra of nearbyInfra) {
    if (infra.type === 'chest' || infra.type === 'furnace') {
      memoryQueries.push(
        memoryAgent.query(`(${infra.x},${infra.y},${infra.z})の${infra.type}に何が入ってた？`)
      );
    }
  }
  const memoryResults = await Promise.all(memoryQueries);

  // ③ LLM 計画生成
  const planPrompt = `
    目標: ${target} x${count}
    レシピ依存ツリー: ${formatTree(recipe)}
    インベントリ: ${formatInventory(inventory)}
    近傍インフラ: ${formatInfra(nearbyInfra)}
    記憶 (チェスト/かまどの中身): ${memoryResults.join('\n')}

    上記の情報から最適なクラフト手順を PlanState 形式で出力してください。
  `;

  const plan = await llm.invoke(planPrompt); // gpt-4.1-mini
  blackboard.updatePlan(plan);
  return plan の概要テキスト;
```

### ClassifyNode の needsPlanning 判定

ClassifyNode (LLM) が `needsPlanning=true` を返した場合:
→ MetaCogFCA が初回評価で「plan-craft を呼ぶべき」と判断して send-feedback
→ または TaskFCA 自身がクラフト要求を認識して plan-craft を呼ぶ

CraftPreflight ノードは廃止。classify 後に即 execute に入る。

---

## 3. グラフの簡素化

### 新しいグラフフロー

```
                    ┌─────────┐
                    │ ingest  │
                    └────┬────┘
                         │
              ┌──────────┴──────────┐
              │ Router: emergency?  │
              └──┬───────────────┬──┘
          Yes    │               │  No
     ┌───────────▼───┐    ┌─────▼─────┐
     │ emergency_    │    │ classify   │
     │ fastpath      │    │ (LLM)     │
     └───────┬───────┘    └─────┬─────┘
             │                  │
             └────────┬─────────┘
                      │
                ┌─────▼─────┐
                │  execute   │
                │ (Parallel) │
                └─────┬─────┘
                      │
                ┌─────▼─────┐
                │  format    │
                └─────┬─────┘
                      │
                     END
```

### 廃止されるノード

| ノード | 廃止理由 | 代替 |
|-------|---------|------|
| recall | 事前全取得は不要。オンデマンドの方が効率的 | MemoryAgent + recall-memory ツール + 初期注入 |
| emotion_step | execute 内の EmotionLoop で初回評価すれば十分 | EmotionLoop (初回 tick を即座に実行) |
| craft_preflight | FCA のツールとして呼ぶ方が柔軟 | plan-craft ツール |
| writeback | MemoryAgent がタスク中に随時保存 | MemoryAgent の保存機能 |

### レイテンシ改善

```
変更前:
  ingest (0ms) → classify (1-3s) → [emotion (1-2s) ∥ recall (1-8s)] → execute
  → classify 後の並列処理で 1-8秒のブロック

変更後:
  ingest (0ms) → classify (1-3s) → execute (即座)
  → classify 後に即 execute に入る
  → 記憶は execute 中に MemoryAgent が非同期で取得
```

---

## 4. EmotionLoop の変更

### 初回評価の即座実行

現状: emotion ノード (classify 後) で初回評価 → execute 中の EmotionLoop で継続評価
新設計: emotion ノード廃止、EmotionLoop が execute 開始直後に初回 tick を即座に実行

```typescript
class EmotionLoop {
  async run(): Promise<void> {
    // 初回 tick を即座に実行 (デバウンスなし)
    await this.tick();

    // 以降は既存の event-driven ループ
    this.blackboard.on('task:updated', onTaskUpdated);  // 10秒デバウンス
    this.blackboard.on('meta:updated', onMetaUpdated);  // 即座
    // ...
  }
}
```

これにより emotion ノードが不要になり、グラフが1ステップ短くなる。

---

## 5. ParallelExecutor の変更

### 4プロセス並列

```typescript
class ParallelExecutor {
  async run(state, signal): Promise<ParallelExecutorResult> {
    const blackboard = new CognitiveBlackboard(goal, null, messages);
    // ※ initialEmotion は null → EmotionLoop の初回 tick で設定

    // Minecraft の場合、selfState を設定
    if (isMinecraft) {
      blackboard.updateSelf({ inventory, health, food });
      blackboard.updateSelf({ vitalAlerts: checkVitalAlerts(...) });
    }

    // MemoryAgent を初期化 (非同期で初期記憶を取得開始)
    const memoryAgent = new MemoryAgent(blackboard, envelope);
    const initialMemoryPromise = memoryAgent.initialize(goal, envelope);

    // 各ループを生成
    const emotionLoop = skipEmotionLoop ? null : new EmotionLoop(blackboard, emotionNode);
    const metaLoop = skipMetaCognition ? null : new MetaCognitionLoop(blackboard, modelSelector);

    // FCA に MemoryAgent のクエリ関数を渡す
    const wrappedState = {
      ...state,
      recallMemory: (q: string, ctx?: QueryContext) => memoryAgent.query(q, ctx),
      getJournalSummary: () => blackboard.plan?.journalSummary ?? null,
      getActiveSubtaskInfo: () => formatActiveSubtask(blackboard),
      getInitialMemory: async () => {
        const mem = await initialMemoryPromise;
        return mem;  // 初回のみ。以降は null
      },
    };

    // 4プロセス並列起動
    const taskPromise = this.fca.run(wrappedState, blackboard.signal);
    const emotionPromise = emotionLoop?.run() ?? Promise.resolve();
    const metaPromise = metaLoop?.run() ?? Promise.resolve();
    const memoryPromise = memoryAgent.run(blackboard.signal);

    // TaskFCA の完了を待つ
    const taskResult = await taskPromise;
    blackboard.complete();

    // 他プロセスの終了を待つ (3秒タイムアウト)
    await Promise.race([
      Promise.allSettled([emotionPromise, metaPromise, memoryPromise]),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);

    return { ...taskResult, finalEmotion: blackboard.emotionState };
  }
}
```

---

## 6. TaskFCA の新しいツール

### 追加ツール

```typescript
// ── 記憶ツール ──

recall-memory
  params: { question: string }
  効果: MemoryAgent に問い合わせ、関連記憶を整理して返す
  例: "鉄鉱石はどこで見つけた？" → "北の洞窟(50,30,120)で iron_ore を発見 (3/14)"
  内部: state.recallMemory(question) を呼ぶ

save-memory
  params: { content: string, importance?: number }
  効果: MemoryAgent に保存依頼
  例: "このチェスト(10,64,20)にはiron_ingot x3が入っていた"
  内部: memoryAgent.save(content, importance)

// ── クラフト計画ツール ──

plan-craft
  params: { target: string, count: number }
  効果: レシピ解決 + インベントリ突合 + 記憶問い合わせ + LLM 計画生成
  出力: PlanState を blackboard に注入 + 概要テキストを返す
  内部: 情報収集 → MemoryAgent.query() → LLM → blackboard.updatePlan()
```

### 廃止ツール

| ツール | 廃止理由 | 代替 |
|-------|---------|------|
| save-experience | MemoryAgent が自律的に判断して保存 | save-memory (汎用) |
| save-knowledge | 同上 | save-memory (汎用) |
| recall-experience | 区別不要、MemoryAgent が適切な記憶を返す | recall-memory (汎用) |
| recall-knowledge | 同上 | recall-memory (汎用) |
| recall-person | recall-memory で「〜さんについて教えて」で対応 | recall-memory |
| update-plan | MetaCogFCA が plan 管理を担当 | MetaCogFCA のツール群 |

---

## 7. CognitiveBlackboard の変更

### 追加フィールド

```typescript
// 初期記憶コンテキスト (MemoryAgent が execute 開始時に非同期取得)
private _initialMemoryContext: string | null = null;

get initialMemoryContext(): string | null { return this._initialMemoryContext; }

setInitialMemoryContext(context: string): void {
  this._initialMemoryContext = context;
}
```

### 既存フィールド (変更なし)

emotionState, metaState, taskState, selfState, plan — 全て既存のまま。

---

## 8. 全体のデータフロー

### タスク実行の時系列

```
1. リクエスト着信 → RequestEnvelope 生成

2. ingest: モード推定 (emergency タグ → fastpath)

3. classify: LLM (gpt-4.1-mini) で統一分類
   → mode, riskLevel, needsTools, needsPlanning, selectedModel

4. execute (ParallelExecutor):
   ┌─ 初期化 ──────────────────────────────────────────────┐
   │ CognitiveBlackboard 作成                               │
   │ MemoryAgent.initialize() 開始 (非同期で初期記憶取得)   │
   │ selfState 設定 (Minecraft: inventory, health, food)    │
   └────────────────────────────────────────────────────────┘

   ┌─ 4プロセス並列起動 ───────────────────────────────────┐
   │                                                        │
   │ [TaskFCA]                                              │
   │   iter 0: 初期記憶をエフェメラル注入                   │
   │   iter 1: ユーザー要求に応じてツール実行               │
   │     → plan-craft("stone_pickaxe", 1)                  │
   │       → レシピ解決 + インベントリ + 記憶問い合わせ     │
   │       → PlanState 生成 → blackboard.updatePlan()      │
   │     → mine-block("stone", 3)                          │
   │     → craft-one("stone_pickaxe")                      │
   │     → task-complete                                    │
   │                                                        │
   │ [MetaCogFCA]                                           │
   │   3iter 毎: Step1 サマリー更新 + Step2 ツール評価      │
   │     → assess, update-subtask, send-feedback, done     │
   │                                                        │
   │ [EmotionLoop]                                          │
   │   初回: 即座に tick (初期感情設定)                     │
   │   以降: task:updated (10秒デバウンス)                  │
   │                                                        │
   │ [MemoryAgent]                                          │
   │   初期化: 人物情報 + 関連記憶を取得                    │
   │   監視: 5iter 毎にツール結果を分析、保存判断           │
   │   応答: recall-memory ツール呼び出しに同期応答         │
   │   終了: 最終保存 (タスク結果をエピソード記憶に)        │
   └────────────────────────────────────────────────────────┘

5. format: チャネル別にアクション変換

6. (writeback なし — MemoryAgent が既に保存済み)
```

### LLM 呼び出し一覧 (新設計)

| # | コンポーネント | モデル | いつ | 入力 | 出力 |
|---|--------------|--------|-----|------|------|
| 1 | ClassifyNode | gpt-4.1-mini | リクエスト着信時 | envelope.text + チャネルコンテキスト | mode, risk, needsTools, needsPlanning |
| 2 | EmotionLoop (初回) | gpt-5-mini | execute 開始直後 | userMessage, context | emotion + Plutchik 8次元 |
| 3 | EmotionLoop (継続) | gpt-5-mini | 10秒デバウンス | messages, recentResults, currentEmotion | 更新された感情 |
| 4 | MemoryAgent (初期取得) | gpt-4.1-mini | execute 開始直後 | goal + envelope + 検索結果 | 整理された初期記憶テキスト |
| 5 | MemoryAgent (クエリ応答) | gpt-4.1-mini | recall-memory ツール呼出時 | question + 検索結果 | 回答テキスト |
| 6 | MemoryAgent (保存判断) | gpt-4.1-mini | 10iter 毎 / タスク完了時 (save-memory は LLM 不要で即保存) | recentToolCalls | 保存すべき記憶 (or なし) |
| 7 | MetaCogFCA (サマリー) | gpt-4.1-mini | 3iter 毎 | prevSummary + recentToolCalls | journalSummary (500字) |
| 8 | MetaCogFCA (ツールループ) | gpt-4.1-mini | 3iter 毎 | snapshot + plan + summary | assess + プラン操作 |
| 9 | TaskFCA (メインループ) | 動的 (ModelSelector) | 毎イテレーション | system prompt + history + ephemeral | tool_calls or text |
| 10 | plan-craft (計画生成) | gpt-4.1-mini | TaskFCA から呼出時 | レシピ + インベントリ + 記憶 | PlanState |

---

## 実装順序

### Phase 1: MemoryAgent 基盤
1. MemoryAgent クラス実装 (query, save, run)
2. recall-memory / save-memory ツール定義
3. ParallelExecutor に MemoryAgent を追加 (4プロセス並列)
4. 初期記憶注入の仕組み (initialize → エフェメラル)

### Phase 2: plan-craft ツール
5. plan-craft ツール実装 (情報収集 + MemoryAgent 連携 + LLM 計画生成)
6. CraftPreflight ノードを廃止、グラフから削除
7. classify → craft_preflight 並列ルーティングを廃止

### Phase 3: グラフ簡素化
8. recall ノード廃止
9. emotion ノード廃止 (EmotionLoop に初回 tick 追加)
10. writeback ノード廃止
11. classifyRouter を簡素化 (全チャネルで classify → execute 直行)

### Phase 4: 旧ツール整理
12. save-experience / save-knowledge / recall-experience / recall-knowledge / recall-person / update-plan を廃止
13. 旧 ScopedMemoryService の recall() は MemoryAgent 内部で再利用 (DB アクセス層として)

---

## 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| **新規: MemoryAgent.ts** | 記憶エージェント本体 (query, save, run, initialize, compress) |
| **新規: tools/memory/recallMemory.ts** | recall-memory ツール定義 |
| **新規: tools/memory/saveMemory.ts** | save-memory ツール定義 |
| **新規: tools/minecraft/planCraft.ts** | plan-craft ツール定義 |
| shannonGraph.ts | recall/emotion/craft_preflight/writeback ノード廃止、ルーター簡素化 |
| ParallelExecutor.ts | MemoryAgent 追加、初期記憶注入、wrappedState に recallMemory コールバック |
| FunctionCallingAgent.ts | recallMemory / getInitialMemory をステートに追加、初回エフェメラル注入 |
| EmotionLoop.ts | run() 開始時に初回 tick を即座実行 |
| CognitiveBlackboard.ts | initialMemoryContext フィールド追加 |
| 旧ツール群 (memory/) | save-experience, recall-experience 等を廃止 (recall-memory / save-memory に統合) |

---

## 検証方法

1. `npx tsc --noEmit` で型チェック
2. MemoryAgent 単体テスト:
   - query: DB に記憶保存 → query で取得できること
   - save: 保存判断 LLM が適切にフィルタすること
   - 圧縮: 古い記憶が統合されること
3. plan-craft テスト:
   - レシピ解決 + インベントリ突合が正確なこと
   - MemoryAgent へのクエリが実行されること
   - PlanState が blackboard に注入されること
4. グラフ簡素化テスト:
   - classify → execute 直行で動作すること
   - 初期記憶がエフェメラルで注入されること
   - EmotionLoop の初回 tick で感情が設定されること
5. 統合テスト:
   - Minecraft クラフトタスク: plan-craft → mine → craft の全フロー
   - Discord 会話: 初期記憶注入 → 会話 → MemoryAgent 保存
   - 記憶の取得: 「前にチェストに何入れた？」で過去の記憶を想起
