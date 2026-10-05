# Minebot：原因の切り分けとコードレベル改善案

Owner: Minecraft Shannon / Minebot。調査対象はユーザー承認済みの
`/home/azureuser/Shannon-dev`。本書は修正前の原因調査と提案の履歴。
その後のユーザー指示で中核修正を実装した。現状と検証は
[Minebotアーキテクチャ改善](minecraft-architecture-improvements.md)を参照する。
以下の旧計測・提案コードを現在のruntimeと混同しない。本番・通常DB・認証設定は変更していない。

## 結論

単にJevを速いモデルとして挿し込むだけでは解決しない。優先すべきは、
**正しい観測、判断ごとの確信度、完了の証拠、身体操作の単一所有者、緊急用の実行経路**。
その上に、依存関係を持つサブタスクと自己フィードバックを接続する。

以前の「Jevの判断品質が不十分」という表現は、モデルそのものの限界と、接続側の欠陥を
分ける必要がある。今回の単純な3状況では現行質問でも行動選択は全件正解。
過去の正常製錬での不要な提案について、モデル固有の原因まで確定したわけではない。

| 前回挙げた課題 | 今回の具体的な原因・不足 | 確度 |
| --- | --- | --- |
| 1. 高速判断の品質 | APIの判断ごとのconfidenceを捨てる。独立質問を一貫した評価のように扱う。観測と待機の表現も不完全 | 接続の欠陥は確定、過去の誤提案の単独原因は未確定 |
| 2. 自律計画・迂回 | 試験はスクリプトが手順を選択。タスクツリーは表示用CRUD寄りで、依存・証拠・再計画履歴がない | 実装・試験範囲の不足は確定。LLMの失敗率は未測定 |
| 3. 完了判定 | task-completeが無条件にcompletedへ移行。同じバッチの後続操作も走る | 実装を通した再現で確定 |
| 4. 身体操作の競合 | ConstantSkillはInstantSkillのリース外。CombatのtimeoutはPromiseだけを先に終了。高速反射は主に文章としてSystem 2へ渡す | 再現とソースで確定 |
| 5. 反応時間 | 危険変化を見る前に通常4秒の間隔制限。処理中に変化した最新状態を即再評価しない | 仮想時計による再現で確定 |
| 6. 実世界の信頼性 | 準備済みアリーナ・短時間・手順固定。試験botと通常botで観測の補助処理も違う | カバレッジ不足は確定。自然地形の成功率は不明 |

## 今回実施した検証

- 新規のcharacterization test **13件**。現在の問題挙動を期待値として再現するテスト。
  合格は「修正された」の意味ではない。実装時には安全な期待値へ反転する。
- 関連する既存テストと合わせて **6ファイル、60/60件合格**。
- Jev実API：3状況 × 4種類の入力／質問 × 3反復 = **36リクエスト**。
  専用Minebot資格情報だけを使用。API応答は`jev-1.13.0`。
  175–347ms、中央値197.5ms、p95（nearest rank）296ms。
  通信時間であり、危険発生から身体が動くまでの時間ではない。
  使用量は入力65,490／出力7,296 tokens。金額は未算出。
- 実Minecraft 1.21.11：水中・毒・夜・雨、炉へ投入中／閉じた後の比較を**2反復**。
  各反復で実際に原鉄3個を炉へ入れ、少なくとも鉄インゴット1個の生成を確認。
  今回は観測の診断であり、自然地形や自律的な攻略試験ではない。
- 使った10ファイル（中核7、診断3）のローカル／VMハッシュ一致を確認。
  診断テストはその後追加され、最終版もVMへ同期して実行した。

証拠は`backend/saves/minecraft/progressive_reports/`（ignored、ローカルへコピー済み）：

- `architecture-audit-regression-final-v2.json`：60件、成功。
- `architecture-audit-unit.json`：途中の10件版。最終版と混同しない。
- `architecture-audit-regression.json`：最初の関連試験は必須ダミーenv不足で1suiteの収集に失敗。
  runtimeの不具合ではない。ダミー設定を付けて再実行した。
