# アプリ版Shannon Coreへの会話ミラー

Status: Discord scope拡張はユーザー判断で暫定合格、canonical read projectionはproduction反映・スモーク確認済み

## 目的

旧Azure runtimeのDiscord固有ツールと配信を維持したまま、本人が話した
完了済みターンをアプリ版Shannonの会話・記憶正本へ寄せ始める。これは
応答モデルの切替ではなく、統合の第1段階となるshadow writeである。

## 経路

```text
Discord owner message
  → legacy FCA / tools
  → request-bound Discord send succeeds
  → non-blocking mirror adapter
  → loopback POST /v1/platform/turns
  → exact conversation + owner binding
  → canonical SQLite turn + memory refinement queue
```

本人ターンの応答前には、同じbindingで`POST /v1/platform/context`を読み、
2,400文字以内のcanonical人格・関心・記憶projectionをsystem promptへ追加する。
取得失敗、応答不正、timeout時はprojectionなしの従来応答へfallbackする。

Discord送信に失敗したターンはミラーしない。ミラー障害は、すでに成功した
Discord返信を失敗扱いにしたり自動再送したりしない。本文・token・URLを
ログへ出さず、安全なerror classだけを記録する。

## 設定

本体のGit外envにのみ置く。両方空なら無効。片方だけ、短いtoken、公開
HTTP、別path、query/fragment付きURLは拒否する。

```dotenv
SHANNON_CORE_PLATFORM_URL=http://127.0.0.1:4319/v1/platform/turns
SHANNON_CORE_PLATFORM_TOKEN=<dedicated 32+ character service token>
SHANNON_CORE_PLATFORM_BINDINGS_JSON='[{"platform":"discord","conversationIdPrefix":"discord:<guild-id>:","ownerUserId":"<owner-id>","title":"Discord・コミュニティ"}]'
SHANNON_CORE_PLATFORM_TIMEOUT_MS=3000
```

対向のアプリAPI側では同じ専用tokenに加え、canonical owner scopeと
`platform + exact conversationまたはDiscord guild prefix + ownerUserId + safe title`
のbindingを設定する。同じbinding JSONを旧runtimeでも使い、他ユーザーの返信は
Discordへ届けてもcanonical APIへは送信しない。paired-device token、Agent Host
token、Discord Bot tokenを流用しない。

## 境界

- 対象はDiscordテキストで、実際の送信が成功した応答だけ。
- voice、友人・グループ参加者の発言、未binding channel、caller指定scopeは対象外。
- 外部conversation IDとowner IDの最終認可はアプリAPIが行う。
- request IDの再送はアプリAPIのdurable receiptで重複しない。
- 旧Mongo人物記憶を移行・再分類しない。
- 友人の同意済みrelationship memoryと、応答生成のShannon Core移行は後段。

## Phase 2 production scope

- アイマイラボ！: 現行のメンション呼びかけを維持し、全チャンネル・全ユーザーへ返信する。
- とやまさば: 設定済みの「シャノンと遊ぼう！」チャンネルだけで全ユーザーへ返信する。
- canonical conversation／個人記憶へmirrorするのは、どちらもbinding済みowner IDの完了ターンだけ。
- 旧runtimeでも同じbindingを照合して非owner turnを送信せず、アプリAPIでもowner不一致を403で拒否する。

## 返事も心が書く（第5a段階、2026-10-06、dev のみ）

`SHANNON_CORE_PLATFORM_REPLY=true`（既定は無効）の時、Discord テキストの返信は Bot 自身の LLM ではなく、心（shannon-ios）の
`POST /v1/platform/reply` が書く。心の会話の中心（アプリと同じ履歴・想起・気分・道具）を通るので、本人の DM（心の側で
`owner-private` に結んだ会話）で「マイクラで木材集めといて」と言えば `minecraft.request` で体の列に積まれる。

```dotenv
SHANNON_CORE_PLATFORM_REPLY=true
# 本人以外の発言も心に答えさせる時だけ（既定は本人のみ）
SHANNON_CORE_PLATFORM_REPLY_PEOPLE=false
SHANNON_CORE_PLATFORM_REPLY_TIMEOUT_MS=55000
```

