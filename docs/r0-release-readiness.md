# R0：本番反映の阻害要因への対応 — 2026-08-28

状態：VM dev に実装・検証済み。**2026-08-30 に本番 UID 切替・新認証コード deploy・admin ログイン確認まで完了**（[切替記録](prod-cutover-2026-08-30.md)）。dev は `.dev-runtime-lock` 維持。

## prodの未コミット解消

ユーザーの「それらの問題を解消して」という依頼に対応し、開発とは別のGit記録整理を実施した。

- prodの旧HEAD `d75ae2f` と未コミット12パスの実内容が、保全済み `95426bb` のtreeと一致することを確認。
- prodのindexとmain参照だけを同コミットへ揃えた。checkout、hard reset、ソース・環境設定の書き換えはしていない。
- prodは `95426bb`、作業ツリーclean。769実ファイルのハッシュ不変と、削除済み1パスが不在のままであることを確認。
- backend PID 14447と開始時刻は不変、5001番のhealthは200/ok。restart、GitHub push、dev変更のデプロイなし。
- 旧HEAD、index、差分・bundleを保全。devは同じ `95426bb` の子孫なので、将来のリリース履歴に本番独自変更が含まれる。

この整理は、今後の本番変更を包括的に許可するものではない。

## devの修正

### 外部入口

- 7つの操作WebSocketへFirebase本人確認と `console:access` 認可を適用。初期ログ検索も認証後。Originは `WEB_ALLOWED_ORIGINS` の完全一致、token付きURLは拒否。
- ID tokenは最初のメッセージで送信。認証確認まで操作・表示を開始しない。60秒以内の認可leaseとtoken期限で切断し、再接続時に新しいtokenで確認する。認証失効の反映には最大lease分の遅延がある。
- 認証されていない接続へbroadcastしない。他の認証済み接続を追い出さない。ログ検索結果は要求した接続だけへ返す。
- frontendはログアウト時に切断し、token取得中の古い結果を破棄。KPIの内部APIにもBearerを付与。
- HTTPはヘルス・readiness・独立認証のX webhook以外を共通入口で保護。内部APIはレビュー済み管理者だけ許可し、将来追加のAPIも既定で保護。
- **管理コンソールは管理者専用**。Web 会話通知・ログ・planning は `web:bind-session` 必須の session ルーティング済み。一般利用者向け Identity–Binding–Audience UI と Firebase UID 対応付けは別工程。
- **旧public chat/SSEは503で停止扱い**。共有の私的記憶・グローバルイベントへ到達する旧graphを、adminTokenや設定フラグで再公開しない。公開用の制限された会話経路を別途実装・評価するまで、機能復旧済みとは扱わない。
- Minebot HTTPはloopbackで待受し、32文字以上の専用 `MINEBOT_API_TOKEN` が必要。未設定503、認証なし401、browser Origin付きは拒否。Mod側の対応とSSH転送などの保護された接続が必要。既存Modを無変更で接続できるわけではない。

### X停止とツール制限

- `TWITTER_DISABLED=true` と、既存prodで使われる `TWITTER_ENABLED=false` のどちらも停止として扱う。
- X APIクラスの全公開async入口とログイン入口で停止判定。直接呼び出し・media upload・retryでも資格情報照会や通信より前に拒否。
- X専用の定期生成入口も停止。Discord用の天気・占い生成と画像添付は維持し、Xアップロードだけを停止できる。
- `allowedTools=[]` は許可なし。モデルに見せるリストと実行に渡すmapが一致し、モデルが未許可toolを要求しても呼ばれない。
- これは全チャネルの操作別・対象別承認を完成させたものではない。外部送信先に結びつく承認や、Discord/LLM内部経路への権限伝播は引き続き必要。

### 移行・運用

