# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Shannon is an autonomous AI agent platform (Minecraft bot, Discord bot, Twitter agent, YouTube integration, web dashboard). It is a monorepo with npm workspaces: `backend`, `frontend`, `common`.

### Key commands

| Task          | Command                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| Install deps  | `npm install --ignore-scripts && npx patch-package` (see native modules note below)        |
| Build common  | `npm run build -w common`                                                                  |
| Build backend | `cd backend && NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck` |
| Dev (both)    | `npm run dev` (uses `concurrently`)                                                        |
| Frontend dev  | `npm run dev -w frontend` (Vite on port 3001)                                              |
| Frontend lint | `npm run lint -w frontend`                                                                 |
| Backend tests | `npx vitest run` (from `backend/`; requires `OPENAI_API_KEY` + `MONGODB_URI`)              |

### Non-obvious caveats

- **Backend TypeScript build requires ~10GB+ heap.** Standard `tsc -b` will OOM on a 16GB VM. Use `NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck` from the `backend/` directory to transpile without type-checking. Build `common` first (`npm run build -w common`) since the backend references it.
- **Native modules:** `npm install` fails if run normally because the `gl` package (dependency of `node-canvas-webgl`) cannot compile on modern compilers. Use `npm install --ignore-scripts` then manually build needed native modules: `canvas` (run `npm run install` in `node_modules/canvas`), `@discordjs/opus` (run `npx @mapbox/node-pre-gyp install --fallback-to-build` in `node_modules/@discordjs/opus`). Then run `npx patch-package` to apply patches.
- **System dependencies required for native modules:** `build-essential`, `libcairo2-dev`, `libjpeg-dev`, `libpango1.0-dev`, `libgif-dev`, `librsvg2-dev`, `libpixman-1-dev`, `pkg-config`, `python3`, `cmake`, `libopus-dev`, `libgl1-mesa-dev`, `libxi-dev`, `libxext-dev`. These should already be installed by the VM setup.
- **Backend requires environment variables:** `OPENAI_API_KEY` (required), `MONGODB_URI` (required), `TWITTER_API_KEY`, `TWITTER_API_KEY_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`, `NOTION_API_KEY`, `GOOGLE_API_KEY`, `SEARCH_ENGINE_ID` are all needed for the backend to start without crashing. See `backend/src/config/env.ts` for the full list. For optional services, dummy values work (e.g. `TWITTER_API_KEY=dummy`).
- **Backend startup requires `--unhandled-rejections=warn` flag.** The Discord bot's `initialize()` calls `client.login()` without await, causing an unhandled promise rejection that crashes the process when `DISCORD_TOKEN` is empty/invalid. Use `node --unhandled-rejections=warn` to work around this.
- **MongoDB must be running locally** (default port 27017). Start with: `mongod --dbpath /data/db --logpath /data/db/mongod.log --logappend --bind_ip 127.0.0.1 --port 27017 &`. Ensure `/data/db` is owned by the current user.
- **Backend startup command (full):** `cd backend && TWITTER_API_KEY=dummy TWITTER_API_KEY_SECRET=dummy TWITTER_ACCESS_TOKEN=dummy TWITTER_ACCESS_TOKEN_SECRET=dummy NOTION_API_KEY=dummy GOOGLE_API_KEY=dummy SEARCH_ENGINE_ID=dummy PORT=5001 node --unhandled-rejections=warn --experimental-specifier-resolution=node --es-module-specifier-resolution=node dist/server.js`
- **Frontend requires Firebase env vars:** Create `frontend/.env` with `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`. See `frontend/.env.example` for a template.
- **All tests are integration tests** that require real API keys (OpenAI, Twitter, etc.). There are no pure unit tests.
- **Frontend lint has 1 pre-existing error** (`unused variable` in `src/services/config/ports.ts`).
- **API test endpoint:** `POST /api/test/scheduled-post?dry_run=true` with `x-api-key` header (matches `TWITTERAPI_IO_API_KEY` env var) and body `{"command":"fortune"}` generates a fortune post via OpenAI without posting to Twitter.

### CD（GitHub Actions → 本番 VM）

- **トリガー:** このリポジトリ（**Shannon-prod**）の **`main` への push / マージ**（[`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml)）。
- **動作:** SSH で本番 VM に入り、`/home/azureuser/Shannon-prod` で `git fetch` → `reset --hard origin/main` → `npm ci --ignore-scripts` → `npx patch-package` → **`./start.sh`**（tmux で backend / frontend を再起動）。
- **Secrets（Repository secrets）:** `SHANNON_SSH_HOST`, `SHANNON_SSH_USER`, `SHANNON_SSH_PRIVATE_KEY`（**秘密鍵は `-----BEGIN`〜`-----END` 全文**。aiminelab 用の鍵と共用可。ホストが同じなら `AIMINELAB_SSH_*` と同値でもよいが、名前はワークフローが `SHANNON_*` を参照する）。
- **クローン先が違うとき:** workflow 内の `SHANNON_PROD_DIR` を実パスに変更する。
- **開発リポジトリ（Shannon-dev）との関係:** 本番が pull するのは **Shannon-prod の main** だけ。開発は Shannon-dev で行い、本番に載せる変更は **Shannon-prod にマージ・push** してから CD が走る形を想定。Shannon-dev の push だけで本番を更新したい場合は、Shannon-dev 側に別 workflow を置き、同じ SSH 手順で `Shannon-prod` のディレクトリだけ pull するか、`repository_dispatch` 等で連携する必要がある。
- **NSG / SSH:** GitHub ホステッドランナーから VM の 22 番へ届く必要あり（aiminelab CD と同様）。届かない場合はセルフホステッドランナー検討。
