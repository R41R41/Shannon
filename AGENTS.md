# AGENTS.md

## Radar RAD-1D（2026-08-29）の注意

`docs/shannon-radar.md`13節。取得前にowner文書CASで回数とleaseを予約する。`PersonalRadarService.collect`は明示のserver policyなしでは拒否する。失敗/取消/応答不明も回数を返さず、設定変更/削除で予算を消さない。journal ACK前にconnectorへ進まない。期限切れleaseは本人を再確認した`maintain`で明示回復し、自動再取得しない。設定/版/leaseの最終確認を省略しない。`maintain`は期限切れmetadataだけを消し、設定/墓標/予算を保持。HTTP/server/scheduler未登録、通常DBへ適用しない。試験は別37029・新しい空DB・journal有効の架空fixtureだけで、終わったら正常停止。全owner走査・worker supervisor・外部provider全体の予算・課金予算・全監査/全面撤回は未完。通常の起動ロック・prod read-onlyを維持する。古い実行コードは追加したacquisition stateを落とす可能性があるため混在運用/無検証rollbackをしない。

## Radar RAD-1C（2026-08-28）の注意

`docs/shannon-radar.md`12節。`/radar`の本人用source設定/非通知preview画面を追加。AgentProviderから分離し、session世代・User object・期限とcatalog版で表示を制限する。更新/ログアウト/タブ離脱/期限で表示とdraftを消去し、遅延応答で復活させない。保存後は版を照合して読み戻し、結果不明時に再試行しない。APIはserver未登録のまま。ブラウザ検証は明示的な`serve-radar-ui-fixture.cjs --isolated-fixture`のloopback専用・架空データ・in-memory repositoryだけで、Firebase/通常DB/実ソース/本体へ接続しない。利用後はfixtureとSSH tunnelを停止する。実認証のE2E・lease/予算予約・purge・weather/calendar・投稿は未完。prod read-only、ロック維持。以下は過去の段階。

## Radar RAD-1B（2026-08-28）の注意

`docs/shannon-radar.md`11節。本人限定catalog/変更履歴の単一owner Mongo CAS、設定・撤回・private preview HTTP登録関数を追加。Firebase projectId＋UIDからownerを固定し、他人/admin代理/Discord自動リンクを拒否。再認証callbackを省かず、保存前・返却前に同意/権限/版を確認する。source変更でcatalogを失効、削除は設定/内容を消しID墓標で再投入を拒否。APIはserver未登録、collect/publish endpointなし。別Mongo37029の架空fixtureだけで検証し、通常DB/実ソースに書かない。監査64件・source10件/墓標込み32ID・各20metadataは初期の上限で、永久dedup/全監査/全派生消去/物理expiry purge/lease/queue/本人画面は未完。prod read-only、起動ロック維持。以下は過去の段階。

## Radar RAD-1A（2026-08-28）の注意

`docs/shannon-radar.md`10節。source registry契約/private JSON read adapter、Radar専用のpublic IPv4をpinするHTTPS GET、YouTube/選択Web RSS/Atom、出典正規化→private digest previewを実装。112新規モック試験とRAD-0 65件、対象通常型検査を通過。実ソース設定/定期起動/DB保存/外部通信/投稿はしていない。weather/calendarは未対応で拒否、認証UI・durable catalog/queue・回数予約・全撤回は後続。JSON fixtureだけを作り通常DBに書かない。既存URL取得やschedulerに自動接続しない。取得後と保存/公開前の最新同意・権限確認を省略せず、registryを本人認証の代わりにしない。prod read-only、起動ロックを維持。

## Shannon Radar（2026-08-28）の注意

主用途は静かな個人/コミュニティ情報Bot。`docs/shannon-radar.md`を参照。新しい`modules/radar`はSDK/I/O/会話graph非依存のRAD-0基盤のみ。rankと配信判断は別、未設定は沈黙、個人digestは非通知preview、Discordはカード承認待ちで送信機能なし。approval照合を認証の代わりにしない。本人/同意/scope付きの観測から始め、profileを主記憶にしない。無反応を嫌悪と扱わずセンシティブ属性を推測しない。既存request返信portやscheduler/EventBusから自発投稿を迂回実行しない。connector/queue/本人管理UI/全面撤回は未完、実投稿・設定・本体起動は行わずdevロックとprod読み取りのみを維持する。

## RF-03第6段階（2026-08-28）の注意

