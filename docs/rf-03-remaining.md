# RF-03 / R0 残作業（C・D）

2026-08-30 時点。本番 UID 切替・admin ログイン後の残り。

## C — RF-03 / R0 本体

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| C1 | Identity binding → 会話経路 | 🚧 | Radar HTTP gate + Discord/Web memory gate 配線済。main server Radar 登録・LINE は未 |
| C2 | 公開 chat / SSE | 🚫 | 503 停止維持。別設計後に復旧 |
| C3 | Discord 全宛先認可・LLM 権限伝播 | 🚧 | voice/Minebot/Web session は済 |
| C4 | 記憶 scope 実 DB 移行 | 🚫 | 旧データ自動再分類なし |
| C5 | backend 全体 strict 型検査 | 🚧 | `--noCheck` 変換のみ |
| C6 | `check:access-integration` 型エラー | 🚧 | Web エージェント系 |

## D — Radar / LINE / インフラ

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| D1 | Radar 個人 feed 本番 runtime | 🚧 | dev 基盤・架空 fixture のみ |
| D2 | LINE 配備 MVP | 🚫 | 独立 bundle・別工程 |
| D3 | GitHub Actions 本番 CD | 🚧 | 手動 preflight。main 自動 deploy なし |
| D4 | `release-preflight.py` 正式実行 | ✅ | 2026-08-30 実行。`ready:false`（dirty worktree・手動証跡・MINEBOT token 等） |
| D5 | Discord テスト bot・LLM 費用上限 | ⏳ | R0 入力待ち |

## 優先順位（実装）

1. **C1** — `IdentityProfile` を Radar HTTP / Discord テキストの owner 解決に接続
2. **C3** — Discord テキスト outbound 残経路
3. **D4** — main マージ後 preflight 実行
4. **C5/C6** — 型エラー段階解消

## 関連

- [architecture-current.md](architecture-current.md)
- [refactor-execution-sessions.md](refactor-execution-sessions.md)
- [shannon-radar.md](shannon-radar.md)
- [line-integration.md](line-integration.md)
