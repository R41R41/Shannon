# LINE連携 — D-010 / LINE-1（2026-08-29）

状態：VM dev実装。実LINE/LLM接続・本番反映は未実施。個人情報配信の初回宛先はDiscord DMからLINEの1対1トークへ変更。LINEグループはenvで明示許可したものだけ会話可能にする。D-009のDiscord DM選択を置換するが、コミュニティDiscordの静かな承認付きカード要件は維持する。

## 利用体験

- 個人：本人との1対1トークにダイジェストを届ける。引用返信でその情報を説明・深掘りできる。Webは設定/履歴用。
- グループ：`LINE_ALLOWED_GROUP_IDS`に指定したグループだけ。既定はBotへのメンション、または「シャノン、」「Shannon,」「/shannon 」の呼びかけ時に返信する。日常会話すべてへの応答を希望する場合だけ`LINE_GROUP_REPLY_MODE=all`を明示する。自発投稿・個人ダイジェスト転送はしない。
- 個人配信の停止/同意：本人1対1トークの`配信開始`/`配信停止`（`/radar on`/`/radar off`も可）。グループの発言や友だち追加だけで個人配信を許可しない。ブロックイベントでも停止する。
- 時刻・頻度・本人の実ID/グループID・費用枠は未確定。雛形は無効、予算0で送らない。22〜8時JSTの静音は初期設定案であり稼働スケジュールを承認した意味ではない。

## 責務と実装範囲

| 層 | 内容 |
| --- | --- |
| `modules/conversation/lineConversation.ts` | SDK非依存の型、本人/グループscope、呼びかけ、期限、静音判断 |
| `services/line/config.ts` | 明示envパース。空は拒否。グループ名・ワイルドカード・個人宛先へのC…IDを拒否 |
| `application.ts` | 独立Express Webhook、署名→宛先判定→予約→会話生成→同じreplyTokenへの返信、停止と引用文脈 |
| `chatModel.ts` | 既存LangChain依存を使うテキスト会話。明示モデル/キー、900出力token、retryなし。旧ツール・記憶・全体graphは接続しない |
| `ledger.ts` / `mongoLedger.ts` | channel文書のCAS、重複/LLM予算/Push予算/同意・停止/永続outbox。初期挿入の_id一意性、majority+journal ACK後に外部作用 |
| `transport.ts` | 固定LINE HTTPS APIのReply/本人Pushだけ。redirect/retryなし。本文/secret/返信tokenをログに出さない |
| `start-line-dev.cjs` | dev専用独立起動、共有.env/Firebase/Discord/main serverなし、起動ロック優先 |

署名は元のraw bytesへHMAC-SHA256。署名前にJSONを再構築しない。256KB/最大20event・入口4並行、会話は全体8件まで、同一scopeで直列化。再送eventは24h保持の予約で重複を防ぐ。55秒より古いメッセージは初期段階では処理しない。生成は最大35秒/元eventから50秒で中断し、期限切れ返信を有料Pushへ置換しない。

会話履歴はメモリ上だけ、最大10発言・参照期限30分、別個人/別グループで分離。未呼びかけ会話は履歴に入れない。unsend/leave/memberLeftでscopeの履歴を消し、処理中生成も中断する。期限切れメモリの物理解放は次の参照/停止時であり30分ちょうどの消去保証ではない。再起動で履歴は消える。人物の主記憶への保存や他サービスの人物名による自動統合は行わない。

LINE専用人格文はキャラクターの口調だけを持つ。既存shannon_profile.mdのメンバー名・関係性は無断でLINEへ持ち込まない。私的Radar引用は本人の1対1トークでのみ、受け付け済みmessage ID・同意版・期限を照合する。引用元を特定できなければ推測しない。

## 個人配信経路と残る接続

