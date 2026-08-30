# RF-03 第5段階：本人・会話・出典で限定する人物記憶

2026-08-28。第4段階 `b17e2740` に続くdev実装。本番未反映、ライブ起動ロック維持。旧PersonMemoryを再公開・移行しない。

## 目的と今回の範囲

旧人物記憶はplatform/user単位でDM・公開会話を混ぜ得るため停止していた。今回、新しい人物記憶の最小単位を「現在の本人が、現在の会話で発言した引用」として実装する。性格・信頼度・関係性を推測して旧profileへ書き戻す処理は戻さない。

対象はcanonical Discordテキストenvelopeの本人だけ。subjectはDiscord user ID、audienceは既存のscopeVersion/key（guild/channel/conversation/thread、DMの場合は本人とDM channelを含む）で固定する。本人のDMをその本人の公開会話へ持ち出さない。同じ公開channelでも、人物記憶の検索対象は現在の話者本人に限定する。

表示名・タグ・名前の対応表・モデル指定のsubjectは本人確認に使わない。Web/Discord音声/Minecraft等、本人の契約が不足する経路とmemoryDisabled入力は人物記憶を停止する。一般の体験/知識のMemoryPortと、今回の本人限定PersonMemoryPortは別契約。

## 責務

| 層 | 役割 |
|---|---|
| `modules/memory/personMemory.ts` | SDK非依存の本人binding、引用/出典の契約、PersonMemoryPort、件数制限、引用の表示 |
| `services/memory/requestPersonMemory.ts` | リクエスト冒頭で本人・scope・原文・出典を捕捉。保存/編集/忘却結果を返す |
| `services/memory/personStatementRepository.ts` | Mongo操作。全read/writeで本人＋scopeを必須化し、重複と版競合を処理 |
| `models/ScopedPersonStatement.ts` | 新コレクション`scopedpersonstatements`。旧モデルや一意制約は変更しない |
| 新旧ツール・MemoryAgent・RecallEngine | 同じportへ接続し、旧人物profileへフォールバックしない |

bindingは発行済みオブジェクトだけを認め、スプレッドコピー等で作り直したものをrepositoryで拒否する。これは内部コードの境界であり、全アプリの本人認証やOS権限分離の代用ではない。

## 保存するもの・しないもの

- quote：現在のenvelope.textに完全一致で含まれる原文、最大1000文字。要約・改変・過去の履歴・ツール結果からの新しい文章は拒否する。
- source：Discord message ID、request ID、受信時刻。モデルの引数からは受け取らない。保存前にsnapshot化する。
- scope、subject、kind=`user_quote`、status、revision。
- 原文全体や会話全文、displayName、traits、trust/familiarity、推測した人物名は保存しない。

「本人の発言」であって「本人について確認済みの事実」ではない。第三者について述べた文や引用が含まれる可能性は残り、プロンプトでは未検証の発言データ・指示ではないと明示する。記録する引用の選択はモデルの判断であり、保存同意の専用UIや参加者同意の実装ではない。

## 一意性・編集・忘却

初回出典をscope＋subject＋Discord message IDで固定し、SHA-256をMongoの`_id`とする。**1メッセージにつき1つの引用**。既存の`_id`一意性と`$setOnInsert`を使い、並行再試行で二重登録しない。後から同じメッセージの別の引用を要求しても自動上書きしない。

内部portのcorrectは同じ出典メッセージの編集反映に限定する。現在の原文に含まれる引用とmessage ID、期待revision、本人/scope、active状態を同時に照合して更新する。別メッセージを根拠に既存記憶を訂正する会話UIや、Discord editイベントへの接続は未実装。

内部portのforgetは同じ本人/scopeと期待revisionを照合し、quote/sourceをunset、statusをforgottenにしてrevisionを増やす。本文を残さず、scope/subjectと初回出典のハッシュを含む最小の墓標で同じ出典の再登録を止める。遅延した元の保存や、同じmessage IDの編集後の保存でも復活しない。

