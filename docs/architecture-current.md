# Shannon 現状アーキテクチャ

> **最終更新: 2026-08-29**
> 作業先: Azure VM `/home/azureuser/Shannon-dev`（`codex/shannon-foundation`）
> 本番 `/home/azureuser/Shannon-prod` は開発中読み取りのみ。この文書は **いま動いているコードの地図** であり、2026-04 の「FCA置換済み」記述は誤りだった。

関連: [FCA核](./refactor-fca-kernel.md) · [記憶scope](./refactor-memory-scope.md) · [人物記憶](./refactor-person-memory.md) · [LINE](./line-integration.md) · [Radar](./shannon-radar.md) · [開発手順](./development-workflow.md)

---

## 1. 一言で

Shannon は **複数の実行核と複数のプロセス** を持つエージェント群である。1つの Claude ループが全チャネルを処理している、という前提は捨てる。

| プロセス | 役割 | 起動 |
|---|---|---|
| 本体 backend（Discord / Minecraft / Web / X） | Shannon Graph。dev は `.dev-runtime-lock` で停止 | ロック中は起動しない |
| LINE 専用サービス | Webhook・1対1会話・個人Radar配信。本体グラフを起動しない | `shannon-line.service`（prod）。dev は permit 付き |
| フロント Vite | 管理console。public chat は停止 | 本体とは別 |

実行核は3系統ある。

```
① modules/fca（共有核）
   Radar digest / LINE chat / Discord FunctionCallingSession / 定期投稿の探索

② ShannonExecutor（Minecraft 主パス）
   Anthropic SDK 直接。失敗時だけ ① の Discord FCA へ落ちる

③ 独自ループ（核の外）
   CodeAgentLoop（ステイ）/ 一部 scheduler の配信（X投稿・画像生成）
```

LangChain は消えていない。Discord FCA は StructuredTool を核へ包む。定期投稿の検索も既存ツールを port として核へ渡す。共有核 `modules/fca` は SDK / グローバル pub/sub / Mongo 非依存。

---

## 2. 実行フロー（本体グラフ）

```
Channel Adapter → RequestEnvelope
    ↓
Shannon Graph: ingest → execute → writeback
    ↓
execute:
  Minecraft かつ Anthropic key あり かつ SHANNON_USE_FCA≠true
    → ShannonExecutor（InstantSkills / Routines / prompt cache）
    → 例外時のみ FunctionCallingAgent（= 共有核 + LangChain ツール袋）
  それ以外（Discord / Web 等）
    → FunctionCallingAgent
```

感情・メタ認知の3並列（`EmotionNode` / `EmotionLoop` / `MetaCognitionLoop` / `ParallelExecutor`）と `ClassifyNode` / `SubTaskPlannerNode` / `SubTaskExecutor` は削除済み。`EmotionType` も画面・音声・共有型から消えた。Discord 音声の感情は Voicepeak 自身の `analyzeEmotionForTTS` で、Plutchik とは別系統。`CognitiveBlackboard` / `MemoryAgent` / 空の `MemoryNode` も削除した。記憶ツールは `recall-memory` / `save-memory` / `save-person-memory` に統合し、旧 `save-experience` 等5ツールは廃止。記憶の実行経路は `MemoryPort`（`bindRequestMemory`）と `ScopedMemoryService`。X/YouTube 投稿エージェントは不完全な TaskContext では記憶しない。未参照のコードは [削除ゲート](./deletion-gate.md) が止める。

LINE と Radar はこのグラフに入らない。独立 HTTP runtime。

---

## 3. ShannonExecutor と modules/fca の関係

### どこで使われるか

`ShannonExecutor` の呼び出し元は実質 `shannonGraph.ts` の execute ノードだけ。Minecraft かつ Anthropic キーがあるとき。`MinebotTaskRuntime` はフィードバック注入と bot 参照渡し、`SubAgentRoutineExecutor` は Executor のツール変換を再利用する。Discord / LINE / Radar / 投稿エージェントは Executor を使わない。

### どちらが高性能か

**用途が違うので、片方を「高性能」と呼んで置換しない。**

