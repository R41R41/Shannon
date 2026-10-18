# Minecraft 体の反射（P8）の運用メモ（2026-10-19）

共通 FCA の体（`MINEBOT_COMMON_FCA=on`）に、旧 Minebot が持っていた反射と知識を戻す P8 の、スイッチ・既定・巻き戻しの一覧。設計は `Syzygy/notes/cloud-handoff-2026-10-19/design-p8-body-reflexes.md`。API 側の相手は `codex/shannon/reflex-aware-api`。**本番の env 変更と再起動は、そのつどオーナーに確認する。**

## 何が入っているか

| 部品 | 既定 | 中身 | 場所 |
| --- | --- | --- | --- |
| 床（retreat / eat / armor） | on | 火の付いたクリーパーと飛んでくる矢から下がる（350）、空腹・低体力で食べる（200）、空きスロットに防具と盾（150）。2026-10-16 から本番にある | `utils/floorReflexes.ts` |
| 低体力の逃走（flee） | **on** | 体力 6 以下で到達できる敵が 3m 内なら、最大 1.2 秒・5 ブロックだけ走る（20 秒に 2 回まで）。崖・溶岩・火・壁に向かう向きは取らず、安全な向きが無ければ始めない | `floorReflexes.ts` |
| 手が空いている時の拾い物（pickup） | **on** | 4m 内で止まっている落とし物へ歩く（10 秒に 1 回、敵 16m 内・体力 10 未満・満杯では歩かない）。掘らない・置かない・泳がない専用の経路設定で歩き、命令が来たら即座に止まって経路設定を戻す | `utils/idlePickup.ts` |
| 戦闘知識（combat） | **on** | 盾が撃ってくる種類を学ぶ（`shotAtBy` / `shootsAtBody`）、掘りの脅威半径（`hostileThreatRadius`）、観測の `margin.hitsLeft`、被弾した Mob を 5 分間敵として扱う（`noteAttackedBy`） | `utils/combatKnowledge.ts`、`utils/threatRadius.ts` |
| 床の予算（budget） | on | クールダウン・60 秒あたりの割り当て・失敗の止め（下記） | `utils/floorBudget.ts` |
| 反射台帳（ledger） | 常に on | 反射が何をしたかを 16 件残し、観測の `world.reflexes` と受信票の末尾に出す | `utils/reflexLedger.ts` |
| `interrupted_by_reflex` | on | 反射に切られた命令をそう返す（API は失敗の数に数えない） | `integration/commonFca/nativeBody.ts` |
| 観測の `biome` / `jobs` / `jobsOmitted` | 常に on | 体が見ている生息域、作業中のかまど（入りきらない分は `jobsOmitted` に件数） | `cognition/worldFrame.ts` |

## スイッチ

`MINEBOT_FCA_REFLEXES`（モード）と `MINEBOT_FCA_REFLEX_OFF`（個別に外す、カンマ区切り）。起動時に 1 回だけ読む（`utils/floorConfig.ts`、読み込みは `utils/floorLayer.ts` の 1 か所）。

| `MINEBOT_FCA_REFLEXES` | 意味 |
| --- | --- |
| 未設定 / `default` | 上の表の既定すべて |
| `floor` | **2026-10-16 の本番の床そのもの**。retreat / eat / armor だけ。flee・pickup・戦闘知識は無い（台帳・受信票の印・予算は残る。印は `ledger-tag` で外せる） |
| `off` | 床を読み込まない。常駐の溶岩・呼吸・盾・踏ん張り・崖際の反射は残る。**本番の床まで止まる**ので、P8 の巻き戻しにはこれを使わない（下の表） |
| `extended` | `default` の旧名（以前は flee と pickup を足すモードだった）。受け付けるが警告を出す |
| それ以外 | `default` として扱い、警告を出す（`off` にはならない） |

| `MINEBOT_FCA_REFLEX_OFF` の名前 | 外れるもの |
| --- | --- |
| `retreat` / `eat` / `armor` | 床のそれぞれ |
| `flee` | 低体力の逃走 |
| `pickup` | 拾い物 |
| `combat` | 戦闘知識の部品すべて（盾の学習、掘りの脅威半径、`hitsLeft`、`noteAttackedBy`） |
| `budget` | 床の予算（反射は無制限に戻る。失敗の再試行は 3 秒固定の旧挙動） |
| `ledger-tag` | 受信票の反射メモと `interrupted_by_reflex`（旧来の `interrupted` に戻る） |

存在しない名前は無視して警告する。そのモードが動かしていないものを外しても何も変わらない。

起動ログの 1 行で、いま何が動いているか分かる:

```
🧱 床の反射: default（retreat,eat,armor,flee,pickup） 台帳=on タグ=on 戦闘知識=on 予算=on 拒否=[]
```

### 部品ごとの巻き戻し