- 送るのは既存の binding に一致する会話だけ（未 binding の channel は送らない）。既定は本人の発言だけ。音声・添付/画像URLを含む本文・追加要件フォームの回答は送らない。
- 心が答えられない時（無効・拒否・タイムアウト・形式不正）は従来の経路で答える。心の返事は同じ会話の port で送り、`/v1/platform/turns` へは二重に mirror しない（心が既に記録した）。送信に失敗しても旧経路で答え直さない。
- 心の側も `SHANNON_PLATFORM_REPLY=on` が必要（既定は 503）。契約は shannon-ios の `docs/platform-people-contract.md`「Replies」。
- 実装: `backend/src/services/integration/shannonCoreBridge.ts`（`requestDiscordReply`）、`discordCompanionReply.ts`、`EventRouter.processDiscordMessage`。テスト: `tests/unit/shannonCoreBridge.test.ts`、`discordCompanionReply.test.ts`（loopback の偽の心）、`discordCompanionReplyRouting.test.ts`。

## ボイスチャンネルも心が答える（dc-voice、2026-10-20、既定は切）

`SHANNON_DC_VOICE=on` の時、VC の声を心の `POST /v1/platform/voice/turn`（NDJSON）に通し、返事は心の `POST /v1/platform/voice/speech`
（ElevenLabs の PCM）で再生する。契約は shannon-ios の `docs/discord-voice-contract.md`。心の側にも `SHANNON_DC_VOICE=on` が要る（切の間は 503）。

```dotenv
SHANNON_DC_VOICE=on
# VC にいる人（bot 以外）を人ごとに聞く。off なら PTT の人だけ（既定 on）
SHANNON_DC_VOICE_OPEN_MIC=on
# しゃべる口（getVoiceMouth().say / setSituation。既定 on）
SHANNON_DC_VOICE_MOUTH=on
# 長い発話の途中の相づち（既定 off）
SHANNON_DC_VOICE_BACKCHANNEL=off
```

- 会話は `discord:<guildId>:<声の文字チャンネル>` で、`SHANNON_CORE_PLATFORM_BINDINGS_JSON` に結ばれたものだけ。束縛が無い・voiceMode が minebot・URL/token 未設定の時は旧の作り（PTT、Whisper、invokeGraph、VOICEPEAK）のまま。
- 心の最初の行（decision）が 4 秒以内に来なければ、その発話は旧の作りに任せる。decision のあとの失敗では旧に落とさない（言った分は言ってある）。
- 戻し方は `SHANNON_DC_VOICE` を外して再起動。
- 実装: `services/discord/voice/`（`dcVoiceGuild.ts`、`utteranceCollector.ts`、`turnQueue.ts`、`bargeIn.ts`、`speechPlayer.ts`、`voiceMouth*.ts`）、`services/llm/voice/dcVoiceTurn.ts`、`services/integration/shannonCoreVoiceClient.ts`。テスト: `tests/unit/dcVoice*.test.ts`、`voiceMouth.test.ts`、`shannonCoreVoiceClient.test.ts`。

## 頭は 1 つ（one head、2026-10-20、既定は切）

`SHANNON_ONE_HEAD=on` の時、この体は Discord の耳と口だけになる。文字のメッセージは全部（束縛の有無、持ち主かどうかに関係なく）、
VC の発話も束縛に関係なく、心の `POST /v1/converse` に 1 つの形（誰が・どこで・文字か声か・人前か）で送る。誰がその場にいるか・
何を覚えているか・何を言うかは心が決める。契約は shannon-ios の `docs/one-head-contract.md`。

```dotenv
SHANNON_ONE_HEAD=on
# 声も心に通すには dc-voice も on（VC の受け方・口・相づちは dc-voice のもの）
SHANNON_DC_VOICE=on
```

- 心の側にも `SHANNON_ONE_HEAD=on`（と `SHANNON_PLATFORM_REPLY=on`、`SHANNON_DC_VOICE=on`）が要る。心が 503・403・落ちている・時間切れの時だけ、
  その 1 通・1 発話は旧の作り（invokeGraph、VOICEPEAK）が答える（ログ `[OneHead] fallback`）。
