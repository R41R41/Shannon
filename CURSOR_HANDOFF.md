# Shannon / Cursor 引き継ぎ（2026-08-29）

RF-04：Radar / LINE会話 / Discord会話は `modules/fca` の同じループを使う。送信先・記憶・ツールはrunごとに注入。詳細は `docs/refactor-fca-kernel.md`。稼働中の本番LINE bundleへは未反映。

## 最初に守ること

- 正本の開発先はAzure VM `azure-constant-server:/home/azureuser/Shannon-dev`。
- `/home/azureuser/Shannon-prod`は既存本番。dev実機合格までは読み取りのみ。既存のbackend/frontend/Discord Bot/通常DBを止めたり置換しない。
- ローカル`implementation/Shannon`や`research/sources`は正本ではない。
- 秘密値を表示、ログ、Git、Notion、Cursor chatへ出さない。保護設定は`/home/azureuser/.config/shannon-line-dev/`（dir 700、files 600）をファイル名だけ確認する。
- `runtime.env`、Google refresh token、LINE token/secret、本人IDを`cat`しない。必要ならプロセス内で読み、結果は件数/真偽/hashだけ出す。
- 詳細境界は`AGENTS.md`、`docs/development-workflow.md`、`docs/line-deployment.md`、`docs/shannon-radar.md`を読む。

## Gitと実装状態

- branch: `codex/shannon-foundation`
- RAD-FCA/LINE統合commit: `a47cf7f785b8f72a220ac7cea724b45306ef689a`
- この文書追加前はclean。コード14ファイル、301行をcommit済み。
- 主な追加:
  - `GoogleRadarOAuthBroker`: `youtube.readonly` + `calendar.events.readonly`完全一致、access tokenはメモリだけ。
  - `lineRadarFcaSelection`: 同一run候補からFCAが0〜5件をdraft、送信権限なし。
  - `LineRadarWorker`: YouTube/Calendar/feed/weather取得→FCA→insert-only receipt→既存policy/outbox→LINE。
  - `radardeliveryreceipts`: owner/source/external IDのhashだけを永久予約。題名/URL/query/OAuthを保存しない。
  - `database-schema.mjs`: catalogとreceiptのstrict/error validatorを独立bundle化。
- 本番compositionはFCA/receiptを必須注入。旧feed中心経路はテスト互換だけ。

## 検証済み

- backend offline: 35 files / 1,006 tests passed。
- foundation boundary passed。
- 対象の通常TypeScript検査 passed。
- 全backend `tsc --noCheck --skipLibCheck` passed。
- 独立LINE bundle: 45 inputs、build passed。
- 全backend通常`tsc`は既存巨大コードが約4GiB上限でOOM。合格と称さない。
- `shannon_line_dev`は新規空DBから次を作成済み:
  - `radarpersonalcatalogs` strict/error validator
  - `radardeliveryreceipts` strict/error validator
  - `linechannelledgers`
- 実OpenAI FCAは架空候補で成功。
- Google専用OAuthを本人承認で発行・保護保存済み。実API確認はYouTube登録233件、Calendar 0件（題名/IDは未出力）。Google Calendar APIも対象projectで有効化済み。
- 公開 `https://sh4nnon.com/line/webhook`: 未署名401、署名付き空event 200、LINE Developersの「検証」成功。
- LINE Developers「Webhookの利用」は有効、再送/エラー統計は無効のまま。Managerの応答/あいさつは無効。

## 現在のdev実機

- 独立LINE runtimeが`127.0.0.1:15040`で一時稼働中（この引き継ぎ時点のPIDは49810、永続serviceではない）。
- nginxの正確な`location = /line/webhook`だけを一時的に15040 `/webhooks/line`へproxy。
- 元設定backup: `/etc/nginx/shannon.conf.pre-line-20260829`（`sites-enabled`外）。
- dev permit期限: `2026-08-30T00:24:38.109Z`（09:24 JST）。期限後は停止する。
- dev schedule: 毎日13:24 JST、窓30分。Push上限1/24h、2/月。chat上限10/24h。静音22:00–08:00。
- source: 登録YouTube（devだけ直近72h baseline、最大20候補）、primary Calendar 7日。天気/選択Web/X/Gmail/Notion/Discordは未設定または未接続。
- userにはスマホのシャノン1対1トークへ「配信開始」を送るよう依頼済み。これが未完なら本人同意はまだない。

## 直ちに行うdev実機確認

1. ユーザーの「配信開始」を待つ。本人ID一致・署名成功時だけledgerがopt-inし、Botが状態をreplyする。第三者を登録しない。
2. 生メッセージ本文やIDを出力せず、`shannon_line_dev.linechannelledgers`を集計して`optedIn=true`、consentVersion、entry status件数だけ確認する。
3. schedule窓内ならworkerが30秒以内に候補取得→FCA→最大5件をPushする。LLM/LINEのacceptedと、ユーザー端末の実受信を区別する。
4. `radardeliveryreceipts`は件数とvalidatorだけ確認。hash値、題名、URLは表示不要。
5. 一度送った後にプロセスを正常停止・同じpermitで再起動し、当日slot/receiptにより同じものを再送しないことを確認する。sending/unknownを盲目的に再送しない。
6. ユーザーに通常の短い質問を1件送ってもらい、返信会話を確認。次に「配信停止」でopt-outと状態返信を確認する。停止後のPushなしを確認する。
7. prod切替直前には、本人へprodで再度「配信開始」を求める方が安全。dev consentを無条件にコピーしない。

