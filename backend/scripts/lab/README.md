# Minebot 隔離ラボの実行補助

開発VM（`/home/azureuser/Shannon-dev`）専用。隔離ワールド（loopbackの`progressive-lab-*`）だけを使い、Shannon-prod・共有ワールド・通常DB・Discordには接続しない。起動ロック（`.dev-runtime-lock`）はそのまま。

出力先は`MINEBOT_LAB_SCRATCH`（既定`~/.cache/minebot-lab`）。/tmp には置かない：このVMはSpotで、ときどきAzure側から停止され（`hv_utils: Shutdown request received`）、/tmp はそのたびに消える（2026-10-02 04:27 に実走2本のログを失った）。

| スクリプト | 用途 | 課金 |
| --- | --- | --- |
| `launch-nether-run.sh <port> <label> [window_ms] [learning_mode] [reasoning_effort=low] [planner_model=claude-sonnet-5-5] [budget_profile]` | 新しい自然地形の隔離ワールドを作り、ネザー到達を目標にした実走を開始する。環境変数 `MINECRAFT_LAB_VIEW_DISTANCE`（5〜12、既定5）で身体の見える範囲（描画距離）を変えられる。計画器の既定は Claude Sonnet 5.5・推論 low（2026-10-02 ユーザー決定。`gpt-5.6-luna` も第6引数で指定可）。予算台帳は第7引数（承認済みのプロファイル名） | あり（承認済みの台帳の範囲内のみ） |
| `resume-nether-run.sh <port> <label> <worldDir> [window_ms=1200000] [planner_model] [budget_profile] [reasoning_effort]` | 終わった実走を、同じ隔離ワールド・同じ身体（所持品もそのまま）で続行する（`MINECRAFT_CAMPAIGN_RESUME=true`）。そのワールドのサーバーが動いていること。支給・テレポート・時刻の変更はしない。結果は元の実走と分けて「続行」として記録する | あり（承認済みの台帳の範囲内のみ） |
| `check-anthropic-key.mjs [鍵ファイル] [model]` | Anthropicの鍵が使えるかを1トークンの要求で確かめる。HTTPの状態・鍵が属する組織ID・エラー文だけを出し、鍵は一切出さない。鍵は `~/.config/minebot-lab/anthropic.env`（権限600。`ANTHROPIC_API_KEY`、組織に紐づく鍵なら `ANTHROPIC_WORKSPACE_ID` も） | 通った時だけ1トークン |
| `run-stats.sh <label>...` | 実走ログから、計画器の応答時間（中央値・90%点）、1応答あたりのツール数、目標管理の呼び出し割合、目標管理のエラー数、死亡数、節目までの分、台帳の課金額を1行のJSONで出す（モデル比較用） | なし |
| `monitor-runs.sh <label>...` | 実走ログから3分ごとに1行の状況（道具回数・死亡・反射・予算の精算額）を出す | なし |
| `run-outage.sh <scenario> <label> <port> <worldDir> [ENV=VAL...]` | 計画器を止めた状態で反射だけを試す（`scripts/minecraft-planner-outage-flee-probe.ts`）。シナリオ例: `ravine-rim` `seagrass-pool` `reflex-only` `drowned-pool` `shelter-water` `under-ice`、`cornered`＋`MINECRAFT_OUTAGE_WOUNDED=true` | なし |
| `run-lab-probe.sh <script.ts> <label> <port> <worldDir> [ENV=VAL...]` | 上の「経路・掘削の無課金プローブ」を隔離条件の環境変数つきで1本実行し、結果の行を出す | なし |
| `run-unit.sh <出力ファイル> [vitestの引数]` | 単体テストを実キーなしの環境で実行（既定は `tests/unit`。引数なしで全体を回すと統合テストが外部APIへ出ようとするため） | なし |
| `run-flee-trace.sh <label> <port> <worldDir> <x,z> [ENV=VAL...]` | 逃走の動きの記録、避難穴と敵の到達見込み（`MINECRAFT_FLEE_TRACE_SHELTER=true`）、道具の破損（`MINECRAFT_FLEE_TRACE_TOOLBREAK=true`）、氷の穴から上がる（`MINECRAFT_FLEE_TRACE_ICEHOLE=true`） | なし |

