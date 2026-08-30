# RF-03 / R0 残作業（C・D）

2026-08-30 時点。本番 UID 切替・admin ログイン後の残り。

## C — RF-03 / R0 本体

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| C1 | Identity binding → 会話経路 | ✅ | main Radar/Discord/Web + LINE runtime gate（`findByLineUserId` / `lineDeliveryEnabled`）。実 LINE 接続は D2 |
| C2 | 公開 chat / SSE | 🚫 | 503 停止維持。別設計後に復旧 |
| C3 | Discord 全宛先認可・LLM 権限伝播 | ✅ | scheduled/subscriber outbound gate、memoryDisabled→ツール除外 |
| C4 | 記憶 scope 実 DB 移行 | 🚫 | 旧データ自動再分類なし |
| C5 | backend 段階 strict 型検査 | ✅ | `check:foundation` + `check:access-integration` + `check:memory-integration` 合格（フル `tsc` は OOM のため対象外） |
| C6 | `check:access-integration` 型エラー | ✅ | Web/Discord/Voice/LangChain 深い型・migration `.d.ts` 等を解消 |

## D — Radar / LINE / インフラ

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| D1 | Radar 個人 feed 本番 runtime | 🧪 | 隔離 fixture + main server 登録済。`npm run test:radar-catalog-fixture`。本番 validator/実認証は未 |
| D2 | LINE 配備 MVP | 🧪 | bundle + Mongo fixture + identity gate コード済。`npm run test:line-mongo-fixture` / `test:line-bundle`。実 Webhook/HTTPS 未 |
| D3 | GitHub Actions 本番 CD | 🧪 | `check-foundation` + automated preflight workflow。main 自動 deploy なし |
| D4 | `release-preflight.py` 正式実行 | ✅ | 2026-08-30 実行。`ready:false`（dirty worktree・手動証跡・MINEBOT token 等） |
| D5 | Discord テスト bot・LLM 費用上限 | ⏳ | R0 入力待ち |

## 優先順位（実装）

1. **D1 本番接続** — Mongo validator 適用 + 実 Firebase + 個人 feed/天気限定本番
2. **D3 手動 cutover** — 手動証跡完了後 preflight `ready:true` → 別承認 deploy
3. **D2 実 LINE** — permit/env + HTTPS Webhook + 実スマホ受信
4. **C2/C4** — 公開 chat / 記憶 scope DB 移行（別設計）

検証手順: [release-test-harness.md](release-test-harness.md)

## 関連

- [architecture-current.md](architecture-current.md)
- [refactor-execution-sessions.md](refactor-execution-sessions.md)
- [shannon-radar.md](shannon-radar.md)
- [line-integration.md](line-integration.md)
