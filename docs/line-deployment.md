# LINE独立サービスの配備手順（LINE-2）

状態：dev統合・Google/LLM実接続まで検証済み。ユーザーはdev実機合格後の本番追加を承認済み。**LINE webhook公開・端末受信・本番起動は未実施**。

## 配置と責務

| 対象 | dev | 本番追加案 |
| --- | --- | --- |
| コード | `/home/azureuser/Shannon-dev` | `/home/azureuser/shannon-line/releases/<40桁commit>` |
| 保護設定 | `~/.config/shannon-line-dev/` | `~/.config/shannon-line-prod/` |
| DB | `shannon_line_dev` | `shannon_line_prod` |
| HTTP | `127.0.0.1:15040` | `127.0.0.1:15041` |
| 公開経路 | 実機試験時のみ明示切替 | 既存 `https://sh4nnon.com/line/webhook` を `/webhooks/line` へproxy |

既存Shannon-prodのコード、Botプロセス、Firebase認証、通常DBを置換しない。一般のdev起動ロックも外さない。本番のnginx/service変更は以下のdev実機合格後に別工程として実施する。外部ポート15040/15041は開放せずloopbackだけで使う。

## 配備前の本人確認・同意

1. 対象は既存LINE公式アカウント「シャノン」、チャネル2007363979。キー発行とVM保護保存は操作時に承認を得る。秘密値はチャット/Notion/Git/生ログへ出さない。
2. BotのU…IDをAPIのBot情報と照合し、本人のU…IDを本人確認済み情報/署名付き私信で確認する。最初に話しかけた第三者を自動登録しない。グループC…IDも本人が指定したグループと照合しenv allowlistへ入れる。
3. 情報ソース・天気の粗い地域、時刻、LINE Push通数枠、LLMモデル/鍵/回数枠を確定する。envの初期予算は0。無料プランの通数とLLM API料金は別物。アカウント全体の残り通数も確認する。
4. 個人配信はLINE本人の「配信開始」を別途必要とし、友だち登録やデプロイだけでopt-inしない。

## 設定ファイル

設定ディレクトリは所有者700、全ファイル600/nlink1、symlink禁止。

- `runtime.env`：`backend/line.env.example`のLINE専用項目。共通backend/.envを読み込ませない。
- `radar.json`：`version:1, enabled, hourJst, minuteJst, consentExpiresAt, feeds, weather, topics, youtubeSubscriptions, calendar`。全フィールド必須。稼働時刻に静音がかぶらないことを確認。許可期限は最大30日。
- feedsは最大3sourceで、YouTube/Calendar/weatherを合わせた総sourceは最大6。各sourceは`id, kind(youtube/web), locator, articleHosts, topicIds, maxItems(1..20), retentionMs(60秒..7日)`。YouTube locatorはチャンネルID、Webは公開HTTPS RSS/AtomのクエリなしURL。ソースを削除後に再登録する際は新しいidを使う。
- weatherはnull、または`id,kind:weather,timeZone,latitudeTenth,longitudeTenth`。勝手に端末の位置を取得しない。
- `launch-permit.json`：`version:1, environment:dev/prod, envSha256, policySha256, bundleSha256`。devだけ`expiresAt`が必須、最大24h。**検証と設定レビュー後に運用者が作成する許可**であり、スクリプトは自動発行しない。

permitとenv/policy/bundleのhashが一致しなければ起動拒否。設定変更は新しいレビュー/permitとプロセス再起動で行う。稼働中のenv/policy/permit削除・変更は再認可時に拒否。止める際はファイル変更だけに頼らずサービスを停止する。

## ビルド・依存の固定

Node22.21.1を明示し、devで`node scripts/build-line-service.cjs`を実行。`backend/dist-line/runtime.mjs`はLINE/Radarに必要な45入力のbundleで、既存サーバーを起動する副作用はない。外部依存はexpress、mongoose、dotenv、cheerio、LangChain core/OpenAIのみ。直接依存はdevで検証した版へ固定する。