`ledger.enqueue`で明示owner/同意/期限/静音/月間・24h上限を検査し、通知予算とpending outboxを同じCASで予約する。`deliver(id, authorize)`は内部worker用でHTTP公開しない。送信前に現在のsource/owner許可callback・同意版・停止/静音/期限を再検証する。宛先はconfigの本人U…IDのみで、LLMやmessage本文に指定させない。

pending→sendingはCASの1勝者だけ。結果はaccepted/failed/unknown。LINE受付は端末受信の保証ではない。失敗/不明/停止でも通数を返さず、sending/unknownの自動再送はしない。プロセス停止でreserved/sendingが残った場合は未完・結果不明として運用者が照合する。exactly-onceや無損失queueを保証しない。再送対応時には同じretry keyの有効期間/照合を設計する。

Push予約は最大62日、本文/引用参照は最大24h（期限後は参照不可、次の書込みで本文削除）。本人の配信停止は本文/引用参照を消すが、会計・重複メタデータを消さない。帳簿上限2,000件/2MB、満杯なら新規処理停止。停止自体は満杯でも可能。LINE月間上限はこのプロセスの予約分のみで、公式アカウント管理画面など別経路の配信通数は包含しない。

**未完**：既存Firebase owner catalogとLINE本人の安全なbinding/委譲grant、定期取得worker→ダイジェスト選定→このoutboxへの接続、source撤回の全派生消去、全owner/無稼働時purge、送信不明の運用画面、実スマホ受信。LINE user IDをFirebase UIDとして偽装したり、ブラウザtoken保存で無人取得を代用しない。今回のentryはschedulerを起動しない。配信MVP完成とは扱わない。

## 設定・実接続の準備

雛形は`backend/line.env.example`。devの実設定はGit管理外`/home/azureuser/.config/shannon-line-dev/runtime.env`（directory700/file600、本人所有、symlink不可）。既存backend/.envには2026-08-29調査時にLINE_*設定なし。今回は新規秘密設定・アカウントを作成していない。

必要項目：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、LINE_BOT_USER_ID、LINE_PERSONAL_USER_ID、LINE_ALLOWED_GROUP_IDS。LLMのモデル/専用キー・24h回数、Pushの月間/24h通数、dev permit期限を明示する。`--check`は形式のみで実資格情報/疎通を保証しない。`--serve`はロック解除等の運用承認後だけ、127.0.0.1:15040を使用。Mongoは通常DBから別の`shannon_line_dev`。通常DBの作成/変更は今回未実施。

LINE公式アカウントのMessaging API設定、グループ参加許可、Bot招待、署名検証可能なHTTPS Webhook経路が必要。自動あいさつ/応答との二重送信も確認する。コンソール変更や公開endpoint作成、実送信、有料プランへの切替は今回行わない。専用Firebaseの新規作成をLINE導入の無条件の前提にはしない。

## 検証と本番

`npm run test:offline -w backend`（全外部mock）と既存型検査/build。`scripts/test-line-mongo.cjs --isolated-fixture`はdev限定・新しい空データ/架空IDのMongo37030を使用し、並行予約・enqueue/claimの1勝者・DBclient再接続後の保持・停止/本人変更拒否を検証して正常停止する。実停電/replica failover試験ではない。

初回本番は、devで実Webhook→許可グループ返信、本人の定期ダイジェスト→引用会話→停止、再起動/重複/結果不明対応まで検証した後の別工程。既存prodファイルやプロセスを変更しない。独立LINE serviceのみ追加し、旧本体の全面切替を待たせない計画。日時は実設定と検証後に決める。

## 公式仕様（2026-08-29確認）

- [グループ会話/参加許可](https://developers.line.biz/en/docs/messaging-api/group-chats/)
- [raw bodyの署名検証](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Webhookと引用元ID](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [LINE API](https://developers.line.biz/en/reference/messaging-api/)
- [API再送とretry key](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)
- [Reply/Push通数](https://developers.line.biz/ja/docs/messaging-api/pricing/)
- [既存ChatOpenAIライブラリ](https://docs.langchain.com/oss/javascript/integrations/chat/openai)
