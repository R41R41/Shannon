# 隔離ラボの実走と ShannonUIMod・人との会話（2026-10-05）

公開ラボ（`MINECRAFT_LAB_PUBLIC=true`）の実走中に、入ってきた人がシャノンと話せるようにした。本体（`skillAgent.ts`）と同じやり方で ShannonUIMod v2.0.0 とつなぐ。dev の隔離ラボ専用で、本体・本番・共有ワールドには触れない。

## つなぎ方

- ワールド作成（`scripts/minecraft-isolated-lab.mjs`、公開ラボのみ）: `MINECRAFT_LAB_UI_MOD=true` で `MINECRAFT_LAB_MODS_DIR`（既定 `backend/saves/minecraft/uimod-test`）から `fabric-api-*.jar` と `shannonuimod-*.jar` を1つずつ `mods/` へ複写し、`config/shannonuimod.json`（権限600）を書く。
  - ポートはゲームポートから決める（`scripts/lab/lab-ui-mod.mjs`）: backend（実走側のHTTPサーバー）= +3600、Mod の受信サーバー = +3800。公開範囲 25500〜25600 なら 29100〜29200 と 29300〜29400 で、どちらも loopback のみ。VM のファイアウォールが開けている 7777・8080〜8085・14000〜14200・25500〜25600 には重ならない。作成時に使用中なら止める。
  - `backendToken` は48桁の乱数で、このファイルにだけ置く。実走スクリプトはここから読み、環境変数・標準出力・ログには出さない。
  - `botPlayerName` は `MINECRAFT_LAB_BOT_NAME`（既定 `I_am_Shannon`）。身体のアカウント名と違えば `CAMPAIGN_UI_MOD` の `botNameMatches:false` に出る。
- 実走（`scripts/minecraft-campaign-live-probe.ts` の full runtime、`launch-nether-run.sh` が使う経路）: ワールドに設定があれば `LabUiModBridge` を起動する。
  - Mod → 実走: `MinebotHttpServer` を `127.0.0.1:backendPort` で待ち受け、ワールドのトークンだけを受け付ける。`setTaskRuntime` / `setEventReactionSystem` / `setOnChatMessageCallback` を本体と同じく配線する。トークンが無いワールド（例: 既存の qywEbW）では待ち受けず（`CAMPAIGN_UI_MOD_WARNING UI_MOD_TOKEN_MISSING`）、状態の送信だけを行う。Mod は設定を起動時に読むので、トークンを足したらサーバーの再起動が要る。
  - 実走 → Mod: 常時スキル・反応設定（開始時と変更の要求時）、タスク一覧（`runtime.setTaskListUpdateCallback`）、タスクツリー（ShannonExecutor の `publishTaskTree` → `/task`）、シャノンの発言（`chat` スキル → `/bot_chat`。`CONFIG.setUiModBaseUrlOverride` で送り先をこのワールドの Mod にする）。どれも2秒で打ち切る送りっぱなしで、失敗しても実走は止まらない。同じ宛先への送信が詰まった時は最新の1件だけを残す。
  - 常時スキル・反応設定の変更要求は 403 で断る（`settingsLocked`）。本体と共有の `saves/minecraft/*.json` に書かれ、実験条件も途中で変わるため。音声（Discord）と `/bot_command` は無い（Mod は旧来の経路へ自動で切り替える）。
  - 本体側は変わらない: `MINEBOT_UI_MOD_BASE_URL`（loopback の http のみ）か上書きを設定しない限り、サーバー名からの選択のまま。
- 観戦者: `MINECRAFT_LAB_WATCHERS=spectator`（既定。入った人を観戦モードにする）か `free`（ゲームモードを変えない。一緒に遊べる）。

## 話しかける

