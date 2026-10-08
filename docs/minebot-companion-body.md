# 本番 Minebot を心の体にする（companion body モード、2026-10-06）

普段の Shannon Minebot（`backend/src/services/minebot/client.ts` + `skillAgent.ts` + `MinebotTaskRuntime`、本体 backend から起動）を、専用の常設ワールドでだけシャノンの心（shannon-ios の companion）の体にする。既定はオフで、オフなら今までとまったく同じ。ラボ実走（`scripts/minecraft-campaign-live-probe.ts`）と同じ部品を使う（`backend/src/services/minebot/integration/`）。心の側の契約は shannon-ios の `docs/minecraft-body-contract.md`。

## 設定（`backend/src/config/env.ts`、URL・トークン・id・サーバー名がそろった時だけ有効）

| 変数 | 内容 |
| --- | --- |
| `MINEBOT_COMPANION_BODY_URL` | 心の URL。loopback の http のみ（例 `http://127.0.0.1:<port>`） |
| `MINEBOT_COMPANION_BODY_TOKEN_FILE` | 心に体として登録した端末トークンのファイル。接続のたびに読む。値はログに出さない。読めない・短い時はその接続ではオフ |
| `MINEBOT_COMPANION_SERVER_ID` | 心がこのワールドを覚える id（心の `SHANNON_MINECRAFT_BODY_JSON` の `servers[].serverId` と同じ） |
| `MINEBOT_COMPANION_SERVER_NAME` | このモードを使う Minebot のサーバー名。通常は `shannon-home`（サーバー表にある、モードを使ってよい唯一の既知ワールド `COMPANION_WORLDS`）。表にある他のサーバー（YouTube・テスト等の共有ワールド）は拒否 |
| `MINEBOT_COMPANION_SERVER_PORT` | 表に無い新しいサーバー名の時だけ必要（他のサーバーのポートは拒否）。`shannon-home` では省略（書くなら表と同じ 25560 でなければ拒否） |
| `MINEBOT_COMPANION_SERVER_VERSION` | 同上。表に無い名前の時だけ必要（`shannon-home` は表で 1.21.11） |
| `MINEBOT_COMPANION_UI_MOD_BASE_URL` | 任意。そのワールドの UI Mod の受信サーバー（loopback）。省略時は表のポート（`shannon-home` は 8086） |

一部だけ設定・不正な値は「オフ」で起動し、理由（`COMPANION_BODY_CONFIG_INCOMPLETE:…` など。トークンは含まない）を警告に出す。

## shannon-home をサーバー表と画面に追加（2026-10-06、オーナー決定）

モードの有無にかかわらず、`shannon-home` は普通のサーバーとして選べる（モードがオフなら他のサーバーと同じ普段の Bot）。

- Minebot（`MinebotConfig`）: ポート 25560、版 1.21.11（`MINECRAFT_SERVER_VERSIONS`。名前の先頭に版が無いため。`client.ts` は `CONFIG.serverVersion()` で版を決める）、UI Mod 8086（`UI_MOD_PORT_OFFSET` を足す）。既存サーバーのポート・版・UI Mod は不変。
- サーバー管理（`backend/src/services/minecraft/client.ts`）: `minecraft:shannon-home` として登録。`SERVER_BASE_PATH/shannon-home` の `start.sh` / `stop.sh` で起動・停止し、状態は専用の tmux ソケット（`tmux -L shannon-home list-sessions`）で見る。
- 画面: `common` の `MinecraftServerName`、Web の Minebot サーバー一覧（`MinebotBotItem.tsx`）と状態一覧（`StatusTab.tsx` の「MC shannon-home」）、運用画面の報告対象（`configuredShannonOpsReporter.ts`）。管理ウィンドウの「Minebot を shannon-home で起動」は既存の `minebot.start`（対象 `minecraft:shannon-home`、サーバーが起動中であること）で動く。

## 動き（その専用ワールドに接続中だけ）

