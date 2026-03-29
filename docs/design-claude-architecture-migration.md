# Shannon Claude Architecture Migration 設計書

> **ブランチ**: `feature/claude-architecture`
> **作成日**: 2026-03-29
> **目的**: Shannon の実行モデルを Claude Code と同じ「1フロンティアモデル + シンプルループ」アーキテクチャに移行する

---

## 1. 現状の問題

実測ログ (2026-03-29) の分析:

| タスク | LLM 反復 | 実時間 | LLM 時間比 |
|--------|---------|--------|-----------|
| 精錬+クラフト | 50 | 184秒 | 92% |
| 食料収集 | 25 | 63秒 | 95% |

**原因**: 小型モデル (gpt-4.1-mini) の推論力不足を、複雑なアーキテクチャ (8ノード, 3並列ループ, 50回反復) で補おうとしている。結果として遅く、不正確。

---

## 2. 目指すアーキテクチャ

### Claude Code のアーキテクチャ（参考）

```
System prompt (人格 + ルール)
  +
Tool definitions
  +
ループ: 拡張思考 → ツール呼出 → 結果 → 拡張思考 → ... → 完了
```

**特徴**: ClassifyNode も EmotionLoop も MetaCognitionLoop もない。1つのフロンティアモデルが、1つのループで、分類・感情・メタ認知・計画・実行を全部やる。

### Shannon の新アーキテクチャ

```
[現在: 8ノード + 3並列ループ]
ingest → classify → emotion → recall → subtask_plan
  → execute(ParallelExecutor(EmotionLoop + MetaCognitionLoop + FCA))
  → format → writeback

[移行後: 3ノード + 1ループ]
ingest → execute(SingleModelLoop with Claude) → writeback
```

execute 内部:
```
Claude Sonnet 4.6 (extended thinking 有効)
  System prompt: Shannon人格 + Minecraftルール(簡潔版) + ルーチンカタログ
  Tools: routine:*, manage-routine, InstantSkills, recall-*, save-*, task-complete
  Context: inventory, position, nearby entities
    ↓
  [拡張思考] モデルが自分で判断:
    - タスク分類（会話？行動？緊急？）
    - 感情（人格プロンプトから自然発生）
    - 計画（複数ステップの推論）
    - メタ認知（「このアプローチは正しいか？」）
    ↓
  Tool calls (複数ツールを1回で呼び出し可能)
    ↓
  Results → 次の思考 → ... → task-complete
```

---

## 3. Claude Code のコピーにならない理由と解決策

### 3.1 リアルタイム制約

**問題**: Claude の拡張思考は 10-30 秒かかる。Minecraft ではゾンビが来る、溺れる、空腹になる。

**解決策**: 2層構造を維持
```
System 1 (即応層): ConstantSkills + RoutineExecutor
  - autoEat, autoSwim, autoAvoidDragonBreath → 100-1000ms 周期
  - RoutineExecutor → LLM 不要で高速実行
  - EventReactionSystem → ダメージ検知で自動逃走

System 2 (思考層): Claude Sonnet 4.6
  - 新規タスクの計画・実行
  - 10-30秒の思考時間は ConstantSkills が生存を担保
```

**重要**: Emergency fastpath は維持。ダメージ検知時は LLM を待たず ConstantSkill が即座に対応。LLM には事後報告。

### 3.2 人格の持続性

**問題**: Claude Code は各会話がリセットされる。Shannon は持続的な人格（記憶・感情・自己モデル）を持つ。

**解決策**: 記憶システムは外部に維持、ツールとして提供
```
[現在] ScopedMemoryService が6種のメモリを毎回 pre-load → プロンプトに注入
[移行後] recall-*, save-* ツールを提供 → モデルが必要時に自分で引く
```

- `recall-person`, `recall-experience`, `recall-knowledge` → 既存ツール
- `save-person`, `save-experience`, `save-knowledge` → 既存ツール
- Shannon プロフィール → システムプロンプトに常時注入（人格の核）
- 感情状態 → プロンプトの人格指示で自然発生。MongoDB への保存は task-complete 後に fire-and-forget

### 3.3 マルチチャネル

**問題**: Claude Code は1チャネル。Shannon は Discord / X / YouTube / Web / Minecraft の5チャネル。

