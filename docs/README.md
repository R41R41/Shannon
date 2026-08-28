# Shannon ドキュメント索引

開発・設計資料の入口。**いまの実装の要約だけ知りたい場合は `[architecture-current.md](./architecture-current.md)` から読む**のが最短です。

## すぐ読む

- [開発・検証・本番反映の手順](./development-workflow.md)（2026-08-28）：VMのdevを作業先とし、prodは検証後に反映。
- [Shannon｜設計・資料ハブ](https://www.notion.so/3ca1e847628881c9b4bbfd5556a55347)：現行設計・計画・判断・変更履歴。


| ドキュメント                                                       | 内容                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| **[architecture-current.md](./architecture-current.md)**     | **現行アーキテクチャサマリ**（2026-03）。LLM グラフ・Minebot・自己改善・メモリ・全主要パス。 |
| [architecture-llm-minebot.md](./architecture-llm-minebot.md) | LLM グラフ・Minebot・自己改善の**詳細設計書**（長文）。                       |


## トピック別


| ドキュメント                                                                                                                                              | 内容                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [design-consciousness-and-self-improvement.md](./design-consciousness-and-self-improvement.md)                                                      | 意識・自発性・内なる声など**思索メモ**（未実装案と実装済みの区別を冒頭に記載）。 |
| [test-cases.md](./test-cases.md)                                                                                                                    | マイクラ向け**手動テスト観点**一覧。                       |
| [manual-test-twitter-discord-llm.md](./manual-test-twitter-discord-llm.md)                                                                          | Twitter/Discord/LLM の**手動テストチェックリスト**。     |
| [terrain-investigation-skills.md](./terrain-investigation-skills.md) / [terrain-investigation-quickstart.md](./terrain-investigation-quickstart.md) | 地形調査スキルの詳細仕様とクイックスタート。                     |


## リポジトリ直下の関連ドキュメント


| ドキュメント                                        | 内容                                             |
| --------------------------------------------- | ---------------------------------------------- |
| [AGENTS.md](../AGENTS.md)                     | 開発環境セットアップ・CI/CD・運用注意事項。                       |
| [SKILLS_REFERENCE.md](../SKILLS_REFERENCE.md) | InstantSkill 70 個 + ConstantSkill 15 個の全スキル一覧。 |
| [ARCHITECTURE.md](../ARCHITECTURE.md)         | 旧アーキテクチャ（2025-11）。歴史的参照用。現行は本ディレクトリ参照。         |


## アーカイブ

[archive/](./archive/) — 過去のリファクタ計画・モデル更新ログ・旧ガイド・旧プロジェクトステータス。**現行仕様の根拠には使わない**こと。

## リポジトリ外

- サイト: [アイマイラボ「シャノンの仕組み」](https://aiminelab.com/architecture)


## 2026-08-28の責務分離

- [Web認証・モデル設定の責務分離](refactor-access-foundation.md)：RF-01/RF-02の初期実装、テストと移行前提。
- [Notionの現行設計](https://www.notion.so/3ca1e84762888170816ee73f25c40ce3)：段階的な責務分離。

- [R0リリース準備・追加検証（2026-08-28）](r0-release-readiness.md)
