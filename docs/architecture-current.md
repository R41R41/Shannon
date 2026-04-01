# Shannon 現状アーキテクチャ

> **最終更新: 2026-04-01**
> ブランチ: `feature/claude-architecture`

---

## 1. 一言で

Shannon は **Anthropic Claude API を直接呼出す** マルチチャネル自律エージェント。3ノードグラフ (`ingest → execute → writeback`) で全チャネル (Discord / Minecraft / X / Web / YouTube) を処理する。LangChain を経由せず、**ShannonExecutor** が Anthropic Messages API を直接叩く。

---

## 2. 実行フロー

```
User Message (any channel)
    ↓
Channel Adapter → RequestEnvelope
    ↓
Shannon Graph (3 nodes)
    ├─ ingest: mode 推論 + モデル選択
    ├─ emergency_fastpath: 緊急時のみ (classify/recall スキップ)
    ├─ execute: ShannonExecutor (Claude API 直接)
    │   ├─ ツール呼出ループ (max 25 iter)
    │   │   ├─ InstantSkills (70個) → skill.run() 直接
    │   │   ├─ Routines (8個) → RoutineExecutor (LLM 0回)
    │   │   ├─ search-skills → スキル検索
    │   │   ├─ recall-*/save-* → 記憶エージェント
    │   │   └─ task-complete → 完了宣言
    │   └─ prompt caching (2回目以降 90% 入力コスト削減)
    └─ writeback: ActionFormatter + ScopedMemory 保存
```

### 旧アーキテクチャとの比較

| | 旧 (gpt-4.1-mini + LangChain) | 現在 (Claude + Anthropic SDK) |
|--|-------------------------------|-------------------------------|
| グラフノード | 8 | **3** |
| 認知ループ | 4並列 (FCA+Emotion+MetaCog+Memory) | **1** (ShannonExecutor のみ) |
| LLM API | LangChain 経由 (ChatOpenAI) | **Anthropic SDK 直接** |
| ツール定義変換 | Zod → LangChain → OpenAI → Anthropic | **Anthropic ネイティブ** |
| 分類 (ClassifyNode) | gpt-4o-mini で毎回 LLM 呼出 | **削除** (ingest のヒューリスティック) |
| 感情 (EmotionLoop) | 10秒周期で LLM 呼出 | **削除** (プロンプトの人格指示) |
| メタ認知 (MetaCognitionLoop) | 3iter毎に LLM 呼出 | **削除** (Claude の拡張思考が内包) |
| 記憶 (recall) | 6種メモリを毎回 pre-load | **オンデマンド** (recall-* ツール) |
| プロンプト | 6100文字 / 30ルール | **~2000文字 / 5ルール** |
| shannonGraph.ts | 750+ 行 | **416 行** |

---

## 3. ShannonExecutor (`graph/ShannonExecutor.ts`, ~470行)

Anthropic Messages API を直接呼出す実行エンジン。FCA (1200行, LangChain) を置換。

### モデル選択

| タスク種別 | モデル | コスト |
|-----------|--------|--------|
| 挨拶・雑談 | claude-haiku-4-5 | $0.25/$1.25 per 1M tokens |
| タスク実行 | claude-sonnet-4 | $3/$15 per 1M tokens |
| 環境変数で上書き | `SHANNON_MODEL=claude-opus-4-20250514` | — |

### Prompt Caching

```
iter 1: system prompt + tools = ~50K tokens (フル課金)
iter 2+: cache_read = ~50K tokens (90% 割引)
```

`cache_control: { type: 'ephemeral' }` をシステムプロンプトと最終ツールに設定。

### ツール実行優先順位

```
1. task-complete → 完了宣言 + コンテキスト保存
2. search-skills → InstantSkills/Routines の説明・引数を検索
3. routine-xxx → RoutineExecutor (LLM 0回)
4. InstantSkill → bot.instantSkills.getSkill().run() 直接呼出
5. LLM ツール → llmToolMap (recall-*, save-*, manage-routine 等)
6. unknown → エラー
```