`backend/dist-line`でlockfileを生成し、`npm ci --ignore-scripts --omit=dev --workspaces=false`。リリースにはbundle、固定package/lock、専用node_modules、起動スクリプト、LINE専用人格文だけを含める。秘密設定・dev全体のnode_modules・通常保存データは含めない。生成物はGit対象外、bundleとmanifest/lockを検証証跡として保全する。


### Google読み取り権限とreceipt

`runtime.env`のGoogle資格情報は、LINE専用に発行した更新トークンを使う。scopeは`youtube.readonly`と`calendar.events.readonly`の完全一致で、YouTube/Calendarの書込み、Gmail、Drive、プロフィール権限を含めない。Google projectでYouTube Data APIとCalendar APIを有効にする。更新トークンは保護envだけに置き、release/Notion/Gitへ入れない。

YouTube初回baseline以前を本番でbackfillしない。同じ動画をdev実機と本番の両方で送らないよう、本番切替時に送信済みreceiptのhash文書だけを専用prod DBへ移す。receiptは永久insert-onlyで、題名、URL、検索query、OAuth情報を持たない。Calendarは現時点から7日間のprimary予定だけを最大20件読み、説明/場所/参加者を取得しない。

## dev合格条件

- 既存offlineテスト・対象通常型検査・ビルド。全backendのnoCheck変換は完全型検査と区別する。
- 新しい隔離Mongo、署名付き架空Webhook、モックproviderで同時worker8件、永続pendingのDB再接続からの1回送信、予算保持、引用期限、停止/設定変更の拒否。
- 配備bundleの独立HTTP health/署名検証/正常停止と、許可ファイルなしの起動拒否。
- 実キー/本人/許可グループを設定し、一時dev permitで本人LINE受信→返信→会話、非許可の拒否、配信停止→送信なしを確認。実受信はLINE APIのacceptedと区別する。

## 本番追加・復旧

1. devの合格commitとSHA manifest、現在のprod/nginx設定、空き容量を記録。2026-08-29時点でVM空き約1.4GiB/使用98%だった。ディスク拡張や既存データ削除を無断実施しない。
2. `prepare-line-database.cjs prod --new-empty-database`は新しい専用DBだけにcatalog validator/ledger collectionを作成する。既存collectionがあれば拒否し、上書き移行をしない。通常DBには触らない。
3. 検証済み配備物をcommit別ディレクトリへ配置しSHA照合。専用のsystemdサービスをazureuser、Node22、上記releaseのWorkingDirectoryで設定する。起動は`node scripts/start-line-service.cjs --serve prod`。既存Botのsystemd/unitは変更しない。
4. loopback healthを確認し、nginxの**正確なLINE pathだけ**を15041の`/webhooks/line`へproxy。nginx -t合格後にreload。既存HTTPS/他経路を確認する。
5. LINE側Webhook検証の成功後に利用を有効化し、本人の実受信・会話・停止を確認。実送信の確認が必要な段階では対象と内容を説明する。
6. 失敗時はLINE専用サービスを停止し、追加したnginxのLINE locationだけを元へ戻してtest/reload。既存Botは止めない。LINEのWebhookスイッチも元の状態へ戻す。未送信pendingだけ再開可能、sending/unknownを自動再送しない。
7. リリースを戻す場合はLINE-2のledger/schema/ownerを理解する版だけを使う。LINE-1への無検証rollbackや新旧writerの混在は禁止。

## 運用上の限界

初回workerは最大3source・日次1回の開始窓30分。長時間停止で窓を過ぎた日は送信せず、追いつくための大量送信はしない。取得途中の失敗でも当日の自動再試行なし。返答でWeb検索/旧人物記憶/ツール実行はできない。未設定のCalendar OAuthや承認Discordは後続。

配信停止は端末に届いた過去メッセージを消さない。catalogの内容消去はmaintenance/再開時に行われ、停止中の物理expiryや完全監査の保証は未完。通数上限はこのサービスの予約分で、Manager等から送った分を自動把握しない。LLM呼出し回数は費用の厳密な金額上限ではない。
