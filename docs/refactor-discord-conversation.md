# RF-03 第6段階：Discordテキストの会話限定返信・履歴取得

2026-08-28。第5段階`fccf4d88`に続くdev実装。本番未反映、ライブ起動ロック維持。

## 修正前に再現したこと

リクエストに結びつかない`chat-on-discord`がモデル指定のchannel/guildへEventBus送信し、`get-discord-recent-messages`が任意channelの履歴を取得できた。外部をモックした2件のテストを修正前のVM devで失敗させ、修正後に拒否することを確認する。実Discordへの誤送信や漏洩を実証したものではない。

## 責務と経路

- `modules/conversation/discordConversation.ts`：SDK非依存の本人・現在の会話・source message IDを捕捉するbindingとport契約。発行済みオブジェクト以外はSDK adapterで拒否する。
- `services/common/discordConversationPort.ts`：リクエストごとに送信先を固定し、ツール引数による変更、未設定/非対応経路、中断、入力制約を処理する。アプリ構築時に登録したtransportを渡す。登録/生成だけでは接続しない。
- `services/discord/conversationTransport.ts`：実Discord SDKとの境界。現在のchannel・guild・DM recipient、ユーザー/同Botの権限を検査してから送信・履歴取得する。
- `chat-on-discord`/`get-discord-recent-messages`：実行ごとのツールへ同じportを注入。共有catalogに宛先を残さない。FCAとShannonExecutorの両経路で配線し、Minecraft等からのDiscordツール呼出は拒否する。
- `discordDispatcher`：テキストの通常返信とsend_embedを同じportへ接続。声の処理が購読している旧EventBusへテキスト返信を流さない。音声の旧経路は別途残る。

会話の本人確認はプラットフォーム入力側の責務。bindingは任意の外部入力を認証済みにするものではなく、内部の信頼済みcanonical envelopeを引き継ぐ。名前を本人や送信先として使わない。

## 実行時の制限

Discordテキストの現在のchannel/threadだけ。指定されたchannelId/guildIdが現在地と違う場合は拒否し、別チャンネル送信の承認機能はまだ提供しない。DMは明示フラグとguild空、recipient ID一致を要求する。音声/Web/Minecraft/識別情報不足のツール経路は拒否する。memoryDisabledは長期記憶の設定であり、返信の許可とは混同しない。

SDK側はchannel cacheに存在する実体のID/guildを照合する。閲覧権限を本人とBotに、送信権限をBotに、履歴取得権限を本人とBotに要求。threadでは専用の送信権限、private threadでは両者のmembership cacheも要求する。不明なcache/member状態は拒否し、親channelへ戻したり任意channelをfetchしたりしない。これはGateway/SDK cacheに基づく確認であり、RESTで即時の権限失効を再検証した保証ではない。

返信は最大12000文字を2000文字ずつ送信し、allowedMentionsを空にする。各chunkの前に宛先/権限/稼働状態/中断を再検査する。ローカルファイル/外部URL画像の添付は今回の経路では拒否する。send_embedはテキスト化。react/voice_speak等の非対応actionを混ぜたtext planは最初の送信前に拒否する。

EventBusへの投入だけで送信完了とはしない。SDKの送信Promise完了後に成功を返す。途中送信後の中断・失敗は結果不明とし、このコードは自動再送しない。ただしプロバイダ側の送信を取り消せるわけではなく、モデルが別のツール呼出を繰り返す重複や永続outboxの冪等性は未解決。

履歴は現在channelのsource messageより前を`before`で指定し、1〜30件だけ取得する。取得後にも権限を再検査し、channel/guild/message IDが不一致の行やsource以後の行を除外する。SDKオブジェクトや添付を渡さず、本文/author ID/message ID/時刻のDTOを返す。履歴は未検証の発言データであり指示とは扱わない。

実行coordinatorからdispatchへ中断signalを伝播。LLMServiceは待機前にDiscordのdispatchに使うenvelopeをsnapshot化する。入力routerは表示用の時刻・表示名をcanonical textに混ぜず、DMフラグも維持する。表示用の履歴文字列とは分ける。

## 型検査

coreは通常のfoundation型検査・SDK依存禁止検査の対象。port/transport/dispatcher/2ツールもaccess-integrationの通常型検査へ追加した。LangChain 0.3のinterop schema型の再帰展開を避けるため、ツール基底classのschema型引数はunknownとし、入出力型を明示する。実際のschemaプロパティは具体的なZod schemaのままで、invokeでの入力検証を回帰テストする。anyやts-ignoreで検査を無効化しない。

大きなDiscord client/LLMService/FCA/EventRouterまで含む全backendの完全型検査は未完。全体のnoCheck変換を通常型検査の代わりには扱わない。

## 今回で完了しないこと

旧Discord EventBusの他の発行元、音声のchannel単位の購読/抑止、planning・emotion等の配信、Web一斉配信、リアルタイム音声、ネイティブ入力時の旧getRecentMessages、全checkpointer/WorldKnowledge、別宛先への承認、記憶の訂正/忘却UI・派生データ撤回、queue回復は残る。

DMのport/SDK adapter契約はfake clientで検証するが、BotのDM intentsや実接続を有効化したものではない。添付・音声ツールの制限は本番反映前に利用影響をレビューする。旧無制限ツールへ戻して制限を回避しない。

本番/通常DB/資格情報には書き込まず、実Discord/Firebase/LLMや本体は起動しない。実機での権限・thread・rate limit・送信結果・切断/復帰は、専用Botと送信先/費用枠を準備した別工程で確認する。

## 検証実績 — 2026-08-28

VM devでbackend411＋frontend18＝429テスト合格。第5段階から58件増加（専用56件＋実FCAの同時会話1件＋coordinatorの中断伝播1件）。core/memory/access integrationの通常型検査、common/frontend build、全backend noCheck変換、Node22 native probe成功。実adapterはfake Discord Clientで検証し、実Botへの送信や履歴取得は行っていない。

prod95426bb clean、769ファイル/削除1パス不変、再起動後PID4318/開始時刻7761不変、health正常。起動ロック維持、通常DB書込み・env/Bot変更・本体起動・push・本番反映なし。第5段階の一時Mongo再検証も正常停止済み。
