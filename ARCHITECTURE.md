# Shannon アーキテクチャドキュメント

> **このファイルは旧版です。** 現行アーキテクチャは以下を参照してください:
>
> - **[docs/architecture-current.md](./docs/architecture-current.md)** - 現行サマリ（2026-03）
> - **[docs/architecture-llm-minebot.md](./docs/architecture-llm-minebot.md)** - LLM・Minebot 詳細設計
> - **[docs/README.md](./docs/README.md)** - ドキュメント索引
>
> 以下の内容は 2025-11 時点のもので、統一グラフ (Shannon Graph v2) 移行前の旧アーキテクチャです。
> 歴史的参照用として残しています。

---

<details>
<summary>旧アーキテクチャ（2025-11 時点 / クリックで展開）</summary>

## システム全体図

```
┌─────────────────────────────────────────────────────────┐
│                    Minecraft Server                      │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼─────┐         ┌──────▼──────┐
    │ Minebot  │◄────────┤ ShannonUIMod│
    │(Backend) │  HTTP   │ (Frontend)  │
    └────┬─────┘  8082   └──────┬──────┘
         │                       │
    LangGraph                Packet
    TaskGraph             Communication
```

## Backend アーキテクチャ（旧）

### LangGraph ベースのタスク実行フロー

```
User Message → CentralAgent (gpt-4o-mini)
  → TaskGraph (LangGraph)
    → UnderstandingNode → PlanningNode (o1-mini) → ExecutionNode
      → CustomToolNode (42 skills)
      → ReflectionNode
```

**注**: 現行は統一グラフ `ingest → classify → execute → format` に移行済み。
CentralAgent / TaskGraph / PlanningNode / CustomToolNode は廃止され、
`ClassifyNode` / `FunctionCallingAgent` / `ParallelExecutor` に置き換わっています。

</details>