VM devでbackend411＋frontend18＝429テスト、対象通常型検査/build/native probe合格。実Discordはfake clientで検証、実接続なし。巨大なclient/FCA等を含む全backendはnoCheck変換のみ。

`docs/refactor-discord-conversation.md`を参照。Discordテキスト返信/履歴ツールは現在の本人・会話のport経由だけとし、未binding・別channel/guild・非対応媒体/添付を拒否する。SDK側もID/権限/private thread membershipを確認し、送信Promise完了後に結果を返す。text dispatcherを旧音声EventBusへ戻さない。音声・旧イベント発行元・Web broadcast等の全宛先認可は未完。起動ロック・prod読み取りのみを維持し、制限を迂回しない。

## RF-03第5段階（2026-08-28）の注意

`docs/refactor-person-memory.md`を参照。新しい人物記憶はDiscordテキストの現在の本人＋会話scope＋原文出典のみ。旧PersonMemory・名前統合・関係性推測は復活させない。新collectionはscopedpersonstatements、1 message 1引用、既存_id一意性で重複を防ぐ。編集/忘却は内部portのみで自動実行しない。忘却はこの記録の本文/source削除と同じ出典の再登録防止に限り、全履歴/派生/旧queueの撤回ではない。VM dev371テストと一時mongodでの架空fixture検証を実施。一時mongod停止済み、通常dev/prod DB・env/Botは未変更。ライブロック維持、本番未反映。

## RF-03第4段階（2026-08-28）の注意

`docs/refactor-minecraft-memory-identity.md`を参照。固定server/world IDの設定・接続所有・runtime/adapter配線を実装したが、実対応付けは未設定。world再生成時はworldIdを変える。表示名/endpointをIDの代用にせず、未設定の長期記憶停止を維持する。Mod/Discord音声は記憶停止・game-chat履歴への混入禁止。旧人物記憶の復旧・全宛先/履歴/WorldKnowledge分離は未完。dev限定のメタデータ監査は各0件で、旧本番データの分類成功とは扱わない。env/DB/Bot変更・ライブ起動・push・prod反映は行っていない。

## Cursor Cloud specific instructions

### Project overview

Shannon is an autonomous AI agent platform (Minecraft bot, Discord bot, Twitter agent, YouTube integration, web dashboard). It is a monorepo with npm workspaces: `backend`, `frontend`, `common`.

**設計ドキュメント索引**: [`docs/README.md`](docs/README.md)（現状サマリは [`docs/architecture-current.md`](docs/architecture-current.md)）。

### Key commands

| Task          | Command                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| Install deps  | `npm install --ignore-scripts && npx patch-package` (see native modules note below)        |
| Build common  | `npm run build -w common`                                                                  |
| Build backend | `cd backend && NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck` |
| Dev (both)    | `npm run dev` (uses `concurrently`)                                                        |
| Frontend dev  | `npm run dev -w frontend` (Vite on port 3001)                                              |
| Frontend lint | `npm run lint -w frontend`                                                                 |
| Backend tests | `npx vitest run` (from `backend/`; 統合テストは `OPENAI_API_KEY` + `MONGODB_URI` が必要)   |

### Non-obvious caveats