## prod追加手順（dev合格後）

1. 既存prodを読み取り監査: `/home/azureuser/Shannon-prod` HEAD `95426bb0cb71...`、clean、既存Shannon health `https://127.0.0.1:14001/health` with Host `sh4nnon.com` が200であること。既存unit/processを変更しない。
2. dev HEADを確定し、`git status --porcelain`空、bundle/manifest/package-lock SHAを保全。
3. `/home/azureuser/shannon-line/releases/<40桁HEAD>`へ最小releaseを配置:
   - `backend/dist-line/{runtime.mjs,database-schema.mjs,build-manifest.json,package.json,package-lock.json,node_modules}`
   - `scripts/{start-line-service.cjs,prepare-line-database.cjs}`
   - `backend/saves/prompts/others/line_chat.md`
   - 秘密設定は絶対にreleaseへ入れない。
4. prod Node22をrelease専用パスで固定。`start-line-service.cjs`はrelease rootの40桁commit pathを要求する。
5. `/home/azureuser/.config/shannon-line-prod/`を700、filesを600/nlink1で作る。dev保護envから秘密をプロセス内コピーし、表示しない。prod policyはレビューし、permitはenv/policy/bundle hash完全一致、prodはexpiryなし。
6. `node scripts/prepare-line-database.cjs prod --new-empty-database`で**新規空の`shannon_line_prod`だけ**を作成。既存collectionがあれば中止。通常DBへvalidatorを適用しない。
7. devで実送信したreceiptのhash文書だけをprodへ移す場合、schema/件数/ownerを検査し、題名/URL/token/ledger consentは移さない。二重配信を避ける目的だけ。
8. `shannon-line.service`をazureuser/Node22/loopback15041で新規追加。既存`shannon.service`は触らない。
9. 15041 health/署名付き空eventを確認後、nginxの`location = /line/webhook`のproxyだけを15040→15041へ切替。`nginx -t`後reload。既存path/portを確認。
10. LINE webhook検証、本人のprod「配信開始」、実受信/会話/停止を確認。acceptedだけで端末受信済みと称さない。
11. 失敗時: LINE専用service停止、exact nginx locationだけを元へ戻す。既存Shannonを止めない。sending/unknownは再送しない。

## prod初回policyの判断

- 初回を「同期後新着だけ」に厳密にするならprod `youtubeSubscriptions.baselineAt`を切替時刻にする。これだとdevで確認した過去72h候補はprodでは送らない。
- devで実送信した候補だけを除外し、残る72h新着を翌日以降候補にしたいならdev baselineを維持しreceipt hashだけ移す。
- どちらにするかユーザーへ説明して決める。視聴済みとは称さず「Shannon未共有の登録チャンネル新着」と表現する。

## 残る機能（prod初回の必須条件ではない）

- X read-only実adapter/費用上限。
- 選択Web sourceの本人設定。
- 天気の粗い地域（ユーザー未指定、推測禁止）。
- Notionページ選択UI、Gmail重要未読の定義と最小scope。
- 許可Discord community lane/承認カード。個人Calendar/Gmail/Notionをcommunityへ渡さない。
- LINEグループIDは未登録。Botが参加可能でもenv allowlistは空。ユーザーが対象グループを明示し、IDを本人確認できるまで返信しない。
- 人物本人管理/全面撤回、旧音声/Web/EventBus境界は別ロードマップ。

## 資料更新

- Notionハブ: `https://www.notion.so/3ca1e847628881c9b4bbfd5556a55347`
- 主に08 architecture、02 plan、06 change historyを既存ページへ部分更新し、読み戻す。秘密/生ログ/IDは書かない。
- ローカル調査正本: `/Users/arairyo/Documents/Codex/2026-08-28/shannon-notion-costant-vm/research/`
- この引き継ぎ後の実機結果、本番切替、rollbackの有無をNotionと`docs/line-deployment.md`/`docs/shannon-radar.md`へ記録する。

## Cursorへ最初に渡すプロンプト

> Azure VM `azure-constant-server` の `/home/azureuser/Shannon-dev` を正本としてShannon開発を続けてください。最初にrootの `CURSOR_HANDOFF.md`、`AGENTS.md`、`docs/development-workflow.md`、`docs/line-deployment.md`、`docs/shannon-radar.md`を読み、現在状態を読み取り確認してください。`/home/azureuser/Shannon-prod`はdev実機合格まで読み取りのみ、既存Shannon/通常DBは変更しないでください。秘密値は出力しないでください。まずLINE本人の「配信開始」受信、状態reply、初回digest、停止、再起動重複防止をdevで完了し、結果を記録してください。その後、同じ検証済みbundleを独立prod serviceとして15041へ追加し、exact nginx pathだけを切替え、実端末受信まで確認してください。
