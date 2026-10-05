# Minebot adaptive architecture：本番リリース

Owner: Minecraft Shannon。2026-09-30のユーザー指示は、改善の追加実装と本番反映を明示承認した。
旧資料のprod read-onlyは今回のMinebot反映に限って上書きされる。公開chat停止、本人認証、
記憶scope、通常DBの移行禁止、無関係なLINE/Radar/iOS/Aether/Voyagerの境界は変えない。

## 本番の実体と反映単位

- 実行中のbackendはsystemd `shannon.service`、cwdは`Shannon-current/backend`。
- 変更前の実体は`/home/azureuser/Shannon-releases/20260929T130901-discord-scheduler-fix`。
  source commitは`1413dc87f661776657dca93409016d2135befbcf`。
- `Shannon-prod`のHEADは`5412c1f`だが、このcheckoutだけを基準にすると、稼働中の定期投稿修正を
  巻き戻す。本番の実リリースを親にし、レビュー済みMinebot変更だけを追加する。
- 候補は`/home/azureuser/Shannon-releases/minebot-adaptive-yCdtpf`。
  `minebot-release-manifest.json`に全対象source hashes・親・fingerprintを記録する。
- 保存データは`/home/azureuser/Shannon-runtime/backend-saves`への同じsymlink。
  DB schema、利用者、Discord主体、共有world、秘密設定はコピー・移行しない。
- `.env`とdependenciesは既存本番の参照を保持する。devの.envやdev markerは配備しない。
  rootだけでなくbackendのworkspace-local dependenciesも維持する。

## 今回追加した実装

既実装のnative観測、Jev分布検証、完了証明、途中評価、owned Constant/Combat/containment、
イベント駆動収集、background炉、skill修正を一括反映する。詳細は
[minecraft-architecture-improvements.md](minecraft-architecture-improvements.md)。

