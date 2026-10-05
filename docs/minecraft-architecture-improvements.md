# Minebot：観測・自己評価・完了証明・身体所有権の改善

Owner: Minecraft Shannon / Minebot。対象はユーザー承認済みの
`/home/azureuser/Shannon-dev`。本頁の2026-09-29試験時点では本番未反映。2026-09-30の追加実装・
本番反映の承認と実績は[minecraft-production-release.md](minecraft-production-release.md)を正とする。試験では通常backend、Discord、MongoDBを起動せず、
Minecraft 1.21.11の隔離lab（loopback 25577）で検証する。

## 判断と実行の責務

旧Blackboardの重い並列Agent群は復活させない。run-scopedな`TaskWorkspace`に、観測、
実行証跡、依存関係、評価、完了証明を集約する。System 2は目標の解釈と手順・迂回路を選び、
Jev/System 1は選択肢の限られた途中評価・反射を担当する。

- 観測: `cognition/worldFrame.ts`。ネイティブの水中、効果、時刻、雨を優先し、独自cacheは
  fallbackとして保持。窓のプレイヤー領域と炉のinput/output/fuel/progressを分離する。
  敵の観測枠を一般entity枠から分け、観測のsource/coverageを明示する。
- 評価: `JevExecutionCritic.ts` / `JevReflexPolicy.ts` / `decisionEvidence.ts`。
  Jevの実際の`next_control` / `immediate_action`のconfidenceと選択分布を保持する。
  自己申告のHIGHやflatな分布だけでは制御しない。不正な選択肢・非有限値・不整合分布は拒否する。
  精錬の`pending_external`は失敗と区別する。SWITCHは具体的なready代替がある場合、
  REPLANはその代替がなく計画変更が必要な場合に分ける。
- 途中評価: `ExecutionSupervisor.ts`。native event＋500msの補助観測。
  通常評価の4秒budgetはworkspace内でツールを跨いで共有する。
  状態変化は通常cooldownより前に検知し、100msのdebounceで最新状態へ集約する。
  一度に1リクエスト。回答中に重要な状態が変われば旧回答を適用せず再評価する。
  action/session、revision、進捗、重要事実、回答の期限を検証する。
  `detected/requested/received/applied/rejected`を記録する。
- 身体: `ActionExecution.ts` / `SkillExecutor.ts` / `types/skills.ts`。
  Instant、Constant、Combat、緊急逃走がbot別の身体leaseを共有する。
  キャンセルのPromiseが返ってもbodyの実終了までleaseを保持する。
  子のsignalと期限を親へリンクし、captured motor portはawait後・native event内でも
  期限切れ所有者の書き込みを拒否する。内部の建築サブスキル呼出しも保護を通す。
- 反射: `DirectReflexExecutor.ts`。Jevの検証済み分布、利用可能性、期限1500ms、重要事実が
  一致した場合だけ、引数を生成せずEAT / SURFACE / STOP_MOVEMENTを実行する。
  FLEEは既存の複数脅威を扱うowned containmentを使用する。
  shelter primitiveは未実装なのでSystem 2へ委譲する。API failureはbotを制御しない。
  既存の生存用Constantとcontainmentは維持し、モデルだけに生存を依存させない。
- 完了: `GoalVerifier.ts`と`ShannonExecutor.ts`。物理作業前に固定の`GoalContract`を設定する。
  emergencyは契約設定待ちで救命を遅らせないが、完了には証明が必要。
  freshな所持数、開始時からの増分、block、到達位置、攻撃対象の死亡観測を検証する。
  不明・未ロード・開始所持数不明は成功ではない。`task-complete`の発言だけでは終了せず、
  検証済み完了後の同じバッチの残りも実行しない。
- GoalGraph: `applyTaskTreeOperations`。操作batchをatomicに検証し、重複ID、missing parent、
  missing dependency、cycle、不正status、未証明completedを拒否する。
  dependencyが証明済みのready leafをplannerへ提示し、receiptをactive subtaskに結びつける。
  再計画履歴は16版保持する。生成後に消費した前提素材の証明を消さない。
- 記憶: motor portは新しいbot/world identityではない。`memoryContext.ts`でnative identityへ
  解決し、従来のserver/world scopeとrevocation fenceを維持する。

これは「コードによる状況判断をすべてモデルへ置換した」という意味ではない。
コードは権限・期限・身体所有権・観測証明・最低限の生存を担当する。
意味のある状況評価や計画変更の選択はモデルが担当し、速度と安全性を両立させる。

