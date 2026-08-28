# AGENTS.md

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

### 本番 CD（GitHub Actions → Shannon-prod）

- **トリガー:** **`main` への push / マージ**および手動 `workflow_dispatch`（[`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml)）。
- **動作:** SSH で本番 VM に入り、本番クローンで `git fetch` → `checkout main` → **`reset --hard origin/main`** → **`npm ci --ignore-scripts --legacy-peer-deps`**（`@langchain/anthropic@1.x` と `@langchain/core@0.3` の peer 衝突回避）→ **`npx patch-package`** → **`./start.sh`**。続けて tmux セッション `shannon-backend-prod` / `shannon-frontend-prod` の存在を確認。
- **Secrets（Repository secrets）**

| Secret | 内容 |
|--------|------|
| `SHANNON_PROD_SSH_HOST` | 本番 VM の IP または FQDN |
| `SHANNON_PROD_SSH_USER` | 例: `azureuser` |
| `SHANNON_PROD_SSH_PRIVATE_KEY` | VM ログイン用の秘密鍵（**BEGIN〜END 全文**。先頭空行は workflow 側で除去） |
| `SHANNON_PROD_REPO_PATH` | （任意）本番クローンの絶対パス。未設定時は `/home/azureuser/Shannon-prod` |

- **以前 `SHANNON_SSH_*` だけ登録していた場合:** 上記 `SHANNON_PROD_*` に合わせて Secrets を登録し直すか、同じ値を `SHANNON_PROD_*` 名で追加する。
- **本番側の前提:** `origin` がこのリポジトリの `main` を向いていること。`git fetch` は VM 上の GitHub 用 SSH（`git@github.com:...`）が通ること。`tmux` が利用できること。
- **ネイティブモジュール:** `npm ci` は `--ignore-scripts` のため、**初回本番セットアップ**で `canvas` / `@discordjs/opus` 等を手動ビルド済みであること（AGENTS の Native modules 節）。ロック変更後に CI の `npm ci` が失敗したら本番で依存を直してから再デプロイ。
- **NSG / SSH:** GitHub ホステッドランナーから VM の 22 番へ届く必要あり（aiminelab CD と同様）。

## Shannon開発方針（2026-08-28）

ユーザー指定の実装・テスト先はAzure VMの `/home/azureuser/Shannon-dev`。同VMの `Shannon-prod` は開発中は読み取りのみとし、検証後の本番反映を別工程にする。ローカル調査用コピーを本番・開発実行元と取り違えない。

[開発手順](docs/development-workflow.md)と[Notion資料ハブ](https://www.notion.so/3ca1e847628881c9b4bbfd5556a55347)を読んでから作業する。設計・実装・検証の変更はNotionの関連資料と変更履歴へ反映し、再取得で確認する。

devの `.dev-runtime-lock` は共有認証情報等の整理が済むまで起動スクリプトを止める。直接node起動で迂回しない。まず外部をモックする単体テストとビルドを行う。DB接続先はdev専用であり、prodのDBや秘密設定を上書きしない。