- `architecture-audit-regression-final.json`：中間の修正版。
- `2026-09-29T13-12-38-901Z-critic-audit.json`／`-summary.json`：36件の入力・実応答。
- `2026-09-29T13-13-40-616Z-architecture-native.json`：ネイティブ状態と認知状態の比較。

診断ソース：`backend/tests/unit/minecraftArchitectureAudit.test.ts`、
`backend/scripts/minecraft-critic-audit.ts`、
`backend/scripts/minecraft-architecture-live-probe.ts`。
新規の全backend厳密型検査は実施していない。テスト実行をその代用とは扱わない。

再現テストの再実行（VM、外部API・DBを呼ばない）：

```bash
cd /home/azureuser/Shannon-dev
bash scripts/with-dev-node.sh bash -c '
  cd backend
  SHANNON_ISOLATED_MINEBOT_PROBE=true \
  OPENAI_API_KEY=offline-test-not-used \
  MONGODB_URI=mongodb://127.0.0.1:27017/shannon-offline-not-used \
  node ../node_modules/vitest/vitest.mjs run \
    tests/unit/minecraftArchitectureAudit.test.ts \
    tests/unit/minecraftTaskWorkspace.test.ts \
    tests/unit/minecraftJevExecutionCritic.test.ts \
    tests/unit/minecraftJevReflexPolicy.test.ts \
    tests/unit/minecraftActionExecution.test.ts \
    tests/unit/minecraftExecutorSupervision.test.ts \
    --maxWorkers=1 --minWorkers=1
'
```

Jev診断は同じwrapper内のbackendで
`TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm scripts/minecraft-critic-audit.ts`。
デフォルト36回、`MINECRAFT_CRITIC_AUDIT_REPEATS=1`なら12回。最初のHTTP／timeoutエラーで止め、
無制限retryはしない。各variantの比較は試験用payloadだけを変え、runtime実装は変えない。

実ゲーム診断は[minecraft-test-lab.md](minecraft-test-lab.md)の隔離lab運用に従い、
空いているloopback portで`scripts/minecraft-isolated-lab.mjs`を実行しreadyを確認してから、
上記ダミーenv付きで`TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm scripts/minecraft-architecture-live-probe.ts`。
既存の共有worldへ接続しない。終了後は該当labだけをMinecraftの`stop`で保存終了する。

## 1. 判断品質：先に観測とAPIアダプターを直す

### 1A. 誤った観測を「確実な事実」として送る

対象：`cognition/worldFrame.ts:53–105`。

- 水中判定は`bot.isInWater`を読むが、ネイティブの値は`bot.entity.isInWater`。
  リポジトリ内に前者へ値を転記する経路も見当たらない。
  実ゲーム2/2で、水中=trueなのに認知ではfalseになった。
- 炉の窓が開いても`bot.inventory.items()`を読む。
  実ゲーム2/2で、炉へ移した原鉄3＋石炭1が所持品に残って見えた。
  サーバーOracleで原鉄所持数0を確認。窓を閉じると認知の所持品も0へ更新された。
- `activeEffects`と`environmentState`は独自の補助キャッシュに依存。
  probeでは毒が[]、夜／雨が空文字。**通常botには**
  `events/BotEventHandler.ts:377`の効果イベント橋渡しと、
  `constantSkills/autoUpdateState.ts`の環境更新がある。
  したがって「本番でも毒・天候が常に見えない」とは結論しない。
  ただしcache更新済みか／いつの値かを観測側は示せず、probeとの同等性もない。
- nearest-16を全entityから切り出してから敵を抽出する。
  アイテム16個の向こう2mにいるゾンビが観測から消えるケースを再現。
  試験の敵が少ない時には表面化しない。

改善案：`WorldObservationAdapter`を追加し、`captureWorldObservation`から呼ぶ。