## 維持した機能と設定

自動追従は10秒で切らずpersistentのまま、救命中断後に対象名を保持して再開する。
Constantは身体所有権を取得しても旧Instant実行フラグで自分を抑制しない。
queue clearは実際のcurrent actionを中断し、bodyが残っているのにidleへ戻さない。
Combatの盾・距離制御・死亡観測、採掘・農業・クラフト・炉処理は維持する。
緊急containmentはmemory/query中には手放さず、実際の物理操作開始時に引き渡す。

2026-09-30のmain plannerはAnthropic/OpenAI Responsesを交換可能にした。同じExecutorを使い、
OpenAI-only本番でも完了証明・身体所有・途中評価に接続される。OpenAI/Lunaの自己申告confidenceは
Jev provider distributionと別物として記録する。新しいdirect reflexはJevの分布を必要とする。
`MINECRAFT_COGNITION_MODE` / supervisionの既定off・shadow・feedback境界は維持し、
隔離試験は通常サービス・共有資格情報を変更しない。本番設定の変更範囲は本番リリース文書に限定する。

## 検証と証拠

証拠は`backend/saves/minecraft/progressive_reports/`（ignored）。ログ、実応答、サーバーOracle、
source hashesをセットで保存する。途中版の成功と最終コードの成功を混ぜない。

### 最終検証の結果

| 検証 | 結果・証拠 |
| --- | --- |
| 関連unit 14ファイル | **161/161件**。`architecture-improvement-unit-final-v3.json`。内部子deadline・未知baseline・隔離planner dispatchも含む |
| strict cognition/execution core | 合格。`architecture-improvement-core-typecheck-final.log`（exit 0） |
| backend全体のnoCheck | 合格。`architecture-improvement-backend-nocheck-final.log`（exit 0）。厳密型検査ではない |
| backend全体のstrict | 4GB heap・120秒の上限でtimeout（exit 124）。完了しておらず合格と扱わない |
| 旧critical fixture 3反復 | 旧判定3/3、死亡0。health→中断適用409/398/386ms、body終了410/398/386ms。`2026-09-29T14-23-27-358Z-critical-feedback.json`。後日の調査でgamerule名が誤りと判明。自然回復を無効化できた固定体力試験とは扱わない |
| 状態が連続変化するcritical trial | 804ms、中断・死亡0。敵追加と自然回復で2回答を破棄。体力固定のOracle違反でcampaign失敗。`2026-09-29T14-17-01-614Z-critical-feedback.json`。削除・成功扱いしない |
| tier3 production/farming/combat | **3/3、死亡0**。`2026-09-29T14-11-13-165Z-summary.json`。準備・Oracle含め約155秒/118秒/44秒。戦闘本体18.7秒 |
| 最終Executor protocol fixture | **3/3**。`2026-09-29T14-24-14-004Z-autonomous-runner.json`。実採掘、fresh native完了証明、後続設置0件を外部Oracleでも確認。provider calls 0、自律quality未評価 |
| Constant/建築の対象回帰 | 6/6表示だが、そのうち初期auto-swimは酸素十分で1msのno-op。浮上成功の証拠には使わない。食事・追従・回収・視線・ゲート建築は既存Oracle条件で合格。`architecture-improvement-practical-final.log` |
| 強化した実浮上試験 | **3/3**。酸素5/20→水面へ到達→20/20、HP18以上を確認。処理4,237/4,254/4,261ms。`architecture-improvement-swim-final-v2.log` |

tier3のsource fingerprintは`9d78c3c15383e3f179a211c788478dc9e5a1b0057af80bcdfc374c3f66b3b31c`。
このcampaign後に内部建築呼出しのfence、未知baseline、telemetryの時刻固定、隔離planner catalogを
追加補修した。したがってそのfingerprintを最終全ソースのhashとは呼ばない。補修後に161 unit、
core typecheck、critical 3反復、Executor protocol試験、対象Constant/建築回帰を実施した。

反応速度は0.1秒達成と結論しない。固定fixtureの3試行では600ms未満だが、連続変化では804msがあり、
広い分布のp95を保証できない。回復が成功なのに「HPを固定したまま」というfixture条件へ違反する例は、
目的別の合否を分離し、速度の外れ値も保持する。旧manifestの`natural_regeneration=false`は意図の
記録で、コマンド成功の証明ではなかった。実1.21.11の補完で正名`minecraft:natural_health_regeneration`
を確認し、Oracleでfalseを確認してから再試験した結果は本番リリース文書へ記録する。
自然戦闘campaignではこの無効化を使用していない。