1. **OpenAI-only本番の接続漏れ**を修正。本番にAnthropic keyが無く、旧graphは汎用FCAへ落ちていた。
   `OpenAIPlannerClient`によりMinecraft専用ExecutorをOpenAI Responsesでも利用できる。
   tool IDs/resultの順序・Optional引数・画像入力を保持。store=false、有限deadline、task abortを伝播。
   Anthropic対応は維持し、他の会話/定期投稿/LINEのmodelは変えない。
   `MINECRAFT_PLANNER_PROVIDER=auto|openai|anthropic`、OpenAI既定は`gpt-5.6-luna`。
   [公式model仕様](https://developers.openai.com/api/docs/models/gpt-5.6-luna)と
   [公式function calling](https://developers.openai.com/api/docs/guides/function-calling)に基づく。
2. **node ID墓標**。削除した親・子のIDを同じrunで再使用できない。atomic batch失敗では墓標を
   確定せず、TaskWorkspaceのcontinuationに履歴を保持する。4096 IDsで有限にする。
3. **中断後の未停止検知**。2秒quiescenceしないbodyをログ・progressへ記録する。
   古いmotor portをfenceし、leaseを保持する。警告だけで強制的に所有権を解放しない。
   third-party asyncを安全に強制killできると偽らない。body終了で自動的に通常引継ぎへ戻る。
4. **model予算**。planner/critic/reflexのrequestと保守的token reservationを共用する。
   ACK前にfile lock＋atomic write＋fsync。失敗requestも消費し、再起動で回数を戻さない。
   defaultはUTC日300 requests / 2,000,000 reserved tokens。費用の正確なledgerではない。
   本番は大きいtool catalogを考慮して300 requests / 20,000,000 reserved tokensへ明示設定する。
   `MINECRAFT_MODEL_BUDGET_FILE`をGit外のruntimeへ明示。破損・競合・時計逆行・枠不足は拒否。
   Jevにはoutput上限が無いため厳密な課金上限と呼ばない。既存救命fallbackは維持。
5. **非OP攻略actorの試験**。`minecraft-openai-acceptance-probe.ts`は準備/OracleのOPと
   攻略playerを分離する。木材、パンcraft、ブロック設置を外部Oracleとnative proofで確認する。
   擬似modelのprotocol試験と実modelの自律試験を別集計する。
6. **pause後の部分完了証拠**。同じimmutable主契約の攻撃済み対象死亡はresumeに保持する。
   他のgoal/次元に同じentity IDが現れても継承しない。inventory/blockはresume後も再観測する。

## 検証・未検証の境界

- 開発関連unit追加後177/177（`production-promotion-unit-v2.json`）。
- strict cognition/execution/Responses adapter合格（`production-promotion-core-typecheck-v3.log`）。
- 候補backend noCheck build合格。全体strict合格の代用にはしない。
- tier3実Minecraft: production/farming/combat 3/3、死亡0。
  `2026-09-29T15-20-47-268Z-summary.json`、fingerprint
  `b594bf25ada13075a1c3f79e724f371376c7899dde2e42011b093b1556b9164d`。
  後続のplanner transport/試験harness修正を含む最終全ソースhashとは呼ばない。
- 最初の全体unitは1323 assertion成功でも3 suitesのimport失敗で全体失敗。
  logger test互換とworkspace-local dependency参照を修正し、v3は1348/1348成功（93 files）。
  最終候補では**1350/1350**、93 files成功。`release-checks/backend-unit-final.json`。
  strict coreとnoCheck buildも最終候補で成功。全体strict未完の境界は維持する。
- 非OP Survival protocol受入：木材3個、パン1個craft、石1個設置の3/3成功、死亡0。
  最終コードでも再確認し3/3。`2026-09-29T15-43-59-161Z-openai-acceptance.json`、
  準備/Oracle込み13,094/7,143/5,079ms、実API calls 0。モデル品質と混同しない。
- 実1.21.11では自然回復ruleは`minecraft:natural_health_regeneration`。
  旧`natural_regeneration`は無効で、barrierはコマンド処理順の保証だけだった。
  falseを外部Oracleで確認した再試験は3/3、死亡0、health→中断416/451/434ms（6 Jev calls）。
  `2026-09-29T15-33-21-903Z-critical-feedback.json`にfixtureProofを保存。
  修正前のHP2→3による失敗・698ms中断は保持し、固定体力成功と数えない。
- 実OpenAI自律試験は専用key、または明示的に許可された本番key限定の受入試験が必要。
  通常DB/Discordへ接続せず12 requests・推定予約額$0.50で止める。
  本番keyのこの範囲の利用はユーザーが明示承認済み。keyは既存.envをin-memoryで読み、転記しない。
- 実GPT-5.6 Luna限定受入：木材3個の採集**成功**（25,531ms、7 iterations）。
  パンはrecipe/所持品/作業台の観測まで進んだが、累計12 request上限で停止して未完。
  石設置は未実施。死亡0、予約額$0.2007276、API各1,105〜3,209ms。
  `2026-09-29T15-38-39-931Z-openai-acceptance.json`。transport/tool往復は確認できたが、
  この初回campaignだけでは実モデル3/3成功とは呼ばない。追加試験結果は次節へ分離する。
  actorの非OPはlabのops.jsonでも確認、Survival/HPは外部Oracleで検証する。
- 長期自然地形/多数seed、held-out Jev校正、誤介入率の評価は未完。
  本番cognitionは既存shadowを維持し、running-action supervisionもshadowにする。
  自動中断/直接反射を全面有効化したという意味ではない。

## 承認後の実モデル追加受入

2026-09-30、ユーザーが追加使用を1000円以内で承認。今回はさらに小さい枠
24 request / 保守的予約額$0.50で開始し、成功後に終了した。承認はこの隔離受入に限定する。
公式OpenAI Docsの[GPT-5.6 Luna料金](https://developers.openai.com/api/docs/models/gpt-5.6-luna)（入力$0.20、cached$0.02、cache-write$0.25、出力$1.20/1M、
長contextの割増）を確認し、送信前の予約計算は従来の保守的単価を維持した。

| 自律課題 | 準備・Oracle込み | Executor | iterations | 外部検証 |
| --- | --- | --- | --- | --- |
| パン1個をcraft | 25,909ms | 18,977ms | 9 | bread=1、wheat=0、Survival、HP20 |
| (3,100,0)へ石を設置 | 18,294ms | 13,220ms | 8 | 指定座標stone、Survival、HP20 |

- **2/2成功、死亡0**。初回の木材採集成功と合わせ、3つの簡単な課題を実モデルで確認できた。
  同一campaignで3/3を再試験したという意味ではない。昼・Peaceful・材料準備済みの隔離arenaであり、
  自然地形や長期目標の自律品質を保証しない。
- planner actor `MinebotTrial`の非OPはops.jsonで確認。準備/判定だけは別OP actorを使う。
  modelには手順を渡さず、14個のローカルskill＋plan/goal/completion toolから選ばせた。
- 追加18 API request（タイトル要約1回も含む）、全HTTP200。予約額**$0.2933141**。
  input55,018/cached38,249/cache-write16,632/output939 tokens。通常短context公式単価からの
  token料金試算は約**$0.00607718**。請求確定額・円換算・税/決済手数料の実測ではない。
  初回分の予約額$0.2007276とは別の追加使用枠で、今回の上限まで使い切っていない。
- API latency1,162〜3,165ms、昇順中央値1,756ms。craft本体約555ms、設置本体約22ms。
  単純課題では物理処理より、観測・計画管理を含むmodel往復が支配的。
- 証拠：`2026-09-29T16-02-39-010Z-openai-acceptance.json`と
  `production-promotion-openai-additional.log`。試験対象5ファイルは稼働manifest hashと一致。
  初回の予算停止/固定手順の報告は保持し、成功結果へ上書きしていない。

### 追加試験で残った効率課題

`manage-task-tree`に`TASK_COMPLETION_UNKNOWN`と`TASK_ACTIVE_NODE_NOT_READY`の拒否があった。
完了した世界状態は主契約のnative proofと外部Oracleで確認できるが、最終taskNodesには
in_progressが残る。パンの親nodeにはpostconditionsがなく、石の拒否batchには
activeNodeId=place_stoneが指定されていた（更新statusは短縮ログから不明）。
コードは「postconditionsのない完了はunknown」および
「更新後のready node以外はactiveにできない」を原子的に検証する。
ただし成功runでは全会話/拒否batchの引数を保存せず、ログ引数も短縮されるため、
個々のbatch内statusまで復元して原因確定したとは言わない。検証を緩めて成功扱いにはしない。
次の改善候補は、拒否時にnode ID・不足predicate・ready IDsを返す診断と、
完了更新と次active選択を分けるmodel側の操作精度。今回はruntimeコードを追加変更していない。

追加試験時の本番PID98048/ready200は維持し、再起動・設定変更を行わなかった。
labは01:04:16 JSTにstopし、全3dimension保存、tmux終了、25577閉鎖を確認。
共有hub/Apple app statusは変更せず、知見をcanonical Minebot文書へ追記した。

## 本番切替の実績

- **2026-09-30 00:42:06 JST、反映完了**。backend PID `98048`。
  `/proc/98048/cwd`は候補の`backend`、currentは上記候補へ切替済み。
- source fingerprint: `ec883d5fea9bd7ecf44b56094c34de24e20815d10637c71550a68f30ac61a6af`。
  稼働候補の129対象ファイルをmanifest hashと再照合し一致。
- health/ready 200、公開chat 503、認証なしidentity入口401。
  MongoDB再接続、Discord bot起動・slash登録を確認。
  stop時の`MongoDB disconnected`は旧PIDの正常停止ログで、新PIDの起動失敗ではない。
- non-secret process envでOpenAI/Luna、Jev/shadow、supervision/shadow、永続予算を確認。
- private backup: `/home/azureuser/.codex-shannon-preservation/minebot-cutover-00cGJP`。
  directory 0700、各file 0600。保存領域40,273,920 bytesとMongo archive6,702,276 bytesを保全。
  DB migration/backup上書き復元は行っていない。
- frontend PID2190、AgentHost924、iOS923、Aether838、Voyager929は再起動せず維持。
  `Shannon-prod` checkoutもcleanのまま。既存定期投稿修正を親として維持。
- 隔離labは00:44:54 JSTに`stop`で終了。overworld/nether/endの全chunk保存、tmux終了、
  loopback25577の閉鎖を確認した。world/失敗ログは保持している。
- 反映後のこの実績追記はcanonical dev文書だけに行う。稼働releaseのimmutable sourceと
  manifestを編集して成功証拠を書き換えない。release内の文書は切替前snapshotである。

## 切替・復旧手順

1. `prepare-minebot-release.cjs`で準備。実親・dev HEAD一致、全対象の旧baseline hash一致を確認する。
   未レビューdev差分・本番側の独自差分・source collisionがあれば停止する。
2. 候補でbuild・全offline unit・core strict・ゲームの代表用途を確認する。
3. 切替直前にcurrent/PID/health/readiness・data symlink・認証設定・security入口を再確認。
   保存領域とservice設定をGit外の0700保全先に退避する。DB移行は行わない。
4. `shannon.service`だけをgraceful stop。保存領域の最終backup後、同じdata参照を保持したまま
   `Shannon-current`のsymlinkをatomicに候補へ変更し、同serviceだけstartする。
   frontendも新releaseで再起動される可能性に備え、既存frontend env参照は保持する。
5. health/ready、DB接続、Discord起動、loopback認証、公開chat停止、source hashを確認する。
   失敗時は旧currentへatomicに戻してservice起動。データを旧backupへ上書き復元しない。
   今回はDB/schema変更がないためsource rollbackと同じ最新data参照を使う。
6. labへ`stop`を送り全dimension保存・port閉鎖を確認。worldと失敗ログは保持する。

## 知識返却

TI-KNOWLEDGE-MINEBOT-PRODUCTION-RELEASE:
本番はcheckout HEADだけでなくsystemd cwdとcurrent symlinkまで確認する。
「コードを反映した」と「実行経路に接続された」と「自律品質を実APIで確認した」は別の合格条件。
専用Executorがprovider key条件で使われない場合、観測/完了/自己feedbackの修正は配置だけでは効かない。
共有Syzygy hub・Apple Shannon statusはこのMinebot backend反映から変更しない。
