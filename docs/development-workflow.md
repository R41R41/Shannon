# 開発環境と本番反映の手順

最新の追加実装・prod Git整理・Node22/native・DB復元結果は [R0リリース準備](r0-release-readiness.md) を参照。以下は初期整備時点の記録を含む。

## 作業先

- 実装・テスト：Azure VMの `/home/azureuser/Shannon-dev`。
- 本番：`/home/azureuser/Shannon-prod`。開発作業中は読み取りのみ。停止・再起動・直接編集しない。
- 設計・進捗：[Shannon資料ハブ](https://www.notion.so/3ca1e847628881c9b4bbfd5556a55347)。

## 2026-08-28の基点整合

本番のHEAD `d75ae2f` と未コミット12ファイルの差分を、保全コミット `95426bb` に取り込んだ。devをこのコミットから始まる `codex/shannon-foundation` に切り替え、768件の追跡パスを本番の実ファイルハッシュと照合した。元の本番リポジトリは変更していない。

devの旧HEADは `90ce114`。旧ブランチを `preservation/dev-before-alignment-2026-08-28` として保持し、未コミット変更3件と未追跡2件をstash `1bf20f7` に退避した。旧生成スキルは自動で再適用しない。内容をレビューして必要な差分だけ戻す。

設定・保存データ・Git履歴を含む退避アーカイブは作業元Macの保護された保管先にある。VM側の保全情報と旧ビルドは `/home/azureuser/.codex-shannon-preservation/`。秘密設定の退避ファイルはNotionやGitに掲載しない。

## 意図的に分けるもの

「同じコード基点」は、DB・認証情報・ポート・実行状態まで本番と共有する意味ではない。

- devのMongoDB接続先は `shannon_dev` に変更。本番は `shannon`。DBの作成・接続・データ移行の検証はまだ行っていない。
- backend HTTPは15000、WebSocketは15010/15011/15013/15016/15017/15018/15019/15020、Minebot APIは18092。
- `.env`の認証情報を本番から複製していない。もともと共通のDiscord等の認証情報が残るため、実サービスの起動を保留する。
- `.shannon-development`で開発環境を識別し、`--dev`なしの起動スクリプト実行を拒否する。
- `.dev-runtime-lock`がある間は、root/backend/frontendの起動スクリプトを停止する。tmuxやポートに触る前に検査する。
- これは起動スクリプトの保護であり、直接のnode実行や外部APIをOSで遮断するものではない。ロックを迂回しない。
- devだからという理由で自己改善を自動適用しない。`SELF_IMPROVE_AUTO_APPLY_TIER2=true`の明示設定時だけ有効。

## オフライン検証

アプリの起動スクリプトを使わず、VM上のdevで実行する。下記の単体テストは外部サービスをモックし、Webhook試験はローカルHTTPのみを使う。統合テスト全体を無条件に走らせない。

```bash
cd /home/azureuser/Shannon-dev
npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node node_modules/patch-package/index.js --error-on-fail
NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 npm run build -w common

cd backend
NODE_OPTIONS=--max-old-space-size=4096 nice -n 10 node ../node_modules/typescript/bin/tsc --noCheck --skipLibCheck
NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 node ../node_modules/vitest/vitest.mjs run tests/unit tests/selfImprove/nightlySchedule.test.ts --maxWorkers=1 --minWorkers=1

cd ..
NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 npm run build:dev -w frontend
```

backendの上記ビルドは**型チェックを省いた変換**。完全な型検査合格とは扱わない。frontendはTypeScript検査とVite buildを行う。`build:dev`はdev接続先を使い、本番モードのバンドルを開発用として配信しない。

2026-08-28には、古い適用済みpathfinderパッチが残っていたため、同じ2.4.5の配布物へ戻してリポジトリのパッチを適用し直した。`patch-package`はエラー時も終了コード0になることがあるため、`--error-on-fail`を必ず使う。

## ライブ試験の前に残る条件

- Discord等のテスト用主体・送信先を決め、本番botや定時処理と競合させない。
- 開発DBへの接続・権限を確認し、必要なら匿名化fixtureを投入する。本番DBをそのままテストに使わない。
- LLM・画像・外部APIの費用上限を決める。
- VMのNodeは20.18.3。一部依存はNode 22以上を要求する。prodのグローバルNodeを変えず、dev専用ランタイム／コンテナで検証する。
- `sodium-native@5.0.10`のLinux配布バイナリは、VMにないGLIBC_2.33を要求する。単純なnpm rebuildでは直らない。音声機能のライブ試験前に、隔離した対応環境またはソースビルドを検証する。OSの共有libcを開発都合で更新しない。
- 上記を確認した後に起動ロック解除を判断する。ロック解除そのものを環境検証の代わりにしない。

## 本番へ反映するとき

1. devで対象変更の単体・統合・代表会話を検証し、Notionへ結果と未検証事項を書く。
2. prodのHEAD・差分・設定・データ保全を再確認する。今回のソース保全はDB復元試験の代わりにならない。
3. 反映対象のコミットと移行・復旧手順をレビューし、短い切替枠で反映する。
4. dev用マーカー・ロック・環境設定・接続先をprodへコピーしない。
5. 本番CDはmainへのpushでresetを伴う。検証と反映判断前にmainへpush／mergeしない。

## LINE専用サービス（2026-08-29 LINE-2）

ユーザーがLINE初回MVPの本番追加までを明示承認。実機検証を経て既存Shannon-prodとは別のrelease/service/DBで配備する。詳細は [LINE配備手順](line-deployment.md)。本体の`.dev-runtime-lock`は維持する。新しい`start-line-service.cjs`はLINEのenv・source設定・bundleのhashを固定した別の保護permitなしでは起動しない。dev許可は最大24hで、資格情報の発行/転送や費用枠の合意の代用にはしない。旧Bot・Firebase等の起動許可へ転用しない。