| | ShannonExecutor | modules/fca |
|---|---|---|
| 目的 | Minecraft 長時間タスク | 会話・選択・短いツールループ |
| モデル | Anthropic 直接（Sonnet / Haiku、prompt cache） | 注入された model（LINE/Radar は OpenAI 系、Discord は OpenAI または LangChain Anthropic） |
| 強み | 50K 級ツール定義の cache、InstantSkill 直実行、緊急 Abort、タスクツリー | 短いループ、fail-closed な未登録ツール、catalog 差し替え、送信/記憶を核に持たない |
| 弱み | プロセス静的な前回タスク要約、Minecraft 専用 | Minecraft の 70 スキル袋・生存ポリシー・prompt cache を持たない |
| 失敗時 | FCA へフォールバック（Discord 用ツール袋が載る） | 呼び出し側が扱う |

Minecraft を核へ無理に吸収すると、Anthropic cache と InstantSkill 直実行を失う。会話側を Executor に寄せると、LINE/Radar が本体グラフの旧グローバル bus に縛られる。**核は1つ（fca）、Minecraft 実行器は別実装として残す**のが妥当。共通化するのは「ツール名の許可リスト」と「記憶/送信をループ内に書かない」契約だけ。

`SHANNON_USE_FCA=true` は Minecraft でも FCA を使う実験スイッチ。本番相当の既定ではない。

---

## 4. ツール袋（目標は2つ）

現状は実装形式が3つある。袋としては **Minecraft / その他一般** の2つに畳む。

| 袋 | 中身 | 経路 |
|---|---|---|
| `minecraft` | InstantSkills・Routines・search-skills・plan-craft・manage-routine・Minecraft 記憶ツール | `minecraft_executor`（主）。Discord FCA の Minecraft フォールバックでも一部が載る |
| `general` | 検索・画像・Discord会話・X・Notion・YouTube URL・記憶ツール・投稿用 submit | 経路ごとに **許可名の部分集合** だけを渡す |

経路と許可名の宣言は `backend/src/modules/access/toolCatalog.ts`。Discord / Web / Minecraft FCA は run 時に `selectToolsForChannel` で切る。loader が全ツールを積んでも、Twitter 投稿ツールは会話経路から呼べない。

Radar の discovery スキルは general 袋の読み取り専用サブセット。LangChain StructuredTool とは名前が違う（`search_web` ≠ `google-search`）。送信ツールはどの袋のループにも入れない。

`postNews` と `postAboutToday` は同じ核 + 同じ検索袋 + `submit_post`。配信（X 投稿・画像生成）はループの外。プロンプトとヘッダーだけを分ける。CodeAgentLoop はステイなのでこの袋に混ぜない。

---

## 5. 記憶（混在禁止）

混ざってはいけない単位は「同じ人が別の場で話した内容」ではなく、**公開範囲（scope）** である。

| ストア | 使ってよい経路 | 使ってはいけない経路 |
|---|---|---|
| 新 `ShannonMemory`（scopeVersion=1） | Discord テキストで scope が発行できたとき。Minecraft は server/world ID が揃ったときだけ | LINE、Radar、Web、X、YouTube、scheduler、scope なし |
| 新人物引用 `scopedpersonstatements` | Discord テキストの現在の本人＋会話のみ | 表示名検索、別会話、LINE、Radar、Minecraft |
| 旧 `PersonMemory` | **読み書きしない**（recall は常に null、会話書き戻しは拒否） | すべての会話経路 |
| `WorldKnowledge` | Minecraft かつ **operator の `dev:`/`prod:` serverId**（表示名・host・`default` 不可） | Discord/LINE/Radar/Web、未binding、表示名 |

| LINE 会話 | プロセス内の短履歴のみ。本体記憶へ書かない | 旧人物記憶・Radar owner 文書 |
| Radar owner 文書 | 本人 Radar 専用 DB | Discord/Minecraft 記憶、グループ LINE |
| Minecraft タスク引継ぎ | 同じ serverId+worldId の continuation だけ | プロセス全体の static lastTask |

宣言は `backend/src/modules/memory/stores.ts`。`deriveMemoryScope` は discord / minecraft 以外で null。null なら検索も保存もしない。WorldKnowledge は `forServer`（assigned id のみ）、HTTP は同じ `serverId` 必須。InstantSkill の知識抽出・スナップショットは bound `serverId` だけを渡す。

残っているもの（完成扱いにしない）:

- 旧 PersonMemory **文書**の分類は `scripts/lib/memory-scope-audit.cjs` の read-only dry-run だけ。自動移行しない。
- LangGraph checkpointer は現行コードに無い。
- Web の durable ShannonMemory は Identity–Binding–Audience が無いので **拒否が完成**。実装しない。
- Minecraft 長期記憶は `MINECRAFT_MEMORY_IDENTITIES` が空ならオフ。コード経路はある。表示名では開かない。

旧データを一括移行しない。