- 心が「言うことは無い」と答えた文字（`done` の `reply` が空）は、何も投稿せず、旧の作りも答えない。
- 体のタスクの追加確認への返事（`[追加要件への回答]`）は、今まで通りこの体が受ける。添付ファイル・画像の URL は「（画像）」に置き換えて送る。
- 戻し方は `SHANNON_ONE_HEAD` を外して再起動（dc-voice・第5a段階の動きに戻る）。
- 実装: `services/integration/oneHeadConverse.ts`、`shannonCoreBridge.ts`（`requestDiscordReply`）、`shannonCoreVoiceClient.ts`（`turn`）。
  テスト: `tests/unit/oneHeadConverse.test.ts`。

## テスト用サーバーも本番で（2026-10-21、既定は切）と声の符号化

`SHANNON_PROD_ALLOW_TEST_GUILD=on` の時、本番（`--dev` でない）もテスト用サーバー（`TEST_GUILD_ID`）のメッセージ・命令・声を受け、
スラッシュコマンドをメインのサーバーとテスト用サーバーの両方に登録する。切（既定）なら今まで通り、本番はテスト用サーバーを
扱わない。dev の動きはスイッチに関係なく同じ。会話をシャノンの心に結ぶには、両側の束縛（体の `SHANNON_CORE_PLATFORM_BINDINGS_JSON`、
心の `SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON`）にテスト用サーバーの `conversationIdPrefix` を足す。

VC の聞き取りは `@discordjs/opus` で復号し、その native addon がこの node / CPU 向けに無い時は `opusscript` で復号する
（`services/discord/voice/opusCodec.ts`）。起動の行は `[VoiceManager] opus codec: @discordjs/opus`（native）、
`... decoding with opusscript`（代わり）、どちらも無い時だけ `voice decoding disabled`。
実装: `services/discord/guildPolicy.ts`、`opusCodec.ts`。テスト: `tests/unit/discordGuildPolicy.test.ts`、`opusCodec.test.ts`。

## 検証

- `backend/tests/unit/shannonCoreBridge.test.ts`
- `backend/tests/unit/discordConversation.test.ts`
- `backend/tsconfig.access-integration.json`

2026-09-18にread projectionをproductionへ反映した。API側は本人200／非本人403、
旧runtime側は本人`available`／非本人`ineligible`／模擬上流障害`unavailable`を確認した。
projection本文を表示せず、長さ上限、state version、timestampを検証し、前後でcanonical
DBのreceipt、thread、message、experience件数が不変かつ`quick_check=ok`であることを確認した。

別ユーザーによるDiscord live canaryは実施していない。ユーザー判断によりscope拡張は
暫定合格として次段階へ進んだため、第三者発言が個人記憶へ入らない保証は二重gateの
自動試験と本番fail-closed probeによる証拠として扱う。


## 本人以外の発言（2026-10-02）

束縛済みの会話では、本人以外の発言もアプリ版Shannonへ写す。アプリ版はその人を
Discordアカウントで識別して「人」として覚え、その会話にいた全員を聞き手として記録する。
契約はアプリ版リポジトリの `docs/platform-people-contract.md`（v1）。

- 本人の発言は従来どおりの本文で送る。
- 本人以外は `conversationKind`（DMは `dm`、それ以外は `channel`）、`sourceDisplayName`
  （envelopeの表示名、無ければDiscordのユーザー名、80文字まで）、`sourceKind: person` を加える。
  表示名が取れない時は送らない。
- 送るのはシャノンが返信したターンだけ。添付・埋め込みは送らない。
- 本人以外のターンで 403・409・429 が返っても、Discordの返信は失敗扱いにしない
  （覚える機能の停止スイッチ、重複、流量制限）。それ以外の失敗は従来どおり安全なerror classだけを記録する。
- 文脈の読み取りは、本人以外の発言でも束縛済みの会話なら行い、`conversationKind` と
  `participants`（その発言者）を付ける。アプリ版がその場にいる人に合わせて内容を絞る。
- 束縛していない会話（友人とのDMなど）は、これまでどおり何も送らない。覚えさせるには会話ごとに束縛を追加する。