公開ラボ（`MINECRAFT_LAB_PUBLIC=true`）で使える追加の環境変数（`launch-nether-run.sh` が渡す。詳細は `docs/minebot-lab-ui-mod.md`）:

- `MINECRAFT_LAB_WATCHERS=spectator|free`（既定 spectator）: 入ってきた人を観戦モードにするか、ゲームモードを変えずに一緒に遊べるようにするか。free で誰かが入った実走は受入に数えない。
- `MINECRAFT_LAB_UI_MOD=true`: ShannonUIMod と Fabric API を `mods/` に入れ、`config/shannonuimod.json`（権限600、トークン入り）を書く。ポートはゲーム+3600（実走側）と+3800（Mod側）で loopback のみ（`scripts/lab/lab-ui-mod.mjs`）。実走はこのファイルを読んで Mod とつなぐ（トークンは環境変数にもログにも出さない）。
- `MINECRAFT_LAB_BOT_NAME`（既定 `I_am_Shannon`）: Mod が見張る身体の名前。`MINECRAFT_LAB_MODS_DIR`（既定 `backend/saves/minecraft/uimod-test`）: jar の置き場所。
- 実走中に `シャノン`／`しゃのん`／`Shannon` で始まるチャット（または Mod の会話欄・`/shannon`）でシャノンに話しかけられる。ログに `CAMPAIGN_HUMAN_CHAT <名前> <先頭60文字>`。話しかけた・Mod でタスクや持ち物を操作した実走は `humanInteractions` が1以上になり、`accepted:false`（`human_interaction`）。

`tsconfig.changed.json`はMinebot関連の変更ファイルだけを通常の型検査にかけるための設定（backend全体は`--noCheck`変換のみ）。

実走を2本走らせる時は、起動を3分ほどずらす。同時に起動するとワールド生成とスクリプトの読み込みが2コアに重なり、サーバーが十数秒遅れる（`logs/latest.log`の「Can't keep up」）。

検証用サーバーは専用のtmuxサーバー（ソケット名 `minebot-lab`）で動く。既定のtmuxサーバーは最初に起動したサービス（例: `terraria.service`）の持ち物になり、そのサービスを止めると配下のセッションごと終了するため、分けてある。実走を終えたサーバーは `tmux -L minebot-lab send-keys -t codex-progressive-lab-<port> "stop" Enter` で止める。一覧は `tmux -L minebot-lab ls`。

水場のシナリオ（`run-outage.sh`）: `flooded-shaft` `flooded-tunnel` `capped-water` `under-ice` `water-pocket`（天井の下の深さ2ブロックの水たまりから、落ちてきた穴へ戻る） `cliff-lake`（崖に囲まれた湖から、経路の実コストで岸を選んで上陸する）。 `lava-overhead`（頭上の土の横に溶岩。tower-up が掘らずに理由を返す）。 `lava-contact`（身体のセルへ溶岩を流す。反射で溶岩の外へ出る。生存は別項目で報告）。 `waterfall-shaft`（坑道の端の縦穴に落ちる滝。足元や途中に置かれた身体が、滝を登らずに横の空気へ出る。`MINECRAFT_OUTAGE_SHAFT_START` で開始の高さ）。 `bank-overhang`（岸で息をした後、張り出した石の真下の水中へ。石を掘らずに隣の開いた水面へ泳ぐ）。 `ice-closes`（立てない深さの湖。氷の穴で息をして氷の下を泳いだ後に穴が凍る。帰り道を捨て、空気が掘り抜く時間を切る前に氷を割って出る）。 `water-trap`＋`MINECRAFT_OUTAGE_TRAP_AT="x,y,z"`（終わった実走のワールドで、身体が最期にいた地点に計画器なしの身体を置き、反射だけで出られるかを見る事後調査。`MINECRAFT_OUTAGE_TRAP_RESTORE="x,y,z,block;..."` で前回の調査が壊したブロックを戻す。実走中のワールドには使わない）。 逃走のシナリオ: `surrounded`（体力8、四方9ブロックにゾンビ4体。被弾なしで5秒後に12ブロック以上離れ、折り返さない）。

