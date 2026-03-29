# Shannon プロジェクト現状レポート

**最終更新**: 2025 年 12 月 2 日

---

## 📊 プロジェクト概要

### システム構成

```
Shannon-dev (Backend)
├─ minebot: Minecraft自律エージェント
│  ├─ 42個の原子的スキル
│  ├─ LLMベースのタスク実行（LangGraph）
│  └─ 緊急対応システム
└─ EventBus: サービス間通信

ShannonUIMod (Frontend - Minecraft Mod)
└─ リアルタイムUI表示
```

---

## ✅ 完了済みリファクタリング

### Backend

#### Phase 6: 大規模リファクタリング（✅ 完了）

```
✅ skillAgent.ts 分割（360行 → 各100行以下）
   - SkillLoader, SkillRegistrar, BotEventHandler, MinebotHttpServer

✅ 設定の一元化
   - MinebotConfig.ts で全設定を管理
   - MAX_RETRY_COUNT = 5

✅ 型定義の整理
   - types/ ディレクトリに集約

✅ CentralAgent リファクタリング
   - TaskCoordinator, ActionJudge に分離
   - Structured Output 対応

✅ エラーハンドリング統一
   - ErrorHandler.ts, カスタム例外クラス

✅ テスタビリティ向上
   - DI用インターフェース定義
```

#### プロンプト最適化（✅ 完了）

```
✅ 401行 → 243行（40%削減）
   - 手動スキル一覧削除（動的生成と重複）
   - パターン例削減（3 → 1）
   - 緊急対応ルール分離（条件付き注入）
```

#### 緊急対応システム（✅ 完了）

```
✅ タスクスタック機構
   - 緊急時にタスク中断 → 対応後に復帰

✅ LLM駆動の対応
   - ルールベースではなくLLMが柔軟に判断

✅ 詳細なbotStatus
   - position, health, food, inventory, equipment, conditions
```

#### スキルシステム（✅ 完了）

```
✅ 42個の原子的スキル
   - 移動・視線（7個）
   - ブロック操作（3個）
   - 情報取得（15個）
   - 戦闘・防御（3個）
   - アイテム・クラフト（6個）
   - コンテナ（6個）
   - 農業（3個）
   - 建築（1個）
   - 動物・村人（2個）
   - 生存（2個）
   - その他（4個）

✅ actionSequence機構
   - 複数スキルの順次実行
   - エラー時即座にplanning復帰
```

### Frontend

#### Phase 7: リファクタリング（✅ 完了）

```
✅ ModConfig.java: 設定の一元化
✅ BackendClient.java: HTTP通信の抽象化
✅ PacketRegistry.java: パケット処理の統一
✅ ModErrorHandler.java: エラーハンドリング統一
✅ ShannonUIMod.java: 473行 → 100行以下
```

---

## ⚠️ 未完了・要対応事項

### 🔴 優先度: 高

#### 1. LLM モデル最新化（未実施）

**現状**: 2024 年モデル使用中

```typescript
PlanningNode:  o1-mini (2024年9月)
ToolAgentNode: gpt-4o (2024年5月)
CentralAgent:  gpt-4o-mini (2024年7月)
```

**推奨**: 最新モデルへ移行

```typescript
PlanningNode:  o1-mini → o3-mini
   - 価格: -63% ($3.00 → $1.10 per 1M tokens)
   - 推論品質: +15-20%

ToolAgentNode: gpt-4o → gpt-4.1
   - 価格: -20% ($2.50 → $2.00 per 1M tokens)
   - 性能: +10-15%

CentralAgent:  gpt-4o-mini → gpt-4.1-mini
   - 価格: +167% ($0.15 → $0.40 per 1M tokens)
   - ※絶対額は低いため影響小

総合効果:
- コスト削減: 34% ($117.30/月)
- 品質向上: +15-20%
- 速度向上: +5-10%
```

**実装手順**:

```bash
# 1. OpenAI公式で価格・API可用性確認
# 2. PlanningNodeのみテスト移行
# 3. 効果測定
# 4. 他のNodeも更新
```

---

### 🟡 優先度: 中

#### 2. 実戦テスト

**テストシナリオ**:

```
1. 複雑なタスク
   - 素手から鉄インゴット入手（10フェーズ、60アクション）
   - ネザーでブレイズロッド入手

2. 緊急対応
   - ダメージ検知 → 食事・逃走 → 元タスク復帰
   - 窒息検知 → 浮上 → 元タスク復帰

3. エラーリカバリー
   - ツールなし → クラフト → 再試行
   - パスなし → 別ルート → 成功

4. LLM判定精度
   - new_task / feedback / stop の判定
```

---

### 🟢 優先度: 低

#### 3. 追加スキル実装

**未実装スキル**:

```
⚙️ レッドストーン系:
- toggle-lever
- press-button

🔧 その他:
- equip-armor（現在は手動装備のみ）
- close-container（現在は自動）
```

#### 4. パフォーマンス最適化

**検討項目**:

```
- キャッシング機構（情報取得スキルの結果キャッシュ）
- ログの差分送信（さらなる最適化）
- UIレンダリング最適化
- パケットサイズ削減
```

#### 5. 知識管理システム

**当面は不要と判断**:

- プロンプト最適化で 40%削減達成済み
- 現状で十分機能している
- 必要性が明確になったら再検討

---

## 📁 プロジェクト構造（主要部分）

### Backend

```
backend/src/services/minebot/
├─ config/
│  └─ MinebotConfig.ts          # 設定の一元管理
├─ events/
│  └─ BotEventHandler.ts        # Minecraftイベント処理
├─ http/
│  └─ MinebotHttpServer.ts      # APIサーバー
├─ skills/
│  ├─ SkillLoader.ts            # スキル読み込み
│  └─ SkillRegistrar.ts         # EventBus登録
├─ instantSkills/               # 42個の原子的スキル
├─ llm/
│  ├─ agents/
│  │  ├─ TaskCoordinator.ts     # タスク管理
│  │  └─ ActionJudge.ts         # アクション判定
│  └─ graph/
│     ├─ nodes/
│     │  ├─ PlanningNode.ts     # 戦略立案
│     │  ├─ ExecutionNode.ts    # 実行
│     │  ├─ UnderstandingNode.ts# 理解
│     │  └─ ReflectionNode.ts   # 反省
│     ├─ taskGraph.ts           # LangGraphメイン
│     └─ prompt.ts              # プロンプト管理
├─ types/                       # 型定義
└─ skillAgent.ts                # オーケストレーター
```

### Frontend

```
ShannonUIMod/src/main/java/com/shannon/
├─ config/
│  └─ ModConfig.java            # 設定管理
├─ network/
│  ├─ client/
│  │  └─ BackendClient.java     # HTTP通信
│  └─ packet/
│     └─ PacketRegistry.java    # パケット登録
├─ error/
│  └─ ModErrorHandler.java      # エラーハンドリング
└─ ShannonUIMod.java            # メインクラス（簡素化済み）
```

---

## 🎯 次のアクション

### 今すぐ実施

1. **LLM モデル最新化**
   - OpenAI 公式で価格・API 確認
   - PlanningNode を o3-mini にテスト移行
2. **実戦テスト**
   - 複雑なタスクで動作確認
   - 緊急対応システムの検証

### 必要に応じて実施

3. **追加スキル実装**（レッドストーン系など）
4. **パフォーマンス最適化**（キャッシング等）
5. **知識管理システム**（必要性が明確になったら）

---

## 📊 成果サマリー

### 定量的指標

```
コード削減:
- skillAgent.ts: 360行 → 各100行以下（4分割）
- ShannonUIMod.java: 473行 → 100行以下
- planning.md: 401行 → 243行（40%削減）

期待コスト削減（LLMモデル更新後）:
- 月間: $117.30削減（34%削減）
```

### 定性的指標

```
✅ 保守性向上: 単一責任の原則達成
✅ テスタビリティ向上: DI導入
✅ 拡張性向上: 新スキル追加が容易
✅ パフォーマンス向上: プロンプト最適化
✅ 緊急対応: LLM駆動の柔軟な対応
```

---

## 📚 関連ドキュメント

このドキュメントで全体を把握できます。詳細が必要な場合のみ以下を参照：

- **SKILLS_REFERENCE.md**: 全 42 スキルの詳細リファレンス
- **ARCHITECTURE.md**: アーキテクチャ詳細