- **Git に載せないもの:** `common/dist/`（`npm run build -w common` で生成）、`saves/recent_auto_posts.json` / `watchlist.json` / `voice_text_channels.json`、Minebot の `*_data.json`・`screenshots/`・`self_improvement_history.json` 等は `.gitignore`。**雛形**は `watchlist.example.json` / `voice_text_channels.example.json`。**本番:** 次の `reset --hard` デプロイで、以前コミットに含まれていたこれらは作業ツリーから消える。必要ならデプロイ前にバックアップするか、`git show <旧コミット>:backend/saves/watchlist.json` 等で復元する。
- **Backend TypeScript build requires ~10GB+ heap.** Standard `tsc -b` will OOM on a 16GB VM. Use `NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck` from the `backend/` directory to transpile without type-checking. Build `common` first (`npm run build -w common`) since the backend references it.
- **Native modules:** `npm install` fails if run normally because the `gl` package (dependency of `node-canvas-webgl`) cannot compile on modern compilers. Use `npm install --ignore-scripts` then manually build needed native modules: `canvas` (run `npm run install` in `node_modules/canvas`), `@discordjs/opus` (run `npx @mapbox/node-pre-gyp install --fallback-to-build` in `node_modules/@discordjs/opus`). Then run `npx patch-package` to apply patches.
- **System dependencies required for native modules:** `build-essential`, `libcairo2-dev`, `libjpeg-dev`, `libpango1.0-dev`, `libgif-dev`, `librsvg2-dev`, `libpixman-1-dev`, `pkg-config`, `python3`, `cmake`, `libopus-dev`, `libgl1-mesa-dev`, `libxi-dev`, `libxext-dev`. These should already be installed by the VM setup.
- **Backend requires environment variables:** `OPENAI_API_KEY` (required), `MONGODB_URI` (required), `TWITTER_API_KEY`, `TWITTER_API_KEY_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`, `NOTION_API_KEY`, `GOOGLE_API_KEY`, `SEARCH_ENGINE_ID` are all needed for the backend to start without crashing. See `backend/src/config/env.ts` for the full list. For optional services, dummy values work (e.g. `TWITTER_API_KEY=dummy`).
- **Backend startup requires `--unhandled-rejections=warn` flag.** The Discord bot's `initialize()` calls `client.login()` without await, causing an unhandled promise rejection that crashes the process when `DISCORD_TOKEN` is empty/invalid. Use `node --unhandled-rejections=warn` to work around this.
- **MongoDB must be running locally** (default port 27017). Start with: `mongod --dbpath /data/db --logpath /data/db/mongod.log --logappend --bind_ip 127.0.0.1 --port 27017 &`. Ensure `/data/db` is owned by the current user.
- **Backend startup command (full):** `cd backend && TWITTER_API_KEY=dummy TWITTER_API_KEY_SECRET=dummy TWITTER_ACCESS_TOKEN=dummy TWITTER_ACCESS_TOKEN_SECRET=dummy NOTION_API_KEY=dummy GOOGLE_API_KEY=dummy SEARCH_ENGINE_ID=dummy PORT=5001 node --unhandled-rejections=warn --experimental-specifier-resolution=node --es-module-specifier-resolution=node dist/server.js`
- **Frontend requires Firebase env vars:** Create `frontend/.env` with `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`. See `frontend/.env.example` for a template.
- **多くのテストは統合テスト**（OpenAI 等が必要）。**例外:** `npx vitest run tests/selfImprove/nightlySchedule.test.ts` は純粋な時刻判定のみ（API 不要）。
- **Frontend lint has 1 pre-existing error** (`unused variable` in `src/services/config/ports.ts`).
- **API test endpoint:** `POST /api/test/scheduled-post?dry_run=true` with `x-api-key` header (matches `TWITTERAPI_IO_API_KEY` env var) and body `{"command":"fortune"}` generates a fortune post via OpenAI without posting to Twitter.
- **Self-improve Tier 2:** `SELF_IMPROVE_AUTO_APPLY_TIER2=true` forces file writes after validation (otherwise proposals stay `pending_review`). Dev mode no longer enables auto-apply; explicit `SELF_IMPROVE_AUTO_APPLY_TIER2=true` is required. `SELF_IMPROVE_ALLOW_DELETE=true` is required for Tier 2 `delete` actions. Mutable: almost all of `backend/` except `src/config/`, lockfiles, `package.json`, `tsconfig*`, `.env`, `node_modules/`, `dist/`, etc. (`mutableCodePolicy.ts`). Tier2 prompts prioritize `src/services/minebot/` and `src/services/llm/`.
- **Minecraft self-test chat (chatMode OFF でも可):** `..test-all` / `..test-smoke` / `..test <suite> [--fix]` に加え、`self_test_cases` や `saves/minecraft/self_test_cases` を含む文、または `basic-skills.json` + 「テスト」などの自然文で同じランナーが起動する（`selfTestIntent.ts`）。
- **CodeAgentLoop:** `..agent-fix <説明>` でコーディングエージェント級の自律修正を起動。`read_file` / `search_code` / `list_directory` / `edit_file`（差分適用）/ `create_file` / `delete_file` / `run_tsc` / `run_vitest` の 8 ツールを gpt-4.1 が ReAct ループで使う。`SkillPatcher.diagnoseAndFixWithAgent` / `ImprovementApplier.applyWithAgent` でプログラムからも呼べる。
- **夜間自己改善（課金抑止）:** `SELF_IMPROVE_NIGHTLY_ENABLED=true` で UTC 指定時刻に1日1回 `runNightlyMaintenance` → `saves/self_improve/morning_reports/` に Markdown/JSON。**既定は LLM なし**（レポートに「スキップ」が並ぶだけ）。課金ありにするには明示: `SELF_IMPROVE_NIGHTLY_RUN_REACTIVE=true`（失敗バッファ分析）, `SELF_IMPROVE_NIGHTLY_CODE_AGENT=true`（Anthropic）, `SELF_IMPROVE_NIGHTLY_MINECRAFT_SUITES=smoke-skills` 等。`SELF_IMPROVE_NIGHTLY_MINECRAFT_AUTOFIX=true` は SkillPatcher で追加 LLM。`SELF_IMPROVE_MORNING_WEBHOOK_URL` で Discord 等へ要約投稿可。