### コスト見積もり

#### Sonnet 4 (メインモデル)

| タスク | iter | 入力 tokens | 出力 tokens | コスト |
|--------|------|------------|------------|--------|
| 挨拶 (Haiku) | 1 | ~2K | ~200 | **~$0.001** |
| 簡単なタスク | 3-5 | iter1: ~52K, iter2+: ~2K (cached ~50K) | ~1K | **~$0.18** |
| 複雑なタスク (25 iter) | 25 | iter1: ~52K, iter2-25: ~60K (cached ~50K) | ~3K | **~$0.25** |

**prompt caching 効果**: 同一タスク内の2回目以降は入力 50K tokens が $0.30/1M (通常 $3/1M の 1/10) で読まれる。

#### 日次コスト見積もり

| 使用パターン | タスク数/日 | 推定コスト/日 |
|-------------|-----------|-------------|
| 軽量 (挨拶+簡単タスク) | 10 | **~$0.50 (~75円)** |
| 標準 (混合タスク) | 20 | **~$2.00 (~300円)** |
| 重い (複雑タスク多数) | 30 | **~$5.00 (~750円)** |
| Twitter 自動投稿込み | 20+11投稿 | **~$3.00 (~450円)** |

**注意**: 上記は prompt caching が効いた場合。caching が効かない（5分以上間隔が空く）場合は 2-3倍。

---

## 4. Routine System (System 1 層)

### RoutineExecutor (`minebot/routines/RoutineExecutor.ts`)

JSON 定義のルーチンを LLM 呼出なしで実行。AbortSignal + bot.executingSkill 制御で緊急割込み対応。

### 登録ルーチン (8個)

| ルーチン | ステップ数 | 前提条件 |
|---------|-----------|---------|
| `gather-wood` | 2 | なし |
| `make-wooden-tools` | 8 | なし（素手から開始可能） |
| `make-stone-tools` | 5 | 木のツルハシ |
| `find-and-mine-ore` | 2 | 石のツルハシ以上 |
| `smelt-ore` | 4 | かまど設置済み |
| `hunt-animal` | 5 | なし |
| `store-items` | 2 | チェスト座標 |
| `equip-full-armor` | 4 | 防具インベントリ |

### manage-routine ツール

Shannon 自身がルーチンを CRUD:
- `list` — 登録済みルーチン一覧（成功率・実行回数つき）
- `create` — 新規ルーチン定義
- `edit` / `delete` — 既存ルーチン変更・削除

---

## 5. 知識システム

### 自律学習

```
失敗 → search-skills で正しい使い方を調べる
    → recall-knowledge で過去の知識を引く
    → save-knowledge で新しい知識を保存
    → 次回は recall-knowledge で即座に引ける
```

### 初期知識 (MongoDB seed, 10件)

狩猟手順、食料、採掘、クラフト、精錬、ブロック設置、道具アップグレード、鉄ピッケル作成、サバイバル基本、ルーチン一覧。

### search-skills ツール

スキル名やキーワードで検索 → description + params を返す。LLM が「やり方が分からない」時に自分で調べる。

---

## 6. 生存システム

### ConstantSkills (15個, System 1)

| スキル | 間隔 | Critical |
|--------|------|----------|
| autoEat | 1000ms | — |
| autoSwim | 100ms | Yes |
| autoAvoidDragonBreath | 100ms | Yes |
| autoRunFromHostiles | 1000ms | — |
| autoPickUpItem | 1000ms | — |
| autoFollow | 1000ms | — |
| ... | | |

### 緊急割込み

```
ダメージ検知 (EventReactionSystem)
  → bot.interruptExecution = true
  → ShannonExecutor の AbortSignal 発火
  → 中断タスクのゴール+進捗を保存
  → 緊急タスク実行
  → 次タスクで「中断されたタスクの続き」として自動復帰
```

### タスク実行中のフィードバック