```ts
type Fact<T> = {
  value: T | null;
  observedAt: number;
  source: 'native' | 'window' | 'derived' | 'cache';
  coverage: 'known' | 'partial' | 'unknown';
};
```

1. 水中・効果・時刻・雨はネイティブ情報を優先。効果IDはそのバージョンのregistryで名前へ。
   補助cacheは互換用fallbackとして保持し、空文字をknownにしない。
2. 窓がある間のプレイヤー所持品は`currentWindow.slots.slice(inventoryStart, inventoryEnd)`。
   containerの物をプレイヤー所持品に混ぜない。各slotイベントでrevisionを更新する。
3. 炉のinput/output/fuel slotと、燃焼残量・progressを別の観測へ。
   **fuel slotが空でも既に消費した燃料で燃焼中**になれるため、slotだけで燃料切れとしない。
4. `nearbyThreats`は敵専用に抽出し、一般entity枠とは分離。観測範囲・未ロードを明示。
5. probeも同じadapterを使う。通常イベントhandlerを起動しなくても中核観測は成立する設計へ。

合格条件：今回の13件のうち観測2件を安全な期待値へ反転し、同じ実ゲーム比較を3回再試験。
炉input3を「所持raw3」と数えない、水中／効果を取りこぼさない、crowdで敵を消さない。
窓を閉じても二重計数せず、通常botの既存表示・効果通知は維持する。

### 1B. 本物のconfidenceではなく「自己申告ラベル」で操作を許可

対象：`JevExecutionCritic.ts:282–297,365`、`JevReflexPolicy.ts:224以降`、
`ExecutionSupervisor.ts:74`。

`choiceValue()`は`choice`だけを読む。APIにある各回答の`probabilities`／`confidence`を捨て、
別質問のHIGH／MEDIUM／LOWを0.9／0.66／0.33へ変換している。
MEDIUM=0.66は現在の制御許可の閾値と等しいので操作可能になる。