### 本番CD・リリースの現状

最新状態は `docs/r0-release-readiness.md`。devのworkflow定義はmain自動反映から手動candidate検証へ変更済みだが、未pushのためGitHubは旧定義のまま。本番へpush/mergeしない。実切替はUID/資格情報・限定実機・復旧・機能制限を確認した別工程。

## Shannon開発方針（2026-08-28）

ユーザー指定の実装・テスト先はAzure VMの `/home/azureuser/Shannon-dev`。同VMの `Shannon-prod` は開発中は読み取りのみとし、検証後の本番反映を別工程にする。ローカル調査用コピーを本番・開発実行元と取り違えない。

[開発手順](docs/development-workflow.md)と[Notion資料ハブ](https://www.notion.so/3ca1e847628881c9b4bbfd5556a55347)を読んでから作業する。設計・実装・検証の変更はNotionの関連資料と変更履歴へ反映し、再取得で確認する。

devの `.dev-runtime-lock` は共有認証情報等の整理が済むまで起動スクリプトを止める。直接node起動で迂回しない。まず外部をモックする単体テストとビルドを行う。DB接続先はdev専用であり、prodのDBや秘密設定を上書きしない。

### RF-01/RF-02の初期実装

`docs/refactor-access-foundation.md`を参照。新しいaccess/modelSettingsモジュールはSDK・DB・環境変数に依存させない。`npm run check:foundation -w backend`と`check:access-integration`で検査する。公開API全体の認証は未完了なので起動ロックを解除しない。旧email-only認証、公開管理者登録、frontendの認証bypassを復活させない。Firebase UIDの利用者対応付けはレビュー後の別工程。

### R0追加検証とGit整理

ユーザーの問題解消依頼に基づきprodのGit記録のみ `95426bb` へ整合、未コミット0件。実ファイル769件と削除済み1パス、環境設定・backend PIDは不変。dev新コードは未反映。今後も開発中のprodファイル/設定/プロセス変更はしない。

Node22.21.1を `bash scripts/with-dev-node.sh` で使用。native probe、158 backend +18 frontendテスト、隔離MongoDB復元に合格。共有外部資格情報とUID対応付けは未解決なので起動ロックを迂回しない。管理consoleのみ許可、public chat停止、Mod専用認証必須という現行制限を勝手に緩めない。詳細と残条件はR0資料。

### RF-03の実行管理とセッション分離

最新のdev実装は `docs/refactor-execution-sessions.md` とNotion 08の15節。第1段階の実行順序・中断管理に続き、共有FCAを登録用catalogと1回限りのsessionへ分離した。状態付きツールは `createForRun()` で生成し、共有agentへMemoryAgent/blackboardを注入しない。ParallelExecutorにはgraphからcanonical requestEnvelopeを明示する。

VM devでbackend207＋frontend18＝225テスト、対象型検査・common/frontend build・native probe合格。backend全体はnoCheck変換のみ。本番ファイル/設定/プロセス不変、env/DB変更・live起動・push・deployなし。DB記憶検索のscope、旧memoryツール、Webの一斉配信、全チャネル宛先認可は未完。public chat停止と起動ロックを維持する。Halcyonは音楽Botで対象外、新しいテストBotは未作成。

### RF-03の記憶scope（第3段階）

`docs/refactor-memory-scope.md` とNotion 08の16節を参照。scopeVersion/keyのある新規記憶だけを同じ範囲で検索・保存する。旧人物記憶・旧pending queue・範囲不明データを勝手に再分類しない。現行Minebot入力には固定server/world IDがなく長期記憶は拒否、Web等もaudience未配線のため拒否。MemoryNodeは互換空実装。`check:memory-integration` は記憶サービスの通常型検査。全グラフ完全型検査・実DB移行・実API検証は未完。prod読み取りのみ、起動ロック維持。
