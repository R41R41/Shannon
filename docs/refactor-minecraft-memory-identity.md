# RF-03 第4段階：Minecraftの固定IDと旧記憶監査

2026-08-28。VM devの第3段階 `29633937` に続く実装。prod未反映、env・DB・Bot設定は変更しない。起動ロックを維持する。

## 問題と責務

固定IDを要求する共通MemoryPortに対して、Minebot adapterはserverNameしか渡さず、runtimeの自動生成envelopeは表示名をworldIdへ流用していた。明示IDが消えること、表示名変更でconversation/threadが変わることをVM devで修正前に再現した。

- `modules/memory/minecraftIdentity.ts`：SDK・環境変数非依存の接続設定の検証、dimension正規化、固定conversation/thread生成。
- `MinebotConfig`：環境設定を読み、指定した接続先と対応付けるadapter。接続前に検証する。
- `runtime/memoryContext.ts`：実際のbotオブジェクトに一度だけIDを結び付け、切断時に失効。可変serverNameから再推定しない。
- `MinebotTaskRuntime`：既存envelopeのID照合、キュー投入時のsnapshot、再開する履歴との照合、切断・dimension変更時の中断。
- `MinecraftRecentHistory`：game-chatの直近履歴をworld/dimensionごとに切り替え、Mod/Discord音声を混ぜない。
- `scripts/lib/memory-scope-audit.cjs`：旧記憶のメタデータだけを分類する、移行機能のない監査。

## 設定契約（未適用）

設定名は `MINECRAFT_MEMORY_IDENTITIES`。以下は書式例だけであり、実サーバーとの対応付けを確認済みという意味ではない。現在のenvには設定を追加していない。

```json
{
  "version": 1,
  "environment": "dev",
  "bindings": [
    {
      "name": "1.21.11-fabric-test",
      "host": "127.0.0.1",
      "port": 25567,
      "serverId": "operator-assigned-server",
      "worldId": "operator-assigned-world-generation"
    }
  ]
}
```

name/host/portは現在の接続設定との完全一致用。ID自体は運用者が割り当て、ホスト・ポート・表示名から生成しない。serverIdにはdev/prodの接頭辞を付け、同じIDを両環境に記述しても記憶scopeを分ける。**worldの再生成・別worldへの置換時はworldIdを更新する。** 同じIDの誤った再利用をMinecraftプロトコルから自動検出することはできない。

空の設定・対応なしは長期記憶停止。不正JSON、環境不一致、ID/endpoint/接続名の重複、ID欠落は接続前に拒否する。エラーに設定本文は含めない。dimensionは実botのgame.dimensionを読み、標準の短縮表記をnamespaced IDへ正規化する。不明ならoverworldを補わず停止する。

記憶scopeはserver/world/dimension。実行レーンはserver/worldであり、同じbotのdimension間の操作を並行化しない。会話IDは表示名と独立する。切断後の古いbotへ再bindできず、再接続では新しいbotオブジェクトを使用する。

## 呼出元・履歴・中断

game-chatとruntimeのsystem入力へ固定IDを配線。既存envelopeも現在のbot ID/dimension/canonical conversationと一致しない限り実行へ渡さない。呼出元のenvelopeは書き換えずコピーする。

キュー投入時に元worldを固定し、実行時に再確認する。待機タスクの旧本文・保存messages・task nodesを別world/dimensionへ向け直さない。scope不明の旧タスクやMod/音声タスクをgame-chatとして再開することも拒否する。拒否されたタスクは確認して破棄・新規作成する必要があり、自動移行はしない。

接続のend/kickedと、dimensionが変わるrespawnで実行のAbortSignalへ中断を通知し、終了時にlistenerを解放する。**中断は協調的であり、開始済みのDB/API/ゲーム操作を取り消すものではない。** すべてのツールの中断対応や出力先認可を完成させたわけではない。

Discord音声とMod入力は、物理botを操作するIDがあってもworldの共有記憶への保存を認めない。`metadata.memoryDisabled=true` を共通scope判定と非同期snapshotへ引き継ぎ、検索・保存・writebackを停止する。これらの入力をgame-chatのrecent historyへ追加しない。game-chatの履歴もdimension変更/固定ID不明時には引き継がない。Mod/音声の本人ID・公開範囲・宛先認可の再設計が必要。

