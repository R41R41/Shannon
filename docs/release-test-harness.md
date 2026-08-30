# Release test harness (D1 / D3 / D2 / C1)

2026-08-30。`.dev-runtime-lock` 維持のまま mock/isolated で検証する手順。

## 一括（推奨）

```bash
cd /home/azureuser/Shannon-dev
npm run test:release-fixtures
```

含む: common/backend build → Radar catalog fixture → LINE Mongo fixture → LINE bundle build → `check:backend-strict` → `test:offline`

## D1 — Radar 個人 feed runtime

| コマンド | 内容 |
|---|---|
| `npm run test:radar-catalog-fixture -w backend` | 37029 隔離 Mongo + validator fence |
| `npm run build -w common && cd backend && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noCheck --skipLibCheck` | 独立 runtime 用 dist |
| `node scripts/serve-radar-runtime-fixture.cjs --isolated-fixture` | loopback 15030 HTTP（最大 10 分、自動停止） |

実接続 dev `--serve` は `~/.config/shannon-radar-dev/` + ロック解除レビュー後。

## D3 — CD / preflight

| コマンド | 内容 |
|---|---|
| `npm run check:backend-strict -w backend` | foundation + access + memory 型検査 |
| `npm run preflight:automated` | prod/dev 分離 + env 整合（手動証跡 blockers をスキップ） |
| GitHub `Production release preflight` | workflow_dispatch + candidate SHA → prod VM で automated preflight |

`ready:true` には手動 cutover 証跡（UID 移行・backup・rollback 等）が別途必要。

## D2 — LINE MVP

| コマンド | 内容 |
|---|---|
| `npm run test:line-mongo-fixture -w backend` | 37030 隔離 Mongo ledger |
| `npm run test:line-bundle -w backend` | `backend/dist-line/runtime.mjs` ビルド |
| `node scripts/prepare-line-database.cjs dev --new-empty-database` | 空 DB 準備 |
| `node scripts/start-line-service.cjs --check dev` | permit 検証（`~/.config/shannon-line-dev/` 要） |

## C1 — LINE identity binding

| コマンド | 内容 |
|---|---|
| `npx vitest run tests/unit/lineIdentityGate.test.ts` | binding + `lineDeliveryEnabled` gate |
| `PUT /api/identity/bindings/line` | main server（Settings UI） |
| LINE runtime | `LINE_FIREBASE_PROJECT_ID` + `LINE_IDENTITY_MONGODB_URI` 設定時に `authorizePersonal` 有効 |

未設定時は従来どおり gate 無効（profile 未保存と同じ）。

## 関連

- [shannon-radar.md](shannon-radar.md) §19
- [line-integration.md](line-integration.md)
- [rf-03-remaining.md](rf-03-remaining.md)
