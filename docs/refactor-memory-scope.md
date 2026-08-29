# RF-03 第3段階：記憶の範囲境界（F04/F05）

2026-08-28、VM Shannon-devのみ。未push・本番未反映・起動ロック維持。前段の実行順序/セッション分離に続く実装。Notion 08の16節を現行の進捗記録とする。

## 問題と方針

修正前に外部をモックした実RecallEngineで、範囲不明の旧記憶、本人のDM記憶の公開会話への持ち込み、共通のdiscordタグを経由した別guild記憶の参照を再現した。検索後だけのフィルタではtop-Kを別範囲の記憶が占有する。保存後にcontent/時刻でscopeを追記する旧処理も廃止する。

`modules/memory` はSDK非依存のscope判定とMemoryPortを持つ。`services/memory/requestMemory` はcanonical RequestEnvelopeから範囲を一度だけ導出し、検索・保存へ渡すadapter。タグ・表示名・モデル出力・confidenceで権限を与えない。sourceUserIdは信頼したchannel adapter由来であることが前提で、任意HTTP入力の本人確認をこの関数が行うものではない。

## 範囲の契約

新しい `scopeVersion=1` と `scopeKey` を保存する。keyは区切り文字連結ではなく要素配列のJSON。scopeオブジェクトは不変で、policyから発行したものだけをserviceが受け付ける。

| 入力 | 読み書きできる範囲 |
|---|---|
| Discord DM | 安定user ID + DM channel ID + conversation ID + thread ID。guild付きDM等の矛盾は拒否 |
| Discord guild | guild ID + channel ID + conversation ID + thread ID。同じ範囲の参加者間で共有 |
| Minecraft | server ID + world ID + dimension。サーバー表示名だけでは認可しない |
| Web / X / YouTube / scheduler / internal / Notion / 不足情報 | この段階では記憶I/Oを拒否。本人確認とaudience契約を配線するまで未対応 |

DM記憶は本人でも公開チャネルへ持ち出さない。shared_project/global_generalized/self_modelという旧ラベル単独やgeneralized=trueは共有許可にならない。会話由来の自己モデル・strategy・internal state・world patternも生成元の範囲に置き、モデルによる公開範囲の昇格をしない。固定人格ファイルとは別の扱い。

## 検索・保存・実行経路

- タグ/全文/最近の記憶/episode/自律状態のMongoクエリに、sort/limit前から同じscope条件を入れる。
- 意味検索もscope付きMongoクエリで候補ベクトルを取得してから類似度・top-K・randomを計算。全体キャッシュは使わず、最終取得でもscopeを再確認する。候補なしではembedding APIも呼ばない。旧cache lifecycle APIは互換no-op。
- 保存の最初のcreateにscopeを含める。dedupとevictionは同じ範囲内。入力のscope/owner/generalizedを無視し、scopeはツール引数に公開しない。
- FCA単独、ParallelExecutorのMemoryAgent、ShannonExecutorのツールに同じrequest portを渡す。旧save/recall-experience/knowledgeもrequestごとのfactoryとportへ接続。save-memoryは保存結果を返し、保存失敗を成功と表示しない。
- TaskEpisodeMemoryはplatformだけの検索/保存を拒否し、envelope必須。初期記憶・episode・非同期自律更新・キューはscopeに必要な値を先にsnapshot化する。runtime bot等はキューのenvelopeへコピーしない。
- MemoryWriteEventは新しいscopeVersion/keyを持つジョブだけをclaimし、payloadとkey/ownerの不一致を抽出前に拒否。古いpendingジョブはそのまま残す。新しいjobの生成以外に旧DBを変更する移行はない。
- 旧MemoryNodeは互換用の空実装。X/YouTube等の不完全なTaskContextから記憶を読まない。生成/initializeでモデル・timer・全体バックフィル/統合を起動しない。
- 範囲を持たないPersonMemoryは、recall-person/初期記憶/共通recallと会話書き戻しから隔離。表示名をcanonical person IDへ昇格させるfallbackも削除。

## 意図的な制限・移行

既存の記憶・人物・キューを削除/一括再分類しない。versionのないレコードは検索対象外。現行Minebot AdapterはserverNameしか渡さないため、現状のMinecraft長期記憶は停止する。安定server/world IDを環境設定から明示する次の配線が必要。人物記憶、Web、他チャネル、共有知識の再有効化には出典と範囲のレビューが必要。

scope単位に容量を数えるので、全体容量は以前の500/300件より増える可能性がある。旧データは自動削除しない。運用上限・明示的なscope付き保守ジョブ・検索indexの実DB評価はリリース前に決める。意味検索は毎回同じscopeの候補をDBから読むため、その負荷測定も残る。

コードrollbackで旧検索へ戻すと、旧版がscope付きレコードを無制限に読む可能性がある。安全なrollbackはこの境界を保持する候補、または記憶機能停止を伴うものに限定して別途リハーサルする。scopeのstampを消してrollbackしない。未リリースのため実切替は行っていない。

## 検証と未完了

VM devのNode22.21.1でbackend250件＋frontend18件＝268件合格（前回より43件追加）。core/記憶service/対象access adapter型検査、common/frontend build、backend noCheck変換、native probeが成功。prod769ファイル/削除1パス・Git clean・PID14447/開始時刻不変・health正常を読み取りで確認した。

`npm run check:foundation -w backend` と `npm run check:memory-integration -w backend` でcoreと記憶サービス/episode/旧MemoryNodeを通常型検査する。FCA/MemoryAgentを含むグラフ全体の完全型検査は既存負債のため未完。backend全体のbuildはnoCheck変換と区別する。

モックで2利用者、DM→公開、別guild/channel/conversation/thread、別server/world/dimension、同名利用者、不明scope、旧ラベル、dedup/eviction、意味検索の候補と再取得、旧/新ツール、初期記憶、episode、queue、自律状態、非同期snapshot、保存失敗を確認する。実DBクエリプラン・index・同時write競合は未検証。実Discord/Firebase/LLM、ゲーム、DB移行は実行しない。

2026-08-29: 経路ごとのストア宣言（`modules/memory/stores.ts`）を追加。旧 PersonMemory の会話書き戻しと relationship 更新は拒否。LINE/Radar は Discord の ShannonMemory / 人物引用を使えない。WorldKnowledge は operator の `dev:`/`prod:` serverId のみ（表示名・host では開かない）。Minecraft タスク引継ぎは server+world。Web の durable memory は audience 契約まで拒否が完成。旧データ分類は audit CLI の dry-run のみで自動移行しない。Minecraft 長期記憶は `MINECRAFT_MEMORY_IDENTITIES` が空ならオフ。DB記憶経路の修正を全体のプライバシー保証や F04/F05 完了とは扱わない。
