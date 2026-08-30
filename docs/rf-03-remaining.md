# RF-03 / R0 残作業（C・D）

2026-08-30 時点。本番 UID 切替・admin ログイン後の残り。**2026-08-30 本番:** Web `/radar` API、Mongo validator、LINE会話・日次Radar、Web保存ソース同期、Identity gateを接続済み。Notion: [07｜残タスク・本番接続状況（2026-08-30）](https://app.notion.com/p/3cc1e847628881129fade902cf5b7ffa)。

## C — RF-03 / R0 本体

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| C1 | Identity binding → 会話経路 | ✅ | main Radar/Discord/Web + LINE runtime gate。本番LINEは `lineDeliveryEnabled`、定期Radarはさらに `radarPersonalFeed` を要求 |
| C2 | 公開 chat / SSE | 🚫 | 503 停止維持。別設計後に復旧 |
| C3 | Discord 全宛先認可・LLM 権限伝播 | ✅ | scheduled/subscriber outbound gate、memoryDisabled→ツール除外 |
| C4 | 記憶 scope 実 DB 移行 | 🚫 | 旧データ自動再分類なし |
| C5 | backend 段階 strict 型検査 | ✅ | `check:foundation` + `check:access-integration` + `check:memory-integration` 合格（フル `tsc` は OOM のため対象外） |
| C6 | `check:access-integration` 型エラー | ✅ | Web/Discord/Voice/LangChain 深い型・migration `.d.ts` 等を解消 |

## D — Radar / LINE / インフラ

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| D1 | Radar 個人 feed 本番 runtime | ✅ | 本番main server・validator・実Firebase・本人ソース設定を接続。表示は最大60秒、タブ離脱/ログアウトで消去 |
| D2 | LINE 配備 MVP | ✅ | 本番service稼働。通常会話・配信コマンド・FCA検索・Web保存YouTube/RSS先頭3件・Identity gateを接続 |
| D3 | GitHub Actions 本番 CD | 🧪 | `check-foundation` + automated preflight workflow。main 自動 deploy なし |
| D4 | `release-preflight.py` 正式実行 | ✅ | dirty prodを保全stash後にdev履歴へ統合。MINEBOT専用tokenを保護設定し、automated preflightを再実行 |
| D5 | Discord テスト bot・LLM 費用上限 | ⏳ | R0 入力待ち |

## 優先順位（実装）

1. **運用観測** — 次回日次窓の選定・重複抑止・実LINE受信を監査し、通知過多なら即停止
2. **実ソース拡張** — Calendar/天気、未登録YouTube推薦、X/Web discoveryを本人同意ごとに段階追加
3. **D3継続** — GitHub preflightから独立した、署名済みartifactによる本番切替を整備
4. **C2/C4** — 公開 chat / 記憶 scope DB 移行（別設計）

検証手順: [release-test-harness.md](release-test-harness.md)

## 関連

- [architecture-current.md](architecture-current.md)
- [refactor-execution-sessions.md](refactor-execution-sessions.md)
- [shannon-radar.md](shannon-radar.md)
- [line-integration.md](line-integration.md)