---

## 6. プロセス内結合：port と gateway

ライの問い「疎結合・将来リポジトリ分割・いまは VM 1台」に対する答え。

**2026-08-29 更新:** 旧 `EventBus`（共有グローバル pub/sub）は削除済み。UI 通知は `WebNotificationHub`、LLM 入口は `llmInboundDispatch`、サービス start/stop は `serviceCommandRegistry`、外部ツール RPC は `platformToolGateway`、Discord 送信は conversation/outbound port、Voice は `voiceGateway`、Minebot スキルは `minebotSkillGateway`。

| 段階 | 何か | 向いていること | Shannon での位置 |
|---|---|---|---|
| 1. 共有グローバル | 旧 EventBus、`getInstance()` | 原型 | **EventBus は削除済み**。singleton はまだ残る |
| 2. プロセス内 port | 関数の引数で「誰が何をしてよいか」を渡す | 同一 VM・同一 Node プロセス。テストが差し替え可能 | RF-03 / RF-04 の方向。gateway/registry もこれ |
| 3. 同一 VM の別プロセス + HTTP | Express / Unix socket | クラッシュ分離、別の秘密、別のデプロイ | **LINE はすでにこれ**（15041） |
| 4. 別ホスト / 別リポジトリ | サービスメッシュ、キュー | チーム分割、スケール | 不要。VM 1台で足りる間はコストだけ増える |

**宛先認可・記憶検索・ツール実行の同期経路に pub/sub を使わない。** Discord テキスト返信・履歴は `discordConversationPort`、Web 返信・計画通知は `webConversationPort` / `WebNotificationHub`（sessionId でフィルタ）。

フロントとバックエンドはすでに HTTP で分かれている。**契約は port/gateway、実装は in-process、本当に秘密が違うものだけ別プロセス（LINE の前例）。**

---

## 7. 本人と宛先（Web UI で管理したい対象）

いま ID がチャネルごとに別物として存在する。自動リンクしない。

| 系統 | 識別 | 管理場所（現状） |
|---|---|---|
| Web / Radar ログイン | Firebase projectId + UID | 本体 `.env` / Radar 専用 runtime |
| Discord | snowflake | Bot 設定 |
| LINE | チャネルユーザ ID。Radar owner は `line:` + ハッシュ | `~/.config/shannon-line-*` |
| Minecraft | 将来の serverId / worldId + プレイヤ UUID | 未配線。表示名は ID にしない |

一元管理のモデルは「Identity（人）— Binding（チャネル上の ID）— Audience（この会話/配信の宛先）」。Binding は本人が Web UI で明示したときだけ増える。Discord の人物引用を LINE グループへ流さない、という既存禁止は Binding があっても維持する。

設定 UI に載せるもの: Binding、Radar source 最大3、LINE 配信 ON/OFF、許可グループ、ツール経路の許可名、記憶の有効チャネル。載せないもの: トークン本体、refresh token、署名シークレット。UI は「ある/ない/期限」だけ。

これは未実装。本体ロック中に本番 Firebase へ繋がない。

---

## 8. 秘密と設定

分ける。共有 `.env` に LINE を戻さない。

| 種類 | 置き場 |
|---|---|
| 本体（Discord / OpenAI / Mongo 通常） | `backend/.env`（dev と prod で別） |
| LINE Messaging / LINE LLM / LINE 専用 Mongo | `~/.config/shannon-line-dev` と `shannon-line-prod` |
| Radar Google Calendar grant | LINE/Radar 専用。本体 ADC に載せない |
| CSE（ウェブ検索） | LINE 用は LINE env。本体 Google 検索は本体 env。キーを共有しないのが望ましい |
| 起動許可 | LINE は bundle hash + permit。本体は `.dev-runtime-lock` |

Web UI で触ってよいのは非秘密のポリシー（配信時刻、source 数、モデル名の選択）。秘密の回転はファイルと permit の更新。

---

## 9. `FunctionCallingAgentState` の分け方

巨大な1袋を3つに割る。

1. **KernelInput**（`modules/fca` がすでに持つ）  
   system、messages、tools、limits、finish policy、signal。
2. **Composition**  
   envelope、memory port、person port、Discord conversation port、audience。ループが勝手に `getInstance()` しない。
3. **ChannelAdapter**  
   `onTaskTreeUpdate`、音声ストリーム、Minecraft inventory callback、LINE Reply はループの外。