| 戻したいもの | 設定 | 戻り方 |
| --- | --- | --- |
| 低体力の逃走だけ | `MINEBOT_FCA_REFLEX_OFF=flee` | API の fast judgment（flee-from・避難所）だけになる |
| 拾い物だけ | `MINEBOT_FCA_REFLEX_OFF=pickup` | 命令の合間は立っているだけ |
| 戦闘知識 | `MINEBOT_FCA_REFLEX_OFF=combat` | 盾は撃つ種類を学ばない、掘りの敵の半径は既定 16、`hitsLeft` は出ない、被弾した Mob を敵にしない |
| 床の予算 | `MINEBOT_FCA_REFLEX_OFF=budget` | 反射が無制限に戻る |
| 受信票の印 | `MINEBOT_FCA_REFLEX_OFF=ledger-tag` | API は `interrupted` を受け取る（`retry_same`） |
| P8 の運動と知識を全部（2026-10-16 の本番と同じ床） | `MINEBOT_FCA_REFLEXES=floor`（印も戻すなら `MINEBOT_FCA_REFLEX_OFF=ledger-tag`） | 本番の床と同じ |
| 床そのもの | `MINEBOT_FCA_REFLEXES=off` | **本番の床も止まる**。P8 の巻き戻しではなく、床の障害調査用 |
| コード | `git revert`（新しい部品は別ファイル） | |

env を戻して `shannon.service` を再起動する。`MINEBOT_FCA_REFLEXES=off` を誤って入れたかどうかは起動ログの `床の反射: off（なし）` で分かる。

### 外せないもの

台帳の記録、観測の `reflexes`・`biome`、受信票を作る経路は外せない。どれも「起きたことを言う」だけで、体を動かさない。`jobs` は共通 FCA の体（台帳がある体）にだけ出し、旧モードの観測は従来のまま（旧モードには `get-background-jobs` がある）。`biome` は世界から直接読み、読めなければ旧来の `environmentState.biome` に戻すので、旧モードでも値は同じ名前になる。

## 戦闘知識を戻した時に旧と合わせたところ

- **掘りの脅威半径**は固定値ではなく、旧 `EventReactionSystem.emergencyClearanceRadius` の規則どおり（`utils/threatRadius.ts`）。基準は `min(検知 16, 危険距離 8 × 2) = 16`。測定で遠くから当ててくると分かった種類（反射が答える種類と戦闘中の種類は除く）が、届く距離 + 6 以内にいれば「届く距離 + 6」。9 秒以内に着く敵が基準の外にいればその距離 + 4。直近 5 秒の被弾は「当たった距離 + 6」。最大 64。定数は旧のソースと突き合わせるテストがある。
- **`noteAttackedBy`**: サーバーが被弾の原因として名指しした Mob（プレイヤー・飛び道具・物体を除く）を、リストに無くても 5 分間「敵」として扱う。オオカミ・ハチ・ゴーレム・ピグリンが当ててきた場合もそうなり、`nearbyThreats`・掘りの敵判定・ゴール判定に入る。**旧システムも `entityHurt` で同じ呼び出しをしていた**ので、これは旧と同じ挙動の復元（近似ではない）。記憶はモジュール全体で共有される。外すなら `combat`。

## 床の予算（`utils/floorBudget.ts`）

床の反射が動いている間（`facts.floorActive`）は API の fast judgment が黙るので、床が実行権を取り続けると心が進めない。矢が連続する、食べるのが失敗し続ける、で起きうる。

| 規則 | 値 |
| --- | --- |
| 矢のよけの間隔 | 終わってから 2 秒（体力 6 以下は 1 秒） |
| 食事・防具の失敗の待ち | 3 秒、6 秒、12 秒…最大 30 秒。途中で切られただけなら 3 秒 |
| 割り当て | 矢のよけ・食事・防具の合計で 60 秒に 15 秒まで（体力 6 以下は対象外） |
| 止め（latch） | 同じ反射が 3 回続けて失敗したら 60 秒止める（次は 120 秒、最大 240 秒）。成功で消える |
| 対象外 | 火の付いたクリーパーからの退避、低体力の逃走（自前で 20 秒に 2 回）、溶岩・呼吸（床ではない） |

止まった時は黙らず、台帳に `budget` の 1 行（`state.world.reflexes` に出る）を残し、`facts.floorSilenced`（`arrow` / `eat` / `armor` / `budget` のカンマ区切り、無ければ null）で保持中を示す。ログは `🚦`。

## API 側（`codex/shannon/reflex-aware-api`）

- `interrupted_by_reflex` は `retry_same`。失敗の数に数えない。ただし同じ道具が 3 回続けて（道具が混ざれば 6 回続けて）切られたら普通の失敗として数え、5 で止める。**読み取りだけの成功（`minecraft.observe` や問い合わせ）は、この連続を断ち切らない**。止める時の理由は `repeated_reflex_interruption`（本当の失敗は従来どおり `repeated_tool_failure`）。
- fast judgment は、反射に切られた避難所を「隠れ失敗」と数えない。

## 確認のしかた（本番 VM `azure-constant-server`、`journalctl -u shannon.service`）

- 起動時 1 行: `🧱 床の反射:`（設定が意図どおりか）
- `🍖 食べる` `🛡️ 防具を着ける` `💥` `🏹` `🏃 低体力` `🎒 手が空いている` `🧾 反射:` `🚦`
- `Motor owner expired` / `body_not_quiescent` / `containment` が増えていないこと
- API 側: 受信票の `failureType`（`interrupted_by_reflex` の件数）、停止理由（`repeated_reflex_interruption`）
