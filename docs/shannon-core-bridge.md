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