- ゲーム内チャット（プレイヤーの発言の packet だけ。下記）で `シャノン` / `しゃのん` / `Shannon`（大文字小文字を問わない）から始まる発言、または Mod の会話欄・`/shannon <文>` から来た `/chat_message`。身体自身と観察者（ShannonProbe）の発言は数えない。Mod の「続行」ボタン（system の「続けて」）はキャンペーンが自分で続くので無視する。
- 話し手の決め方（2026-10-06、レビュー S2）: ゲーム内チャットは minecraft-protocol の `playerChat` のうち、プレイヤーチャットの packet（`player_chat`）の送信者 UUID（`sender`）を持つものだけを聞く。名前はその UUID をプレイヤー一覧で引いた表示用、本文は本人が送った `plainMessage`（サーバーの装飾は使わない）。mineflayer の `chat` イベントは使わない: これは送信者を見ずに、プレイヤーチャット・システムチャット・偽装チャットの表示文字列を `<名前> 本文` 型の正規表現で読むだけなので、システムチャットの `<Rai1241> シャノン、…`、ニックネーム・チームの接頭辞・チャットプラグインで表示名を変えた他人の発言、コマンドブロックやコンソールの `/say`（偽装チャット `profileless_chat`、送信者なし）がオーナーの名前として出てくる。システムチャットと偽装チャットはオーナーの発言にも他人の発言にもせず、捨てる（ログも出さない）。`/msg`・`/teammsg`・`/me`・プレイヤーの `/say` も `player_chat` なので、名前で始まれば送信者の UUID で同じように聞く。体自身と観察者は UUID（と名前）で除く。心はこの UUID だけでオーナーかを決める（`CompanionBodyClient.turn` の `speakerUuid`）。公開ラボは online-mode で、UUID はサーバーが Mojang の認証で決めたもの（enforce-secure-profile=false なので署名は検証しない。サーバーを信頼する）。Mod の `/chat_message` は loopback と Mod のトークンで守られた、このマシンのオーナー自身のクライアントとして信頼し、送られてきた名前をプレイヤー一覧で UUID に引く（従来どおり）。実装 `gameChatSpeaker`・`playerNameByUuid`（`labHumanContact.ts`）、テスト `minecraftLabHumanContact.test.ts`（mineflayer の chat プラグインに偽の packet を流し、mineflayer がオーナー名を返す場合でも聞かないことを確かめる）と `minecraftCampaignOperatorStop.test.ts`。
- 受けた発言ごとに `CAMPAIGN_HUMAN_CHAT <名前> <先頭60文字>` をログに出し、`runtime.putTaskFirst` で `user_chat` タグ付きのタスクを列の先頭に置く。実行中のキャンペーンは緊急時と同じく最後のチェックポイントで一時停止し、会話タスクが終わるとそこから再開する（失われない）。続けて話しかけられたら先の会話の後ろに並ぶ。待っている会話が3件を超える分は `CAMPAIGN_HUMAN_CHAT_DROPPED` を出して捨てる（1件ごとに課金されるため）。
- 会話タスクは ShannonExecutor を goal = 相手の発言、`chat` スキル付きの道具（キャンペーンの実行では `chat` は外したまま）、話しかけた人の名前を入れた短いシステムプロンプト（日本語で一言返す・できることならやる・終わればキャンペーンに戻る）で走らせる。`conversation: true` なので、物理的な作業を約束しなかった（完了条件を設定しなかった）返事は完了証明なしで終われる。作業を頼まれた時は従来どおり完了条件の設定と検証が要る。キャンペーンの目標ツリーと学習の記録には入れない。
- 30ターンで終わらなかった・失敗した会話タスクは、続行を待たずに列から外す（もう一度話しかければよい）。

## 受入の扱い

人が関わった実走は、人の助けなしの受入試験ではなくなる。

