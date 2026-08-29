# EventBus 完全削除計画

**目的:** `getEventBus()` / `EventBus` クラスをコードベースから消す。pub/sub による暗黙的な宛先・認可バイパスをなくす。

**現状 (2026-08-29):** EventBus **は未削除**。`backend/src` だけで `getEventBus()` 呼び出し **約35ファイル**、subscribe/publish **100箇所以上**。

## 置き換えパターン

| 旧 EventBus 用途 | 新経路 |
|---|---|
| `web:post_message` / `web:planning` / `web:log` | `WebNotificationHub`（`getWebNotificationHub()`） |
| `web:status` | `WebNotificationHub.emitStatus` + `serviceCommandRegistry` |
| `llm:*` | `EventRouter` の public メソッド + `registerLlmInbound()` |
| `twitter:*` / `tool:*` (Twitter) | `TwitterClient` 直接メソッド + tool gateway 注入 |
| `discord:*` (テキスト送信以外) | Discord SDK / conversation transport |
| サービス start/stop (`*:status`) | `serviceCommandRegistry.dispatchServiceCommand` |
| Minebot skills | `SkillRegistrar` への直接登録 |

## フェーズ

### Phase 1 — Web 通知（完了）
- [x] `WebNotificationHub`
- [x] `webConversationTransport` → Hub 直結
- [x] `monitoringAgent` / `planningAgent` / `publicRoutes` SSE
- [x] `openaiAgent` の tool→UI 配信を Hub 購読へ
- [x] `statusAgent` / `scheduleAgent` / `skillAgent`
- [x] `BaseClient.setStatus` → Hub
- [x] `realtimeApiAgent` の log → Hub
- [x] `EventRouter.setupRealtimeAPICallback` → Hub
- [x] `EventBus.log` → Hub 委譲（過渡）

### Phase 2 — LLM 入口（完了）
- [x] `EventRouter`: subscribe 削除、public handler のみ
- [x] `registerLlmInbound` で起動時配線
- [x] `llmInboundDispatch` 経由で発行元を直接呼び出しに
- [x] 発行元: `openaiAgent`, `discord/client`, `VoiceManager`, `webhookRoutes`, `TweetMonitor`, `AutoPostManager`, `youtube/client`, `skillAgent`, `scheduler`, `minebot/skillAgent`

### Phase 3 — 外部ツール RPC
- [ ] Twitter / Notion / YouTube ツール → 各 Client 直接呼び出し
- [ ] `TwitterClient.setupEventHandlers` 削除

### Phase 4 — Discord / Minebot / Minecraft
- [ ] `discord/client.ts` の subscribe 群（最大塊）
- [ ] `VoiceManager` / `VoiceProcessor`
- [ ] `SkillRegistrar` / `minebot/client` / `minecraft/client`

### Phase 5 — 残り + 削除
- [ ] `EventRouter` realtime コールバック（Hub 済みなら確認のみ）
- [ ] `AgentOrchestrator`, `scheduler`, `notion`, `xDispatcher` 等
- [ ] `eventBus.ts` / `index.ts` / `eventBus.test.ts` 削除
- [ ] knip / dead-code ゲート更新

## 完了条件

- `rg 'getEventBus|EventBus' backend/src` が **0件**（型定義 `eventMap.ts` はイベント名の型として残すか、`WebNotificationHub` 専用型へ移行）
- 全ユニットテスト通過
- `docs/architecture-current.md` から EventBus 記述削除