ユーザーがタスク実行中にチャットで指示 → MinebotTaskRuntime が `humanFeedback` として注入 → ShannonExecutor の次イテレーションで `【ユーザーからのリアルタイムフィードバック】` として LLM メッセージに追加。

---

## 7. フォールバック

| 環境変数 | 効果 |
|----------|------|
| `SHANNON_USE_FCA=true` | ShannonExecutor → FCA/ParallelExecutor にフォールバック |
| `SHANNON_COGNITIVE_LOOPS=true` | EmotionLoop + MetaCognitionLoop を復活 |
| `SHANNON_MODEL=claude-opus-4-20250514` | Opus に切替 |
| Anthropic API key なし | 自動的に OpenAI + FCA にフォールバック |

---

## 8. 改善課題

### 複数ゾンビ襲撃への対処

現状のアーキテクチャでは **複数体の敵モブに同時に襲われた場合の対処が不十分**:

1. **LLM の応答が遅い**: Sonnet の 1 イテレーション = 3-5秒。その間にゾンビが 3-5 回攻撃。HP 20 → 0 で死亡する可能性
2. **attack-continuously は 1体ずつ**: 複数体を同時に処理できない
3. **autoRunFromHostiles は瀕死のみ発動**: HP が低くなるまで逃げない
4. **combat スキルは追跡が遅い**: 1体にも追いつけない状況で複数体は無理

**必要な改善**:
- **ConstantSkill 層での即応**: autoRunFromHostiles の閾値を下げ、複数体検知で即座に逃走
- **戦闘 AI (LLM 不要)**: 敵の数・距離・自分の HP/装備を評価し、「戦う/逃げる」を瞬時に判断する ConstantSkill
- **shield 自動使用**: 攻撃を受けたら盾を構える ConstantSkill
- **武器自動装備**: 戦闘開始時に最強武器を自動装備
- **地形利用**: 1ブロック幅の通路に逃げて1体ずつ処理（LLM 判断）
- **緊急脱出ルーチン**: `routine-emergency-flee` (高所に登る/水に飛び込む/家に逃げ込む)

---

## 9. 関連ファイル

| 領域 | パス |
|------|------|
| Shannon Graph | `backend/src/services/llm/graph/shannonGraph.ts` (416行) |
| ShannonExecutor | `backend/src/services/llm/graph/ShannonExecutor.ts` (467行) |
| PromptBuilder | `backend/src/services/llm/graph/nodes/prompt/PromptBuilder.ts` |
| RoutineExecutor | `backend/src/services/minebot/routines/RoutineExecutor.ts` |
| RoutineManager | `backend/src/services/minebot/routines/RoutineManager.ts` |
| ルーチン定義 | `backend/saves/minecraft/routines/*.routine.json` |
| 初期知識 seed | `backend/scripts/seedMinecraftKnowledge.ts` |
| InstantSkills | `backend/src/services/minebot/instantSkills/` (70個) |
| ConstantSkills | `backend/src/services/minebot/constantSkills/` (15個) |
| MinebotTaskRuntime | `backend/src/services/minebot/runtime/MinebotTaskRuntime.ts` |
| 設計書 | `docs/design-claude-architecture-migration.md` |

---

## 10. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-04-01 | アーキテクチャクリーンアップ: デッドコード削除 (750→416行)、State整理 (30→8フィールド)、bot直接渡し、キャッシュ率修正。MetaObserver削除→search-skills+recall-knowledgeでメインループ自律学習。初期知識seed (10件)。 |
| 2026-03-31 | ShannonExecutor (Anthropic API直接) で FCA 置換。prompt caching + Haiku軽量タスク分岐。hunt-animal改善、肉調理ルール、タスク中フィードバック、文脈引継ぎ、ルーチン前提条件。 |
| 2026-03-30 | Tailscale 直接通信に移行 (SSH トンネル廃止)。UI Mod タスク表示修正。 |
| 2026-03-29 | Routine System + SubTask Executor 初版。Phase 1-4 (Claude移行、認知ループ除去、メモリオンデマンド化、グラフ簡素化)。ドキュメント整備。 |