**解決策**: ingest (アダプター) と writeback (チャネル別出力) を維持
```
Channel Adapters → RequestEnvelope → execute(Claude) → ActionPlan → Channel Dispatch
```

チャネル固有の処理（Discord voice, Twitter post 等）はツール側で吸収。モデルはチャネルを意識する必要がない（envelope にチャネル情報が入っている）。

### 3.4 コスト

**問題**: Opus は高い。50回ループしたら破産する。

**解決策**: ループ回数の劇的削減 + ルーチンでLLM呼出を回避

| | 現状 (gpt-4.1-mini × 50) | Sonnet 4.6 × 5 |
|--|--------------------------|----------------|
| 入力トークン | ~150K | ~40K |
| 出力トークン | ~50K | ~15K |
| 概算コスト/タスク | ~$0.10 | ~$0.40 |
| 実行時間 | ~184秒 | ~30-50秒 |

4倍のコスト増だが、精度と速度が劇的に改善。ルーチンで LLM 呼出を削減すれば差は縮まる。

**コスト制御策**:
- MAX_ITERATIONS を 15 に制限（現在の50から削減）
- 単純な会話（挨拶、雑談）は 1-2 回で完了するはず
- ルーチンで定型作業を吸収（LLM 0回）
- 将来的に Haiku 4.5 への動的フォールバック（単純タスク向け）

### 3.5 API 差異

**問題**: OpenAI API と Anthropic API でツール呼出の仕様が異なる。

**解決策**: LangChain が吸収
- `@langchain/anthropic` の `ChatAnthropic` は `bindTools()` / `withStructuredOutput()` 対応
- FCA のツール呼出ループは LangChain 経由なので、モデル差し替えで動くはず
- Extended thinking は `ChatAnthropic` の `thinking` パラメータで有効化

---

## 4. 実装フェーズ

### Phase 1: モデル差し替え（最小変更）

FCA の ChatOpenAI → ChatAnthropic に変更。既存アーキテクチャはそのまま。

**変更ファイル**:
- `backend/src/services/llm/graph/nodes/FunctionCallingAgent.ts` — モデル初期化を ChatAnthropic に
- `backend/src/config/env.ts` — ANTHROPIC_API_KEY 設定追加（既に CodeAgentLoop 用にあるはず）
- `backend/src/services/llm/graph/cognitive/ModelSelector.ts` — エスカレーションチェーンを Claude モデルに

**モデル選択**:
| 用途 | モデル |
|------|--------|
| メインFCA | claude-sonnet-4-6 (extended thinking 有効) |
| SubTaskPlanner | claude-haiku-4-5 (structured output, 高速) |
| ClassifyNode | claude-haiku-4-5 (この時点ではまだ残す) |

**期待**: 反復回数が 50 → 5-10 に減少するはず。減少しなければアーキテクチャの問題。

### Phase 2: 認知ループの段階的除去

Phase 1 で反復回数が十分に減ったことを確認してから。

**Step 2a: MetaCognitionLoop 除去**
- Claude の拡張思考が自己評価を内包するため不要
- ParallelExecutor から MetaCognitionLoop を除去
- モデルのプロンプトに「進捗を自己評価し、方針が間違っていたら修正せよ」を追加

**Step 2b: EmotionLoop 除去**
- Shannon の人格プロンプトに感情指示を含める
- EmotionNode.invoke() の1回目の感情判定は残す（初期感情の設定）
- ループ中の再評価は除去（モデルが自然に感情を表現）

**Step 2c: ClassifyNode 統合**
- ClassifyNode の分類を ingest ノードに統合
- または execute ノードの冒頭で Claude が自分で判断（ツール選択で暗黙的に分類）
- `needsPlanning` の判断もモデルに委譲（ルーチンカタログを見て自分で決める）

### Phase 3: メモリのオンデマンド化

**変更**: recall ノードを削除し、recall-* ツールに統一。

**現在の流れ**:
```
recall ノード → 6種のメモリを pre-load → プロンプトに注入 (毎回 ~2000 tokens)
```

**移行後**:
```
プロンプト: 「記憶が必要なら recall-person / recall-experience / recall-knowledge を使え」
モデル: 必要だと判断したときだけ recall ツールを呼ぶ
```

