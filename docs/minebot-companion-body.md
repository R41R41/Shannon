# 本番 Minebot を心の体にする（companion body モード、2026-10-06）

普段の Shannon Minebot（`backend/src/services/minebot/client.ts` + `skillAgent.ts` + `MinebotTaskRuntime`、本体 backend から起動）を、専用の常設ワールドでだけシャノンの心（shannon-ios の companion）の体にする。既定はオフで、オフなら今までとまったく同じ。ラボ実走（`scripts/minecraft-campaign-live-probe.ts`）と同じ部品を使う（`backend/src/services/minebot/integration/`）。心の側の契約は shannon-ios の `docs/minecraft-body-contract.md`。

## 設定（`backend/src/config/env.ts`、全部そろった時だけ有効）

| 変数 | 内容 |
| --- | --- |
| `MINEBOT_COMPANION_BODY_URL` | 心の URL。loopback の http のみ（例 `http://127.0.0.1:<port>`） |
| `MINEBOT_COMPANION_BODY_TOKEN_FILE` | 心に体として登録した端末トークンのファイル。接続のたびに読む。値はログに出さない。読めない・短い時はその接続ではオフ |
| `MINEBOT_COMPANION_SERVER_ID` | 心がこのワールドを覚える id（心の `SHANNON_MINECRAFT_BODY_JSON` の `servers[].serverId` と同じ） |
| `MINEBOT_COMPANION_SERVER_NAME` | このモードを使う Minebot のサーバー名（例 `shannon-home`）。組み込みのサーバー名（YouTube・共有ワールド）は拒否 |
| `MINEBOT_COMPANION_SERVER_PORT` | そのワールドのポート（例 `25560`）。組み込みサーバーのポートは拒否 |
| `MINEBOT_COMPANION_SERVER_VERSION` | mineflayer が話すゲームの版（例 `1.21.11`。組み込みの名前は先頭が版だが、専用名には無いため） |
| `MINEBOT_COMPANION_UI_MOD_BASE_URL` | 任意。そのワールドの UI Mod の受信サーバー（loopback、例 `http://127.0.0.1:8086`）。このサーバーに接続中だけ使う |

一部だけ設定・不正な値は「オフ」で起動し、理由（`COMPANION_BODY_CONFIG_INCOMPLETE:…` など。トークンは含まない）を警告に出す。有効なら `MinebotConfig` のサーバー表に専用名が加わり、`minebot:bot start`（`serverName: 'shannon-home'`）で接続できる。Web 画面・運用操作のサーバー一覧（`frontend` の `MinebotBotItem.tsx`、`configuredShannonOpsReporter.ts`、`common` の `MinecraftServerName`）には未追加。

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
MINEBOT_COMPANION_SERVER_PORT=25560
MINEBOT_COMPANION_SERVER_VERSION=1.21.11
MINEBOT_COMPANION_UI_MOD_BASE_URL=http://127.0.0.1:8086
MINEBOT_COMPANION_SERVER_ID=<心の設定と同じ id>
MINEBOT_COMPANION_BODY_URL=http://127.0.0.1:<本番の心のポート>
MINEBOT_COMPANION_BODY_TOKEN_FILE=<体の端末トークンのファイル>
```

Mod の設定には `backendToken` がまだ無い。Mod → Bot（入力欄・タスク操作）を使うなら本体の `MINEBOT_API_TOKEN` を入れ、サーバーを再起動する（Bot → Mod の送信はトークンなしで動く）。長期の世界記憶を使うなら `MINECRAFT_MEMORY_IDENTITIES` にこのワールドを別途登録する（未登録なら世界記憶は止まったまま。会話の記憶は心が持つ）。

## 本番投入の順番（コア担当と合意済み）

1. 本番の心は、投入まで `SHANNON_MINECRAFT_BODY_JSON` を空のままにする（空なら turn は 503、体の出来事は無視）。
2. online-mode のサーバーにつなぐ前に、本番の Bot に署名付き UUID の修正（`5df570e`）と、このモードのコミットが入っていること。それまで本番 Bot の env にこのモードの設定を入れない。
3. 体の端末を心に登録し、`SHANNON_MINECRAFT_BODY_JSON`（`serverId`・オーナーの UUID・`onlineMode: true`。shannon-home は secure chat を強制しているので可）を設定するのは、オーナーとコア担当の了承を得てから。
4. その後に本番 Bot の env に上の設定を入れて再起動し、shannon-home に接続して確かめる。
