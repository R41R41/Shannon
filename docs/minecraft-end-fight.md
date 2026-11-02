# エンドの戦い：体の部品（2026-11-02、`claude/dragon-end`）

エンダードラゴン討伐のスプリント（S1「体：エンド」）の体の側。判断（いつ・どれを・どこで）は頭の LLM のもので、体は頼まれた目的をやり切る。手の種類（act.ts の `HAND_KINDS`）は増やしていない。

先例：mine-ai-mcp（MIT、https://github.com/aibengineering/mine-ai-mcp、aibengineering）の作り方（竜の部位の id、止まり木の phase、クリスタルの距離など）を読んで学び、Shannon の作りで書き直した。コードは写していない。

## 観測 `state.end`

エンドの時だけ `state` に付く（他の次元では欄ごと無い）。`utils/dragonState.ts` の `endObservation`。

| 欄 | 中身 |
|---|---|
| `dragon` | 竜が読み込まれていなければ `null`。`id`・`health`（/200）・`phase`（0〜10、読めなければ null）・`phaseName`・`phaseFor`（この体が見ている間のその phase の秒）・`perched`（phase 5・6・7）・`at`・`yaw`（rad）・`head`（止まり木の時だけ、頭の箱の中心）・`headReach`（目から頭の箱までの m）・`strike`（止まり木で `headReach` ≤ 5.0） |
| `fountain` | 出口ポータルの岩盤の柱の上（竜が止まる所。柱の最上の岩盤の 1 つ上）。柱が読み込まれていなければ null |
| `crystals` | `remaining`（立っている、または見ていない台座の数。10 のうち）・`gone`（読み込まれた列に無い＝壊れた）・`caged`（読み込まれた中の檻つき）・`list`（読み込まれた物、近い順 10 まで：`id`・`x`・`y`・`z`・`caged`（true/false/null）・`dist`・`healing`（ビームが竜に向く）・`blast`（爆発圏 12 m の内だけ：今の立ち位置で爆発した時の失う体力の見込み））・`unseen`（見ていない台座の x・z） |
| `clouds` | 竜の息の雲（dragon_breath）の `x`・`y`・`z`・`r`、4 つまで |
| `fireballs` | 飛んでいる dragon_fireball の数 |

台座の中心は島の上の輪（半径 42）で固定（`SPIKE_CENTRES`）。どの台座が高い・檻つきかは世界のシード次第。

## 手の動き（既存の手のまま）

- `attack target:"ender_dragon"`（または `#id`）：止まり木（phase 5・6・7）の間だけ、頭の部位（本体 id + 1）へ `bot.attack` を送る。目から部位の箱まで 5.0 m 以内で、頭 → 首（+2）→ 胴（+3）→ 翼（+7・+8）の順に届く物。剣は 13 tick、斧は 25 tick の待ちを守る。体は歩かない（立ち位置は LLM の `go`）。止まりの code：`not_perched`（止まり木に居なかった）・`out_of_reach`（止まり木だが届く部位が無い）・`perch_over`（止まり木が終わった）・`time_up`・`target_lost`。倒した時は死の演出（約 10 秒）まで待つ。
- `shoot target:"ender_dragon"`：飛んでいる間だけ（止まり木の竜に矢は効かない：`perched_immune`）。胴の部位の中心を狙う。
- `shoot target:"#<crystal>"`：13〜64 m（`too_close`・`too_far`）、矢の道に固い物があれば撃たない（`line_blocked`。檻の鉄格子も塞ぐ）、弓は 21 tick 引く。
- `attack target:"end_crystal"`（または `#id`）：手が届く（3 m）時の 1 撃だけ。爆発の見込み（距離・体の見える割合・難易度・防具）が体力に 4 を足しても残らなければ撃たない（`blast_unsafe`、数字つき）。
- `use at:<ベッドのマス>`（ネザー・エンドだけ）：寝ずに右クリックする＝爆発（威力 5）。先に自分への被害を見積もり、危ないなら断る（`blast_unsafe`）。結果は「爆発した・中心から自分まで・失った体力・竜の頭の箱までと体力の前後」。体が自分で使うことは無い。

## 床の反射 `floor-dragon`

エンドで次の物が体に届く時、行動を止めて水平に離れる（置かない・跳ばない・走らない）。`utils/dragonDanger.ts`（判断）と `floorReflexes.ts` の `dragonTick`・`runDragonRetreat`。

- 息の雲（半径は 7 以上として扱う。地面の 0.5 m の板：その上や下の体は当たらない）
- 止まり木の竜が吐く息（phase 5 はすぐ、phase 7 は 1.25 秒たってから。頭の 2.5 m 先、半径 7）
- 火の玉の線（40 tick 先まで、線から 7 m。速さは (s + 0.1) × 0.95）
- 止まり木の竜の体の箱（頭・首は箱から 1 m、翼は (4, 2, 4) で 2 下げた箱）

逃げ道が無い時は、最後の手（`lastStandChoice`）が黒曜石・エンドストーンを先に積む（竜はこの 2 つを壊せない）。

## 討伐の証明 `goal-evidence`

`boss.verified` は、体が **この竜に被害を与え**、その後に **同じ竜の死** を 60 秒以内に見た時だけ true。被害は、サーバーが体を原因とした `damage_event`（剣・矢）、体の `bot.attack`（部位でも）の直後の竜の被弾、体が使ったベッドが竜の脇で爆発した時。死は `entityDead`、または死にかけ（phase 9）の竜の消失（死の演出の終わり）。再接続・別のタスク・別の次元・体の被害でない死は証明にならない（`unknown`）。advancement `minecraft:end/kill_dragon` がこの接続で入った時は `boss.advancement` に添える（裏付け。証拠そのものではない）。

## 隔離ラボで測った数字

`backend/scripts/minecraft-end-fight-probe.ts`（VM の隔離ラボ、`scripts/lab/run-end-fight.sh`）。モデルは使わない。

（測定の結果は区切りの報告に書いた。更新はこの節へ。）