変更対象と関連回帰を含む44ファイルのローカル/VM SHA-256一致を確認した。
最終source snapshotは`architecture-improvements-final-source.tar`、SHA-256:
`b297007cd90bb7b70881bcc05301035f8dc9c526495129566208afcfe3837be3`。
このsnapshotは中核変更と回帰テストのbundleであり、リポジトリ全体や資格情報のarchiveではない。
強化した水中fixtureを加えた最終45ファイルbundleは`architecture-improvements-final-source-v2.tar`、
SHA-256 `3c53e7ab2601c810d2d0df053c3c247f61e3b7cfb6c57897b40fbb74c84af0ae`。
fixture自体もローカル/VM一致を確認した。

水中fixtureの穴も修正した。酸素が減るまで9秒待ち、水面の呼吸可能なairを確保し、
実際の到達位置＋HP18以上をサーバーOracleで要求する。
従来の「HP>0」だけの成功を、実際の浮上成功の証拠へすり替えない。
最初の強化版は酸素5→20の回復をログで確認したが、体力Oracle（約1秒）を先に行うことで
沈み始めた後の位置を測り、位置条件に失敗した。到達位置を先に検証するよう測定順を修正した。
長時間水面に静止し続ける機能を新たに証明したとは扱わない。

- 修正前の13件のunsafe characterizationは安全な期待値へ反転した。
  観測、分布、stale、完了、Graph、Constant、Combat、プロトコル順、memory identityを単体検証する。
- native比較3反復: 水中・毒・夜・雨、炉へ移した原鉄/石炭が所持品から消えること、
  炉の燃焼・progress、実際のインゴット生成を確認した。
  `2026-09-29T13-49-16-117Z-architecture-native.json`。
- Jevの最終質問9応答（3状態×3反復）: 正常CONTINUE、迂回必要REPLAN、危険ABORTが9/9。
  confidenceは正常0.88–0.90、REPLAN 0.92–0.95、ABORT 0.97–0.98。
  API往復164–290ms、中央値177ms。`2026-09-29T13-56-23-106Z-critic-audit.json`。
  人工的な3状態であり、汎用的なaccuracyや校正済み確率の証明ではない。
- 実ゲームのcritical feedback: 本物の採掘中にnative体力を下げ、Jevからowned cancellationへ接続する。
  脅威はNoAIのタイミングfixtureであり自然戦闘の成功率ではない。
  healthイベント→中断適用とbody quiescenceを別々に測る。
  敵を先に出した初回campaignは体力変化より前に中断したため、health反応時間の証拠に使わない。
- production/farming/combat tier3: 夜・雨・壁、資源不足、クラフト、精錬、栽培収穫、食事、
  hard夜間のzombie/husk/skeletonを実スキルで検証する。スクリプトが手順を選ぶ試験。
- `AutonomousScenarioRunner`は実Executorへ目標・制約・固定契約のみを渡し、準備座標をplannerへ渡さない。
  `protocol_fixture`は明示的な3turnの擬似modelで、早すぎる完了拒否、実採掘、完了後操作拒否を
  検証する。これを「LLM自律攻略の成功」と数えない。
  isolated catalogではchat/UI Mod/別LLMを使うskillを拒否し、catalog外skillのdispatchも拒否する。
  通常アプリのchatや進捗取得を削除したのではなく、外部サービスへ届かない試験用境界である。

途中で見つかった試験不備も保持する。unit-v5は137 assertion成功でも1suiteのimport収集エラーで
campaign失敗（config mock不足）。autonomous初回は採掘と完了証明は成功したが、前試験の体力を
引き継いでhealth Oracle失敗。初期化を直して再試験し、失敗ログを削除しない。

## 再試験runbook

isolated probeでは必ず`SHANNON_ISOLATED_MINEBOT_PROBE=true`を付ける。
この場合のみ`env.ts`は共有`.env`を読み込まない。通常runtimeの読込みは変更しない。

```bash
cd /home/azureuser/Shannon-dev
bash scripts/with-dev-node.sh bash -c '
  cd backend
  SHANNON_ISOLATED_MINEBOT_PROBE=true \
  OPENAI_API_KEY=offline-test-not-used \
  MONGODB_URI=mongodb://127.0.0.1:27017/shannon-offline-not-used \
  node ../node_modules/vitest/vitest.mjs run \
    tests/unit/minecraft*.test.ts tests/unit/config/env.test.ts \
    --maxWorkers=1 --minWorkers=1
'
```

