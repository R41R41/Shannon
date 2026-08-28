# RF-03 第1段階：実行順序・中断・終了処理の責務分離

更新：2026-08-28。対象：Azure VM `/home/azureuser/Shannon-dev`。
状態：dev実装。prodへの反映、ライブBot接続、有料LLM評価は別工程。
最新の検証結果はNotion 08の14節とローカルの検証記録を参照する。

## 背景と対象

改修前のRequestExecutionCoordinatorに対し、VM devで次の2件の失敗を再現した。

- 通常処理Aを緊急処理Eが中断した後、Aの終了処理がEのAbortControllerを消してしまう。
- Aの終了だけを待っていた通常処理Bが、Eの実行中に開始してしまう。

さらに、coordinatorの中断シグナルが実際のgraph呼出に渡っていなかった。
今回の対象は、実行順序・中断ハンドルの所有者・完了後の送信判定の分離である。
会話・人格・記憶の状態分離や全RF-03の完了ではない。

## 責務と依存方向

`LLMService -> runCoordinatedGraph -> RequestExecutionCoordinator -> modules/execution`

- `modules/execution`：実行レーン、待機キュー、実行中の集合、現在の所有者を管理。中断操作は注入する。SDK、Node型、環境変数、logger、timerに依存しない。
- `RequestExecutionCoordinator`：NodeのAbortControllerと呼出元signalを接続するadapter。共通RequestEnvelopeからレーンを選ぶ。
- `runCoordinatedGraph`：graph実行からdispatchまでを同じレーンに保持し、中断後に返った古い結果のdispatchを拒否する。
- graph/FCA/ToolExecutor：signalを受け取り、エンジン起動、tool呼出、format/writeback等の境界で中断を確認する。
- ParallelExecutor：補助処理の失敗を早期に観測し、終了時にblackboardを完了、listener・timerを解放する。補助処理の停止待機は最大3秒。

## 順序と中断の契約

1. 通常処理は同一レーン内でFIFO。異なるレーンは独立して進む。
2. 通常の会話はchannelとthreadIdの組合せ、MinecraftはworldId/serverId/serverName/threadIdの順で空でない値を使用する。識別子欠落は拒否する。
3. 緊急処理は同じレーンの実行中処理へ中断を通知し、即時開始する。新しい所有者を登録してから古い処理を中断するため、同期abort listenerの再入にも耐える。
4. 中断済みの古い処理が終了しても、新しい実行のハンドルは削除しない。通常処理の再開は、緊急処理だけでなく古い処理の終了も待つ。
5. `self_mod_apply`は全体で直列化する。emergencyタグで並列化しない。
6. 呼出元の事前中断は拒否。待機中に中断された呼出は、実行枠が回ってきてもgraphを開始しない。
7. 中断を無視してgraphが成功を返した場合もdispatchしない。format後、memory writeback開始前にも確認する。

### 意図的な制限

- キュー待機中の中断は即時キュー削除ではない。前の処理が終わった時点で棄却される。
- 中断は協調的。すでに始まった送信、記憶書き込み、外部API、ゲーム操作を取り消す仕組みではない。signalを無視する処理は走り続け得る。
- 緊急処理は古い処理の終了を待たず開始する。中断を無視する古い処理がある間、後続の通常処理は安全側に待機するが、緊急処理との物理的な同時実行は残る。
- このレーンは認証や宛先の認可を代替しない。利用者が任意のthreadIdを指定して安全になるわけではない。
- 共有FCA、ツールのMemoryAgent/blackboard参照、モデル・feedback・TaskTree等の可変状態は今回まだ実行単位へ移していない。異なるレーンや緊急割込みの状態混線は残課題。
- backend全体の完全な型検査は既存負債として残る。対象module/adapterの型検査と全体のnoCheck変換を区別する。

## 検証

VM devのNode22 wrapperを使い、アプリ本体は起動しない。

```bash
bash scripts/with-dev-node.sh npm run check:foundation -w backend
bash scripts/with-dev-node.sh npm run check:access-integration -w backend
bash scripts/with-dev-node.sh npm run test:offline -w backend
bash scripts/with-dev-node.sh npm run test:auth -w frontend
bash scripts/with-dev-node.sh npm run build -w common
bash scripts/with-dev-node.sh npm run build:dev -w frontend
```

backend全体の変換はbackendディレクトリでNode22の`tsc --noCheck --skipLibCheck`。
テストは外部SDK/DB/認知サービスをmockし、実LangGraphのsignal伝播・writeback抑止も確認する。

- `requestExecutionCoordinator.test.ts`：競合2件、FIFO、複数割込み、同期abort再入、独立レーン、失敗後の回復、自己改変直列化、dispatch抑止。
- `graphCancellation.test.ts`：実LangGraphとmockエンジンを通した中断・書き戻し抑止。
- `parallelExecutionLifecycle.test.ts`：事前中断、正常終了、補助処理の失敗、停止待機timeoutの後始末。
- `toolExecutionAccess.test.ts`：signal伝播と中断後に残りのtoolを呼ばないこと。
- `accessFoundation.test.ts`：依存境界と自己改変の編集禁止範囲を拡張。

依存境界検査の対象にexecutionを追加し、strict TypeScriptをNode/SDK型なしで検査する。
実行管理・graph・ParallelExecutorも自己改変の編集禁止対象とする。これはOSのsandboxではない。

## 次段階・移行・復旧

次はFCAとtoolの可変状態を呼出単位のsessionへ移し、本人・会話・記憶範囲・宛先の契約を固定する。
2利用者・2会話の同時実行と緊急割込みをmockで交錯させ、feedback・memory・reply先が混ざらない受入試験を追加する。
公開chatの再開やlive Discord/Firebase試験は、これらの安全性と環境分離を確認した別工程で判断する。

今回DB/schema/envの変更なし。開発起動ロックは維持する。
前のdev基点は`b82ebf22`。復旧は対象コミットの差分をレビューしてrevertする方針で、prodへのコピー・hard resetは行わない。
GitHubへのpush、mainへのmerge、本番切替は未実施。全リファクタリング完了とリリース可否は別に判断する。

関連：`docs/development-workflow.md`、`docs/r0-release-readiness.md`。
Notion：https://www.notion.so/3ca1e84762888170816ee73f25c40ce3