**忘却の範囲はこの記録だけ。** 別メッセージで同じ話題を新しく保存すること、一般記憶・会話履歴・checkpointer・派生要約・バックアップ・旧queueの撤回は対象外。墓標の保持期間と完全削除方針も今後の判断。編集/忘却は内部APIのみで、LLMツール/HTTP/UI・自動イベントには公開していない。新規保存/検索だけを会話エンジンへ接続した。

## 読み取りと実行経路

Mongoのsort/limitより前にscopeVersion/key/visibility＋owner/subject＋kind＋active状態で絞る。最大20件、既定5件。取得後もstampを再検証し、不正な行を返さない。リクエストごとにportを作り、共有catalogへ本人情報を残さない。

- `save-person-memory`：現在の本人の原文引用のみ。
- `recall-person`：未指定または`self`だけ。人物名による検索は拒否する。
- `recall-memory`：MemoryAgentのある経路と単独経路の両方で本人引用を参照。
- MemoryAgent.initialize/queryとunified ScopedMemoryServiceのformattedPromptへ接続。
- 旧`person`/userProfile/relationshipの構造はnullのまま。新しい`personStatements`で区別し、信頼度等を捏造しない。

保存エラーや引用/出典の欠落時はsaved=falseを返す。「覚えた」と成功扱いしない。読取失敗時の初期記憶は空に縮退する。CAS応答が失われた場合の再試行結果は成功の再返却を保証せず、再読込が必要。全queueのlease/再試行設計とは別。

## 検証

VM devでbackend353＋frontend18＝371件合格（人物記憶41件追加）。本人/同名別人、DM→公開、別guild/channel/thread、引用・出典の欠落/改変、snapshot、scope偽装、ツールの実行ごとの所有、初期記憶・統合prompt、重複・版競合・忘却後再保存を検証した。

対象coreとmemory integration/access integrationの通常型検査、common/frontend build、backend全体のnoCheck変換、Node22 native probeが成功。大きなMemoryAgent/FCA等を含む全backendの完全型検査ではない。

加えてMongoDB 4.4.29の一時インスタンスをloopback37028・専用dbpathへ起動し、架空fixtureのみで実Mongoose/model/repository/portを検証。8並行再試行→1記録、本人と会話分離、CAS勝者1件、忘却時本文/source除去、同じ出典の再保存拒否、旧collection未作成、二次index自動作成なしを確認。試験後に一時mongodを正常停止した。通常のshannon/shannon_dev DBへの書き込みではない。

再実行用probeは`node scripts/probe-person-memory-mongo.cjs --isolated-fixture`。ロックのあるVM devと、別途用意した空の37028/`shannon_person_fixture`だけを対象とする。空でないDBは拒否。起動手順と停止証跡は保全先に残し、本体の起動ロックを迂回しない。

## 移行・リリース前に残ること

旧personmemories、旧記憶・pending jobは変更しない。前段階のdev監査が各0件だったことは旧本番データの分類完了ではない。旧データを全体ごと新subject/scopeへ複製せず、出典/audienceごとの分類・影響レビュー・plan hash・復元手順を別工程とする。

新collectionはautoCreate/autoIndex=false。今回のprobeでは`_id`以外のindexを作成しない。実データ量に対するquery index/容量/保持方針・性能検証はライブ前に必要。認証・全履歴/checkpointer/WorldKnowledge/宛先認可が未完のため、scope付き人物portだけで全体の漏洩防止を保証しない。

Minecraft固定IDは未設定、人物のWeb/音声/Minecraft復旧、一般利用者/公開chat、Firebase/Discord分離、UID/権限、送信範囲・費用枠、限定実機・復旧・本番切替レビューは残る。prodファイル・プロセスは変更せず、pushしない。旧無制限検索へ戻すロールバックは避け、問題時は人物記憶を停止する。