**利点**:
- 「木を切って」に relationship メモリは不要 → トークン節約
- モデルが「この人、前にも同じこと頼んできたな」と判断したときだけ recall
- 必要なメモリの種類をモデルが自分で選べる

**注意**: Shannon プロフィール（自己認識の核）はプロンプトに常時注入。これは記憶ではなく人格。

### Phase 4: グラフの抜本的簡素化

```
[最終形]
ingest → execute → writeback

ingest: RequestEnvelope の正規化 + チャネルアダプター
execute: Claude Sonnet 4.6 のツール使用ループ
  - Emergency タグ → ConstantSkill が先行対応、LLM に事後報告
  - Minecraft → ルーチンカタログ + スキルツール
  - Discord/Web → 通常ツール + recall/save
  - Voice → STT → execute → TTS (VoiceProcessor は維持)
writeback: メモリ保存 + ActionDispatch
```

---

## 5. 維持するもの

以下は Claude アーキテクチャ移行後も維持する:

| コンポーネント | 理由 |
|-------------|------|
| **ConstantSkills (15個)** | リアルタイム生存の即応層。LLM に依存してはいけない |
| **RoutineExecutor + RoutineManager** | LLM の呼出回数削減。モデルに依存しない高速実行 |
| **RoutineRecorder** | パターン→ルーチン自動生成の学習ループ |
| **manage-routine ツール** | Shannon によるルーチン自己管理 |
| **EventReactionSystem** | 緊急時の自動対応（LLM 待ちなし） |
| **MinebotTaskRuntime** | タスクキュー、緊急プリエンプション |
| **VoiceProcessor** | STT/TTS パイプライン（execute の前後で動作） |
| **AgentOrchestrator** | Twitter/YouTube 等の特化エージェント |
| **MongoDB 記憶** | 持続的記憶ストア |
| **Langfuse** | LLM 呼出トレーシング |

---

## 6. 削除・簡素化するもの

| コンポーネント | 理由 |
|-------------|------|
| **ClassifyNode** | モデルが自分で判断。ingest に軽量統合 |
| **EmotionLoop** | 人格プロンプトで自然発生。MongoDB 保存は writeback で |
| **MetaCognitionLoop** | 拡張思考が内包。プロンプトに「自己評価せよ」で代替 |
| **ParallelExecutor** | 3並列ループが不要に。単一ループに |
| **CognitiveBlackboard** | 並列ループ間の共有状態が不要に |
| **ModelSelector (エスカレーション)** | 1モデルで十分。動的切替不要 |
| **ScopedMemoryService.recall()** | pre-load → on-demand (recall ツール) |
| **SubTaskPlannerNode** | モデルが自分でルーチン選択+計画する |
| **SubTaskExecutor** | モデルが直接 routine:* ツールを呼ぶ |
| **PromptBuilder の大半のルール** | モデルの推論力で不要に。10個以下に |

**注**: SubTaskPlanner/Executor は Phase 1 では残す。Phase 2-3 でモデルの精度が十分なら除去。

---

## 7. リスクと緩和策

| リスク | 緩和策 |
|--------|--------|
| Anthropic API ダウン | OpenAI フォールバック（FCA のモデルを切替可能に設計） |
| コスト超過 | MAX_ITERATIONS=15, ルーチン活用, 日次コストアラート |
| 拡張思考が遅すぎ | ConstantSkills が生存担保。思考中も autoEat/autoSwim は動作 |
| ツール呼出の互換性 | LangChain 経由。テスト段階で検証 |
| 精度が期待以下 | Phase 1 で反復回数を測定。改善しなければ Phase 2 に進まない |

---

## 8. 成功指標

| 指標 | 現状 | 目標 |
|------|------|------|
| LLM 反復回数/タスク | 25-50 | 3-8 |
| タスク実行時間 | 60-184秒 | 20-50秒 |
| タスク成功率 | 未測定 | 測定開始、改善 |
| コスト/タスク | ~$0.10 | ~$0.40 (精度・速度とのトレードオフ) |
| プロンプトルール数 | 30+ | 10以下 |
| グラフノード数 | 8 | 3 |

---

## 9. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-29 | 初版作成。Routine System 実装完了を受けて、Claude アーキテクチャ移行の設計。 |