- usersのUID indexをアプリ起動時に自動作成しない。DB接続失敗時に起動を続行せず、接続URIをログへ出さない。
- `backend/scripts/user-binding-migration.mjs`：既定dry run。明示した利用者ID・UID・権限・レビュアーからplanとhashを作る。旧管理者フラグやメールだけで自動移行しない。
- applyは**VM dev / shannon_dev限定**（`user-binding-migration.mjs`）。**本番 apply** は `apply-prod-user-binding.mjs` で別手順（2026-08-30 実施済）。
- `/api/health`はliveness、`/api/ready`はDB・LLM初期化・Web認証設定の最低条件を返す。readiness 200だけでFirebase実認証・全bot・リリース安全性を証明しない。
- devの本番workflow定義からmain pushによる自動反映を外し、手動のcandidate確認に変更。hard reset・npm ci・再起動をしない。**未pushなのでGitHub上の現行workflowはまだ旧定義**。
- `scripts/release-preflight.py`は読み取り専用で、未完の実接続・移行・切替条件を明示して停止する。自動デプロイや自己承認の機構ではない。

## ランタイムとDB復元の実績

- dev用Node `22.21.1` を固定。`bash scripts/with-dev-node.sh ...`で使用。devの起動スクリプトとtmux内のPATHにも適用。prodの `/usr/bin/node`、nvm default、共有OS/libcは変更していない。
- sodium-native 5.0.10を専用キャッシュ内のCMake 3.31.6・GCC 10.5でsource build。GCCパッケージはdownload/extractのみでOSへinstallしていない。
- libsodium source `1899e2061a74798906d52ace044050c12ad41b99`、libjstl `098664c1b158e2cafd4c3fbab55709c7f56306db`。再現手順は `scripts/build-dev-native.sh`。既存Opus N-API v3バイナリをNode22 loader pathでも検証。
- `scripts/probe-dev-native.cjs`で暗号化/復号、Opus encode/decode、canvas PNG生成、voice/DAVE/mineflayer importに合格。実音声通話・ゲーム接続の代替ではない。
- dev DB `shannon_dev` のping成功。本番DBをテストの書き込み先にしていない。
- prod DBのlive dumpは約6.45MB、13コレクション・70,407件。別mongodの127.0.0.1:37027へrestoreし、失敗0件。TTL monitorは無効にして復元後の自動削除を防止。
- 隔離DBでUID部分一意indexを作成し、既存利用者3件を変更しないこと、重複UIDを拒否すること、空の移行指定で自動付与しないことを確認。
- **2026-08-30（本番）:** prod UID apply・`codex/shannon-foundation` deploy・nginx 443 更新・`https://sh4nnon.com` admin ログイン・管理画面・Radar 確認。
- prodはstandalone MongoDBのためlive dumpの同一時点整合性は保証しない。**切替時は書き込み元を止めて最終dumpを取得する必要がある**。本番のTTL変更・履歴削除・実利用者更新は未実施。
- バックアップ・実行ログ・native成果物は保護された保全先へ。DB全文・UID・秘密情報はGit/Notionへ掲載しない。

## 検証結果

- backend 158件、frontend 18件、合計176件がVM devで合格。HTTP/WSは実loopback接続、Firebaseはmock。
- 認証moduleの依存・完全型検査、HTTP/WebSocket/Firebase/Mongo/X APIの対象型検査、common build、frontend型検査・dev buildに合格。
- backend全体は `--noCheck` 変換のみ成功。全体の完全型検査、実Firebase login、browser E2E、実bot/LLM、有料評価は未実施。
- frontendの大きいbundle警告は残る。

## 残る入力・本番切替条件

1. ~~dev リハーサル~~ ✅ / ~~prod manifest~~ ✅ / ~~本番 apply~~ ✅ / ~~admin ログイン~~ ✅（2026-08-30）
2. Discord等のテストbotと送信先、LLM費用上限を決める。共有資格情報を使ってdevを起動しない。
3. 管理コンソール限定・公開チャット停止・Mod認証必須という機能制限をレビューする。必要な利用経路の復旧を実装してからリリースする。
4. Identity binding → 会話経路配線、Radar/LINE 本番接続、release preflight 正式実行は **C/D 残作業**（`docs/rf-03-remaining.md`）。
5. ~~本番切替~~ ✅ 2026-08-30。`main` マージと prod `main` 追従は A 工程で実施。

公式実装参照：[sodium-native](https://github.com/holepunchto/sodium-native)、[cmake-napi](https://github.com/holepunchto/cmake-napi)。