- **話しかけ**: mineflayer の `chat` イベントは聞かず、プレイヤーチャットの packet の送信者 UUID（`integration/gameChat.ts` の `listenToPlayerChat`）で話し手を決める。システムチャット・偽装チャット（`/say` 等）・一覧にいない送信者は誰でもない。コマンド（`..` `./` 等）は従来どおり。名前で始まる発言（`シャノン`/`しゃのん`/`Shannon`）は `POST /v1/body/minecraft/turns` へ、体の今（今のタスクの目標・場所の種類・体力・満腹度・時間帯・最近の実績、座標と持ち物は送らない。本番のタスクはどれも誰かの頼みなので `busyWith` は `request` か `idle`）と一緒に送る。返事はゲーム内チャット（`MINECRAFT_CHAT_MAX_CHARS` ごと最大3行）と UI Mod の `/bot_chat` に出す。`intent: task` で `request` があれば心の列に積まれたもの（claim で受け取る）、無ければその `goal` をタスクの先頭に置く（もう返事をしたので体は完了・失敗時だけ一言）。`stop` は実行中のタスクを止める。心が答えられない時は従来の `processMessage` が答える。UI Mod の入力欄（`/chat_message`）は名前をプレイヤー一覧で UUID に引いて同じく心へ。
- **頼みごと**: `CompanionRequestLoop` を本番の runtime で動かす（`integration/CompanionRuntimeTasks.ts`）。受け取ったら `putTaskFirst`（タグ `companion_task`、`metadata.companionTask`、`memoryDisabled: true`、チャットで報告しない旨の文脈）、進み具合・結果（実行結果の taskTree が `completed` なら `done`、それ以外は `gave_up`/`error`、死亡をはさめば `died`）・増えた持ち物を返す。心からの取り消しでタスクを止め `stopped`。切断・停止で残りは `run_over`。終わった頼みのタスクは列に残さない（次の発言が続きと取られないため）。
- **死亡**: 自分の名前の死亡メッセージの翻訳キーから死因を読み `game.died` を送る（他のプレイヤーがいれば `audience: others`）。
- **UI Mod**: `MINEBOT_COMPANION_UI_MOD_BASE_URL` で送り先を決める。Mod → Bot は本体の `MINEBOT_API_PORT`（既定 8092）と `MINEBOT_API_TOKEN` を使う。
- ログ: `MINEBOT_COMPANION_STARTED` / `_REPLY` / `_UNAVAILABLE` / `_TASK` / `_REQUEST` / `_DIED` / `_STOPPED` と、頼みごとの `MINEBOT_COMPANION_REQUEST_TAKEN` 等。

実装: `integration/MinebotCompanionBody.ts`（本番の組み立て）、`companionBodyConfig.ts`、`companionBodyParts.ts`（ラボと共有: 体の今・死亡と実績・返事・1ターン）、`CompanionRuntimeTasks.ts`（ラボと共有）、`gameChat.ts`（`labHumanContact.ts` から移動、再 export あり）。テスト `tests/unit/minebotCompanionBody.test.ts`、`minebotSkillAgentCompanionChat.test.ts`（偽の心・偽の bot・実物の `MinebotTaskRuntime`、ネットワークなし）。実サーバー・実の心での確認は未実施。

## 専用ワールド shannon-home（2026-10-06 作成）

`/home/azureuser/minecraft/shannon-home`、ポート 25560、online-mode、`enforce-secure-profile=true`、ホワイトリスト（Rai1241・I_am_Shannon）、Fabric 1.21.11 + ShannonUIMod 2.0.0（`config/shannonuimod.json`: backendPort 8092 / httpServerPort 8086）。起動・停止は `start.sh` / `stop.sh`（tmux `-L shannon-home`）。設定例（値は本番の env にだけ置く）:

```
MINEBOT_COMPANION_SERVER_NAME=shannon-home
MINEBOT_COMPANION_SERVER_ID=shannon-home   # 心の SHANNON_MINECRAFT_BODY_JSON の serverId と同じにする
MINEBOT_COMPANION_BODY_URL=http://127.0.0.1:<本番の心のポート>
MINEBOT_COMPANION_BODY_TOKEN_FILE=<体の端末トークンのファイル>
```

Mod の設定には `backendToken` がまだ無い。Mod → Bot（入力欄・タスク操作）を使うなら本体の `MINEBOT_API_TOKEN` を入れ、サーバーを再起動する（Bot → Mod の送信はトークンなしで動く）。

### 世界記憶（`MINECRAFT_MEMORY_IDENTITIES`、オーナー決定で有効にする）

shannon-home の固定 id は serverId `shannon-home`（本番では `prod:shannon-home` になる）、worldId `shannon_home-20261006`（ワールドフォルダ名 `shannon_home` と作成日）。**ワールドを作り直したり別のワールドに置き換えたら worldId を変える**（例 `shannon_home-<新しい作成日>`）。同じ id のまま別ワールドにすると、前のワールドの場所や出来事の記憶が新しいワールドに混ざる（プロトコルからは検出できない。`docs/refactor-minecraft-memory-identity.md`）。名前・host・port は接続設定と完全一致が必要（host は `MINECRAFT_HOST`、既定 127.0.0.1）。本番の env に入れる値（他のサーバーの対応付けが既にあれば `bindings` に1行足す）:

```
MINECRAFT_MEMORY_IDENTITIES={"version":1,"environment":"prod","bindings":[{"name":"shannon-home","host":"127.0.0.1","port":25560,"serverId":"shannon-home","worldId":"shannon_home-20261006"}]}
```