Discord の `FunctionCallingAgentState` は 2 と 3 がまだ混線している。核へ渡す直前に 1 だけを組み立てるのが美しい。Minecraft Executor の state は 1 相当を Anthropic 形式で持つ別型でよい（袋を無理に共通化しない）。

---

## 10. シングルトンをどうするか

問題は「インスタンスが1つか」ではなく、**誰の記憶・誰のツールを、プロセス寿命で共有しているか**。

残してよい（プロセス資源）:

- Discord TCP 接続、Minecraft bot 接続、Mongo ドライバ、HTTP server

残してはいけない（本人・会話に紐づくもの）:

- `TaskEpisodeMemory.getInstance()` に envelope なしで書く（現行は envelope 必須で拒否）
- `WorldKnowledgeService.forServer(表示名)` や旧 `getInstance('default')`（`forServer` は assigned id 以外 null。`getInstance` は削除済み）
- `ShannonExecutor` のプロセス全体 lastTask（world 付き continuation に置換済み）
- `PersonMemoryService` を会話の正本にする（recall/書き戻しは stub。canonical ID だけ残す）
- ツールインスタンスの `setContext` を次の run へ使い回す（`createForRun` がその対策）

直し方: 会話・記憶・ツールは `createForRun` / constructor 注入。`getInstance()` は接続の取得に限り、その戻り値を「この run の owner」に紐づけてから使う。

---

## 11. 自己改善 / CodeAgentLoop（ステイ）

**動いていない。** コードはある。本体 backend がロックで起動していない。`startNightlySelfImproveScheduler` は `SELF_IMPROVE_NIGHTLY_ENABLED=true` のときだけ interval を張る。既定の夜間バッチは LLM なし（スキップ行のレポート）。CodeAgentLoop が走る条件は `..agent-fix`、SkillPatcher/ImprovementApplier からの明示、または `SELF_IMPROVE_NIGHTLY_CODE_AGENT=true`。dev 既定では自動適用しない。触らない。後で核の外の専用ループとして残す。

---

## 12. 型とテスト

「429 テスト合格」は **オフライン unit + 対象 foundation 型検査** の話である。backend 全体は `tsc --noCheck` 変換で、グラフ全体の strict は未完。統合テストは OpenAI と通常 Mongo が要るのでロック中は走らせない。

方針: foundation / memory / access / fca は strict を維持して増やす。本体グラフの noCheck を「設計が正しい」証拠にしない。ライブ E2E をロック解除の代わりにしない。

---

## 13. フロントと公開入口

いまの入口は権限がバラバラ。

| 入口 | 状態 |
|---|---|
| Web public chat | 停止（503 相当の方針） |
| Web 管理 console | Firebase UID + 認可フラグ。公開管理者登録は復活させない |
| Discord | Bot トークン。会話 port で返信先を制限 |
| LINE 1:1 | Messaging API。本体ログインと未結合 |
| LINE グループ | allowlist。個人 Radar / 旧人物記憶を流さない |

統一の核はセクション7の Identity–Binding–Audience。UI は管理consoleに寄せ、public chat を復活させない。LINE を本体 Express に再合流させない。

---

## 14. 関連ファイル

| 領域 | パス |
|---|---|
| 共有 FCA 核 | `backend/src/modules/fca/` |
| ツール経路カタログ | `backend/src/modules/access/toolCatalog.ts` |
| 記憶ストア宣言 | `backend/src/modules/memory/stores.ts` |
| Shannon Graph | `backend/src/services/llm/graph/shannonGraph.ts` |
| ShannonExecutor | `backend/src/services/llm/graph/ShannonExecutor.ts` |
| Discord FCA session | `backend/src/services/llm/graph/nodes/FunctionCallingSession.ts` |
| LINE runtime | `backend/src/services/line/runtime.ts` |
| Radar FCA | `backend/src/services/radar/radarFca.ts` |
| Runtime gateways | `backend/src/services/runtime/`（Hub, tool/voice/minebot/scheduler registry） |

---

## 15. 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-08-29 | 現行に合わせて全面更新。Executor は Minecraft 主パスで FCA 置換ではない。共有核・LINE 分離・記憶混在禁止・ツール2袋・port 契約を記載。投稿エージェントを核へ統合。Discord から Twitter 投稿ツールを除外。WorldKnowledge とタスク引継ぎを server/world 単位に。 |
| 2026-04-04 | （旧）Minebot 戦闘ツールフィルタ等。当時の「FCA 削除済み」は実装と不一致。 |
| 2026-03-31 | （旧）ShannonExecutor 導入。FCA は残存。 |
