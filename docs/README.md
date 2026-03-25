# Shannon ドキュメント索引

開発・設計資料の入口。**いまの実装の要約だけ知りたい場合は [`architecture-current.md`](./architecture-current.md) から読む**のが最短です。

## すぐ読む

| ドキュメント | 内容 |
|-------------|------|
| [**architecture-current.md**](./architecture-current.md) | **最新化サマリ**（2026-03）。全体像・自己改善・自己テスト・夜間バッチ・主要パス。 |
| [architecture-llm-minebot.md](./architecture-llm-minebot.md) | LLM グラフ・Minebot・自己改善の**詳細設計書**（長文）。§11 に 2026-03 追記あり。 |
| [architecture-shannon-v2.md](./architecture-shannon-v2.md) | v2 グラフ再設計の**当初設計**（ingest→classify→execute→format、MemoryAgent 等）。歴史的参照用。 |

## トピック別

| ドキュメント | 内容 |
|-------------|------|
| [design-consciousness-and-self-improvement.md](./design-consciousness-and-self-improvement.md) | 意識・自発性・内なる声など**思索メモ**（未実装案と実装済みの区別を冒頭に記載）。 |
| [test-cases.md](./test-cases.md) | マイクラ向け**手動テスト観点**一覧。自動 JSON テストは同ファイル冒頭のリンク参照。 |
| [terrain-investigation-skills.md](./terrain-investigation-skills.md) / [terrain-investigation-quickstart.md](./terrain-investigation-quickstart.md) | 地形調査スキル。 |

## アーカイブ

[archive/](./archive/) — 過去のリファクタ計画・モデル更新ログ・旧ガイド。**現行仕様の根拠には使わない**こと。

- [archive/README.md](./archive/README.md) — 一覧の説明。

## リポジトリ外の公開向け解説

- サイト: [アイマイラボ「シャノンの仕組み」](https://aiminelab.com/architecture)（ハブ）および `/architecture/llm`（詳細・管理者向け図）。
- エージェント向け運用メモ: リポジトリ直下 [`AGENTS.md`](../AGENTS.md)。