dev で試す時は `"environment":"dev"`（`dev:shannon-home`、記憶は本番と分かれる）。テスト `minebotCompanionBody.test.ts` で、この値があれば shannon-home の接続だけが世界記憶に結びつき、他のサーバーは結びつかないことを確かめている。

## 本番投入の順番（コア担当と合意済み）

1. 本番の心は、投入まで `SHANNON_MINECRAFT_BODY_JSON` を空のままにする（空なら turn は 503、体の出来事は無視）。
2. online-mode のサーバーにつなぐ前に、本番の Bot に署名付き UUID の修正（`5df570e`）と、このモードのコミットが入っていること。それまで本番 Bot の env にこのモードの設定を入れない。
3. 体の端末を心に登録し、`SHANNON_MINECRAFT_BODY_JSON`（`serverId`・オーナーの UUID・`onlineMode: true`。shannon-home は secure chat を強制しているので可）を設定するのは、オーナーとコア担当の了承を得てから。
4. その後に本番 Bot の env に上の設定（`MINEBOT_COMPANION_*` と `MINECRAFT_MEMORY_IDENTITIES`）を入れて再起動し、shannon-home に接続して確かめる。

ゲーム内の呼びかけ（`シャノン`/`しゃのん`/`Shannon` で始まる発言）と、返事を `MINECRAFT_CHAT_MAX_CHARS`（既定72字）×最大3行に収めることはオーナー承認済み（2026-10-06）。

## 10月8日の統合と測定の順序

本人の最新指示は**先にアプリの心へ統合し、その後に40分測定**。接続を確認した単独実走だけでは、心から渡された目標を実行した証拠にはならない。

統合の受入れは、正規オーナー会話 → `minecraft.request` → 共通の行動権 → body claim → 既存Executor → progress/result → 元実行の終了ACK → `body.game`経験、を同じrequestの由来で確認する。キューへ入ったことをゲーム内の達成としない。取消はAbortSignalを送った瞬間ではなく、原runが終了した時だけ既知の`stopped`にする。未終了の間は操作権を保持し、新しい身体実行を始めない。非協調runが終わらない時は未知として残す。

結果のDB保存と経験記録の間の障害で経験を失わないよう、心の側に同一transactionの配送待ち記録と冪等な配送を用意する。これは旧Minebotの技能学習ストアを新心の価値表へ合併する変更ではない。旧技能・場所・経験を保ち、新心は依頼の結果を自分の経験として受け取る。

### 小さいモデルとキャッシュ

本番でHaikuを明示する設定は、`MINECRAFT_PLANNER_PROVIDER=anthropic`と`MINECRAFT_PLANNER_ANTHROPIC_MODEL=claude-haiku-5-5`。認証は既存の私的EnvironmentFileから供給し、文書やreleaseへキーをコピーしない。この明示設定時は通常・軽量・緊急・要約も同じnativeモデルと日次予算を通り、Jevの代替判断もHaikuを使う。Jevの主経路と既存の身体反射は維持する。

有用な固定プロトコル・指示・道具を1時間cacheのprefixに置き、実usageの作成/読取りを検証する。キャッシュやusageが確認できない応答は再送せず、既知費用と不明予約を保つ。過去モデルの比較fixtureは履歴として残す。

### 統合後の有限試験

新規自然ワールド、非OP、支給なし。正規オーナーの`/v1/chat`へ「エンドラを討伐してください」だけを一度送り、心のfresh requestをbodyがclaimして開始する。独立したroot taskを重ねない。40分はrootの開始から数え、setupと停止後の精算を分ける。人が途中目標を追加しない。身体の現行観測・独立oracleで到達度を判定し、モデルの完了宣言だけで討伐としない。

今回専用の$1 Minebot台帳、既存の日次要求/予約量、有限時間のいずれでも止まる。古い台帳や上限を初期化・拡大しない。結果にはusage由来の料金、未知の保守的予約、cache読取り率、要求数、待ち時間、実時間、停止理由を別々に残す。Jev→画像付きDecisions反射は今回未実装で、黙って比較条件へ追加しない。

## Haiku 5.5 公式ガイドの適用

公式 [Prompting Claude Haiku 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5) と [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) を参照する。native Haiku の同一会話では静的 system/tools と送信済み履歴を保持し、現在の観測だけを末尾へ追記する。要約を作る境界では新しい会話を開始し、旧 prefix に結び付いた署名を移植しない。refusal は既知の usage を残した終端として扱い、同じ要求の自動再送で回復を装わない。adaptive・固定 effort・既存の完了証拠・停止・予算・1時間 cache を維持する。実 cache reuse と到達度は統合後に測定する。