経路・掘削の無課金プローブ（環境変数は`run-outage.sh`と同じ隔離条件）:

- `scripts/minecraft-dig-confirmation-probe.ts`: サーバーが実行しない掘削を再現し、素の掘削と確認つきの掘削で押し戻しの回数を比べる。
- `scripts/minecraft-route-probe.ts`: `MINECRAFT_ROUTE_GOALS="x,y,z,range;..."` の各地点について、経路探索の答え（成否・コスト・探索ノード数・設置や掘削の数）を出す。`MINECRAFT_ROUTE_CELLS="x,y,z;..."` でその座標のブロック名も出す。
- `scripts/minecraft-mine-pushback-probe.ts`: 自然地形で石を一括採掘し、サーバーの位置の押し戻しを数える。`MINECRAFT_MINE_SITE="x,y,z"`、`MINECRAFT_MINE_TICK_RATE=10`（サーバーを遅くする。終了時に20へ戻す）、`MINECRAFT_MINE_KEEP_PREDICTION=true`（比較用にライブラリの予測の空気を残す）、`MINECRAFT_MINE_CONSTANT_SKILLS=true`。
- `scripts/minecraft-wall-press-probe.ts`: 面が x=-2 にある壁へ身体を押し付け、衝突判定の許容誤差の有無で押し戻しの回数と「壁の中へどこまで進んだと主張したか」を比べる。
- `scripts/minecraft-bridge-gap-probe.ts`: 落差のある谷を挟んだ2つの足場の間を、足場ブロックを置いて渡れるかを見る（`MINECRAFT_BRIDGE_GAP`、`MINECRAFT_BRIDGE_DROP`。`MINECRAFT_BRIDGE_INTERRUPT=true` で、身を乗り出した瞬間に移動を打ち切っても落ちないかも見る）。建築の構えの秒数・崖際の停止反射の回数・設置数・落下を出す。
- `scripts/minecraft-snow-walk-probe.ts`: 雪の層（1〜8層）の上を歩かせ、押し戻しの回数と、クライアントが持つ当たり判定の高さを出す。
- `scripts/minecraft-flee-from-water-probe.ts`: 深い池に浮いた身体から逃走スキルを呼び、岸へ上がって離脱できるかを見る（岸にゾンビを1体置く）。
- `scripts/minecraft-air-route-probe.ts`: 実走で空気が尽きた地点の事後調査。`MINECRAFT_AIR_ROUTE_AT="x,y,z"` の周囲のブロックを高さごとに出し、身体が通れる空気への道（`routeToAir`）を出す（観察者はスペクテイターで見るだけ）。
- `scripts/minecraft-gaze-probe.ts`: 24ブロック先のエンダーマンへ向かって歩き、怒らせたか（サーバーの「見られた」印・瞬間移動・被弾）と、視線の反射が上下の角度を変えた回数を出す。`MINECRAFT_GAZE_GUARD=off` が対照。
- `scripts/minecraft-pillar-mob-probe.ts`: 1×1の柱積みを始めた直後に、足元のセルへ動かないゾンビを置く。経路を捨てるまでに跳ね続けた秒数と、経路を捨てた理由を出す。
- `scripts/minecraft-inventory-sync-probe.ts`: 作業台のそばで8回続けてクラフトし、その後クラフト枠に丸石を1個残してから板材を3回作る。各回の結果と、身体の所持品の写しがサーバーとずれたスロットを出す。`MINECRAFT_INVENTORY_SYNC=off` が対照（照合なし）。
- `scripts/minecraft-entity-range-probe.ts`: 身体が何ブロック先のMobまで受け取っているかを測る（壁の向こうに12〜128ブロック間隔で動かないゾンビを置く）。2026-10-02の計測: 描画距離5チャンクのサーバーで80ブロック先まで（緊急対応が使っているのは16ブロック）。
- `scripts/minecraft-craft-full-probe.ts`: 満杯の所持品で板材を作り、丸石を捨ててもう一度作る。`MINECRAFT_DROP_CASE=flat|enclosed` で drop-item だけを見る（平地／1マスに閉じ込め）。`MINECRAFT_SHELTER_CASE=1` で、封鎖した縦穴の中から「登る・もう一度避難・横へ掘る」をゾンビが上にいる時といない時で見る。`MINECRAFT_DOUSE_CASE=1` で、開けた地面で火が付いた身体の消火と水の汲み直しを見る。`MINECRAFT_FILL_CASE=1` で fill-area だけを見る（届かない距離まで続く壁を、既にある段を除いて埋める）。`MINECRAFT_CRAFT_STALE_WINDOW=crafting_table|furnace|chest` で、開いたままの画面がある時のクラフトを見る。
- `scripts/minecraft-site-walk-probe.ts`: 設定コマンドを一切使わず、隔離ワールドにそのまま参加して `MINECRAFT_SITE_GOALS="x,y,z,range;..."` を順に歩き、押し戻しの回数・閉じた道・最初に拒否された地点の周囲のブロックを出す（実走を止めた後のワールドで原因を調べる時に使う）。
- `scripts/minecraft-dripstone-probe.ts`: 鍾乳石を並べた水路を泳がせて押し戻しを数える。
- `scripts/minecraft-rubberband-probe.ts`: 実走で押し戻しが続いた地点を歩き直し、tickごとの位置と押し戻しを記録する。

