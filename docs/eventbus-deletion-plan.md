# EventBus 完全削除計画

**目的:** `getEventBus()` / `EventBus` クラスをコードベースから消す。pub/sub による暗黙的な宛先・認可バイパスをなくす。

**完了 (2026-08-29):** `backend/src/services/eventBus/` 削除済み。`backend/src` で `getEventBus|EventBus` **0件**。

## 置き換えパターン（最終）

| 旧 EventBus 用途 | 新経路 |
|---|---|
| `web:*` 通知 | `WebNotificationHub` |
| `web:status` / `*:status` | `WebNotificationHub.emitStatus` + `serviceCommandRegistry` |
| `llm:*` | `EventRouter` public handler + `llmInboundDispatch` |
| Twitter/Notion/YouTube ツール RPC | `platformToolGateway` → 各 Client 直接メソッド |
| Discord 送信 | `discordConversationPort` + `discordOutboundGateway` |
| Voice | `voiceGateway`（VoiceManager 実装） |
| Minebot スキル | `minebotSkillGateway` + `SkillRegistrar` 直接 registry |
| Scheduler | `schedulerGateway` |
| ログ | `logging.logToWeb` → `WebNotificationHub.log` |

## フェーズ（すべて完了）

- [x] Phase 1 — Web 通知 → `WebNotificationHub`
- [x] Phase 2 — LLM 入口 → `llmInboundRegistry` / `llmInboundDispatch`
- [x] Phase 3 — 外部ツール RPC → `platformToolGateway`
- [x] Phase 4 — Discord / Voice / Minebot / Minecraft → 各 gateway + `serviceCommandRegistry`
- [x] Phase 5 — `eventBus.ts` / `index.ts` / `eventBus.test.ts` 削除

## 完了条件

- [x] `rg 'getEventBus|EventBus' backend/src` が **0件**
- [x] 対象ユニットテスト通過
- [x] `docs/architecture-current.md` から EventBus 記述削除
