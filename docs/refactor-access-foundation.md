# RF-01/RF-02：Web認証・モデル設定の責務分離

状態：2026-08-28、VM devに実装。prod未反映。これは最初の一経路であり、F01/F02全体の完了ではない。

設計：[Notion 08](https://www.notion.so/3ca1e84762888170816ee73f25c40ce3)。進捗：[Notion 02](https://www.notion.so/3ca1e84762888153bb4dcf4714a92fb8)。

## 変更した境界

- `modules/access`：本人・利用許可・capabilities・期限付きrequest context。SDK、DB、環境変数、WebSocketを参照しない。
- `modules/modelSettings`：モデル設定の参照・変更・リセット。HTTPを通らず直接呼ばれた場合も権限と期限を確認する。
- `adapters/access`：Firebase Admin SDKのトークン検証とMongoの利用者照会。`bootstrap/webAccess`だけで組み立てる。
- `routes/modelRoutes`：Bearer認証からuse caseへ接続。未認証401、許可なし403、認証基盤不通503。成功確認前にUIで成功表示しない。
- `authProtocol` / `AuthAgent`：メールだけの照会と公開ユーザー作成を廃止し、ID tokenによる自分のプロフィール照会へ変更。返答は要求したsocketだけへ送る。
- frontend `features/auth`：Firebaseの状態とサーバーで検証したセッションを管理。localStorageの認証フラグ・dev管理者bypassを信用しない。認証接続を操作用client群から切り離した。
- WebSocketの基底クラス：生成時にlistenやtimerを開始しない。明示したstart/stopで管理。Authのみ複数接続を許可し、他の旧経路の単一接続挙動は維持。
- 新しい認証・認可・モデル操作の経路と、その変更禁止policy自体を自己改善の編集対象から除外。これは既存のpath policyによる保護であり、OSレベルのsandboxではない。自己改善の隔離実行は別途必要。
- frontendの明示disconnect後の再接続と、古いsocketのcloseが新接続へ影響する問題を修正。

## この変更でまだ保護していないもの

他の7つの操作用WebSocket、public/SSE、tokens/knowledge、テストAPI、Minebot HTTP、Discord/LLMツールの実行権限は未統合。会話の本人・宛先・記憶スコープの伝播も未完了。既存の公開経路がすべて安全になったとは扱わない。旧WebSocketには単一接続とglobal broadcastが残る。

全体の起動もまだ単一Serverに集約されている。今回分離したのはWebSocket listen/timerと認証・モデル操作の生成/実行境界。旧Agentのコンストラクタ内EventBus購読、サービスsingleton、全サービスの再起動ライフサイクルは次の対象。

## ライブ試験の前提と利用者移行

1. devのDB接続・復元手順と、Firebaseの検証用プロジェクトを確認する。prodの設定をコピーしない。
2. backendに `FIREBASE_PROJECT_ID` を設定する。frontendのFirebaseプロジェクトと一致させる。設定値や秘密鍵はGit/Notionへ入れない。
3. Firebase Admin SDK用のApplication Default Credentialsをdev専用に用意する。Azureでは、適切に保護したサービスアカウント設定などを使用する。`GOOGLE_APPLICATION_CREDENTIALS` が必要な場合も保護されたファイルへの参照だけにし、認証情報をリポジトリへ置かない。
4. `verifyIdToken(token, true)` で失効・無効化まで確認するため、対応するFirebase利用者照会の権限と接続が必要。不足時は認証を拒否する。エミュレーター環境変数がある場合は実アプリのverifierが拒否する。テストは注入したfakeを使う。
5. 旧usersをバックアップして、利用者本人と権限をレビューする。信頼できるFirebase管理側の情報から `firebaseProjectId` と `firebaseUid` を対応付け、`isAuthorized` と `isAdmin` を明示確認する。ブラウザが送るemailや旧auth:init由来の管理者フラグから自動移行しない。
6. usersに `(firebaseProjectId, firebaseUid)` の部分一意インデックスを追加するschemaを用意した。実DBでは未実行。重複・空文字・null・別環境の混入をdry runで確認してから適用し、同じUIDに複数の利用者レコードを残さない。
7. バインドのない旧ユーザーはログイン拒否となる。既存の利用者を閉め出さないため、本番の切替前に対応付け・権限と新UIを同時に確認する。公開の初期管理者作成機能は追加しない。
8. 認証tokenはHTTPS/WSSでのみ送る。devのHTTP/WSはlocalhostへのSSH転送などloopback接続の場合だけ許す。
9. 他の公開経路への認証・スコープ適用、共有bot資格情報・費用枠・Node/native依存の条件も解消するまで `.dev-runtime-lock` を維持する。

この作業では環境ファイル、Firebaseの利用者、DBレコード・インデックスを変更していない。Firebase実接続も未検証。

## 検証コマンド

VM devのrootで実行する。テストの外部SDK/DBはfake/mock、HTTP/WSは127.0.0.1の一時ポートだけを使う。

```bash
npm run build -w common
npm run check:foundation -w backend
npm run check:access-integration -w backend
npm run test:offline -w backend
npm run test:auth -w frontend
npm run build:dev -w frontend
```

`check:foundation` は新しい2モジュールの依存制約と完全な型検査。`check:access-integration` はFirebase/Mongo adapter、WebClient、AuthAgent、モデルHTTP経路を含む型検査。backend全体の型検査は別の残課題で、全体の `--noCheck` 変換成功を代わりにしない。

2026-08-28：backend 92件、frontend 14件が合格。追加の境界検査、型検査、frontend buildが合格。Firebaseの署名・期限・失効検証そのものはSDKを利用し、今回の試験ではSDK結果をモックして呼び出し・拒否の契約を確認した。実Firebase/実DB/ブラウザE2E/実bot/性能測定は未実施。

`check-foundation.yml` はPRとcodexブランチpush向けの外部秘密情報なしのCI。定義を追加しただけで、GitHub上ではまだ実行していない。既存の本番CDは変更していない。

## 依存・復旧

Firebase Admin SDKは現在のdev Node 20でも対象となる `13.10.0` を固定。14系はNode 22以上を要求するため今回の基点へ導入しない。native依存の問題がある全体のランタイム更新は別作業。SDK導入でprotobuf関連などの間接依存も更新されている。

コードの復旧基点は `02e0951f`。まだ本番へ反映していないので、本番を戻す操作は不要。将来切り替える際には新旧frontend/backendの認証プロトコル非互換に注意する。古いemail認証・公開管理者登録を復旧時に再公開しない。データ移行後はコードを戻すだけで復旧したと扱わない。

## 公式仕様

- [Firebase ID token検証](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firebase失効検証](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Admin SDK初期化](https://firebase.google.com/docs/admin/setup)