- `scripts/minecraft-hurt-source-probe.ts`: 遠くから当ててくるMob（既定はガスト）を視界に1体出し、被弾ごとに、サーバーが原因として名指しした相手（種類・距離）を出す。`MINECRAFT_HURT_MOB`、`MINECRAFT_HURT_AT`、`MINECRAFT_HURT_OFFSET`、`MINECRAFT_HURT_DIMENSION`。 `MINECRAFT_HURT_PAD=1` で空中に石の足場を作る（オーバーワールドの上空でも試せる）。`MINECRAFT_HURT_DEFLECT=on` で火の玉を打ち返す反射だけを有効にし、飛んできた玉の数・殴った数・被弾・ガストの撃墜を出す（`off` が対照）。`MINECRAFT_HURT_TRACE=1` で、火の玉の位置と速度がクライアントにどう届くかをtick単位で出す。 打ち返しを有効にした時は、殴った球ごとに `returns`（意図した線とのずれ・ガストの箱からの通過距離・先読み量と実際の移動）を出す。`MINECRAFT_HURT_MOBTRACK=<file>` で相手のtickごとの位置を書き出す（先読みの方式を机上で比べる時に使う）。
- `scripts/minecraft-mob-fight-probe.ts`: 装備（`MINECRAFT_FIGHT_KIT`。防具と盾は着せ、ほかは持たせる）と相手（`MINECRAFT_FIGHT_MOB`・`MINECRAFT_FIGHT_COUNT`・`MINECRAFT_FIGHT_OFFSET`）を指定して、空中の石の床で戦闘スキル（`MINECRAFT_FIGHT_SKILL`・`MINECRAFT_FIGHT_ARGS`）を1回実行し、撃破数・所要時間・被ダメージ・拾った物を出す。開発用（装備と相手はコマンドで出す）。 `MINECRAFT_FIGHT_SHIELD=off` で盾の反射を切る（対照）。
- 被弾で身体がどれだけ押されるかは `scripts/minecraft-hurt-source-probe.ts` の報告の `knocks`（1発ごとの押され幅と浮き）・`brace`（押し返しの反射）・`fellAtHit`（何発目で足場から落ちたか）で見る。`MINECRAFT_HURT_STAND="dx,dz"` で足場の端の近くに立たせ、`MINECRAFT_HURT_BRACE=off` で反射を切る（対照）。
- `scripts/minecraft-barter-probe.ts`: 金インゴット（`MINECRAFT_BARTER_GOLD`）を持たせ、ピグリンを1体出して `use-item-on-entity` で物々交換させ、返ってきた物を出す。`MINECRAFT_BARTER_DRINK=1` で、ポーション7種を持たせて中身の名前の対応を確かめ、火炎耐性を選んで飲ませる。
- `scripts/minecraft-mob-fight-probe.ts` の追加の指定: `MINECRAFT_FIGHT_EFFECT=fire_resistance`（効果を付ける）、`MINECRAFT_FIGHT_BUNKER=feet|eye|closed`（身体を丸石で囲い、相手側に穴を開ける）、`MINECRAFT_FIGHT_SPAWNER="dx,dy,dz"`（相手のスポナーを置く。`MINECRAFT_FIGHT_COUNT=0` と併用）、`MINECRAFT_FIGHT_REPEAT=1`（時間までスキルを呼び直す）。
- `scripts/minecraft-wear-probe.ts`: 防具と盾を手持ちに入れて歩かせ、数秒後に身に着いているかを確かめる（`auto-wear-armor`）。
- `scripts/minecraft-hurt-source-probe.ts` の追加の指定: `MINECRAFT_HURT_KIT`（防具と盾は着せる）、`MINECRAFT_HURT_SHIELD=on|off`（盾の反射）、`MINECRAFT_HURT_TIME=midnight`（日光で燃える相手用）、`MINECRAFT_HURT_PAD_RADIUS`（床の広さ。歩く相手には床が要る）。報告に `shotsSeen`・`shield`（構えた回数など）が出る。`MINECRAFT_HURT_TRACE=1` は飛んでいる物すべての位置と、発射・速度のパケットの生のバイト列を出す。
- `scripts/minecraft-checkpoint-restore.ts`: 終わった実走の報告書（`…-dragon-campaign.json`）から、身体の場所・ディメンション・所持品をコマンドで復元する（`MINECRAFT_CHECKPOINT_REPORT`、`MINECRAFT_CHECKPOINT_AT="x,y,z"` でポータルの外へずらす）。その後 `resume-nether-run.sh` で続行すれば、ネザー側だけを前置き無しで繰り返せる。復元した身体からの続行は開発用で、受入には数えない（耐久とエンチャントは戻らない）。`MINECRAFT_CHECKPOINT_EXTRA="iron_sword:1,shield:1"` で、その実走が持っていなかった物を足せる（先の区間だけを試す時用。その装備を作れることは何も示さない）。
- `scripts/minecraft-nether-walk-probe.ts`: 終わった実走のワールドで、身体を指定の地点（既定はネザー）に置き、同じ移動を頼んで、溶岩に入ったか・崖際の停止の回数・入る直前40 tickの動き・周囲のブロックを出す事後調査（身体は耐火つき。受入試験ではない）。`MINECRAFT_NETHER_WALK_FROM="x,y,z"`、`MINECRAFT_NETHER_WALK_GOAL="x,y,z,range,goalType"`、`MINECRAFT_NETHER_WALK_DUMP="x1,y1,z1,x2,y2,z2"`（箱の中のブロックを層ごとに出す）。
- `scripts/minecraft-place-memory-probe.ts`: 設定コマンドを使わずに隔離ワールドへ参加し、身体が覚えた場所（種類ごとの件数、観測に載る `rememberedPlaces`、保存サイズ）と、チャンクを読む負荷（列あたりのms、tickの最大の間隔）を出す。`MINECRAFT_PLACE_GOALS="x,y,z,range;..."` で歩いた後にも出す。
- `scripts/minecraft-nether-chain-probe.ts`: 平地のラボワールド（`level-type=flat`）で、バケツ→水→溶岩を黒曜石に→黒曜石の採掘→火打石→ポータル建設→突入を実スキルで通す（計画器なし。鉄インゴットとダイヤのつるはしは支給で、受入試験には数えない）。環境変数は `MINECRAFT_NETHER_CHAIN_NO_LLM=true`、`MINECRAFT_NETHER_CHAIN_PORT`、`MINECRAFT_NETHER_CHAIN_WORLD_DIRECTORY`。`MINECRAFT_NETHER_CHAIN_LAVA_DEPTH=3` で溶岩を深さ3の湖にする（自然の溶岩に近い条件。黒曜石の下が溶岩のままになる）。全工程で3〜5分かかるので `run-lab-probe.sh`（上限300秒）ではなく直接実行する。