実ゲームは[minecraft-test-lab.md](minecraft-test-lab.md)の隔離labをreadyまで確認する。
同じwrapper/envに`TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm scripts/<probe>.ts`を付ける。
同じplayer/worldを使うprobeは並行起動しない。共有25565–25569は使わない。
終了後はそのlabだけへ`stop`を送り、3次元の保存・プロセス終了・port閉鎖を確認する。
worldとログは保持する。full backend、Discord、通常DBは起動しない。

- progressive: `MINECRAFT_PROGRESSIVE_TIERS=3 MINECRAFT_PROGRESSIVE_REPEATS=1`。
- autonomous: default `protocol_fixture`、最大3反復。`MINECRAFT_AUTONOMOUS_PLANNER=real_provider`は
  Git外の`/home/azureuser/.config/shannon/minebot-planner.env`の専用`ANTHROPIC_API_KEY`が必要。
  最大12model calls。共有planner keyを流用しない。
- critical feedback: Git外の`minebot-jev.env`だけをin-memoryで読む。API originは
  `https://api.typesafe.ai`に限定し最大12calls。キー、HTTP auth headerをログに残さない。
- cognition/execution core: `node ../node_modules/typescript/bin/tsc -p tsconfig.minecraft-execution.json --noEmit`。
  backend全体の`--noCheck --noEmit`は構文・transpile checkであり、厳密型検査の代用ではない。

## 残る限界・次の合格ゲート

1. real System 2 plannerの限定受入試験は本番リリース文書に別集計。固定fixtureの成功を自律成功と呼ばない。
2. 自然地形、複数seed、30–60分の複合目標、資源枯渇・地形変化・夜間遭遇の評価は未実施。
   runnerのdisturbance機構は実装したが、複合自律試験の成立までは未確認。
3. Jevのheld-out多様な状況、confidence閾値校正、誤中断率は今後の評価。
   100ms/4秒のrequest制限とは別に永続request/token予約予算を実装したが、正確な課金ledgerではない。
4. `produced`は所持数のnet増分。消費した中間成果はサブタスクの検証証跡で扱うが、
   全クラフト/取得provenance ledgerではない。modelが設定した契約の自然言語意味一致は
   codeだけでは保証できない。外部評価時はharness/operatorの固定契約を優先する。
5. `defeated`は攻撃したIDの死亡観測で、kill creditの証明ではない。
   同じrunのimmutable主契約に対する観測済み死亡証拠はcontinuationへ保持する。
   新しいgoalへのID再使用で証拠を継承しない。汎用死亡trackerのプロセス跨ぎ復元は未実装。
   削除後のtask node ID再利用は禁止し、履歴をworkspaceへ保持する。
6. 任意のthird-party async operationを強制終了することはできない。中断はportをfenceし、
   bodyがsettleするまでleaseを保持する。2秒後の非quiescence警告・進捗証跡を追加した。
7. 本番導入は別gate。shadowの自然プレイ記録→誤中断率を確認→feedback限定導入の順に進める。

## 共有知識

`TI-KNOWLEDGE-MINEBOT-ARCHITECTURE-IMPROVEMENTS`:
高速modelだけでは改善しない。native観測、判断ごとの分布、freshness、完了証明、
単一の身体所有権を揃え、API latencyと身体中断までのlatency、固定手順試験と自律試験を分けて記録する。
共有hub/Notionへのremote更新は未実施。既存Notion文書のfetchは404で、接続修復は行わない。

## 運用保全

隔離labは`/home/azureuser/minecraft/progressive-lab-ymOk9D`、tmux `codex-progressive-lab`。
試験後にMinecraftの`stop`で保存終了し、world・失敗ログ・修正前source backupを保持する。
overworld/end/netherの全chunk保存、tmux終了、loopback25577のport閉鎖を確認済み。
旧試験時、本番checkout HEAD `5412c1f1c0ae6b121cba65898cd8c702c3d3e2a9` はcleanで変更・再起動しなかった。
今回の反映はcheckoutではなく、実稼働releaseを親にした`Shannon-current`切替で行う。
通常backend、通常DB、Discordをこの作業から起動せず、shared認証を更新しない。
`architecture-current.md`の旧「dev runtime lockで停止」という説明と実ファイルの不在は区別する。
lockが無いことを起動許可と解釈せず、lockの作成/削除はしない。