- 話しかけた回数と Mod の操作（`/throw_item`・`/task_delete`・`/task_prioritize`・`/task_continue` のうち実行されたもの）の合計を `humanInteractions` として報告書と `CAMPAIGN_RESULT` に出す。1以上なら `accepted:false`、`acceptanceVoidReason:"human_interaction"`。捨てた発言も数える。
- `MINECRAFT_LAB_WATCHERS=free` で誰かが入った実走も `accepted:false`（`free_watcher_present`）。サバイバルの人は話さなくても手伝えるため。
- 報告書には `humanChats`（時刻・名前・経路・本文の先頭200文字・タスクID・捨てた理由）、`humanControls`、`freeWatchers`、`watchers`、`uiMod`（ポート・受信の可否。トークンは出さない）、区間ごとの `humanChatRuns` が入る。

## 検証

単体テスト（外部なし・loopback のみ）: `tests/unit/minecraftLabHumanContact.test.ts`（宛先判定・観戦モード・ログ行・設定の読み取り・URL の上書き・ポートの割り当て・jar の選択）、`minecraftLabUiModBridge.test.ts`（偽の Mod サーバーで送信・トークン・設定の拒否・操作の記録）、`minecraftUserTaskFirst.test.ts`（キャンペーンの一時停止と再開・会話の順番）、`minecraftConversationTurn.test.ts`（会話の完了と通常タスクの完了証明）、`minecraftCampaignOperatorStop.test.ts`（実走スクリプトが話しかけを聞き、受入にしない）。実サーバー・実モデルでの実走は未実施。

## シャノンの心につなぐ（2026-10-05、ユーザー決定）

方針: シャノンの心はアプリ版（shannon-ios）ひとつ、Minebot はその体（Live2D と同じ扱い）。言葉は心が書き、体は行動とマイクラの技能知識を持つ。友人は人ごとに覚える。会話の入口はゲーム内チャットが主で、スマホや Discord からの頼みごとも体へ届くようにする（後続）。

- 設定: `MINECRAFT_LAB_COMPANION_URL`（loopback のみ。開発用の心は `http://127.0.0.1:4329`）、`MINECRAFT_LAB_COMPANION_TOKEN_FILE`（心に体として登録した端末トークンのファイル。値はログに出さない）、`MINECRAFT_LAB_COMPANION_SERVER_ID`（公開ラボは `lab-public`。ワールドを作り直しても同じ場所として覚える）。公開ラボ（正規ログイン）でだけ有効。
- 話しかけ: 名前で始まる発言（と Mod の入力欄）は `POST /v1/body/minecraft/turns` で心へ。体の今（目標と今の作業・場所の種類・体力・満腹度・時間帯・最近の実績・何に忙しいか）を一緒に送る。座標と持ち物は送らない。返事はゲーム内チャットと Mod の `/bot_chat` に出し、心が `intent: task` を返した時だけその `goal` を体の仕事として列の先頭に置く（`answered: true` の会話タスク: 体はもう一度返事をせず、終わった・できなかった時だけ一言）。心が答えられない時は体の計画器が従来どおり答える。ログ: `CAMPAIGN_COMPANION_REPLY` / `_UNAVAILABLE`。
- 死亡: バニラの死亡メッセージの翻訳キーから死因（`minecraft:lava` など）を読み、`game.died` の体の出来事として心へ送る（`CAMPAIGN_COMPANION_DIED`）。
- 実装: `backend/src/services/minebot/integration/CompanionBodyClient.ts`、テスト `tests/unit/minecraftCompanionBody.test.ts`。心の側は shannon-ios の `docs/minecraft-body-contract.md`（開発用クローン `/home/azureuser/shannon-companion-dev`、ブランチ `minecraft-body`、未コミット）。
- 開発用の心: 本番と同じ版を別ディレクトリで動かす（127.0.0.1:4329、tmux `-L shannon-companion-dev`、空の SQLite `/home/azureuser/shannon-companion-dev-data`、env `~/.config/shannon-companion-dev/api.env`）。本番のデータ・設定・サービスには触れない。モデル費用はユーザー承認の上限 1,000 円（`llm_usage_events` の実費で監視）。
- L108 での実地確認: 心の返事は届いたが、横道の受け口だったため会話の流れと体の様子を知らなかった。体の今を送る応急処置の後、アプリと同じ会話の中心を通す改修を進行中（履歴・想起・気分・ツールを共有し、全体チャット・ささやき・友人を場面として区別する）。