`scripts/minecraft-prompt-cache-probe.ts` は計画器のプロンプトキャッシュの条件を測る（承認済み台帳を通す少額の課金あり。台帳名と`MINECRAFT_CAMPAIGN_PAID_AUTHORIZED=true`が必要）。
- `scripts/minecraft-mob-fight-probe.ts` の囲いの試験: `MINECRAFT_FIGHT_BUILD=slit_cage`（持たせたブロックで `build-around-self` を呼ぶ。`MINECRAFT_FIGHT_KIT` に `cobblestone*64,cobblestone*64,cobblestone_slab*8`）、`MINECRAFT_FIGHT_PREFIGHT=<秒>`（建てる前に開けた場所で戦わせる対照）、`MINECRAFT_FIGHT_COLLECT=blaze_rod`（戦闘の後、拾う→中央へ戻る→建て直す）、`MINECRAFT_FIGHT_BREAK_SPAWNER=1`（拾う前に中からスポナーを掘る）。報告の `occupancy` は通路に相手がいた割合と、そのうち見えて手が届いた割合。全工程で5〜8分かかるので `MINEBOT_LAB_PROBE_TIMEOUT=560` を付ける。
- 同プローブの実地形モード: `MINECRAFT_FIGHT_REAL=the_nether` と `MINECRAFT_FIGHT_AT=<本物のスポナーの座標>`。何も建てず消さず、身体をスポナーの隣の空いたマスへ置く（`MINECRAFT_FIGHT_WALK_FROM="x,y,z"` を付けると、そこから `accept-threat`→`move-to` で歩いて近づく）。実走のワールドそのものではなく複製で行う（囲いが残ると、続行する実走の条件が変わる）: `cp -a progressive-lab-p2Gj5S progressive-lab-p2Gj5Sfort`、`server.properties` のポートを 25651 に変え、`tmux -L minebot-lab new-session -d -s codex-progressive-lab-25651 -c <複製> 'java -Xms512M -Xmx2G -jar fabric-server-launch.jar nogui'`。フォルダ名は英数字だけにする（プローブの隔離検査がハイフンを通さない）。
- 実走後の様子の図（スクリーンショットの代わり。ゲームの描画は gl のビルドが通らないので使えない）: `scripts/minecraft-box-dump-probe.ts` に `MINECRAFT_BOX="x1,y1,z1,x2,y2,z2"` と `MINECRAFT_BOX_JSON=<file>` を付けて実行（観察者がスペクテイターで見るだけ。ワールドは変えない）→ `python3 scripts/lab/render-box.py <file> <out.png> [--cut Y] [--body x,y,z] [--title 文字]`。ブロックを斜め上から見た立体で描き、Mob・落とし物・身体（`--body`、報告書の `actor.position`）を印で重ねる。`--cut` でその高さより上を外した断面も並べる。図は `saves/minecraft/lab-pictures/` に置いている。
- 復元（`minecraft-checkpoint-restore.ts`）は「移動→所持品を空にする→渡す」の順。報告書と追加分に無い物を持っていたら `unexpected` を出して失敗にする（L77ab: 前の実走が止まった囲いの中で空にしたため、床のロッドを拾っていた）。
