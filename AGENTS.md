# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Shannon is an autonomous AI agent platform (Minecraft bot, Discord bot, Twitter agent, YouTube integration, web dashboard). It is a monorepo with npm workspaces: `backend`, `frontend`, `common`.

### Key commands

| Task | Command |
|---|---|
| Install deps | `npm install --ignore-scripts && npx patch-package` (see native modules note below) |
| Build common | `npm run build -w common` |
| Build backend | `cd backend && NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck` |
| Dev (both) | `npm run dev` (uses `concurrently`) |
| Frontend dev | `npm run dev -w frontend` (Vite on port 3001) |
| Frontend lint | `npm run lint -w frontend` |
| Backend tests | `npx vitest run` (from `backend/`; 統合テストは `OPENAI_API_KEY` + `MONGODB_URI` が必要) |

### Non-obvious caveats

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
- **Self-improve Tier 2:** `SELF_IMPROVE_AUTO_APPLY_TIER2=true` forces file writes after validation (otherwise proposals stay `pending_review`). Dev defaults: `--dev` or `IS_DEV=True` also enable auto-apply. `SELF_IMPROVE_ALLOW_DELETE=true` is required for Tier 2 `delete` actions. Mutable: almost all of `backend/` except `src/config/`, lockfiles, `package.json`, `tsconfig*`, `.env`, `node_modules/`, `dist/`, etc. (`mutableCodePolicy.ts`). Tier2 prompts prioritize `src/services/minebot/` and `src/services/llm/`.
- **Minecraft self-test chat (chatMode OFF でも可):** `..test-all` / `..test-smoke` / `..test <suite> [--fix]` に加え、`self_test_cases` や `saves/minecraft/self_test_cases` を含む文、または `basic-skills.json` + 「テスト」などの自然文で同じランナーが起動する（`selfTestIntent.ts`）。
- **CodeAgentLoop:** `..agent-fix <説明>` でコーディングエージェント級の自律修正を起動。`read_file` / `search_code` / `list_directory` / `edit_file`（差分適用）/ `create_file` / `delete_file` / `run_tsc` / `run_vitest` の 8 ツールを gpt-4.1 が ReAct ループで使う。`SkillPatcher.diagnoseAndFixWithAgent` / `ImprovementApplier.applyWithAgent` でプログラムからも呼べる。
- **夜間自己改善（課金抑止）:** `SELF_IMPROVE_NIGHTLY_ENABLED=true` で UTC 指定時刻に1日1回 `runNightlyMaintenance` → `saves/self_improve/morning_reports/` に Markdown/JSON。**既定は LLM なし**（レポートに「スキップ」が並ぶだけ）。課金ありにするには明示: `SELF_IMPROVE_NIGHTLY_RUN_REACTIVE=true`（失敗バッファ分析）, `SELF_IMPROVE_NIGHTLY_CODE_AGENT=true`（Anthropic）, `SELF_IMPROVE_NIGHTLY_MINECRAFT_SUITES=smoke-skills` 等。`SELF_IMPROVE_NIGHTLY_MINECRAFT_AUTOFIX=true` は SkillPatcher で追加 LLM。`SELF_IMPROVE_MORNING_WEBHOOK_URL` で Discord 等へ要約投稿可。