再現テストでは、操作回答の実confidence=0.02でも、自己申告MEDIUMでSWITCH_SUBTASKが
feedbackへ通ることを確認。実APIの現行方式では、通路閉塞のcontrol confidenceが
0.37–0.39なのに自己申告は3/3でHIGH。正常製錬でも0.45–0.57なのにHIGH。
**「HIGHだから90%正しい」ではない。**
[TypeSafe公式：confidence](https://docs.typesafe.ai/confidence)は分布由来の値を提供し、
用途・リスクに応じた閾値の評価を求めている。

改善案：`parseChoiceAnswer<T>()`を共通化し、分布・選択肢・有限範囲を検証。
`CriticAssessment`／`ReflexDecision`へ以下を持たせる。

```ts
type DecisionEvidence<T extends string> = {
  choice: T;
  probabilities: Record<T, number>;
  providerConfidence: number;
  assessedAt: number;
  observedFactsDigest: string;
};
```

- 操作可否は**その操作回答**の分布、実際のvalidation setでの精度、freshnessで判定。
  self-reported labelは診断用途のみ。confidence自体も正答率と同一視しない。
- JevとOpenAIの数値は別の意味を持つ。共通provider interfaceは保つが、校正を混ぜない。
- OBSERVEと操作中断を同じ単一閾値にしない。具体値はheld-out試験後に決める。
  閾値を引き上げるだけを恒久修正とはしない。

合格条件：flat分布＋HIGHで操作しない、不正分布・不足fieldは非制御扱い、
正常系で必要な介入を抑え過ぎていないことを別途検証。

### 1C. 独立質問とpendingの意味

質問は7個あるが、互いの回答を読んで推論しているわけではない。
正常待ちについての詳しい注意書きはprogress／continueの一部にあり、
next_controlは一般的な「最も有用な制御」、failure_causeは短い原因名の説明になっている。
これを一つの整合した判断のように解釈するのが接続上の問題。
[TypeSafe公式：Introduction](https://docs.typesafe.ai/introduction)でも質問は同じstateに対して
独立に評価されると説明されている。

また`ActionReceipt.success=false, failureType=waiting_external`は正常なpendingまで失敗に見せる。
fallbackの`failures`集計もsuccess=falseで数える。現在はfallbackが操作しないため直接暴走はしないが、
評価・再計画の情報としては紛らわしい。

改善案：

- receiptに`outcome: succeeded | pending_external | blocked | failed | cancelled | partial`を追加。
  既存successは互換用に保持。失敗率やretry回数ではpendingを数えない。
- 制御用質問は現在のactionだけに焦点を当て、健康・脅威・進捗の証拠、正常待ち、
  不明な場合のOBSERVEを同じ質問内で明示。
  説明用causeは別にして、causeの推測から機械的に操作を生成しない。
- 現在の質問セットを一度に全廃する必要はない。診断headsを残し、操作に使うheadを限定する。
- `previous_assessment`は観測事実ではない。診断履歴として区別し、誤った評価の自己増幅を測る。

今回の4方式：現行、pending表現だけ変更、制御質問だけ焦点化、両方。
3状況とも全方式3/3で正しいcontrol。**正答率改善は立証していない**。
通路閉塞の実confidenceは現行0.37–0.39に対し焦点化0.96–0.97。
これはrubric変更による分布の変化であり、一般精度や安全性の証明ではない。
危険＋通路閉塞の複合fixtureでは現行causeはBLOCKED_PATHのまま、controlはABORT_UNSAFE。
複合原因を一つに押し込める設計も再検討する。

過去の6件で見たON_TRACK＋WRONG_ASSUMPTION／不要なOBSERVEは、今回の簡単なfixtureでは
再現しなかった。歴史的リクエスト本文は保存されていないため、完全な同一入力replayではない。
今後は秘密なしのstate・question version・実model versionを保存し、失敗fixtureそのものを評価へ戻す。

## 2. 自律計画・迂回：表示ツリーを実行上の契約へ

対象：`ShannonExecutor.ts:187`、`:392–413`、
`cognition/types.ts:GoalNodeProjection`、`TaskWorkspace.ts:projectPlan`、
`execution/backgroundJobs.ts`。

現状にも「外部仕事中に独立準備を選べる」というpromptと、LLMがサブタスクを更新する機能はある。
しかし`blockedBy`は自由記述で、入力／出力の依存、素材の予約、retryの証拠差、
切り替える候補と理由の構造がない。CRUDは重複IDを許し、存在しないparentをrootへ置き、
LLMがノードをcompletedへ変更できる。3つを実executorで再現した。

以前のproduction／smelt_overlap試験は`await t.skill(...)`でコードが道具作成や待ちの間の作業を選択。
「System 2が自分で失敗を検知して別ルートを見つけた」証拠ではない。
これはまず試験範囲の不足で、モデルが自律的に全て失敗するという結論ではない。

改善案：`planning/GoalGraph.ts`、`planning/ReadyTaskProjection.ts`、
`planning/PlanRevision.ts`を追加。TaskWorkspaceは今のrun-scoped構造を再利用。

```ts
type GoalNode = {
  id: string;
  parentId: string | null;
  requires: string[];
  postconditions: GoalPredicate[];
  state: 'ready' | 'running' | 'pending_external' | 'blocked' | 'verified' | 'failed';
  blocker: { kind: string; evidenceRefs: string[]; observedAt: number } | null;
  attempt: { count: number; lastFailureFingerprint: string | null };
};
```

1. LLMは分解・代替route・候補選択を担当。コードはID、DAG、素材の競合、
   capabilityの存在、postconditionの照合などの実行契約を検証する。
   「鉄が足りなければ必ずA」のようなMinecraft戦略の固定木は増やさない。
2. pending炉を待つnodeと、依存しない準備nodeを明示。残素材を重複して使わせない。
   準備の候補が無ければ待つことも正当な選択として表現する。
3. 再計画は`fromPlanVersion/toPlanVersion`, trigger, observed blocker, discarded route,
   replacement, preserved effectsを記録。古いtool batchを止める既存機能を維持する。
4. 同じ失敗をretryする時は「前回と変わった観測／引数」の証拠を要求。
   絶対に再試行しない規則ではなく、変化があれば同じ経路を再候補にできる。
5. 既存MAX_ITERATIONSのユーザー続行確認は維持。
   自律継続には別途run予算・期限・ユーザー選択を設け、勝手に無限ループへしない。

合格条件：重複ID／欠落parent／循環を拒否し理由を返す。中断前のverified成果を維持。
実executorに**ゴールだけ**を渡す試験で、道具不足→準備→採掘、途中閉塞→迂回、
燃料不足→追加調達、正常製錬→独立準備を、介入を毎回異なるタイミングで入れて確認。
偽plannerによるprotocol試験と、本物plannerのゲーム試験は別集計にする。

## 3. 完了判定：宣言を検証要求として扱う

対象：`ShannonExecutor.ts:550–567`、`:881`。

空の所持品、pendingの鉄収集node、世界観測なしでも「鉄つるはし完成」でcompletedになった。
task-complete→place-block-atの同一応答では、完了表示後にもplaceが実行された。
同じ無条件完了のコードはprodにも残っていることを読み取り確認。
なお`iterations: MAX_ITERATIONS`は1iterationの実行でも30を返す。これは計測の別欠陥で、
過去のskill duration計測を無効にするものではない。

改善案：`planning/GoalContract.ts`、`testing`ではない通常用`verification/GoalVerifier.ts`を追加。

```ts
type GoalPredicate =
  | { kind: 'inventory_at_least'; item: string; count: number }
  | { kind: 'produced_item'; item: string; count: number; sinceReceipt: string }
  | { kind: 'block_matches'; dimension: string; position: [number, number, number]; block: string }
  | { kind: 'target_defeated'; entityId: number; encounterId: string };
type GoalVerdict =
  | { status: 'verified'; evidenceRefs: string[] }
  | { status: 'mismatch'; unmet: GoalPredicate[] }
  | { status: 'unknown'; observationsNeeded: string[] };
```

- 開始時に原依頼を保存し、LLMが検証可能なpostconditionsを提案。依頼との対応を維持。
  「鉄を掘る」と「鉄インゴットを持つ」、「敵を倒す」と「安全に逃げる」を混同しない。
- task-completeは`verify(contract, freshObservation, receipts)`を呼ぶだけ。
  mismatchは不足をtool resultとして返して継続。unknownは観測／人の確認へ。
  自由度の高い依頼も扱えるようにし、曖昧なゴールの機能を削除して済ませない。
- 実行完了は現在の在庫だけでなく、必要なら生成／設置のreceiptと結果を確認。
  「鉄3個を取り出してつるはし作成」では、クラフト後に鉄3個が残ることを要求しない。
  履歴のverified postconditionと最終の所持条件を区別する。
- verified後の残りtoolは「未実行：タスク完了」で結果を返し、物理操作を行わない。
  既存のAnthropic tool_use／tool_resultの順序は維持。
- iteration実数を加算して返す。capと実数は別field。
- 通常運用のVerifierはOPコマンドを前提としない。
  ネイティブslot／block／craft／対象entity evidenceで判定し、
  試験だけ外部のMinecraftCommandOracleで照合する。
  他の敵の死を全て自分の撃破として数えず、帰属が不明ならunknown。

合格条件：虚偽完了を拒否、既存品を「新しく作った」と誤認しない、部分成功を保持、
死後のrespawn／逃走を撃破達成にしない、完了後の追加操作0件、1iterationは1と報告。

## 4. 身体操作・高速反射：一つの所有権と実行口へ

対象：`types/skills.ts:30–85`、`constantSkills/autoEat.ts:79–128`、
`types/collections.ts:ConstantSkills`、`CombatController.ts:129`、
`eventReaction/EventReactionSystem.ts:468–515,615以降`、`JevReflexPolicy.ts:capabilityForAction`。

- AutoEatはcontainMovement=falseで、InstantSkill中のチェックが適用されない。
  実際の`AutoEat.run()`が採掘リース保持中にequip(bread,'hand')／consumeする再現に成功。
- Combatは4秒のPromise.raceで待ちを終了してcleanupするが、実行bodyをabortしない。
  実controllerへ4.5秒後に書き込むexecutorを注入し、戦闘終了後の遅い書き込みを再現。
  これは実ゲームで必ず毎回発生するという主張ではなく、制御上防げないことの証明。
  tower等の実装にもawait後の身体操作があり、単に例外をcatchしても止められない。
- ConstantSkillsのqueue timeoutにも同じraceがあり、clearQueueは実行bodyを止めず
  isProcessingを解除する。ここはソース確認で、独立した実ゲーム発生率は未計測。
- EventReactionSystemは従来の継続逃走を先に開始し、Jev判断は主に緊急タスク文へ追記。
  ジェネリックな「Jevが選んだreflexを直ちに実行する」経路ではない。
- SURFACE／SEEK_SHELTERにはcapability対応がなく、未対応=availableと扱われる。
  空のcapability一覧でも両方trueになるテストを追加。
- 初期reflexはinterruptの待ちの後に利用するが、action/worldのgeneration・TTLを持たない。
  実行中supervisor側のfreshnessとは別の穴。

改善案：既存`ActionExecution`／`SkillExecutor`を拡張し、
`ActionCoordinator`、`MotorPort`、`ReflexActionCatalog`を追加する。

1. movement/look/hand/windowの所有権をInstant／Constant／Combat／継続逃走で共有。
   containMovementだけで判断せず、食事はhand、盾はhand/lookと宣言する。
2. emergencyはpriority付きで旧actionをabort。通常はbodyのquiescenceまで待って引き継ぐ。
   handshakeと、abort後のMotorPort generation検査で遅い書き込みを防ぐ。
   古いbodyが遅い場合の封じ込めは別状態として記録し、未停止のまま所有権だけ解放しない。
3. 常時の溺死防止・食事・盾・安全な逃走を無効化しない。
   既存の即時安全行動もcatalog内のfallback候補にして、Jev障害で生存性を失わない。
4. Combatのaction deadlineはlinked AbortSignalでbodyへ伝播。
   await後／callbackのMotorPort呼び出し前にtoken検査。
   Native pathfinder/pluginも停止・callback解除・quiescenceを検証して移行する。
5. ReflexActionCatalogは全reflexに能力・必要資源・パラメータ組立・可用性・期限を明示。
   SURFACEを実装へ正しく接続できない場合は未対応扱いでSystem 2へ委譲。
6. Jevは**実行可能な候補から**状況に合うreflexを選ぶ。
   座標・プロトコル・食料の存在などはadapter／catalogで検証する。
   直接のMinecraftコマンドや自由生成コードは実行しない。
7. reflexにもrun/session/action generation、critical-fact digest、採用期限を付ける。
   staleなら最新状態を再評価し、古いEAT／FLEEをそのまま採用しない。

合格条件：採掘＋食事＋敵接近＋水中の競合を組み合わせ、物理資源の同時writer0、
終了後writer0、必要な生存操作は継続、復帰後の残タスク成功を確認。
命令の削除／生存スキル停止を修正の完了条件にはしない。

## 5. 反応時間：通常監視と危険変化を別の予算にする

対象：`ExecutionSupervisor.ts:30–90`、`TaskWorkspace.ts:observeWorld/recordAssessment`。

仮想時計で、初回評価100ms後のHP20→2が、次の4000msのtickまで評価されないことを再現。
間隔制限がcriticalFacts計算より前にあるため、危険変化も同じ制限になる。
リクエスト中の変化は古い結果を拒否するが、latest-state再評価を直ちにqueueしない。
同一内容のobserveでもrevisionが増え、実質変化のない再観測で結果をstaleにする。

なお従来の逃走・autoSwim等には別経路がある。
この4秒は「全ての緊急行動が4秒止まる」という意味ではなく、**supervisorのモデル評価経路**の遅れ。
通常の500ms sampling、敵接近500ms、環境1s、逃走300ms、System 2のplanningも別の時間。

改善案：

- `requestAssessment(trigger: normal_progress | blocker_changed | critical_changed)`を追加。
  通常監視は現行の節約予算を保持。危険の事実変化は別の短いdebounce／token budgetへ。
  危険かどうかの戦略評価はモデル。コードは「値が変わった」通知と計算予算を担当。
- health、entity threat、oxygen、水中、効果のeventでenqueueし、500ms pollは取りこぼしの補助。
- 常にin-flight最大1を基本とし、処理中の新情報はlatest pendingとしてcoalesce。
  stale rejectionの後は最新状態を即dispatchする。古いrequestの結果で上書きしない。
  APIの429／timeoutは有限backoffと予算で扱い、無限再試行しない。
- 観測ログのsequenceは毎回増やせるが、contentRevision／criticalRevision／progressRevisionを分離。
  無関係の再観測ではcritical判定を破棄せず、危険内容が変わったら必ず破棄。
- supervisor instanceをskillごとに作り直す方式から、run単位の監視へ段階移行し、
  ownership actionIdへbind。skill開始でbudgetをresetしてAPI連打するのを防ぐ。
- `detectedAt/enqueuedAt/requestedAt/responseAt/adoptedAt/motorStartedAt/effectObservedAt`を記録。
  queue、通信、引継ぎ、物理効果を分離して集計。

合格条件：危険変化が通常4秒budgetに抑制されない、処理中の変化が再評価される、
同一観測で誤ったstaleにならない、request stormなし、旧generationの操作0。
検出→dispatch100ms以内、検出→採用済みmotor開始p95 600msを**初期目標**にするが、
ネットワーク・quiescenceを含む実測で合否を決める。0.1秒達成を現時点で約束しない。

## 6. 信頼性の試験：ゴールだけを渡す自然環境の試験を追加

対象：`scripts/minecraft-progressive-live-probe.ts`、
`scripts/minecraft-execution-live-probe.ts`、`testing/MinecraftProbeBot.ts`。

今までの試験は実Mineflayerと物理効果を使っており、価値はある。
しかし平坦地形へ対象・障害・敵・成長を用意し、スクリプトが実行順を選ぶ。
この成功件数を「自然ワールドの自律適応成功率」と呼ぶことはできない。
probeと通常botの観測補助処理も違い、危険入力の同等性を確認していなかった。

改善案：`testing/AutonomousScenarioRunner.ts`と`testing/InterventionSchedule.ts`を追加。

- native executorへgoal＋制約だけ渡す。runnerはsetup／外部oracle／状況への介入のみ担当。
  先回りして次のskillを選ばない。production脚本はスキル回帰用に残す。
- 固定seedの自然生成ワールドを使い、木／鉱石位置は攻略側へ渡さない。
  崖、水流、洞窟、未ロードchunk、夜雨、複数敵を段階化する。
- 介入：ルート閉塞、燃料枯渇、道具破損、満杯所持品、別プレイヤーの移動、
  作業途中の敵／水中、30iteration境界、disconnect/reconnect。
- 準備済み炉・骨粉による成熟・OP状態などの便宜はmanifestで明示。
  普段権限のないbotがOPに頼って合格しないよう、setup用主体と攻略botを分ける。
- skill／planner／critic／motor／oracleを独立採点。
  偽成功、不要中断、必要介入の見逃し、同じ失敗の再試行、復帰成功、死亡、
  避けられる停滞、ゲーム仕様の待ちを別に数える。
- latency比較は同一source／seed／初期状態で直列に行う。成功したtrialだけ選び直さない。
  まず3seed×3反復のpilot、次に未使用seedを含む10seed以上、30–60分の長期run。
  複数seedでも件数が少なければ保証とは呼ばない。
- traceに操作／モデル版／観測根拠を残し、失敗を再現fixtureへ昇格。
  OpenAI-docsスキルの[公式agent evals](https://developers.openai.com/api/docs/guides/agent-evals)
  を参照し、回答単体だけでなく操作・引継ぎ・完了までを分けて評価する方針にした。
  OpenAIのSDKやサービスへの移行を要求するものではない。

合格条件：6節の難易度を段階的に上げ、同じ改善対象を少なくとも3回再試験。
false completion0、death0を最初のpilot gateとし、失敗時は原因・復帰を残す。
難しいタスクを削る／敵を消して成功にする／死亡後に初期状態を戻して同じ成功として数えることはしない。

## 実装順序と判断の境界

1. **観測adapter＋Jevのconfidenceアダプター＋実数iteration**。
   狭い修正で誤った入力と計測を直し、API shadow評価を再実行。
2. **GoalContract／GoalVerifier＋完了後batch fence**。
   失敗や部分成果の意味を固定し、偽成功を止める。
3. **ActionCoordinator＋Constant／Combatの移行**。
   生存機能を保ちながら競合をなくす。ここまでは偽policyで決定論的に検証。
4. **緊急event lane＋freshness＋ReflexActionCatalog**。
   本物Jevはshadowから。held-out危険ケースに合格してから明示feedbackで直接反射を検証。
5. **GoalGraph／再計画記録＋AutonomousScenarioRunner**。
   ゴールだけの実ゲームで、待機／迂回／復帰を測る。

全体を書き直す必要はない。TaskWorkspace、ActionExecution、event-driven回収、
background jobs、旧batchの無効化、既存skill catalogは再利用する。
汎用性はモデルによる判断と差し替え可能な観測／能力契約で確保し、
速度はイベント・絞った状態・短い実行可能候補・余計な再計画の削減で確保する。

本物System 2モデルによる新規の自律ゲーム試験は今回は行っていない。
共有のOpenAI／Anthropic認証情報を通常runtimeから流用して起動することはしない。
隔離planner経路・専用資格情報・費用上限を用意してから実施する。
モデル変更の推奨も、その試験なしには確定しない。

## 運用・保全・知識返却

- 今回の隔離lab：`/home/azureuser/minecraft/progressive-lab-rzimIv`、loopback25577。
  試験終了後に`stop`、全dimension保存、tmux終了、port閉鎖を確認。worldは削除していない。
- prod HEADは`5412c1f1c0ae6b121cba65898cd8c702c3d3e2a9`でclean、変更／再起動なし。
  devの他タスク変更は維持。通常Shannonサービスは今回起動していない。
- 古い運用docは`.dev-runtime-lock`ありとしているが、今回のVM確認ではそのファイルは
  root／直下サブディレクトリには無かった。原因・他タスクによる変更は不明。
  これを起動許可と解釈せず、ロックの新設／削除や通常runtime起動はしていない。
- Notion資料hubは指定の接続でも404。同期したとは報告せず、本書へ保持。
- shared Syzygy hub／Apple Shannon repo／Aether／Voyagerのデータは変更していない。

TI-KNOWLEDGE-MINEBOT-ARCHITECTURE-AUDIT（owner: Minecraft Shannon）:
Jevの実confidence破棄、native/window観測差、無条件完了、Constant／Combatの所有権外操作、
通常4秒budgetによるcritical評価抑制を再現。恒久修正は機能を残して契約を統一すること。
証拠は上記の13再現＋60回帰＋36API＋2実ゲーム比較。
共有hubへの昇格時にはApple repo mappingとlegacy Minebot VMの対象を混同しない。