### 頼みごとの列（第4段階、2026-10-05）

スマホで「木材集めといて」と言うと、心（`minecraft.request` 道具、ライ氏と二人の時だけ）が心の側の列に積み、体が受け取って動き、進み具合と結果を心に返す。心は次の会話で `[マイクラの体で起きたこと]` と体験（`body.game`）としてそれを知る（「木材集まった？」に結果で答える）。

- 体の側: `CompanionRequestLoop`（`backend/src/services/minebot/integration/CompanionRequestLoop.ts`、テスト `tests/unit/companionRequestLoop.test.ts`）。心が設定されている時だけ、実走と並んで `POST /v1/body/minecraft/claim` を長く待つ（最大25秒、持っている頼みごとの id を `holding` で伝える）。受け取った頼みごとは `putTaskFirst` で作戦の先頭へ（タグ `user_chat`、`metadata.humanChat = { player: 'owner', message: goal, answered: true, requestId }`、計画器はチャットせずに実行して task-complete）。受け取り（`accepted`）・開始（`started`）・作業中の技能名（`working`、ときどき）を進み具合として、終わったら `done` / `failed`（`gave_up`・`died`・`error`・`queue_full`・`run_over` など）と、その間に増えた持ち物（最大6種の個数）を結果として返す。心から取り消されたらタスクを止めて `stopped` を返す。実走の終わりに残っていれば `run_over`（死亡なら `died`）。ログ: `CAMPAIGN_COMPANION_REQUEST` / `CAMPAIGN_COMPANION_REQUEST_TAKEN` / `_CANCELLED` / `_REPORTED`、報告の `companionRequests`。
- ゲーム内チャットの頼み: 心が体の受け取りを確認できている時（直近40秒の claim）は、`intent: task` を心が列に積み `intent.request.id` を返す。体はその場では動かず、claim で受け取って同じ道を通る（進み具合・取消・結果が一本になる）。`request` が無い時は従来どおり体がその場で列に置く。
- 人との接触の数え方は従来どおり: 頼みごと1件も人の関与1回（ゲーム内チャット由来は発言の記録に結びつけ、二重には数えない）。受入にはならない。
- 心の側の詳細・状態・誤りコードは shannon-ios の `docs/minecraft-body-contract.md` の「Requests (phase 4)」。Discord からの頼みは第5a段階で dev に実装（下記）。

### Discord から心へ（第5a段階、2026-10-06、dev のみ）

Discord Bot が `SHANNON_CORE_PLATFORM_REPLY=true`（既定は無効）の時、binding 済みの会話の本人の発言は心の `POST /v1/platform/reply` が答える（心の側も `SHANNON_PLATFORM_REPLY=on`）。本人の DM（心の側で `owner-private`）は「ライ氏と二人」なので、体がワールドにいれば「マイクラで木材集めといて」が `minecraft.request` でスマホと同じ列に積まれ、体が claim で受け取る。「何頼んだっけ？」には `[マイクラの体で起きたこと]` と会話の履歴で答える。共有チャンネル・友人には道具を出さない。心が答えられない時は従来の Bot の LLM が答える。詳細は `docs/shannon-core-bridge.md`。

### 本番 Minebot を体にする（2026-10-06、dev）

ここまでの心とのつなぎ（話しかけ・頼みごとの列・死亡）は、普段の Shannon Minebot でも専用の常設ワールド（`shannon-home`）でだけ使えるようにした（既定オフ）。部品はラボと共有（`backend/src/services/minebot/integration/`）。設定と本番投入の順番は `docs/minebot-companion-body.md`。