## 旧記憶の監査

```bash
cd /home/azureuser/Shannon-dev
bash scripts/with-dev-node.sh node scripts/audit-dev-memory-scopes.cjs --dev-read-only
```

CLIはロックのある上記devパスと、loopbackの `shannon_dev` DBに限定。`--apply` や任意URIは受け付けない。アプリを起動せずnative Mongo driverで読むため、Mongoose modelの初期化・index作成・TTL変更・削除・移行を行わない。これはコードによる書き込み抑止であり、DB利用者の権限分離の完成を意味しない。

対象はshannonmemories/personmemories/memorywriteeventsの3コレクション。取得フィールドはscopeVersion/key/visibility/ownerのみ、_idも除外。本文・人物名・会話・埋め込み・job payloadを読まない。出力は件数と理由だけで、IDやscopeKeyを含めない。各10万件で上限を設け、超過時はcomplete=false。読み取り失敗を0件成功と扱わない。

判定は「旧scopeなし」「不正/非対応stamp」「構造上scopeあり・内容未レビュー」「人物の出典/audience要レビュー」「job envelope要レビュー」。人物記憶は新しいstampに見えても自動移行しない。自動移行候補は常に0件。分類は公開許可ではなく棚卸し。

実devの読み取りでは3コレクションとも0件（未作成の場合を含む）。空のdev DBでCLI接続と読み取りは確認したが、**旧本番データを分類・匿名化・移行できた証拠ではない**。過去の別mongodへの復元試験とも区別する。

## 人物記憶の復旧設計（未実装）

旧PersonMemoryはplatform/user単位で公開会話とDMを混ぜ得る。旧レコード全体に新scopeを一括付与して再公開しない。

1. 新しいscoped person repository/portを作り、認証済みplatform subject IDとscopeKeyを検索の必須条件にする。表示名・Minecraftの呼び名で同一人物に統合しない。
2. 旧コレクションのplatform/user一意制約を破壊する変更は避け、新コレクションの複合一意制約をdevで検証する。本人・audience・出典・版・訂正/撤回の記録を保持する。
3. レビュー可能な出典を持つ最小単位だけを候補とし、scope不明、DMと公開の混在、別guild混在は隔離のまま。移行planに件数・出典・対象scope・競合・plan hashを含める。
4. まず匿名化fixtureで同名別人、本人DM→公開、別guild、同時write、訂正/忘却を検証。旧人物データの復旧は、分類結果・影響・移行方法のレビュー後の別工程。

## 検証と未完了

外部をmockして実adapter/実MinebotTaskRuntime、registry、bot所有、queue/restart、dimension、history、memoryDisabledの非同期writeback、監査projection/上限/エラー/禁止引数を検証する。最終の件数・実行証跡はNotion 08の17節と `research/RF03_WORLD_IDENTITY_2026-08-28.md` に記録する。

core、記憶service/episode/旧MemoryNodeとID registry/config/adapterは通常型検査対象。巨大なclient/SkillAgent/MinebotTaskRuntimeを含むbackend全体はnoCheck変換のみで、完全型検査ではない。native importの成功も実ゲーム接続の成功ではない。

実world対応付け・Minecraft UUID等の本人確認、WorldKnowledge/routine/全checkpointerの範囲分離、全宛先認可、人物port、旧データの実分類、queueのlease/再試行/訂正忘却は残る。実world IDを設定する前にこれらの影響をレビューする。固定IDの配線完了をもってライブ記憶を再開しない。

## リリースと復旧

本番は読み取りのみ。Discord/Firebase/UID/費用枠・限定実機・機能制限・切替/復旧の条件を満たすまでライブロック維持。新しいenvの実値・Bot・DBは変更しない。GitHubへpushしない。

問題時は固定ID設定を無効にして記憶を止める。古い全件検索へ戻してデータを読ませない。scopeなし旧コードへ単純ロールバックすることは安全な復旧とは限らず、記憶停止またはscope境界を維持した版を使う。
