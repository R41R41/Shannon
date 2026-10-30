# 「続ける力」の契約（2026-10-30、契約の版 3.2）

次の大きな版「続ける力」（設計は共有メモ `next-version-design-20261028.md` の案 2）を、体の担当と頭の担当の 2 人で作るための契約です。
同じ文書が、頭（`shannon-ios` の `docs/continue-contracts.md`）、体（`Shannon` の `docs/continue-contracts.md`）、共有メモ（`continue-contracts.md`）にあります。
**変える時は 3 つを同時に変え、見本（fixture）の manifest の版を上げます。**

- 書いたのは契約・見本・通しの確かめの骨組みだけです。実装はまだ無く、ここに書いた型はまだどこにもありません。
- 「確か」は今のコードや記録で確かめた事、「決め」はこの契約で決めた事、「仮説」は確かめていない見込みです。数字の見込みは、どれも確かめていません。合格の条件・仮説・観測の結果を混ぜません。
- 基にした版：頭 `06f5e55`、体 `4e8c3df`（どちらも main。頭は v2 の後にミニシャノンの 2 commit が main に入ったので、その上に付け直した。契約の範囲のファイルには触れていない）。
- 実走 45 は終わりました（45 分、黒曜石 7、ネザー無し。保留 1〜11）。直しの実走で、途中で版が変わったので、版の効き目の比べには使いません。この契約では、失敗の型の題材としてだけ使います。
- 方針（00-README の 1〜7）：判断は LLM、細部は体。LLM が従わない時は書き方で直し、コードで強制しない。スイッチは付けない。段階に分けず、1 つの版で入れる。

## 版 3.1 で変えた事（v3 → v3.1）
Codex の 3 回目の見直し（`scratchpad\codex-contracts-answers\CONTRACTS-v3.md`、判定は「条件つき」。制御と盾は閉じた）の「入る前に直す物」5 つと、決めきれなかった 5 つの決め（共有メモ `continue-contracts-review-decisions.md` の末尾）を入れました。v3.1 は Codex にかけ直さず、そのまま実装に入ります。「実装の途中で直してよい物」は 13 章「実装の担当へ」に並べました。

| 直す物 | 主に変えた所 |
|---|---|
| 1 再起動と held の移り変わり | 1 章（結果の状態と保留の状態を 2 つの軸に、頭の再起動の時の `sent` と旧 headBoot の実行中の命令） |
| 2 出来事を切り捨てない | 3 章（配送の番号・ページ・`events` の命令の返事、受け取り箱からの処理し直し）、8 章（落とす規則を削った） |
| 3 deathSeq の比べ方 | 5 章（死の数え方の世代と番号の組） |
| 4 依存表の抜け | 2 章（依存先の状態を決める優先の順）、見本の表（解放後の unknown、操作 0 で終わった手）、10 章の境界 2 の照らし方 |
| 5 境界 8 の見本 | 10 章（unknown が決まるまで届けるのを止める注入、頭の再起動を配送の順で 2 場面に） |

## 版 3 で変えた事（v2 → v3）
Codex の 2 回目の見直し（`scratchpad\codex-contracts-answers\CONTRACTS-v2.md`、判定は「条件つきで実装に入ってよい」）と、取りまとめ役の v3 の決め（共有メモ `continue-contracts-review-decisions.md` の末尾）に沿って直しました。指摘は今のコードで確かめてから直しました。

| 条件・直す物 | 主に変えた所 |
|---|---|
| 1 失効の識別を仕上げる | 2 章の失効の表（次元の世代・頭の起動の登録・つなぎ直しの帰属）、5 章（死の証拠と番号の作り直しを分ける） |
| 2 unknown の移り変わりを保存まで | 1 章の「不明の結果」を状態の表に（ストア・safe・片付けの範囲・訂正・再起動） |
| 3 制御と盾の引き渡し | 4 章（引き継ぎの予約、失敗時の盾、根の文脈への盾の使用権の委譲） |
| 4 結果・依存・予算を実値で | 1 章（not_started と failed の境目、順のついたまとめ方、`lastSearch`）、2 章（判定表に released と pending、保持と開始を分ける、replace）、6 章（4 つの数） |
| 5 帳簿と証拠の届け方 | 3 章（重複除去の記録、観測の番号、送った時の定義の写し、出来事の分けた届け）、8 章（一度出す事実の配送、手の始まりを続けて取る、境界 8 の表、meter の時計） |
| そのほか | 保留 3 の見本は人の作った場面と明記、保留 9・再開 9→保留 10 の見本、`decision.reads` の作り方、実走 45 の終わり、「体の再起動は帳簿に影響しない」を仮説に |

## 版 2 で変えた事（v1 → v2）
Codex（gpt-6.1-sol）の見直し（`scratchpad\codex-contracts-answers\CONTRACTS.md`）と、取りまとめ役の決め（共有メモ `continue-contracts-review-decisions.md`、直す物 11 個と 13 の点）に沿って直しました。
Codex の指摘は、今のコードで確かめてから直しました。確かめた所は各章に「確か」で書いています。確かめて違っていた所は、12 章の終わりにまとめています。

| 直す物 | 主に変えた所 |
|---|---|
| 1 失効の優先の順 | 2 章の「失効を先に当てる」、5 章（life を必須に・照らす時機・次元・つなぎ直しの識別子） |
| 2 不明の扱い | 1 章の「不明の結果」（届け終えた・解放を確かめた を分ける、すぐの片付け、遅れた結果の訂正） |
| 3 制御の引き継ぎ | 4 章（token を作らず motor port の失効に統合、盾の引き渡し、bridge は延ばさない） |
| 4 依存の判定表を 1 枚に | 2 章の判定表と見本 `continue/dependency-table.json`、列の印の寿命 |
| 5 約束の帳簿 | 3 章（観測が正本、一意な出来事、送った時の rev、途中材・act の外の反射、不明の差、書く入口を 1 つ） |
| 6 count の意味 | 1 章の「既に済」の表（make・craft・mine を外す、attack は観測した死だけ） |
| 7 見本と境界の誤り | 見本の作り直し（パン 11 点、保留 1 を 2 つに、ほか）、10 章の判定 |
| 8 vertical | 6 章（`dir` を入力に、canDig を必須、未知・高さ・落下・置きの確かめ・砂利、段数と掘り・置きの数を分ける、seal の順） |
| 9 担当の抜け | 8 章（共有の WorkingEvent の種類）、9 章（版の合わない実物は不合格）、11 章の表 |
| 10 準備の skipped は LLM | 7 章（頭は事実だけ出す）、8 章の D6 の規範 |
| 11 実走 45 の失敗の型を入力に | 8 章の「判断に届ける事実」 |

## 目次

0. 共通の決まり（名前・単位・番号・見本の置き場）
1. 結果（目的の結果 × 実行の終わり方）
2. 続け方（失効が先、その後に依存の判定表）
3. 約束（帳簿）
4. 制御（持ち主の集め方と引き継ぎ）
5. 命の番号（life）と、つなぎ直しの識別子
6. vertical（縦の長い移動の手。下りも上りも）
7. 計画（kind と準備の状態）
8. 計測と、判断に届ける事実（D6 の規範を含む）
9. 見本（fixture）と、体の実物を頭の試験へ渡す仕組み
10. 通しの確かめの骨組み（10 の境界と、継ぎ目の場面）
11. 担当の分け方と作る順
12. 決めた事・決めきれなかった所・直さなかった指摘
13. 実装の担当へ（実装の途中で直してよい物）

---

## 0. 共通の決まり

- **型の名前は両側で同じ**にします。頭は `services/api/src/contracts/`、体は `backend/src/services/minebot/integration/commonFca/`（今の `minecraftControlContract.ts` と同じ「写し」の扱い）に置きます。新しいファイルは両側とも `continueContract.ts` です。
- 時刻はすべて ISO 8601 の UTC 文字列（`observedAt` と同じ）。長さはミリ秒の整数（`ms`）。
- 座標は `{x,y,z}` の整数のマス（`ActPos`）。
- 文（LLM が読む物）は日本語。コード（閉じた語・理由の番号）は英小文字とアンダースコア。
- **互換は要りません**（頭と体は同時に反映します）。古い形を読み続ける分岐は作りません。読み替えが要るのは、保存されている物（計画ツリー・保留のファイル・命の番号のファイル・場所の記憶・判断の記録）だけで、各契約の「移し方」に書きます。
- 見本の置き場：頭は `services/api/tests/fixtures/continue/`、体は `backend/tests/fixtures/continue/`。中身は同じで、`manifest.json` に各ファイルの sha256 があります（9 章）。
- **表が見本になっている物**（依存の判定表 `continue/dependency-table.json`）は、両側の実装がその表を読んで試験します。文書の表と見本の表が食い違ったら、見本の表が正本です。

---

## 1. 結果（目的の結果 × 実行の終わり方）

### ねらい
今は、体が `completed && inputsReleased` 以外で後ろを捨て、頭も `!result.ok` で後ろを取り消します（確か：体 `controlLoop.ts` の `launch()`、頭 `minecraftLlmcQueue.ts` の `settle()`）。「もう済んでいた」「途中まで進んだ」「始めていない」「結果が分からない」が区別できず、続けられません。
結果を **2 つの軸**で返します。今の `outcome`・`inputsReleased`・`cancelled`・`unknown` は、止める・送り直すの安全のために潰さず残します。

### 形
```ts
/** 目的の結果: その単位がねらった事が、今どうなっているか。 */
export type GoalOutcome =
  | 'done'         // この単位がやって、ねらいを満たした
  | 'already'      // 始めた時にはもう満たしていた（何も変えていない）
  | 'partial'      // 進んだが、ねらいまでは届いていない（progress に量と残り）
  | 'not_started'  // 体を動かす操作（motor の操作）を 1 つも始めていない（手を呼んだかどうかではない）
  | 'failed'       // 体を動かす操作を始めたが、ねらいへは何も進んでいない
  | 'unknown';     // ねらいの成否を観測できない（受け取りが無い、相手を見失った、など）

/** 実行の終わり方: その単位の実行が、どう終わったか。 */
export type RunEnd =
  | 'finished'   // 自分で終わった（成功でも失敗でも）
  | 'cut'        // 外から止められた（反射・stopIf・取り消し・期限・満杯・死・失効・引き継ぎ）
  | 'not_run'    // 始まらなかった（前の手で止まった・列で捨てた・前提を満たさない・保留中・失効）
  | 'unknown';   // 終わり方が分からない（受け取りの outcome が unknown、または解放を確かめていない。列の項目の単位だけ）

/** 外から止めた物・始めなかった理由（RunEnd が cut か not_run の時）。 */
export type CutBy = 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall'
  | 'death' | 'stale_life' | 'dimension_changed' | 'lease_expired' | 'connection_changed' | 'operator_stop' | 'handover';

/** 進んだ量と残り。単位は手の種類で決まる（下の表）。 */
export interface Progress {
  unit: 'step' | 'block' | 'item' | 'meter' | 'blow' | 'second';
  done: number;                 // 確かめた量（vertical なら確かめた移動の段数。置きの確かめが無い段は数えない）
  left: number | null;          // 分からない時は null
  at?: ActPos;                  // 止まった時の足の位置
  msPerUnit?: number;           // 実際にかかった 1 単位の平均（頭の残り時間の見積もりの直しに使う）
  work?: { dug: number; placed?: number; placeAttempts?: number; stockUsed?: number; placedConfirmed?: number };   // 段数とは別に数える
  /** vertical: 4 つの数（6 章）。go など他の手は dug・placed だけ。 */
  /** go: 止まった位置から行き先までの距離（m）と、道探しの先端から行き先までの距離（m）は別の物。 */
  fromStopM?: number; searchEndM?: number;
  /** go: 最後の道探し（保留 2・10）。len 0 の timeout は「行き先の周りが塞がっている」見込みの事実。 */
  lastSearch?: { status: 'success' | 'partial' | 'timeout' | 'no_path'; len: number; nodes: number; ms: number; endM?: number;
    blockedAround?: { at: ActPos; block: string; diggable: boolean }[] };   // 行き先の周り 1 マスの、通れない・掘れないマス（8 件まで）
}

/** 1 つの手の結果（今の ActHandLine に足す欄）。 */
export interface HandOutcome {
  goal: GoalOutcome;
  end: RunEnd;
  cutBy?: CutBy;                // end が cut か not_run の時
  code?: string;                // 閉じた理由の番号（'stuck'・'search_timeout'・'target_lost' など。今の「go 止まった <code>」の code）
  progress?: Progress;
  delta?: InventoryEvent[];     // 約束の帳簿のための持ち物の出来事（3 章）
  pass?: number;                // repeat の何周目か（1 から）
}

/** act の結果（今の ActResult に足す欄）。 */
export interface ActOutcome {
  goal: GoalOutcome;            // 手の goal から決める（下の決め方）
  end: RunEnd;
  cutBy?: CutBy;
  life: number;                 // この act を走らせた命の番号（5 章）
}

/** 列の項目の結果（MinecraftControlReceipt に足す欄）。 */
export interface ItemOutcome {
  goal: GoalOutcome;
  end: RunEnd;
  released: boolean;            // = 今の inputsReleased（同じ値を入れる。読み手が 2 軸を 1 か所で読めるように）
  /** 列で捨てられた時: 何のせいか（失効か、どの項目が止まったせいか）。 */
  droppedBecause?: { code: CutBy | 'depends_failed' | 'depends_unknown'; item?: QueueRef };
  /** 依存先が止まったが、この項目は頼っていないので動かした時（2 章）。 */
  keptDespite?: { item: QueueRef; code: string };
  startedAt?: string;           // 体が始めた（始めなかった項目には無い）
}
```

- `MinecraftControlReceipt` は今の欄をすべて残し、`unit?: ItemOutcome` を足します（act でない命令には付けない）。
- `ActResult`（`result` の JSON）は今の欄をすべて残し、`outcome: ActOutcome` を足します。`ActHandLine` には `HandOutcome` の欄を平らに足します。
- **`status` と新旧の対応、許される組み合わせ**は、2 章の判定表（見本 `continue/dependency-table.json` の `outcomes`）に 1 枚でまとめます。ここに別の表は置きません。
- **progress は primitive が構造で返します**（確か：今の `StepOutcome`（`utils/primitives/common.ts`）は ok・理由・文が中心で、量を持たない）。`runAct()` が文を読んで progress を作る形にはしません。`StepOutcome` に `progress?: Progress` と `events?: InventoryEvent[]` を足します。
- **repeat の周回**：今は 2 周目に `report.lines` を消します（確か：`act.ts` の `if (pass > 1) report.lines = []`）。新しい形では、行は `pass` を付けて周回ごとに残します（受け取りの大きさの上限は 8 章）。持ち物の出来事は周回ごとに数えます。

### 意味：手の種類ごとの「既に済」「進み」
「既に済」は、体が事実を見て決めます（選ぶのではない）。**今ある手の意味は変えません**。
- `make`・`craft` の `count` は「あと何個作るか」、`mine` の `count` は「何個掘るか」です（確か：`make.ts` は今の数 + count を目標にする）。「既に count 以上持っていれば already」は採りません。持っている数を目標にして止めたい時は、LLM が `done` 条件を書きます。

| 手 | already になる時 | progress の unit |
|---|---|---|
| eat | 満腹が 20（食べられない）。今の「満腹（20/20）なので … は食べられない」 | — |
| dig | そのマスが既に空気・水（今の「既に air（掘らずに次へ）」） | block |
| place | そのマスに既に同じ物がある | block |
| go・walk | 始めた時に行き先の range 内にいる | meter（`fromStopM` と `searchEndM` を分ける） |
| equip | 既にその物を着けている・持っている | — |
| make・craft・mine | 無し（count は追加の数） | item |
| smelt | 無し。入れる物が持ち物に無い時は failed | item |
| attack・fight | 体が相手の死を観測していた時だけ（12 章の決め 4）。実行中に見えなくなった相手は、成功とせず goal `unknown`・code `target_lost`（今の attack は「倒れたか、離れて消えた」で ok を返す。確か：`attack.ts`） | blow |
| pillarUp・jump | 無し | block |
| vertical | `dir: down` で既に toY 以下、`dir: up` で既に toY 以上（6 章） | step |
| wait | 無し（いつも done） | second |

act と列の項目の `goal` は、手の goal から**上から順に当てて、最初に当たった物**に決めます（順のついた完全な規則。見本 `continue/dependency-table.json` の `aggregate` が正本）。
1. `done` 条件（`doneMet`）で済んだ → `done`。
2. すべての手が done か already で、少なくとも 1 つ done → `done`。すべて already → `already`。
3. どれかの手の goal が `unknown` → `unknown`（攻撃の途中で相手を見失った act は、`failed` ではなく `unknown` のまま）。
4. どれかの手が done か partial → `partial`。
5. どれかの手が体を動かす操作を始めた（`motorOps > 0`） → `failed`。
6. それ以外 → `not_started`。
- 列の項目は、act の goal をそのまま使います。受け取りが無い・`outcome: unknown` の時は、頭が `goal: unknown`・`end: unknown` にします。

### 不明の結果（保存まで含めた 1 つの移り変わり）
- 確か：今の頭の `receiptOf()` は `outcome === 'unknown' || !inputsReleased` で `FCA_BODY_OUTCOME_UNKNOWN` を投げます。列の `settle()` は項目を `ended` にし、開いた項目が無ければ段を `acknowledged` にします（`minecraftLlmcQueue.ts` の `settleFlag()`）。ストアの `settle()` は、既にある受け取りと内容が違う物を受けず、`reconciledReceipt`（体が解放を証した時の閉じ方）の後だけ遅れた答えで置き換えます。`safe()` は、保存された outcome が unknown か inputsReleased が真でない操作を「未解決」とします（`store/minecraftControlStore.ts`）。列だけを直すと、次の段の安全の判定は未解決のままです。
- **1 つの操作（command）の状態**を、ストアに保存して、列・safe・帳簿・判断の入力が同じ物を読みます。

| 状態 | 入る時 | safe | 列の項目 | LLM へ |
|---|---|---|---|---|
| `sent` | 命令を入れた | 未解決（開いた項目として待つ物は除く。今どおり） | 開いている | — |
| `settled_known` | 受け取り（outcome が unknown でなく、inputsReleased が真） | 解決 | ended・released | 結果 |
| `settled_unknown` | 受け取りが unknown か inputsReleased が偽、または受け取りの期限切れ | 未解決 | ended・delivered（released ではない） | 「結果は不明（解放を確かめていない）。自動では出し直さない」 |
| `released` | 片付けの受け取りが解放を確かめた、または体のつなぎ直しの後の最初の poll が `activeOperationIds` 空・held でない（今の `reconcileOperations` の証し） | 解決（outcome は unknown のまま） | released | 「解放を確かめた（結果は不明のまま）」 |
| `corrected` | `settled_unknown` か `released` の後に、同じ command の本当の受け取り（known・inputsReleased 真）が届いた | 解決 | 訂正 | 「訂正: q12 の結果は … だった」 |
| `held` | 片付けが期限内に解放を確かめられなかった | 未解決 | — | 保留（incident と同じ扱い。操作者が resume か cancel） |

- **結果の状態と保留の状態は別の軸です**（v3.1）。上の表の `sent`〜`corrected` は結果の状態、`held` は保留の状態（`none`・`held`・`resumed`・`cancelled`）に分けて保存します。`held` になった後の 4 つの出来事は、次のとおりに組み合わせます。

| `held` の後に来た物 | 結果の状態 | 保留の状態 |
|---|---|---|
| 遅れた片付けの成功（解放の証し） | `released`（safe は解決） | `held` のまま（操作者を待つ） |
| 同じ command の本当の受け取り | `corrected`（訂正を LLM へ。帳簿へ 1 度） | `held` のまま |
| 操作者の resume | 変えない（不明なら不明のまま。出し直さない） | `resumed`（体の保留を解く。解放がまだなら、解放を確かめるまで動かす命令を送らない） |
| 操作者の cancel | 変えない | `cancelled`（タスクを止める） |

  - 結果の訂正と保留の解除は、どの順で来ても別々に当てます（訂正しても保留は解けず、resume しても結果は訂正されない）。

- **片付けの手順**：`settled_unknown` になったら、頭はすぐ stop（今の片付けの命令）を送ります。期限は stop を入れた時から 5 秒の上限（仮。成功の保証ではない）で、体側の片付けの中断の期限 3 秒（確か：`controlLoop.ts`）を内に含みます。5 秒で解放が確かめられなければ `held`。通信できない時も `held` です。
- **片付けの範囲は正式な結果です**：今の stop は待ちを全部捨て、実行中を止めます（確か：`controlLoop.ts`）。その時に捨てた・止めた項目は、受け取りの `cutBy: cancelled`・code `cleanup_stop` が確定した結果です。後から q1（不明だった物）の本当の成功が届いて q1 が `corrected` になっても、片付けで捨てた q3 は戻しません（頭が結果の順から列を作り直さない、2 章と同じ）。
- **解放を確かめるまで**、頭は体を動かす新しい命令を送りません（観測だけの命令は送ってよい）。
- **帳簿**：受け取りの持ち物の出来事は、`settled_known` か `corrected` で反映します。出来事の id で 1 度だけです（3 章）。
- **再起動**：
  - 頭の再起動：状態はストアにあるので残ります。起きた後、新しい `headBoot` を返事で登録すると、体は前の `headBoot` の待ちを捨て、**実行中の前の `headBoot` の命令も止めます**（`cutBy: connection_changed`。受け取りは今どおり ACK まで送り直す）。頭は、起きた時に `sent` か `settled_unknown` の操作があれば、体を動かす命令より先に片付けを送ります。`sent` の操作は、送り直されてきた受け取りで `settled_known`・`settled_unknown` に、受け取りが来ないまま片付けが解放を証したら `released`（結果は unknown）に移ります。前の操作がすべて `settled_known`・`released`・`corrected` になるまで、体を動かす命令を送りません。
  - 頭の再起動の後に送り直されてきた受け取り：ストアが ACK していなかった物は、ふつうに `settled` にします。訂正（`corrected`）になるのは、再起動の前に既に unknown を LLM へ知らせていた時だけです（12 章の決め 5、v3.1）。
  - 体の再起動：前の接続の操作は、新しい接続の最初の poll の証し（上の表）で `released` になります。結果は分からないまま（`corrected` にはならない）です。届けていなかった持ち物の出来事は失われ、観測との差は `unexplained` になります（3 章。仮説：失われる量はふつう小さい）。
- **不明の項目は、頭も体も自動で出し直しません**（境界 8）。保留の出し直し（`resume`）は、体が理由を言った失敗にだけ使います。

### 誰が書き、誰が読むか
- 体が書く：`HandOutcome`（`runAct()` と各 primitive の `StepOutcome`）、`ActOutcome`（`runAct()` と `NativeCommonFcaBody.execute()`）、`ItemOutcome`（`CommonFcaControlLoop.launch()`・`closeUnstarted()`・`begin()`）。
- 頭が読む：`readActResult()`、`createLlmcQueue()` の `settle()`・`drop()`・`itemResult()`、結果の文（LLM へ）、判断の記録。
- 頭が書く：`goal: 'unknown'`（受け取りが無い時だけ）、操作の状態（ストア）、訂正の文。

### 今のコードのどこが変わるか
- 体：`instantSkills/act.ts` の `runAct()`（手の結果・周回の行）、`utils/primitives/common.ts`（`StepOutcome` に `progress`・`events`）、各 primitive（progress と出来事、already の判定、attack の `target_lost`）、`utils/actReport.ts`（`HandLine`・`ActReport`・`renderActReport()`）、`integration/commonFca/nativeBody.ts` の `execute()`、`controlLoop.ts` の `launch()`・`closeUnstarted()`・`begin()`、`minecraftControlContract.ts`（写し）。
- 頭：`contracts/minecraftActContract.ts`（`ActHandLine`・`ActResult`・`readActResult()`）、`contracts/minecraftControlContract.ts`（`MinecraftControlReceipt.unit`）、`surfaces/minecraft/minecraftControl.ts` の `receiptOf()`・`reconcileOperations`、**`surfaces/minecraft/store/minecraftControlStore.ts` の `settle()`・`lateReceipt()`・`safe()`（操作の状態）**、`surfaces/minecraft/minecraftLlmcQueue.ts` の `settle()`・`settleFlag()`・`drop()`・`itemResult()`・`neverRan()`、片付けを送る所、結果の文を作る所。

### 移し方
保存されている物は無し（受け取りは保存しない）。判断の記録の古い行は、`unit` が無い物として読みます。

### 見本
`result/r43-reflex-ate-first.json`、`result/r45-hold1-go-partial.json`、`result/r45-resume1-dig-already-go-no-floor.json`、`result/unknown-receipt-cleanup.json`、`result/unknown-state-machine.json`、`result/act-not-started-reflex-late.json`、`result/count-keeps-its-meaning.json`、`result/attack-target-lost.json`、`result/resume-order.json`、`result/r45-resume9-replay-holds-again.json`、`result/r45-hold2-local-go-partial.json`、`result/r45-hold10-goal-blocked.json`、`result/r45-hold3-place-ok-then-world-differs.json`、`result/r45-hold9-face-air.json`、`result/r45-hold9-hand-at-send.json`、`result/held-two-axes.json`、`result/head-restart-sent.json`。

---

## 2. 続け方（失効が先、その後に依存の判定表）

### ねらい
失敗の時に「後ろの手をどこまで捨てるか」を、**LLM が明示した頼り（`dependsOn`）と始まりの条件（`pre`）**で決めます。前提を書いていない事は、頼らない証拠にしません。**頼りが明示されていない後ろの手は、今どおり捨てます。**
その前に、**列全体を失効させる事（死・次元・止め・lease・つなぎ直し）を必ず先に当てます**。依存の判定は、失効の対象外の項目だけに当てます（Codex の指摘 1。確か：死の時は待ちを全部捨てる設計なのに、v1 では `dependsOn: []` が残る、という矛盾があった）。

### 形
```ts
// act の中の手（ActHand に 1 欄足す。体の Hand の zod にも同じ欄）
interface ActHand {
  // …今の欄…
  /**
   * この手が頼る、同じ act の同じ周回の前の手の番号（1 から。ActHandLine.i と同じ数）。
   * 無い（undefined）: 今どおり。前の手が止まれば、この手も動かない。
   * []: どの手にも頼らない。前の手が失敗しても動く。
   * [1,3]: 手 1 と手 3 が「頼れる成果」（判定表）の時だけ動く。
   */
  dependsOn?: number[];
}

/** 列の印。task と列の世代で名前を分ける（12 章の決め）。 */
export interface QueueRef { queue: string; item: string }   // queue = `${taskId}:${headBoot}:${step}`、item = 'q12'

// 列の項目（ActInput と、体へ送る封筒 MinecraftQueueEnvelope に欄を足す）
interface ActInput { /* … */ dependsOn?: string[] }            // 頼る項目の印（'q12'。同じ列の中）。[] は「どれにも頼らない」
interface MinecraftQueueEnvelope { /* item, after, node, pre, maxMs, startBy */ queue: string; dependsOn?: string[]; madeIn: MadeIn }

/** その命令を作った判断が読んだ観測の識別（失効の判定に使う）。 */
export interface MadeIn { life: number; dim: Dim; dimSince: string; bodyBoot: string; connectionId: string; headBoot: string; obsSeq: number }

/** 依存先の状態（体の recent の作り替え。今は真偽を 16 件だけ持つ）。 */
export type DependState = 'succeeded' | 'failed' | 'pending' | 'unknown';
```

### 意味：失効を先に当てる
次の失効は、依存の判定より先に当てます。当たった項目は、`dependsOn` が何であっても始めません（`end: not_run`、`cutBy` にその理由）。

| 順 | 失効 | 当たる物 | 理由の語 |
|---:|---|---|---|
| 1 | 体のつなぎ直し・頭の再起動 | `madeIn` の `bodyBoot`・`connectionId`・`headBoot` が今と違う命令と、考え中の返事すべて | `connection_changed` |
| 2 | 死（命の番号が進んだ） | 前の命で作った命令すべて（実行中・待ち・ロック待ち・考え中の判断の返事） | `death` / `stale_life` |
| 3 | 次元の世代が変わった | `madeIn.dimSince`（次元の世代。観測の `dimensionSince`）が今と違う、ほかの命令（待ち・考え中の返事）。地上→ネザー→地上と戻っても世代は別なので失効する。**次元を変えている最中の命令そのものは妨げない**（今の act は、その中で次元が変われば後の手を止める。確か：`act.ts`） | `dimension_changed` |
| 4 | 止め（stop・release・操作者の止め） | 待ちすべて | `operator_stop` / `cancelled` |
| 5 | lease の失効（世代が古い） | その lease の命令すべて | `lease_expired` |

- **照らす時機**：受け取った時（`accept()`）、列の待ちから起きた時（`begin()`）、ロックを取った後（`executeAction()` の acquire の後）、体を動かす最初の操作の前（act の手ごと）。受け取った時だけでは足りません（待っている間に死ぬ・次元が変わる）。
- 動かす命令（`kind: skill` で readOnly でない物と `reflex`）では、`context.life` と `madeIn` を**必須**にします（列でない命令は `context.madeIn`）。無い命令は `life_missing` で断ります（5 章）。
- **頭の起動の登録**：頭は、poll の返事すべてに自分の `headBoot` を入れます（`MinecraftControlReply.headBoot`）。体は、1 つの接続の中で最後に受けた返事の `headBoot` を「今の頭」とします（poll と返事は 1 つずつ順に行き来するので、古い返事が後から届くことは無い）。`headBoot` が変わったら、体は前の `headBoot` の待ちを `connection_changed` で捨て、以後その `headBoot` の命令を断ります。
- **つなぎ直しの時の判断の帰属**：判断の入力は、それが読んだ観測の `bodyBoot`・`connectionId` に属します。使う直前に今の接続と比べ、違えば `connection_changed` で捨てて、新しい観測で判断し直します。
- **頭は、届いた結果の順から自分で取り消し直しません**。体が確定した「始めた（`startedAt`）・捨てた（`droppedBecause`）」を受け取りから読みます（Codex の競合例：体が独立な q2 を始めた後に、頭が q1 の失敗を読んで q2 を取り消す、を起こさない）。頭の `drop()` は、LLM が `replace` で書いた時と、失効を頭が先に知った時（考え中の返事）だけ使います。

### 意味：依存の判定表（失効の対象外の項目と手だけ）
**表は見本 `continue/dependency-table.json` が正本**で、頭と体の両方がその表で試験します。要点は次のとおりです。
- **依存先の状態**（`DependState`、実際の値で決める）は、**上から順に当てて最初に当たった物**です（重なりを残さない。v3.1）。
  1. 覚えていない印 → `unknown`
  2. まだ終わっていない（走っている・待っている） → `pending`
  3. `released` が確かめられていない → `unknown`
  4. end が `unknown`（解放の後も結果が不明のまま。片付けで `released` になった項目） → `unknown`
  5. goal が `done` か `already`、かつ end が `finished` → `succeeded`
  6. それ以外（goal が `unknown` で end が `finished` の target_lost、操作 0 で手が終わった `not_started`・`finished` も含む） → `failed`
  - 旧の `ok`・`outcome`・`inputsReleased` は判定に使いません（表の `outcomes` に 1 行ずつの対応がある）。
- **保持の判定と開始の判定は別です**：
  - 保持（待ちに残すか）：依存先がすべて `succeeded` か `pending` → 残す。どれかが `failed` → 捨てる（`depends_failed`）。どれかが `unknown` → 捨てる（`depends_unknown`）。
  - 開始（今始めてよいか）：依存先がすべて `succeeded`、自分の `pre` が真、体が held でない → 始める。どれかが `pending` → 待つ。
- **明示の依存は、手を始めるたびに必ず確かめます**。`onFail: 'continue'` は「失敗した手の後ろを止めない」という意味だけで、依存の確かめを免除しません（Codex の指摘 3）。
  - 例：手 1 の craft が失敗（onFail continue）、手 2 が `dependsOn: [1]` → 手 2 は動かない。手 3 が依存無し（undefined）→ onFail continue なので今どおり動く。
- **間接の依存**：手 2 が手 1 に頼り、手 3 が手 2 に頼る。手 1 が失敗 → 手 2 は not_run → 手 3 も not_run（手 2 が頼れる成果でないため）。
- **書き方の誤り**（送る前に頭が断り、体も形の誤りとして断る）：自分への依存、まだ先の手への依存、範囲外の番号、重複。
- **repeat**：`dependsOn` は同じ周回の手を指します。前の周回の結果は見ません。
- **列の項目**：項目 q が頼れる成果で終わらなかった時、待っている項目 w ごとに次のとおりにします。
  - `w.dependsOn` が配列で、q も、q のせいで捨てられた項目も含まない → 残して、順番が来たら始める（`keptDespite`）。始める直前に `pre` を確かめる（真なら始める・偽なら `precondition` で始めない・判定できない（不明）なら始めない）。
  - それ以外（無い・q を含む・捨てた項目を含む） → 今どおり捨てる（`droppedBecause: depends_failed`）。
  - 依存先の状態が `unknown`（別の列の印・覚えていない印）→ 始めない（`depends_unknown`）。
- **`after` は順番だけ**です。`BodyQueue.admit()` は、`after` の項目が止まっていても、新しい項目の `dependsOn` が配列でそれを含まなければ受けます。ただし、今の列の最後（tail）を飛ばして後ろに付けることはしません。
- **`replace`**：頭の `replace` は、書かれた項目を取り消し、その取り消しを後ろへ「失敗」と同じに伝えます。残るのは、`dependsOn` を配列で書き、取り消した項目を含まない項目（明示の独立）だけです。`dependsOn` を書いていない後ろの項目は取り消します（依存を書いていない事を独立の証拠にしない）。残した項目の順番（after）は付け替えます。体の `removeFrom()` も同じです（今は後ろを全部取る。確か：`bodyQueue.ts`、頭 `minecraftLlmcQueue.ts` の `replace()`）。
- **段をまたぐ `dependsOn`**：列の名前は段ごとなので、前の段の項目には頼れません。頭は送る前に「送らなかった: dependsOn の q9 は前の段の列（今の列で頼れるのは q12・q13）」と明示のエラーを返します（実行の時の `depends_unknown` まで遅らせない）。
- **列の印の寿命**：印は `QueueRef`（task・頭の起動・段の番号で名前を分けた列と、q 番号）です。頭の q 番号は今メモリ上のタスク別の数で、体の recent は裸の q 番号と真偽の 16 件だけです（確か）。体は recent を `QueueRef` → `DependState` に作り替え、少なくとも今の列の印はすべて覚えます。覚えていない印は `unknown` です。
- 体が held（解放を確かめていない）の時は、何も始めません（今どおり）。

### 誰が書き、誰が読むか
- LLM が書く（act の入力。短い書き方は `dependsOn=1,3`、項目は `dependsOn=q12`）。
- 頭は、読み取り・形の検査をして、封筒へ写します（列の名前・作った時の life と次元も入れる）。体は、失効と判定表に従って、始めるか捨てるかだけを決めます（何を頼るかは決めない）。

### 今のコードのどこが変わるか
- 体：`instantSkills/act.ts`（Hand の zod に `dependsOn`、手ごとの失効と依存の確かめ）、`integration/commonFca/bodyQueue.ts`（`ENVELOPE`、`admit()`、recent の作り替え、`removeFrom()`）、`controlLoop.ts`（`accept()`・`begin()`・`launch()` の終わり・`dropWaiting()`・`dropExpired()`・`cancelOne()`）、`execution/ActionExecution.ts`（acquire の後の照らし）。
- 頭：`contracts/minecraftActContract.ts`（`ActHand.dependsOn`、`ActInput.dependsOn`、`ACT_INPUT_SCHEMA`、`actProblem()`）、`contracts/minecraftActShortHands.ts`、`contracts/minecraftControlContract.ts`（封筒）、`surfaces/minecraft/minecraftLlmcQueue.ts`（`drop()`・`replace()`・`add()`・印の名前）、`surfaces/minecraft/minecraftControlValidation.ts`（欄の数の上限を 56 に。12 章の決め 1）。
- **欄の数**：体の Hand は今 43 欄です。この版で足す欄は `dependsOn`（2 章）と、vertical の `dir`・`shape`・`toward`・`toY`・`liquid`（6 章）の 6 つで、49 になります。頭の上限を 48 から 56 に上げます。受け入れの条件は「数の余裕」ではなく、体が作った catalog を頭の本物の検査に通すこと（今の local-gate の段 4）です。

### 移し方
保存されている物は無し。

### 見本
`continue/dependency-table.json`（判定表の正本）、`continue/act-hand-depends.json`、`continue/onfail-continue-does-not-exempt.json`、`continue/indirect-depends.json`、`continue/queue-item-depends.json`、`continue/keep-vs-start-pending.json`、`continue/admit-after-stopped.json`、`continue/no-depends-as-now.json`、`continue/death-before-depends.json`、`continue/replace-keeps-explicit-independent.json`、`continue/cross-step-depends-refused.json`。

---

## 3. 約束（帳簿）

### ねらい
作業台・燃料・食料の取り合い（実走 43 で板を燃料にして作業台が作れず、燃料と作業台のために地上へ上った）を、**消費の禁止ではなく、用途つきの帳簿**で LLM に見せます。下りることも燃やすことも、コードで断りません。

### 形
```ts
/** 約束 1 つ。頭の計画ツリーと一緒に保存する。 */
export interface PlanPromise {
  id: number;                   // #3。計画ツリーの中で 1 から増える。消しても使い回さない
  rev: number;                  // 改訂の番号（作った時 1）
  item: string;                 // 具体的な物の名前（'oak_planks'。ActCondition の have と同じ読み方で 'planks' は *_planks も数える）か、食料の点の 'food'。用途の語（fuel など）は無し
  count: number;                // 残す量
  use: string;                  // 用途（LLM の言葉、40 字まで。例 '作業台'・'地下で食べる分'）
  until?: { node?: string; condition?: ActCondition };  // 期間
  instead?: ActCondition;       // 代わりの条件（頭が判定できる語だけ。下の「代わりの条件」）
  state: 'open' | 'kept_by_instead' | 'closed';
  closedBy?: 'until' | 'released';
  ledger: PromiseEvent[];       // 表示用。古い順。32 件まで（古い物から落とし、落とした数を残す）
  dropped?: number;
}
/** 重複除去の記録（表示用の 32 件とは別に、計画ツリーと一緒に保存し続ける。タスクが終わったら消す）。 */
export interface LedgerSeen { eventIds: string[]; lastObs: { bodyBoot: string; connectionId: string; obsSeq: number } | null }
/** 送った時の約束の定義の写し（項目に覚える。改訂で item・count が変わっても、前の act はこの定義で帰属させる）。 */
export interface UsesSnapshot { id: number; rev: number; item: string; count: number; use: string }

export interface PromiseEvent {
  id: string;                   // 一意な番号（下の InventoryEvent.id をそのまま。made・revised などは `plan:<rev>`）
  at: string;
  kind: 'made' | 'revised' | 'consumed' | 'gained' | 'lost_death' | 'unexplained' | 'released' | 'closed';
  count: number;                // 動いた量
  have: number;                 // その後に観測した量（正本は観測）
  declared?: boolean;           // その act の uses にこの約束があった（LLM の申告。用途どおりに使ったとは言い切らない）
  reason?: string;              // 実際の理由（'smelt_fuel'・'craft_ingredient'・'eat'・'place'・'reflex_eat'・'death' など。体の出来事から）
  promiseRev?: number;          // 帰属させた約束の rev（その命令を送った時の rev）
  by?: { command?: string; item?: string; pass?: number; hand?: number };
}

/** 体が書く持ち物の出来事（手の結果の delta、act の外の反射は WorkingEvent `inventory.changed`）。 */
export interface InventoryEvent {
  id: string;                   // 一意: `${command}:${pass}:${hand}:${seq}`、act の外は `reflex:${connection}:${seq}`
  obsSeq: number;               // その出来事の直後の観測の番号（同じ接続の中で単調に増える。BodyObservation.sequence）
  item: string; count: number; // count は増えた量（+）か減った量（-）
  reason: 'ingredient' | 'fuel' | 'food' | 'placed' | 'thrown' | 'tool_broke' | 'crafted' | 'picked' | 'mined' | 'smelted' | 'reflex_eat' | 'reflex_armor' | 'death' | 'unexplained';
  intermediate?: boolean;       // make の途中で作ってすぐ使った物（板 → 棒 など）
}

// plan.update の ops に 2 種を足す（実行器は ops・current 以外を今どおり断る）。最初の計画の答えにも promises を書ける（12 章の決め 6。書かなければ空）
type PlanOp =
  | { op: 'promise'; id?: number; item: string; count: number; use: string; until?: { node?: string; condition?: string }; instead?: string }
  | { op: 'release'; id: number; why?: string };

// act の入力に 1 欄（頭だけが読む。体へは送らない。replace と同じ扱い）。頭は送った時の定義の写し（UsesSnapshot）を項目に覚える
interface ActInput { /* … */ uses?: number[] }
```

### 意味
- **約束を書くのは LLM だけ**です（最初の計画か `plan.update` の `op: 'promise'`）。`id` を書けば改訂（`rev` を 1 上げ、`revised`）、無ければ新しい番号です。
- **残りの量の正本は観測の値**です。帳簿の `have` は、出来事を足し引きした数ではなく、受け取り・観測ごとに持ち物から数え直した値です。
  - **観測の順**：`have` は、今までに反映した観測より新しい観測（同じ接続なら `obsSeq` が大きい、接続が替わったら新しい接続の物）でだけ書き換えます。古い受け取りが遅れて届いても、`have` を戻しません（`LedgerSeen.lastObs`）。
  - **重複除去の記録**：反映した出来事の id は、表示用の 32 件とは別に `LedgerSeen.eventIds` として計画ツリーと一緒に保存し続けます。32 件から落ちた後に同じ出来事が再び届いても（頭の再起動の後も）、2 度反映しません。
- **消費の説明は、体の一意な出来事で付けます**。頭は出来事の `id` で 1 度だけ反映します（同じ受け取りが 2 度来ても、遅れて来ても 2 重にならない）。
  - make の途中材（原木 → 板 → 棒 → 道具）は、`intermediate: true` の出来事で出します（確か：今の `make.ts` は途中材を作る。手の前後の持ち物の差だけでは、板の作りと消費が消える）。
  - 手の途中で反射が食べた分は、反射の出来事（`reflex_eat`）として 1 度だけ出し、手の出来事には入れません（2 重を防ぐ）。体は反射の台帳（`ReflexLedger`）で、どちらの物かを分けます。
  - act の外の反射の消費は、WorkingEvent `inventory.changed`（8 章）で出します（act が無いので、受け取りには乗らない）。
  - 出来事で説明できない持ち物の差は `unexplained` のまま残します（推して割り振らない）。
  - **出来事は件数だけに潰さず、切り捨てもしません**（v3.1。8 章の「落とす」規則は削った）。
    - 体は、1 つの command の中の出来事に、出した順の**配送の番号** `deliverySeq`（0 から。周回・手をまたいで command の中で一意）を付けます。出来事の `id` は今のまま（`${command}:${pass}:${hand}:${seq}`）で、`deliverySeq` は配送と回収のための番号です。
    - 受け取りには、`deliverySeq` の小さい順に入るだけの出来事と `eventsMore: { command, nextSeq, total }` を載せます。
    - 残りは観測だけの**内部の命令** `events`（`{ command, fromSeq, max }`。LLM には見せない、runnable で offered でない読み取り）で、ページごとに取ります。返事は `{ command, from, to, total, nextSeq, done, lost, events }` です。同じ範囲をもう一度頼んだら、同じ出来事を返します。体が記録を失っていたら（体の再起動など）`lost: true` を返し、頭はその差を `unexplained` にします。
    - 体は、受け取りと全部のページを頭が ACK するまで、その command の出来事の記録を消しません。
  - **保存と ACK の順**（v3.1）：頭は、受け取りと取ったページを**先にストア（永続の受け取り箱）へ保存してから ACK** します（今のストアの `settle()` は ACK の前に受け取りを保存している。確か：`minecraftControl.ts`）。帳簿と `LedgerSeen` への反映は、段の commit の時に、ストアの受け取り箱から行います（今の計画の保存は段の commit の時。確か：`fcaPlanTools.ts`）。反映の前に頭が止まっても、起きた後に受け取り箱から処理し直し、`LedgerSeen` が 2 重を防ぎます。
  - **再起動の後も残す物**：`UsesSnapshot` は、送った命令の行（ストアの操作の行）に一緒に保存します。回収の位置（次に取る `deliverySeq`）もその行に保存します。
- **帰属**：約束への帰属は、その act を送った時の定義の写し（`UsesSnapshot`。id・rev・item・count・use）で決めます。送った後に約束を改訂して item まで変わっても、前の act の消費は前の定義のままです。`uses` は LLM の申告で、`declared: true` として見せます。「用途どおりに消費した」とは書きません。申告と実際の理由（`reason`）を並べて見せます。
- **死**（5 章の命の番号が進んだ）：開いている約束ごとに `lost_death` を記録します。約束は開いたまま残し、解くのは LLM です。
- **期間**：`until.node` の節が done になった時、または `until.condition` を満たした時に `closed`（`closedBy: 'until'`）。`release` は `closed`（`released`）。
- **代わりの条件**：頭が観測から判定できる語（have・food・hunger・hp・dim・at・free・time）と、体が観測に足す `near` だけを使えます。今の頭は `near`・`furnace` を常に「判定できない」にしています（確か：`minecraftConditions.ts`）。体は観測に、作業台・かまど・チェスト・ベッドの近くの位置を証拠つきで足します：`state.world.utilities = { radius: 8, dim, obsSeq, scanned: boolean, found: [{ block, at, distance }] }`。頭の `near` は、`scanned` が真で、条件の半径が `radius` 以内の時だけ判定します（無ければ「判定できない」）。`furnace` は今どおり判定できない語です。
  - 代わりの条件は**観測のたびに評価し直します**。成り立たなくなったら、live に「約束 #3 の代わりの条件が成り立たなくなった（作業台から 95 段離れた）」を 1 度出します（実走 45 の、作業台を地上に置いて 95 段下りた件）。
- **live の 1 行**（事実だけ。番号順、開いている物だけ、4 つまで）：
  - `約束 #3 作業台用の板 4: 今 2・直前に 2 減った（理由: かまどの燃料。申告の用途ではない）（足りない 2）`
  - `約束 #4 地下で食べる分の食料 20 点: 今 22 点・直前に 11 点減った（理由: 食事。申告の用途）`
  - `約束 #3 作業台用の板 4: 今 0・代わりの条件を満たす（作業台 1）`
  - `約束 #3 作業台用の板 4: 今 0・死んで 1 失った`
  - 「直前に」は、前の判断から後の出来事だけです。急ぎの版にも同じ行を入れます（境界 10）。
- **断らない**：頭も体も、約束を理由に手を断りません。
- **書く入口は 1 つ**：計画ツリーへの書き込み（約束・解除・帳簿の反映）は、計画の道具の持ち主（`fcaPlanTools.ts` の tree と checkpoint）を通す 1 つの入口にします（確か：今の計画の道具は内部の tree を更新し、checkpoint で保存する。列の settle から別の帳簿を書くだけでは、その tree に入らない）。頭の担当は、`planPort.applyLedger(events)` のような入口を作り、settle はそこを呼びます。
- **再起動**：頭の再起動の後も、計画ツリー（帳簿と `LedgerSeen`）と一緒に読み戻します。体は帳簿を持ちませんが、届けていなかった出来事は体の再起動で失われ、観測との差は `unexplained` になります（仮説：失われる量はふつう小さい。境界 8 で確かめる）。

### 誰が書き、誰が読むか
LLM が書きます（約束・解除・`uses`）。頭が帳簿を書き、live の 1 行を作ります。体は持ち物の出来事を書きます。読むのは LLM（live）と計測（判断の記録）です。

### 今のコードのどこが変わるか
- 頭：`packages/mind/src/planTree.ts`（`PlanTree.promises`、`applyPlanUpdate()` に `promise`・`release`、保存の形 v2）、`mind/action/fca/fcaPlanTools.ts`（op の enum と欄、帳簿を反映する入口）、`surfaces/minecraft/minecraftFirstPlan.ts`（`FIRST_PLAN_SCHEMA_R4` に `promises`）、帳簿（新しい `surfaces/minecraft/minecraftLlmcPromises.ts`）、`surfaces/minecraft/minecraftConditions.ts`（`near` を観測から）、live への 1 行（`minecraftLlmcLive.ts`・`minecraftLlmcUrgent.ts`）、`ActInput.uses` と送った時の rev（`minecraftActContract.ts`、`minecraftLlmcQueue.ts`）、表示（`BodyPlanView`）。
- 体：各 primitive の出来事（`make.ts`・`craft.ts`・`smelt.ts`・`place.ts`・`body.ts` の eat ほか）、`instantSkills/act.ts`（手の出来事を集める）、`utils/actReport.ts`、`integration/commonFca/nativeBody.ts`（反射の台帳から反射の出来事、観測の `state.world.utilities`）、`integration/commonFca/bodyEvents.ts`（`inventory.changed`）。

### 移し方
- 計画ツリー v1 は `promises: []` として読みます（7 章の移し方と同じ時に）。
- 保留のファイル・場所の記憶は変わりません。

### 見本
`promise/r43-planks-burned-as-fuel.json`、`promise/table-crafted-placed-picked.json`、`promise/food-for-underground.json`、`promise/death-loses-promised.json`、`promise/revised-after-send.json`、`promise/make-intermediate-and-reflex.json`、`promise/instead-lost-after-descent.json`、`promise/same-receipt-twice.json`、`promise/seen-after-32-and-restart.json`、`promise/late-old-observation.json`、`promise/events-split-delivery.json`、`promise/receipt-box-then-ack.json`、`promise/life-file-reset-is-not-death.json`。

---

## 4. 制御（持ち主の集め方と引き継ぎ）

### ねらい
今、体の「誰が動かしているか」は 4 か所にあります（確か）。
1. 通信側の `CommonFcaControlLoop.owner`
2. 操作側の `executeAction()` と `SkillExecutor` のロック（優先度つき。溶岩 400・壁 420・creeper/矢の退避 350・掘り出し 300・低体力の逃げと melee 250・食事 200・反射 100）
3. 戦いの `markHeadCombat()` と `holdMeleeForHead()`
4. 反射の状態（`floorReflexes.busy`・`fleeEpisode`・`melee`・`lavaReflex.engaged`・`breathingReflex.engaged`。読むのは `reflexHeld()`）

新しい持ち主の欄（5 つ目の本当の事）は作りません。実走 45 の 6.4 秒は `fight()` の外、`NativeCommonFcaBody.afterReflex()` の待ちで、待ったのは `attack` の列でした（確か：run45-live、`nativeBody.ts`）。

### 形
```ts
/** 体の制御の持ち主（観測の state.control）。持ち主の正本は実行層の「体を動かす根の文脈」。 */
export type ControlHolder =
  | { kind: 'idle' }
  | { kind: 'command'; actionId: string; command: string; item?: string; life: number; since: string }
  | { kind: 'reflex'; actionId: string; reflex: string; priority: number; target?: number; since: string; episode?: boolean }
  | { kind: 'bridge'; after: string; hold: 'shield' | 'step_back'; target?: number; since: string; until: string }
  | { kind: 'cleanup'; command: string; since: string };

export interface ControlView {
  holder: ControlHolder;
  /** 反射の episode が続いている（ロックを一瞬放した間も）。戦いの印が残っている。どちらもロックの写しではない別の事実。 */
  reflexEpisode?: { reflex: string; target?: number; hands: number; hits: number; since: string };
  combatMark?: { skill: string; target?: number; until: string };
  waiting: { command: string; since: string; behind: string }[];   // 反射の後を待っている命令
}

/** act の結果に足す欄: 反射から引き継いだ時。 */
export interface Handover { from: string; target: number; waitedMs: number; reflexSettledAt: string; confirmed: boolean; shield: 'kept' | 'lowered' | 'dropped' | 'none' }

/** 引き継ぎの予約（実行層が持つ。止めた反射の actionId から作り、取得と 1 つにして確かめる）。 */
export interface HandoverReservation { fromActionId: string; reflex: string; target: number; life: number; forCommand: string;
  holderSeq: number;            // 予約した時の、根の文脈の取得の通し番号（取得のたびに 1 増える。query・入れ子では増えない）
  shield: boolean;              // 盾の使用権を予約が持っている
  at: string; until: string }   // until は at + 300 ms（待つ上限。合格の条件ではない）

/** 体から頭への出来事（MinecraftBodyEvent.kind。頭の共有の WORKING_EVENT_KINDS にも足す。8 章）。 */
type ReflexCapped = { kind: 'reflex.capped'; subject: string /* reflex */; data: { limit: 'melee_hands' | 'melee_hits' | 'budget_arrow' | 'budget_eat' | 'budget_armor'; count: number; bridge: 'shield' | 'step_back' | 'none'; until: string | null } };
```

### 意味
- **token は作りません**。今ある motor port の失効の確かめ（`createMotorPort()` の `Motor owner expired`：持ち主の文脈が止められた・片付いた・静まった時に操作を断る。確か）を、持ち主の正本にします。失効の仕組みを 2 つにしません（Codex の指摘 6・直す物 3）。
  - **持ち主が替わるのは、体を動かす根の文脈を取った時だけ**です。観測だけの呼び出し（query）と入れ子の呼び出しでは替わりません（確か：今の `executeAction()` は query でも世代を上げ、入れ子は親の文脈を使う。持ち主の数え方は query を除く）。
  - 体の操作（キー・道探しの行き先・盾・手の物の使用）は、今の持ち主の根の文脈からだけ効きます。持ち主が替わった後の古い処理の操作は、motor port が断ります。
  - **今の穴**：止める時の片付け（`physicalStops()` の `deactivateItem()`・`clearControlStates()`）は native の bot へ直接行うので、持ち主が替わる前に盾が下がります（確か：`ActionExecution.ts`）。常駐の盾（`shieldBlock.ts`）も直接 `activateItem`・`deactivateItem` します（確か）。次のとおり直します。
- **引き継ぎの手順**（`afterReflex()` を直す）：
  1. 受け取った act の、最初の体を動かす手（already になる手は飛ばす）が `fight` か `attack` で、相手が今の反射の episode の `target` と同じか確かめる。
  2. 引き継げる反射は `floor-melee` と、体力が 5 より上の時の `floor-last-stand`（hit の手）だけです（12 章の決め 3）。低体力の逃げ（`floor-flee`）・溶岩・壁・退避・掘り出し・息・食事・防具は奪いません。普通の act の優先度は一律には上げません（食事を止めないため）。
  3. 実行層に**引き継ぎの予約**（`HandoverReservation`）を作ってから、反射を `handover` の理由で止めます。片付けは、`handover` の時だけ盾を下げず（`physicalStops()` に理由を渡す）、盾の使用権を予約へ移します。前へ進むキーなど、それ以外の操作は片付けます。
  4. 反射の根の文脈が settled になります（確か：今の実行層は settled の時に文脈を active から消し、ロックを放す。なので「今の持ち主がその反射のまま」は確かめられない。予約で確かめる）。
  5. **予約と取得を 1 つにして確かめます**（`SkillExecutor.acquire` の中で）：予約がある・期限内・`holderSeq` が予約の時のまま（間に別の持ち主が取っていない）・相手がまだいる・命の番号が同じ。すべて真なら act が取り、盾の使用権も act の根の文脈へ移ります（`confirmed: true`）。
  6. どれか偽、または 300 ms を越えたら、予約を消します。**予約が持っていた盾は、予約を消す処理が下ろします**（新しい持ち主が盾の使用権を受けていなければ）。act は今どおり待ちます（`confirmed: false`）。死・別の反射の取得・期限のどれでも同じです。
  7. act の結果の `handover` に、待った秒・盾をどうしたかを入れます。
- **盾の使用権**は、体を動かす根の文脈（持ち主）が持ちます。常駐の盾（`shieldBlock.ts`）は、持ち主の盾の委譲の下で動きます：持ち主が盾を委ねている間（fight・attack・引き継ぎ）は、常駐の盾が持ち主の motor port を通して上げ下げします。持ち主がいない時は、常駐の盾が自分で上げ下げします。
  - 「持ち主のいない時だけ常駐の盾が動く」形は採りません。今の fight は盾を自分で上げず、常駐の盾に任せている（打つ時は常駐の盾の `attack` の包みが下げ、次の tick で上げ直す。確か：`fight.ts`・`shieldBlock.ts`）ので、守りが落ちます。
  - **「盾が一度も下がらない」と約束するのは、引き渡しの区間（反射を止めてから、act が最初の操作をするまで）だけ**です。攻撃のための意図した上げ下げは許します。
- **相手が違う時**：反射は今の 1 手（melee は 2 打まで）を終え、次の手を始めません（今の `holdMeleeForHead()` を attack にも広げる）。act はその後に始めます。
- **反射の上限の後**：
  - melee の上限は、episode の手数と打ちの数（`MELEE_MAX_HANDS`・`MELEE_MAX_HITS`）です（確か：`floorReflexes.ts`）。`FloorBudget` は arrow・eat・armor の時間の予算で、別の物です（確か：`floorBudget.ts`）。知らせは `limit` で、どちらの上限かを分けます。
  - 上限に着いた時、体は `reflex.capped` を 1 度出します（頭はこれを急ぎの理由にする）。
  - つなぎ（bridge）は、**反射が既に選んでいた動き（盾を構えている・一歩下がっている最中）を短く続けるだけ**です。新しい動きは選びません。`until` は最初の知らせから 3 秒まで（仮の数）で、続く知らせで延ばしません。終わりの条件は、命令が始まった・相手がいなくなった・体力が 5 以下（低体力の反射へ戻す）・期限の 4 つです。
- **戦いの間の事実を判断へ**（実走 45 の、約 5.3 の打ちを続けて受けても「軽微」とした件）：直近 10 秒に受けた打ちの数と量、今の体力、すぐ食べられる物と回復の見込みを、急ぎの版にも残します（8 章）。引き継ぎの速さだけを D4 の成功の物差しにしません。

### 誰が書き、誰が読むか
体が `state.control`・`handover`・`reflex.capped` を書きます。頭が live と急ぎの理由に読み、判断の記録に残します。

### 今のコードのどこが変わるか
- 体：`execution/ActionExecution.ts`（持ち主の数え方と取得の通し番号、`physicalStops()` に理由、盾の使用権）、`execution/SkillExecutor.ts`（予約と取得を 1 つに）、`integration/commonFca/nativeBody.ts`（`afterReflex()` の引き継ぎ、`observe()` に `state.control`）、`utils/floorReflexes.ts`（episode の target、`handover` で止まる、上限で `reflex.capped` とつなぎ）、`utils/combatOwner.ts`（`holdMeleeForHead()` を attack にも）、`utils/shieldBlock.ts`（持ち主の盾の委譲の下で動く）、`integration/commonFca/bodyEvents.ts`、`minecraftControlContract.ts`（写し）。
- 頭：`packages/mind/src/workingEvents.ts`（`WORKING_EVENT_KINDS` に `reflex.capped`。8 章）、`contracts/minecraftControlContract.ts`、`surfaces/minecraft/minecraftLlmcLive.ts`・`minecraftLlmcUrgent.ts`、`surfaces/minecraft/minecraftControlValidation.ts`（`state.control` の形）。

### 移し方
保存されている物は無し。

### 見本
`control/r45-attack-waited-6-4s.json`、`control/different-target.json`、`control/high-priority-not-taken.json`、`control/melee-capped-bridge.json`、`control/stale-owner-cleanup.json`、`control/handover-race.json`、`control/handover-reservation.json`、`control/shield-kept-on-handover.json`、`control/shield-delegation-during-fight.json`、`control/fight-damage-facts.json`。

---

## 5. 命の番号（life）と、つなぎ直しの識別子

### ねらい
実走 45 の +929 で、死んだ後に、死ぬ前の判断の act（q52 attack）が始まりました（確か：run45-live）。今の頭の死の判定は「前の観測が死亡・次が生存」の移りで、ポーリングがその間を飛ばすと分かりません（確か：`minecraftControl.ts` の `arrivalOf()`）。

### 形
```ts
export interface LifeView {
  life: number;          // 1 から。体が死の出来事で 1 増やす（ファイルが読めない時の作り直しでも増える。下の resetBy）
  /** 番号が前より進んだ理由。死の証拠は 'death' だけ（帳簿の lost_death・頭の arrival の death はこれで決める）。 */
  advancedBy?: 'death' | 'file_unreadable';
  /** 死の数え方の世代と番号の組（v3.1）。世代はファイルを作り直した時に新しくなる（乱数）。番号は死んだ時だけ 1 増え、世代が新しくなると 0 から。 */
  deathEpoch?: string;
  deathSeq?: number;
  since: string;         // その命が始まった時（ログインか、死の出来事の時）
  alive: boolean;        // 死んでからリスポーンまでは false（新しい番号でも alive:false の間がある）
  diedAt?: string;
  deathCause?: string;
  dimension: Dim;
  dimensionSince: string;
}
/** 体の起動とつなぎの識別子（life とは別。頭の再起動・体のつなぎ直しをまたぐ物を見分ける）。 */
export interface BodyRun { bodyBoot: string; connectionId: string }   // bodyBoot は体のプロセスの起動ごとの乱数
// 観測: facts.life（number）と state.life（LifeView）と state.bodyRun（BodyRun）
// 命令: BodyTaskContext に life: number・headBoot: string・madeIn: MadeIn（動かす命令では必須。2 章）。life は「その命令を作った判断が読んだ観測の life」
// 返事: MinecraftControlReply に headBoot: string（頭の起動の登録。2 章）
```

### 意味
- **体が番号を進めます**。`bot.on('death')` の時に 1 増やし、ワールドとボットごとのファイル（保留のファイルと同じ所の `life.json`）に書きます（12 章の決め 2）。
  - ファイルが無い時（初めてのワールド）は 1 から始めます。
  - **ファイルがあるのに読めない時は、黙って 1 へ戻しません**。その時刻から作る大きな番号（ミリ秒の時刻）で始め、`advancedBy: 'file_unreadable'` を付けて黒箱に書きます。頭から見ると番号が大きく跳ぶので、古い命令は必ず失効します。
  - **失効の識別と死の証拠は分けます**：番号が進んだら古い命令は失効します（理由を問わない）。しかし死として扱う（帳簿の `lost_death`、頭の arrival の `death`）のは、**同じ `deathEpoch` の中で `deathSeq` が増えた時**だけです。`deathEpoch` が変わったこと自体は死に数えません（ファイルの作り直しでは持ち物は残っている）。体は新しい世代を必ず 0 から数えるので、頭は新しい世代の基準を 0 とし、それより大きい番号を見たら（その世代の最初の観測でも）死とします。世代が変わって番号が小さくなっても、取りこぼしません。
- **次元の移りは死ではありません**。番号は変わらず、`dimension`・`dimensionSince` だけが変わります。ただし次元の移りは、2 章の失効の 3 番で、移る前の観測で作ったほかの命令を失効させます。
- **照らす時機**（2 章の失効の 2 番）：受け取った時・待ちから起きた時・ロックを取った後・体を動かす操作の前。`alive: false` の間に動かす命令は始めません（`not_alive`）。
- **体がする事**：
  - 動かす命令で `context.life` が無ければ `life_missing` で断ります。
  - `context.life` が今の番号と違えば `stale_life`・`not_run` で断ります（手は動いていない）。
  - 死の出来事で、待っている項目を全部捨て（`droppedBecause: death`）、実行中の手を止め（`cutBy: death`）、ロック待ちと反射の後の待ちを `aborted` にします。
- **頭がする事**：
  - 命令の `context.life` は、**判断の入力に読んだ観測の life** を入れます（送る時の最新ではない）。今の context は送る時に `minecraftReflexAdapter.ts` で作っています（確か）。判断の入力の life を、項目に持たせて渡します。
  - 考え中の判断の返事は、使う直前に最新の観測の life・次元・`bodyRun` と比べます。違えば `discarded`（理由 `life_changed`・`dimension_changed`・`connection_changed`）にして、新しい観測で判断し直します。
  - `arrivalOf()` は、同じ `deathEpoch` の中の `deathSeq` の増えで `death` を決めます（`facts.life` の増えだけでは決めない）。
  - 頭の起動ごとの `headBoot` を命令に入れます。体は、つなぎ直しの前の `headBoot` の命令を断ります（2 章の失効の 1 番）。
- **lease・タスクの世代（`generation`）とは別**です。保留（incident）は命の番号を照らしません（`release` は手ではない）。

### 誰が書き、誰が読むか
体が番号と `bodyRun` を書きます。頭が読み、命令に写します。体は命令の番号を照らします。

### 今のコードのどこが変わるか
- 体：`integration/commonFca/nativeBody.ts`（`observe()`、`execute()` の照らし）、`controlLoop.ts`（`accept()`・`begin()` の照らし、死の時の `dropWaiting`）、`instantSkills/act.ts`（手ごとの照らし）、`execution/ActionExecution.ts`・`SkillExecutor.ts`（ロック待ちを止める、取った後の照らし）、新しい `utils/life.ts`、`utils/incidents.ts`（保留のファイルに life。読むだけ）。
- 頭：`contracts/bodyControlContract.ts`（`BodyTaskContext.life`・`headBoot`）、`surfaces/minecraft/minecraftControl.ts`（`arrivalOf()`）、`surfaces/minecraft/minecraftReflexAdapter.ts`（context に判断の入力の life）、`mind/action/fca/fcaRunner.ts`（破棄）、`surfaces/minecraft/minecraftLlmcQueue.ts`、判断の記録（`request` と `sent` に life）。

### 移し方
`life.json` が無い時は 1 から。読めない時は上のとおり。保留のファイルに life が無い時は、読むだけなので何もしません。

### 見本
`life/r45-death-then-old-attack.json`、`life/portal-is-not-death.json`、`life/portal-pending-other-dimension.json`、`life/same-dimension-return.json`、`life/head-boot-registration.json`、`life/reconnect-decision-belongs.json`、`life/death-at-each-moment.json`、`life/life-file-unreadable.json`、`life/death-epoch-pair.json`。

---

## 6. vertical（縦の長い移動の手。下りも上りも）

### ねらい
実走 45 の保留 1・4〜6 は、岩の中を深く下りる `go` の道探しの時間切れでした。保留 7 は、柱を積んで y=7 から 56 へ上る `go` が 120 秒で着かなかった件で、最後はブロックの変化で引き直しを続けました（確か：run45-live）。
縦の長い移動の形と危険の扱いを LLM が決め、体は一段ずつ機械的に掘る・置く・歩く手を、**`mc.act` の中の手の 1 種 `vertical`** として足します（列は `skill === 'act'` だけを受けるため）。

### 形
```ts
interface ActHand {
  do: 'vertical';
  dir: 'down' | 'up';                     // 向き。入力に書く（今の y から推さない。12 章の決め 12）
  /** stairs: 階段 / shaft: 縦穴で真下（dir down だけ） / pillar: 足の下に置いて真上（dir up だけ）。体は形を変えない */
  shape: 'stairs' | 'shaft' | 'pillar';
  toward?: 'north' | 'east' | 'south' | 'west';  // stairs では必須。shaft・pillar では使わない
  toY: number;                            // どの y まで（足の y）
  canDig: string[];                       // 掘ってよい物（必須。pillar でも頭の上を掘るのに使う）
  maxDig?: number;                        // 掘る数の上限（砂利・砂の掘り直しも数える）
  canPlace?: string[];                    // 置いてよい物（pillar の足場、stairs の上りの足場、seal の塞ぎ。書いた順に使う）
  maxPlace?: number;                      // 置く数の上限
  liquid: 'stop' | 'seal' | 'seal_water'; // 溶岩・水が見えた時: 止める／塞いで続ける／水だけ塞ぎ溶岩で止める
  range?: number;                         // 塞ぐ範囲（既定 1、最大 2）
  seconds?: number;
}
// 短い書き方:
//   vertical down stairs south y=10 dig=stone,dirt,gravel [maxDig=80] [place=cobblestone] [maxPlace=20] [liquid=stop|seal|seal_water] [range=1] [seconds=120]
//   vertical down shaft y=-50 dig=stone,deepslate,tuff place=cobblestone [maxPlace=30] liquid=seal
//   vertical up pillar y=63 dig=stone,dirt place=cobblestone [maxPlace=60] liquid=seal_water [seconds=120]
```
- 頭は、形と向きの食い違いを送る前に断ります（`shaft` で up、`pillar` で down、`stairs` に `toward` が無い、`canDig` が無い）。

### 意味
- **LLM が決める物**：向き・形・どの y まで・掘る/置くの許し・溶岩と水の扱い・上限の秒。
- **体がする物**：一段ずつ掘る・置く・歩くだけです。道探しは使いません。回り道・形の変更・向きの変更・鉱石を追うことはしません。
  - `stairs` の down：向きへ 1・下へ 1 のマスと頭の上の 2 マスを掘って歩きます。`stairs` の up：向きへ 1・上へ 1 の 2 マスと今の頭の上の 1 マスを掘って上がり、足場が無ければ `canPlace` の物を置きます。
  - `shaft`：足の下を掘って 1 段落ちます（`shaftDown.ts` の `shaftStepRefusal()` で確かめる）。
  - `pillar`：頭の上 2 マスが空いていなければ掘り（`canDig` に無ければ止める）、跳んで足の下に置きます。
  - 使い回す部品は `tunnelWalk.ts` の段ごとの掘りと歩き・`shaftDown.ts` の確かめです。ただし `walkCells()` をそのまま使うと、液体・床・落下の今の方針を持ち込みます（確か：`tunnelWalk.ts`）。vertical の許可と上限を通す形に部品を分けます。`planStairLine()` と `StairMine.runImpl()` は使いません。
- **置きの送る条件と確かめは分けます**（12 章の決め 13）：
  - 送る条件：体がそのマスに重なっていない（保留 8 の `mayLayAt`）、当てる面にブロックがある（保留 9 の `hasFace`）、pillar では足がマスの上端より上にある（margin は仮説で 0.2。実物の試験で決める）。
  - 確かめ：置いた後に、そのマスのブロックの更新を見ます。確かめられない置きは `placedConfirmed` にも `stepsValid` にも足しません（`placeAttempts` には数える）。続けて 2 回確かめられなければ `code: 'place_unconfirmed'` で止めます。
- **止める場面**（どれも `progress` と止まった位置を返す）：
  - 次に掘る・入るマスが未知・読み込まれていない → `unloaded`
  - 世界の高さの端（下は y=-64、上は y=320 の手前） → `world_limit`
  - 途中で体が落ちた・押し戻された（予定の段から 1 マス以上ずれた） → `displaced`（`where` は今の位置）
  - `canDig` に無い物（岩盤・守られた物を含む） → `cannot_dig`（文は「canDig に {名前} を足せば進む」。壊して困らない邪魔な物は canDig に無くても掘る。下の「実走46 の後の体の直し」）
  - 露出の守り（見えない敵に身体が見える・届くようになる掘り）が止めた → `threat_exposed`
  - 落ちる段が 1 を超える穴・空洞（down） → `no_floor`。足場を置けない（up の stairs） → `no_place`
  - 掘る数・置く数の上限 → `limit_dig`・`limit_place`。砂利・砂の掘り直しも掘る数に数え、上限に着けば止めます
  - 上限の秒 → `limit_time`
- **液体**（`liquid`）：
  - `stop` → `code: 'lava'` か `'water'` で止めます（`where` はその液体のマス）。
  - `seal`・`seal_water` は、**LLM が許した範囲での機械的な処理**です。候補の順は「液体のマスそのもの → 次に入るマスに面した液体の隣の空き（近い順）」、使うブロックは `canPlace` の書いた順、予算は `maxPlace` と `range` です。塞げなければ `code: 'seal_failed'` と位置・理由（物が無い・届かない・予算）を返します。`seal_water` は溶岩なら止めます。
- **鉱石**：見えた鉱石は `seen`（種類と座標、8 件まで）で知らせるだけで、追いません。
- **数え方は 4 つを分けます**（予算と成果を同じ数で扱わない）：

| 数 | 意味 | 予算に数えるか | 後の訂正で減るか |
|---|---|---|---|
| `placeAttempts` | 置きを送った数（送らずに止めた物は数えない） | `maxPlace` はこれで数える | 減らない |
| `stockUsed` | 在庫から減った数（観測の差） | — | 減らない |
| `placedConfirmed` | 置いた後にブロックの更新で確かめた数 | — | 減らない（その時に確かめた事実） |
| `stepsValid` | 今も有効な段数（下った・上った段で、足場や段が今も世界にある物） | — | 減る（block の更新・押し戻しで、無くなった段を引く） |

  - 掘る予算 `maxDig` は、掘りを送った数（砂利・砂の掘り直しも 1 回ずつ）で数えます。後の訂正で予算は戻りません。
  - `stepsValid` を訂正するのは、**今回の手で通った段と、その段が成り立つのに要るマス（足場・頭の上）だけ**です。その範囲でブロックの更新を観測し、段が成り立たなくなったら引きます。まだ読み込まれていない所・観測していない所を、消えたことにしません（12 章の決め 4、v3.1）。残りの距離は今の位置と `toY` から求め、移動の実績との照らしは別にします。
  - 訂正に使ったブロックの更新と押し戻し（forcedMove）は、8 章の操作の連続記録にも入れます（境界 2 の証拠）。
- **止まった時**：`progress: { unit: 'step', done: stepsValid, left, at, msPerUnit, work: { dug, placeAttempts, stockUsed, placedConfirmed } }` を返します。`done` は今も有効な段数です（階段の 1 段は 2〜3 マスを掘るので、掘った数とは別）。LLM は、その `at` から新しい手を出して続けます。体は前の手を覚えません。
- **既に済**：`dir: down` で既に toY 以下、`dir: up` で既に toY 以上なら `already` です。
- **頭の見積もり**：1 段あたりの見積もり × 段数から始め、体が返す `msPerUnit` で直します（`minecraftActTime.ts`）。見積もりの初めの値（stairs 約 1.6 秒・shaft 約 1.0 秒・pillar 約 0.9 秒）は仮説で、旧 go の段数（保留 5 の 95 段・保留 7 の 49 段）も新しい手の保証にはしません。
- **下りる前の警告**（頭の今の準備の警告）は、`dir: down` の vertical にも go と同じように出します。

### 今のコードのどこが変わるか
- 体：`instantSkills/act.ts`（`HAND_KINDS`・Hand の zod・`runHand()`）、新しい `utils/primitives/vertical.ts`、`utils/tunnelWalk.ts`・`utils/shaftDown.ts`（許可と上限を受ける部品に分ける）、`utils/actHandRules.ts`、`utils/actLabel.ts`、`utils/actReport.ts`（閉じた語）。
- 頭：`contracts/minecraftActContract.ts`、`contracts/minecraftActHandRules.ts`、`contracts/minecraftActShortHands.ts`（読み書きと断り）、`contracts/minecraftActTime.ts`、下りる前の警告（`minecraftLlmcReadiness.ts` ほか）。

### 移し方
保存されている物は無し。

### 見本
`vertical/r45-hold1-stairs-down.json`、`vertical/r45-hold5-shaft-down.json`、`vertical/r45-hold7-pillar-up.json`、`vertical/lava-seal-and-stop.json`、`vertical/stop-cases.json`、`vertical/counts-and-budget.json`、`vertical/boundary2-evidence.json`、`vertical/short-hands.json`。

---

## 7. 計画（kind と準備の状態）

### ねらい
今の節の種類は、題名の正規表現で決まっています（21 か所。下の表）。題名を言い換えると知識・不足・meter が変わります。準備の「省いた」は、`done` と注記「準備を省いた…」で表しています（`descentClosed()`、`prepSkipped()`）。**札（`kind`）と準備の状態（`prep`）を、計画ツリーの本当の欄にします。** 準備を省くかどうかは LLM が決めます。

### 形
```ts
export type PlanKind =
  | 'wood' | 'stone_tools' | 'food' | 'bed' | 'village' | 'prep_descent'
  | 'iron' | 'iron_armor' | 'diamond' | 'water' | 'lava' | 'obsidian' | 'portal'
  | 'nether' | 'fortress' | 'blaze' | 'pearl' | 'stronghold' | 'end' | 'dragon'
  | 'chest' | 'other';

/** 準備の節の状態（作業の状態 state とは別）。書くのは LLM だけ。 */
export type PrepState = 'met' | 'skipped' | 'unmet_now';   // 済み・省いた・今は満たせない

export interface PlanNode {        // packages/mind/src/planTree.ts
  // id, parentId, order, title, state, where?, doneWhen?, note?, reason?, forbid?, caution? は今のまま（where は今どおり文字列）
  kind?: PlanKind;
  kindRaw?: string;                 // LLM が列に無い kind を書いた時の元の値（kind は other）
  prep?: { state: PrepState; why?: string; at?: string };
}
export interface PlanTree {
  schema: 'shannon.plan-tree.v2';
  revision: number; current: string | null; nodes: readonly PlanNode[];
  promises: readonly PlanPromise[];   // 3 章
}
// PlanNodeDraft・plan.update の add/split/set・最初の計画の答え（FIRST_PLAN_SCHEMA_R4 の節）に kind と prep を足す。
// 最初の計画の parent は今どおり string（根は ''）。
```

### 意味
- **`kind` を付けるのは LLM**です（最初の計画と `plan.update`）。頭は付けません（題名から推しません。推すのは v1 の読み替えの時だけ）。付いていない節は `other`。列に無い値は `other` として受け、元の値を `kindRaw` と判断の記録に残します（知識が届かない事実として数えられるように）。
- **`prep` は準備の節の状態**で、作業の状態（`state`）とは別です。**書くのは LLM だけ**です（`plan.update` の set）。頭のコードは `skipped` を書きません（直す物 10。方針 1・2 に合わせる）。
  - 頭は、準備の条件を満たさないまま下りた時（今の `descentClosed()` が見ている場面）に、**事実を出します**：「準備の節 p3（食料 40・作業台か板 4）は満たしていない（食料 17.6 点）が、y=16 まで下りている」。`skipped` にするか、準備を続けるかは、LLM が plan.update で書きます。
- **meter**（`meterLine()`）：`skipped` の節は「省いた」と書き、達成とは数えません。`unmet_now` も遅れに数え、満たせない理由を見せます（12 章の決め 9）。meter の時計は「保留を除いた秒」です（8 章）。
- 実走 45 で、準備の節 p1.3「畑・干し草で食料」が約 1,198 秒「今」のまま止まりました。頭が出す事実（満たしていない・どこにいる）が LLM に届いて、`skipped` や別の節へ移るかは、Sonnet の試験で見ます（コードで閉じない）。
- **題名で決めていた所は、全部 `kind` で選ぶ形に替えます**。判定の値（段・不足・選ばれる知識・近くの候補）は題名を言い換えても変わりません。表示の文（meter の名前など）は題名を使ってよいので、言い換えると変わります。境界 9 は、この 2 つを分けて確かめます。

| # | 今の所（頭 `services/api/src/surfaces/minecraft/`） | 今の決め方（題名・文） | 新しい形 |
|---|---|---|---|
| 1 | `minecraftLlmcReadiness.ts` `preparationStage()` | 今の節の題名を END/GATE/DIAMOND の正規表現 | 今の節（と先祖）の `kind`：end・stronghold・pearl → end、portal・obsidian・nether → nether_entry、diamond → diamonds |
| 2 | `minecraftLlmcReadiness.ts` `gateBack()` | `/ゲート\|ポータル/` | `kind === 'portal'` で `where` を持つ節 |
| 3 | `minecraftLlmcReadiness.ts` `foodFirstLine()` | `FOOD_NODE` か `food>=` | `kind === 'food'` |
| 4 | `minecraftLlmcNode.ts` `isPrepNode()`（`planNowOf`・`followNode`・`openPreparation`・`heldByPreparation`） | `PREP_TITLE` か `food>=` | `kind` が `prep_descent` か `food` |
| 5 | `minecraftLlmcNode.ts` `chestNodesDone()` | `CHEST_NODE` | `kind === 'chest'` |
| 6 | `minecraftPlanDone.ts` `isPrepMilestoneNode()` | `/地下の準備/` か `food>=40〜99` | `kind === 'prep_descent'` |
| 7 | `minecraftPlanDone.ts` `descentClosed()` | doneWhen の `UNDERGROUND_WORK`、#6、`/確かめられない/` | 地下の仕事は `kind` が iron・iron_armor・diamond・obsidian・nether。**閉じずに事実を出す**（上） |
| 8 | `minecraftPlanDone.ts` `prepSkipped()` | 注記が「準備を省いた」で始まる | `prep.state === 'skipped'`（LLM が書いた物） |
| 9 | `minecraftLlmcRoad.ts` `isDragonPlan()` | `/ドラゴン\|エンドラ/` | いずれかの節が `kind === 'dragon'`（か最初の計画の種類） |
| 10 | `minecraftLlmcRoad.ts` `meterLine()`（`doneInPlan`・`prepEnd`・`names`） | #6・#8・#9 | `kind` と `prep`（表示の名前は題名のまま） |
| 11 | `minecraftLlmcRoad.ts` `label`（表示だけ） | 題名の括弧の前 | そのまま |
| 12 | `minecraftLlmcV2Knowledge.ts` `stagesFor()`・`STAGE_WHEN` | planNow と plan.next の文を 5 つの正規表現 | 今の節と次の節の `kind` から段を引く表 |
| 13 | `minecraftLlmcObsidianWays.ts` `obsidianWays()` | planNow に `/黒曜石/` | 今の節か次の節の `kind` が obsidian・portal |
| 14 | `minecraftLlmcLiveRewrite.ts` `addPack()` | planNow に `/エンド\|ストロング\|ドラゴン\|アイ/` | `kind` が end・stronghold・pearl・dragon |
| 15 | `minecraftLlmcReachWords.ts` `nearNeeds()` | plan.next と planNow に FOOD/BED/TRADE の正規表現 | `kind` が food・bed・village |
| 16 | `minecraftLlmcRoute.ts` `goalOf()` | 表示した planNow の文から座標を切り出す | 節の `where` の文字列を、1 つの位置の読み手（`readWhere()`、新しく 1 か所に置く）で読む。表示の文からは読まない（`where` は今も文字列。構造の位置は作らない） |
| 17 | `minecraftLlmcLiveRewrite.ts` `rewritePlan()` | 表示した文の `p1.2` の形 | 節の id を直接比べる |
| 18 | `minecraftLlmcUrgent.ts` `planNowTitle()`（表示だけ） | 表示した文の切り出し | 節の題名を直接読む |
| 19 | `minecraftFirstPlan.ts` `carryDone()` | 題名の同じさ | `kind` と `doneWhen` が同じ（題名は見ない） |
| 20 | `minecraftFirstPlan.ts` `gateFirst`・`ironFirst`・`DROPPED_BEFORE_GATE` | 種の定数の題名の同じさ | 種の節に `kind` を付け、`kind` で選ぶ |
| 21 | `minecraftFirstPlan.ts` `planGoal()` | タスクの目的の文（節ではない） | そのまま |

（表は 2026-10-28 に頭 `e4e1174` を調べた物。作る時に、題名・`planNow` の文を正規表現で読む所が残っていないか、もう一度 grep で確かめる。）

### 誰が書き、誰が読むか
LLM が `kind`・`prep` を書きます。頭は書きません（事実の 1 行を出すだけ）。読むのは頭（上の表の所）と、表示（体の UI MOD は `BodyPlanView` で `kind` を表示に使ってよい。動きには使わない）です。

### 今のコードのどこが変わるか
- 頭：`packages/mind/src/planTree.ts`、`mind/action/fca/fcaPlanTools.ts`、`surfaces/minecraft/minecraftFirstPlan.ts`、上の表の所、新しい `readWhere()`、`contracts/bodyControlContract.ts`（`BodyPlanView` に `kind`）。
- 体：`BodyPlanView` の写し（表示だけ）。

### 移し方（保存されている計画ツリー）
- v1 のツリーを読んだ時、1 回だけ v2 に読み替えます。
  - `kind` は、今の題名の正規表現（上の表の 1〜15 の物）で推して付けます。正規表現が残るのは、この読み替えの関数 1 つだけです。
  - 注記が「準備を省いた」で始まる節は `prep: { state: 'skipped' }` にします（v1 の頭が書いた物をそのまま読み替える。新しい頭は書かない）。準備の節で `state: done` の物は `prep: { state: 'met' }` です。
  - `promises: []` を足します。
- 読み替えた事は、計画の改訂の記録に 1 行残します。

### 見本
`plan/first-plan-with-kind.json`、`plan/title-renamed-same-decisions.json`、`plan/descended-without-prep-fact.json`、`plan/migrate-v1-to-v2.json`、`plan/unknown-kind.json`。

---

## 8. 計測と、判断に届ける事実

### ねらい
D1（結果と続け方）と D4（制御）の効きを分けて測ります。止まってから次の有効な操作までを段に分け、記録を同じ番号の組でつなぎます。判断の記録（`docs/decision-records-2026-10.md`）を土台にして広げます。
あわせて、**判断に届けなければならない事実**（D6 の規範と、実走 45 の失敗の型）を決めます。

### 形
```ts
/** 記録をつなぐ番号の組。1 つの欄だけではつながらない（失敗した命令と、次に動いた命令は別）。 */
export interface TraceIds {
  run: string;              // 実走の番号（頭の task id。判断の記録のフォルダ名と同じ）
  decision?: string;        // 判断の番号（'d0015'）
  reads?: string[];         // その判断の入力に入れた受け取りの command（下の「decision.reads の作り方」）
  command?: string;         // 命令の番号
  queue?: string; item?: string;   // 列の名前と印（QueueRef）
  hand?: number;            // act の中の手の番号（ActHandLine.i、1 から）
  pass?: number;            // repeat の周回
  life: number;
  bodyBoot?: string; headBoot?: string;
  obsSeq: number; obsAt: string;
}

/** 体が受け取りに付ける時刻（MinecraftControlReceipt に足す）。 */
export interface BodyTimes {
  acceptedAt: string; startedAt?: string; lockAt?: string; firstMotorAt?: string;
  failedAt?: string; endedAt: string; reflexWaitMs?: number;
  motorOps?: number;        // この命令が実際に効かせた操作の数（「一度も動かない」の判定に使う）
}

/** 頭が判断の記録に足す行（events.jsonl）。 */
type StageRow =
  | { ev: 'received'; at: string; ids: TraceIds; receipt: { outcome: string; unit?: ItemOutcome }; bodyTimes: BodyTimes }
  | { ev: 'released'; at: string; ids: TraceIds; by: 'receipt' | 'cleanup'; ok: boolean }
  | { ev: 'corrected'; at: string; ids: TraceIds; was: 'unknown'; now: ItemOutcome }
  | { ev: 'woke'; at: string; ids: TraceIds; why: 'failure' | 'remaining' | 'message' | 'alert' | 'furnace' | 'reflex_capped'; predictedRemainingMs?: number }
  | { ev: 'live'; at: string; ids: TraceIds; raw: string; shown: string; dropped: { field: string; count: number; why: string }[]; bytes: number }
  | { ev: 'input_change'; at: string; ids: TraceIds; promptHash: string; thinkingDropped?: { reason: string; count: number }; historyChanged?: 'resume' | 'summary' | 'none' };

/** 手の始まりの記録（体の黒箱に足す種類 'hand_start'）。 */
export interface HandStart {
  ids: TraceIds; at: string;
  pos: ActPos; hp: number; food: number; saturation: number;
  inventory: string;        // 'cobblestone×20,oak_planks×5,…'（名前順）
  holder: ControlHolder;
  lastOps: { at: string; op: string; detail?: string }[];   // 直前の操作 16 件
}

/** サーバーの tick（体の出来事 'server.tick'）。仮の案（12 章の決め 8）。 */
type ServerTick = { kind: 'server.tick'; data: { raw: string | null; parsedMspt: number | null; frozen: boolean | null; at: string; error: string | null } };

/** 体の版（ポールに足す）。 */
interface BodyVersion { revision: string; catalogHash: string }

/** 頭の共有の WorkingEvent の種類に足す物（packages/mind/src/workingEvents.ts の WORKING_EVENT_KINDS）。 */
// 'reflex.capped' | 'server.tick' | 'inventory.changed' | 'utility.near'
```

### 意味：共有の WorkingEvent
- **新しい出来事の種類は、頭の共有の `WORKING_EVENT_KINDS` に先に足します**（確か：`packages/mind/src/workingEvents.ts`。知らない種類は捨てられるのに、その seq は受け取り済みに進むので、体は送り直しを止める。黙って消える）。頭の担当が足し、体の担当はその版の後で送ります（同時に反映するので、反映の時には必ずそろう）。

### 意味：decision.reads の作り方
- 頭は、判断の要求を作る時に、入力へ入れた受け取りの結果（列の知らせ・結果の文）の command を、入れた順に `reads` として判断の記録の `request` の行に書きます。入れなかった物（圧縮で落とした物）は入れません。
- これで「失敗した命令 → それを読んだ判断 → その判断が出した命令」をつなぎます（`sent` の行の `decision` で後ろとつながる）。

### 意味：meter の時計
- 確か：実走 45 の live の meter の「今」と節目の t が、保留を含む壁時計の秒でした（acc +944 なのに「今 5,693 秒・鉄のツルハシ 5,343 秒遅れ」）。
- meter の時計は「保留を除いた秒」（監査の保留の区間を引いた秒。今の時間の上限と同じ数え方）に統一します。

### 意味：時間の段

| 段 | 始まり | 終わり | 時計 |
|---|---|---|---|
| 1 失敗 → 知らせ | `BodyTimes.failedAt` | 頭の `received.at` | 体・頭（同じ VM） |
| 2 知らせ → 判断の始まり | `received.at` | 判断の記録の `request.at` | 頭 |
| 3 判断 | `request.at` | `response.at` | 頭 |
| 4 返事 → 送信 | `response.at` | `sent.at` | 頭 |
| 5 送信 → 体の受け取り | `sent.at` | 次の命令の `acceptedAt` | 体 |
| 6 受け取り → ロック | `acceptedAt`（待った物は `startedAt`） | `lockAt` | 体 |
| 7 ロック → 最初の有効な操作 | `lockAt` | `firstMotorAt` | 体 |

- 段 1 は失敗した命令、段 5〜7 は次の命令の物です。**つなぐのは `run`・`life`・判断の番号（失敗を読んだ判断 → その判断が出した命令）の組**で、`command` だけではつながりません。
- 重なる手戻り（先読みで送った物）は、壁時計で 1 度だけ数えます。
- **先読み**：`woke` の `remaining` の時は、見積もった残りと実際の終わりの差を測ります。
- **手の始まりと操作の記録は、続けて取ります**（訂正に使ったブロックの更新と押し戻しも入れる）：黒箱は直近 90 秒の輪で、成功した act には書かないことがあります（確か：`blackbox.ts`、実走 45 の記録）。120 秒の手では最初の 30 秒が消えます。通しの台（A・B・C）では、体は始めから終わりまで、`hand_start` と体を動かす操作の 1 件ずつ（時刻・命令・手・life・操作の種類）を、輪とは別のファイルに追記し続けます（成功した手・120 秒を越えた手も含む）。本番でも同じ入口を使い、大きさの上限は判断の記録と同じ考えで決めます。
- **命令の種類ごとの証拠の組**（境界の判定で使う）：
  - 始める前に断った：受け取り（`not_run` と理由）だけ。`hand_start` は無くてよい。
  - already：受け取りと手の行。
  - 普通の操作：受け取り・`BodyTimes`（`lockAt`・`firstMotorAt`・`motorOps`）・`hand_start`。
  - unknown：受け取りと、片付けの受け取り（`released` の行）。
- **入力の変化を分けて記録します**（`input_change`）：プロンプトのハッシュ、thinking の破棄（実走 45 の `prefix_binding_mismatch` 16 回）、再開による履歴の変化。前後を比べる時は、これらを D1・D4 の効果と混ぜません。
- **サーバーの tick**：体は、今ある RCON（`SceneSaver` の command）で `tick query` を送り、生の応答・取った時刻・失敗をそのまま残します。止まっている時（frozen）や読めない時を 0 ms にしません。間隔は 10 秒の仮の案で、負荷を測って決めます。
- **大きさ**：受け取りの結果の JSON は今 16,000 字が上限です（確か：`minecraftControlValidation.ts`、`actReport.ts` は地図を落としても上限内になる保証が無い）。上限は変えません。周回の行が多い時は、受け取りには新しい周回の行を入れ、古い周回の行は数と要約にしてよい（表示のため。結果の判定は `outcome` で決まる）。**持ち物の出来事は落とさず、3 章の配送の番号とページで届けます**（v3.1）。境界 10 は最大の長さで試します。

### 意味：判断に届ける事実（D6 の規範と、実走 45 の失敗の型）
規範は「どの入力の版（普通・急ぎ・圧縮の後）でも、最後の要求に残す物」です。頭はこれを満たすように live を作り、`live` の行で確かめます。

| 事実 | 普通 | 急ぎ | 圧縮の後 | 元の件 |
|---|---|---|---|---|
| 体力・満腹・食べられる物と回復の見込み | 残す | 残す | 残す | 実走 43 の瀕死 |
| 直近 10 秒に受けた打ちの数と量 | 残す | 残す | 残す | 実走 45 の +929 |
| 今の持ち主（`state.control.holder`）と命の番号 | 残す | 残す | 残す | D4・D5 |
| 約束の 1 行（4 つまで） | 残す | 残す | 残す | 3 章 |
| 列の今（項目・状態・残りの見込み）と、手の予定の効果（行き先・置く・掘る・作る物） | 残す | 残す | 残す | 実走 45 の、同じ行き先の go を 4 秒後に二重に出した件。目的をコードで推して重複を断ることはしない |
| 持ち物の空き・次の手で増える見込み・満杯の理由 | 残す | 残す | 1 行 | 実走 45 の、満杯でダイヤのツルハシが作れず拾えなかった件。何を捨てるかは LLM が決める |
| 近くの食べ物の候補（動物と魚。24 m 以内。食料が 40 点未満の時は少なくとも 3 件） | 残す | 3 件 | 3 件 | D6（鱈・鮭が判断に届かなかった） |
| 代わりの条件が成り立たなくなった事 | 1 度出す | 1 度出す | — | 3 章 |
| 準備の節を満たさないまま下りた事 | 1 度出す | — | — | 7 章 |
| go・vertical の止まった位置からの残りと、道探しの先端までの残り | 残す | 残す | 残す | 保留 1 |
| 置きが ok の後で世界が違っていた事の訂正（block の更新・押し戻し・確かめた段数の直し） | 1 度出す | 1 度出す | — | 保留 3 |
| 再開の時の、前の結果・出し直したか・新旧の命令の関係 | 1 度出す | 1 度出す | — | 保留 1〜9 の再開 |

- 距離・件数の数（24 m・最大 3 件の優先枠・打ちの 10 秒の窓）は初めの値で（推測）、効き目は確かめていません。**候補が 3 件より少ない時は全部出し**、無い分を作りません。距離・個体の id・打たれた時刻は残します。「消さなかった」ではなく「最後の要求に届いた」で確かめます（境界 10）。
- **「1 度出す」事実の届け方**：1 度出すと決めた事実は、**最後の要求（`recordedClient` が送るバイト）に入った時に届けたもの**とし、それまでは持っておきます。圧縮で落ちた・急ぎの版に入らなかった時は、次の判断の入力にまた入れます。表の「—」は「その版には入れない（届けたことにもならない）」の意味です。
- **再開の契約**：再開した時、頭は前の結果（`skipped` か、出し直した結果）を先に届け、その後で新しい判断を求めます。出し直した命令は前の命令の印（`resumeOf`）を持ち、結果の文に「保留した q12 の出し直し」と書きます。
- **近い go の時間切れ**（保留 2：4 段上の畑への go が、道が見つかった直後に 60 秒に着いた）と、**行き先の周りが塞がった go**（保留 10：2 m 先の同じ高さへの探索が道 0 マスのまま 5 秒で時間切れ）は vertical の外に残ります。go の結果に、着いた所・止まった位置からの残り・最後の道探し（`lastSearch`、塞いでいる物を含む）・使った秒を出し、続けるかは LLM が決めます。
- **再開の時の結果の届け方**（再開 9 → 保留 10）：出し直しが別の理由でまた保留になった時、出し直しの結果と、その間に列に入っていて捨てられた項目（の印と why）を、保留の記録に残します。次の再開（skip-replay でも出し直しでも）の後の最初の判断へ、「保留した act の出し直しは search_timeout で再び保留になった。その間の q65（[p5] 近い鉄を掘る）は捨てた」を先に届けます。

### 今のコードのどこが変わるか
- 頭：`packages/mind/src/workingEvents.ts`（種類）、`infra/decisionRecords/*`（行の種類・`TraceIds`・`reads`）、meter の時計（`minecraftLlmcRoad.ts`）、`surfaces/minecraft/minecraftControl.ts`（`received`・`released`・`corrected`）、`surfaces/minecraft/minecraftLlmcQueue.ts`（`woke`、先読み）、live を作る所（`minecraftLlmcLive.ts`・`minecraftLlmcLiveRewrite.ts`・`minecraftLlmcUrgent.ts`・`minecraftLlmcReachWords.ts`・`minecraftLlmcReadiness.ts`・`minecraftLlmcPack.ts`）、`minecraftBodyVersion.ts`、`scripts/decision-record.ts`。
- 体：`controlLoop.ts`（`acceptedAt`・`startedAt`）、`nativeBody.ts`（`lockAt`・`reflexWaitMs`）、`execution/ActionExecution.ts`（`firstMotorAt`・`motorOps`）、`instantSkills/act.ts`（`failedAt`・手の始まり）、`utils/blackbox.ts`（`hand_start` と、輪とは別に続けて追記する操作の記録）、`utils/sceneSave.ts`（`tick query`）、`utils/actReport.ts`（大きさの上限の落とし方）、ポールの `bodyVersion`。

### 移し方
判断の記録の古い本は、新しい行が無い物として読みます。

### 見本
`measure/trace-ids.json`、`measure/hand-start.json`、`measure/hand-start-continuous.json`、`measure/evidence-by-command-kind.json`、`measure/live-before-after-fish.json`、`measure/urgent-max-input.json`、`measure/one-time-fact-delivery.json`、`measure/meter-clock-excludes-holds.json`、`measure/prefetch-woke.json`、`measure/inventory-full-facts.json`、`measure/queue-and-effects-in-input.json`、`measure/input-change.json`。

---

## 9. 見本（fixture）と、体の実物を頭の試験へ渡す仕組み

### 2 種類の見本
1. **契約の見本**（手書き。この branch で作った物）
   - 契約ごとの入出力の実物を、実走の場面から作りました。頭と体に同じ物を置き、`manifest.json` に各ファイルの sha256 と契約の版があります。
   - 両側のテストは、まず自分の写しが manifest と合うかを確かめます。local-gate は、体と頭の 2 つの写しが同じかを確かめます（違えば落とす）。
   - 見本は「何を入れたら何が出るべきか」の約束です。各担当は、自分の側の関数をこの見本で試します。判定表（`continue/dependency-table.json`）は、両側の実装がそのまま読んで試験します。
2. **体が作った実物**（作る物。実装の時）
   - 実走 39 の教訓（体の本当の形と、頭の受け入れが食い違った）から、**手書きの見本同士を合わせるだけにしません**。
   - 体の担当は、体のビルドから次を作る台本 `backend/scripts/lab/continue-produce.ts` を書きます。
     - **catalog**：今の `catalog-contract.mjs --json` と同じ作り方。
     - **受け取り**：契約の見本の `input` を、体の本物のコードに通して出た受け取りと観測。場面が要る物は、再生の台か隔離ラボで本物のサーバーに通します（10 章）。
   - 出力は `backend/contracts/continue/produced/<見本の名>.json` です。各ファイルに、体の版（git の rev）・作った台本と台・入力の見本の sha256 を書きます。
   - 頭の担当は、`scripts/sync-body-produced.sh <体の rev>` で、それを `services/api/tests/fixtures/continue/produced/` へ写します。頭のテスト `continueProduced.test.ts` は、その実物を、頭の本物の読み手に通します。
   - **版の合わない実物は、通しの合格に使いません**（直す物 9。警告ではなく不合格）。local-gate の head の段に（5）を足し、指定の体の rev から作れる物はその場で作り直して比べ、場面が要る物は作った rev が指定の rev と同じかを確かめます。違えば不合格です。

### 見本の一覧
`services/api/tests/fixtures/continue/manifest.json` を見てください。版 3.1 で足し・直し、契約ごとに 5〜15 個です。どれも次の形です。
```json
{ "contract": "result", "version": "3.1", "scene": "…", "source": "実走 43 +2,123（run43-report.md 105 行）",
  "known": ["確か: 記録から確かめた事"], "decided": ["決め: この契約で決めた事"], "hypothesis": ["仮説: 確かめていない事"],
  "input": { }, "expected": { }, "checks": ["頭の試験で確かめる事", "体の試験で確かめる事"] }
```
- `expected` の文（LLM が読む文）は、意味が同じなら言い回しを変えてよい物です。`checks` に「この語を含む」と書いた物だけを、テストで決まった文字として確かめます。

---

## 10. 通しの確かめの骨組み（10 の境界と、継ぎ目の場面）

各担当の関数の合格数では判定しません。**記録を番号の組（`TraceIds`）でつなぎ、受け取り → 実際の操作 → 中断 → 解放 → 頭での結果の読みまでつながった証拠**で判定します。命令の種類ごとに要る証拠の組は 8 章のとおりです（始めなかった命令に `hand_start` を求めない）。
記録は、判断の記録（頭）・受け取り（`BodyTimes`）・黒箱（`hand_start` と出来事）です。判定は、台本 `tools/continue-verify/judge.ts`（頭のリポジトリ。作るのは頭の担当）が行います。

### 台
- **A 再生の台**（VM、`run-replay.sh` と `scene-case.py`）：本物の体（`runAct()`・道探し）と、写したワールド。vertical・続け方・約束の消費を見ます。
- **B 隔離ラボ**（VM、本物のサーバー・本物の bot・本物の反射・盾・道探し。`run-incident-lab.sh` と `run-hands-live` を広げる）：**D4 はここで確かめます。** 今の保留の通し（`minecraftHoldResumeLab.ts`）は act とサーバーが代役なので、D4 の合格には使いません。敵は `summon`、死は `/kill`、次元は `/execute in` で作ります。
- **C 本物の頭の通し**（`minecraftHoldResumeLab.ts` を広げた物。頭は本物、モデルは台本）：B の体と組み、頭の読み・帳簿・判断の破棄・不明の扱いを見ます。
- **D 入力の取り出し**（API を呼ばない）：頭の `recordedClient` を、送らずに要求のバイトを返す形で使い、最後の要求に必要な物が残るかを見ます。
- **E Sonnet の試験**（上限 ¥500。この骨組みの外）。

### 10 の境界

| # | 境界 | 台 | 判定（番号の組でつないだ記録で） |
|---|---|---|---|
| 1 | 結果と列 | B＋C | 反射が先に食べた後、eat は `already`。`dependsOn: []` の項目に `startedAt` があり、頼る項目だけ `droppedBecause: depends_failed` |
| 2 | 途中の成果 | A | 下の「境界 2 の照らし方」の表のとおり、4 つの数をそれぞれに合う証拠で照らす。次の手が `progress.at` から始まり、掘った段を掘り直さない |
| 3 | 約束と消費 | A＋C | 作る途中の材料・燃料・作業台の設置と回収・食事をまたいで、帳簿の `have` と観測の持ち物が毎回合う。同じ出来事の id が 2 度反映されない |
| 4 | すぐの引き継ぎ | B＋C | 同じ相手：引き継いだ act の `handover.confirmed` と、盾が下がらない（`shield: kept`）。別の敵：melee が次の手を始めない。溶岩・息・食事：奪わない |
| 5 | 死と非同期 | B＋C | 実行中・反射待ち・列待ち・LLM の返事待ちの各瞬間に `/kill` し、**死の時刻より後に、古い life の命令が効かせた操作が 0 件**。待っていた古い命令は 1 つも始まらない（死の前の操作は数えない） |
| 6 | 古い持ち主 | B | 新しい持ち主が始めた後に、古い処理の片付けが走っても、新しい持ち主のキー・盾・道探しの行き先が消えない（motor port の断りの記録） |
| 7 | 次元と復活 | B | ポータルで life が変わらない。移る前の観測で作った待ちの項目は `dimension_changed` で始まらない。死んで別の次元に生き返った時は life が 1 増える |
| 8 | 通信と再起動 | B＋C | 下の「境界 8 の場面の表」の 6 つの場面を、決めた ID・注入する時・対象の命令で起こす。どれでも、同じ命令の操作が 2 回の実行に分かれない、不明の項目が自動で出し直されない、帳簿に同じ出来事が 2 度入らない、期待した訂正の回数どおり |
| 9 | 計画 | C | `kind`・`prep` が、最初の計画 → `plan.update` → 保存 → 頭の再起動 → 読み戻しで残る。題名の言い換えの前後で、判定の値（段・不足・選ばれる知識・近くの候補）が同じ。表示の文は別に照らす |
| 10 | 実際の LLM の入力 | D | **最大の長さの入力**（急ぎの版・情報の多い live・長い結果と帳簿）でも、8 章の規範の表の物が最後の要求のバイトに残る |

### 境界 2 の照らし方（v3.1）
| 数 | 照らす証拠 |
|---|---|
| 移動の実績（通った段の数） | 操作の連続記録の、足の位置の変わり（段の高さが 1 変わった回数） |
| `stepsValid`（`progress.done`） | 手の終わりの観測で、今回通った段とその足場・頭の上のマスが今も成り立っている数。訂正があれば、連続記録のブロックの更新・押し戻しと照らす。移動の実績と等しいとは見ない |
| `placeAttempts` | 連続記録の置きの送り（`place` の出来事の数。送らずに止めた `place_held_back` は数えない） |
| `placedConfirmed` | 連続記録の、置いたマスのブロックの更新（置いた物になった）の数 |
| `work.dug` | 連続記録の掘りの送り（掘り直しも 1 回ずつ） |

### 境界 8 の場面の表（`e2e/boundaries.json` の `boundary8Scenes` が正本）
| ID | 注入する時 | 対象の命令 | 期待する訂正の回数 | 期限 | 要る記録 |
|---|---|---|---|---|---|
| b8-lost-receipt | q1 の受け取りを、頭が q1 を `settled_unknown` にする（受け取りの期限切れ）まで届けるのを止め、その後に本当の受け取りを放す（v3.1） | q1 | 1（`settled_unknown` → 片付け → `released` → `corrected`） | 片付け 5 秒 | 受け取り・片付けの受け取り・訂正の行 |
| b8-dup-poll | q1 の受け取りを載せた poll を 2 度送る | q1 | 0 | — | 受け取り 1 件の反映・帳簿の出来事 1 度 |
| b8-reconnect | q2 の実行中に体の接続を切ってつなぎ直す | q2 と待ちの q3 | 0（q2 は `released`、結果は unknown のまま） | つなぎ直しの最初の poll | 新しい接続の最初の poll・q3 の `connection_changed` |
| b8-head-restart-unacked | q2 の実行中に頭を止め、q2 の受け取りがまだ ACK されていないうちに起こす（unknown は LLM へ知らせていない） | q2 | 0（送り直された受け取りがふつうに `settled` になる） | 起きてからの片付け 5 秒 | 起きた時の片付け・`headBoot` の登録・q2 の受け取り |
| b8-head-restart-notified | q2 を `settled_unknown` にして LLM へ知らせた後に頭を止め、その後に本当の受け取りを放してから起こす | q2 | 1（`corrected`） | 起きてからの片付け 5 秒 | 知らせた記録・起きた後の訂正の行 |
| b8-body-restart | q2 の実行中に体を再起動 | q2 | 0 | つなぎ直しの最初の poll | `released`・`events` の `lost`・`unexplained` の差 |
| b8-lease-swap | q2 の待ちの間に lease を新しくする | q2 | 0 | — | q2 の `lease_expired` |

### 継ぎ目の場面（体と頭の担当の継ぎ目。Codex の推し）
- 体が独立な q2 を始めた後に、頭へ q1 の失敗が届く（頭が q2 を取り消さない）。
- `onFail: continue` の失敗へ後続が明示で頼る。3 つの項目の間接の依存。
- 不明を LLM へ見せた後に、片付けの成功・失敗、遅れた結果、同じ結果の再受信が続く。
- 約束の改訂・解除と、古い rev で送った act の結果が前後する。
- act の外の食事、途中材の作りと消費、手の中断と反射の食事、repeat の複数の周回。
- 引き継ぎの判定の間に、死・低体力・別の安全の反射が取る。
- 同じ life でポータルを移った後に、前の次元の別の項目が待っている。
- 最大の長さの結果・帳簿・急ぎの live を、本物の受信の検査と最後の要求のバイトまで通す。

### 台本の骨組み（`tools/continue-verify/`、頭の担当が作る）
```
continue-verify/
  scenes/            境界と継ぎ目の場面ごとの台本（B の lab の手順: summon・kill・tp・つなぎ直し、C の頭の台本のモデル）
  run-boundary.sh    1 つの境界を、指定の頭・体の rev で回す（VM）
  collect.sh         判断の記録・受け取り・黒箱を 1 つのフォルダに集める
  judge.ts           番号の組でつないで判定する。合否と、つながらなかった命令の一覧を出す
  report.md          境界ごとの結果（rev・台・合否・つながった数）
```
- 境界・台・使う見本・合格の条件・証拠の組は、見本の `e2e/boundaries.json` にも同じ物があります（`judge.ts` はこれを読む）。
- 合格は「10 の境界と継ぎ目の場面すべてで、判定に使った命令が全部つながり、条件を満たす」です。つながらない命令が 1 つでもあれば不合格です。

---

## 11. 担当の分け方と作る順

### 体の担当（`Shannon` リポジトリ）
- `instantSkills/act.ts`（結果・続け方・失効の照らし・持ち物の出来事・vertical の配線・手の始まり）
- `utils/actReport.ts`、`utils/actHandRules.ts`、`utils/actLabel.ts`
- `utils/primitives/common.ts`（`StepOutcome`）と各 primitive（progress・出来事・already・attack の target_lost）
- `utils/primitives/vertical.ts`（新）、`utils/tunnelWalk.ts`・`utils/shaftDown.ts`（部品に分ける）
- `integration/commonFca/nativeBody.ts`、`controlLoop.ts`、`bodyQueue.ts`、`bodyEvents.ts`、`minecraftControlContract.ts`（写し）、`continueContract.ts`（新、写し）
- `execution/ActionExecution.ts`、`SkillExecutor.ts`（持ち主の数え方・片付けの理由・取る時の確かめ・ロック待ちの失効）
- `utils/floorReflexes.ts`、`utils/combatOwner.ts`、`utils/shieldBlock.ts`、`ReflexLedger`（反射の出来事）
- `utils/blackbox.ts`、`utils/sceneSave.ts`、`utils/incidents.ts`（読むだけの足し）、`utils/life.ts`（新）
- 観測の `state.world.utilities`（条件の `near` の材料）
- `backend/scripts/lab/continue-produce.ts`（新）、隔離ラボの場面（`backend/scripts/lab/`）
- 体のテストと見本の写し

### 頭の担当（`shannon-ios` リポジトリ）
- `contracts/minecraftActContract.ts`、`minecraftActShortHands.ts`、`minecraftActHandRules.ts`、`minecraftActTime.ts`、`minecraftControlContract.ts`、`bodyControlContract.ts`、`continueContract.ts`（新）
- `surfaces/minecraft/minecraftControl.ts`（受け取り・片付け・訂正）、`surfaces/minecraft/store/minecraftControlStore.ts`（操作の状態・safe）、`minecraftControlValidation.ts`（上限 56）、`minecraftLlmcQueue.ts`（項目の状態・印の名前・依存・replace）、`minecraftReflexAdapter.ts`（context の life）、`minecraftConditions.ts`（near）
- live の各ファイル（`minecraftLlmcLive.ts`・`minecraftLlmcLiveRewrite.ts`・`minecraftLlmcUrgent.ts`・`minecraftLlmcReachWords.ts`・`minecraftLlmcReadiness.ts`・`minecraftLlmcPack.ts`）
- 計画（`minecraftLlmcNode.ts`・`minecraftPlanDone.ts`・`minecraftLlmcRoad.ts`・`minecraftLlmcV2Knowledge.ts`・`minecraftLlmcObsidianWays.ts`・`minecraftLlmcRoute.ts`・`minecraftFirstPlan.ts`、新しい `readWhere()`）、帳簿（`minecraftLlmcPromises.ts`、新）
- `mind/action/fca/fcaPlanTools.ts`（帳簿の入口）、`fcaRunner.ts`（破棄）
- `infra/decisionRecords/*`、`scripts/decision-record.ts`、`minecraftBodyVersion.ts`
- **共有の `packages/mind/src/planTree.ts` と `packages/mind/src/workingEvents.ts`**：頭の担当が持ちます（頭のリポジトリの中にあるため）。
- `tools/continue-verify/`（新）、`scripts/sync-body-produced.sh`（新）、`continueProduced.test.ts`（新）、local-gate の段（5）
- 頭のテストと見本の写し

### 共有の物と持ち主
| 物 | 持ち主 | 変え方 |
|---|---|---|
| この契約の文書（3 か所） | 契約の担当。決まっていなければ取りまとめ役 | 3 か所を同時に。版を上げる |
| 契約の見本と判定表（両側の写しと manifest） | 同上 | 両側を同時に。gate が違いを落とす |
| 体が作った実物（`produced/`） | 体の担当が作り、頭の担当が写す | 体の rev ごとに作り直す。版が合わなければ不合格 |
| `packages/mind/src/planTree.ts`・`workingEvents.ts` | 頭の担当 | 体は表示の写しと、出来事の種類の表を追う |
| `minecraftControlContract.ts` の写し | 頭の担当が元、体の担当が写し | 今と同じ |
| local-gate の（5）（`Syzygy/tools/shannon-release/`） | 頭の担当 | 体の担当に見せてから |

### 作る順と受け渡し
1. **契約と見本**（この branch）。版 2 をもう一度 Codex に見せる。
2. **計測・D4・計画の状態・失効**（同時に進める）
   - 体：`TraceIds`・`BodyTimes`・`hand_start`・`server.tick`・`bodyVersion`、`state.control`、持ち主の数え方と片付けの理由、引き継ぎ・上限のつなぎ、命の番号と失効の照らし。
   - 頭：共有の出来事の種類、判断の記録の行、`kind`・`prep`・v2 の読み替え、題名の正規表現の置き換え、破棄（life・次元・つなぎ直し）、急ぎの live の規範の欄。
   - **受け渡し**：体は、命の番号と `state.control` が入った観測の実物を頭へ。頭は、`context.life`・`headBoot`・`madeIn` を入れた命令の実物を体へ。
3. **D1 と続け方を両側でつなぐ**
   - 体：結果の 2 軸・判定表・列の印・admit・replace。頭：受け取りの読み・項目の 2 つの状態・片付け・訂正・判定表・replace。
   - **受け渡し**：体は `result/*`・`continue/*` の見本を本物の `runAct()` に通した受け取りを `produced/` に出す。頭はそれで `continueProduced.test.ts` を通す。
4. **D2・D3・D6**
   - 体：持ち物の出来事・反射の出来事・`utilities`、vertical。頭：帳簿・live の 1 行・`uses` と rev・入口、vertical の読み書きと見積もり、判断に届ける事実の規範。
   - D8（精錬の並べ方）は作らず、Sonnet の試験で確かめる。
   - **受け渡し**：catalog（vertical の欄が入った物）を `produced/` へ。gate の（4）と（5）が通ること。
5. **通しの確かめ**（10 章）と **Sonnet の試験**。合格の後に、1 つの版として反映する（スイッチは付けない）。

各段の終わりに、両側の local-gate と、その段で使える境界の通しを回します。段は作る順のための物で、反映は最後に 1 回だけです。

---

## 12. 決めた事・決めきれなかった所・直さなかった指摘

### v1 の 13 の点の決め（取りまとめ役、`continue-contracts-review-decisions.md`）
1. 手の欄の上限を 56 にする。受け入れの条件は、体が作った catalog を頭の本物の検査に通すこと（2 章）。
2. 命の番号は、ワールドとボットごとのファイル。つなぎ直しの識別子は別に持つ。読めない時に黙って 1 へ戻さない（5 章）。
3. 引き継ぐのは、同じ相手の melee と、限った last-stand だけ。floor-flee は奪わない（4 章）。
4. attack の already は、観測した死だけ。30 秒は仮の上限。記憶はワールド・次元・接続と個体の id で区切る（1 章）。
5. 約束の物の語は、具体的な物の名前と food だけ（3 章）。
6. 最初の計画にも promises を書ける。書かなければ空（3 章）。
7. 不明を受けたら、すぐに期限つきの片付け（1 章）。
8. tick は 10 秒の仮の案。生の応答・時刻・失敗を残し、負荷を測って決める（8 章）。
9. `unmet_now` も遅れに数え、理由を見せる（7 章）。
10. kind は閉じた列＋other。未知の値は元の値を残す（7 章）。
11. D6 は別の契約番号を作らず、規範を書く。D8 は今の手のまま Sonnet の試験で見る（8 章）。
12. 名前は vertical のまま、向きを明示する（6 章）。
13. 0.2 は仮説。置きを送る条件と、置けたことの確かめを分け、実物の試験で決める（6 章）。

### 版 2 の 6 つの点の決め（取りまとめ役、v3 の決め。Codex の推しどおり）
1. 列の名前は段ごとのまま。段をまたぐ `dependsOn` は、送る前に明示のエラーにして LLM に返す（2 章）。
2. 片付けの期限は仮に 5 秒を上限にする。成功の保証にしない。体の片付け（3 秒）を内に含み、通じない時は保留（1 章）。
3. 近くの設備は 8 m 以内。範囲・次元・観測の番号・探し終えたかを証拠に付け、無ければ near は判定できない（3 章）。
4. 受け取りは 16,000 字のまま。出来事は件数だけに潰さず、分けて届けて受け取りの番号で回収する（3 章）。
5. 規範の数（24 m・最大 3 件・打ちの 10 秒の窓）は初めの値（推測）。3 件より少ない時は全部出す（8 章）。
6. attack にも盾を渡す。根の文脈へ盾の使用権を渡し、常駐の盾はその委譲の下で動く（4 章）。

### 版 3 の 5 つの点の決め（取りまとめ役、v3.1 の決め。Codex の推しどおり）
1. `events` は、観測だけの内部の命令（LLM に見せない）。command 全体の配送の番号・ページの上限・次の番号・終わり・記録が失われたことを返す。同じ範囲をもう一度頼んだら、同じ出来事を返す（3 章）。
2. 重複除去の記録は、タスクの終わりまで持つ。件数の上限で捨てない。計画のチェックポイントの配列が大きすぎる時は、タスクと出来事の id を一意のキーにした保存表に移す（3 章。保存の仕方は実装の担当が測って決める。13 章）。
3. 引き継ぎの予約の 300 ms は初めの値。隔離ラボで、止める・settled・取得の時間を分けて測る（4 章）。
4. `stepsValid` を訂正するのは、今回の手で通った段と、その段が成り立つのに要るマスだけ。読み込まれていない所・観測していない所を、消えたことにしない（6 章）。
5. 頭の再起動の後は、ストアが ACK していない受け取りを体が送り直す（今どおり）。訂正が 1 回になるのは、既に unknown を LLM へ知らせていた時だけ。境界 8 の頭の再起動は、配送の順で 2 場面に分けた（1 章・10 章）。

### 版 3 で新しく決めきれなかった所（v3.1 で上のとおり決めた）
1. **出来事を取りに行く命令の形**：観測だけの命令 `events`（`{ command, fromSeq }`）にしました。今の catalog に読み取りのスキルを 1 つ足すことになります（欄の数には影響しない）。poll の欄で返す案もあります。
2. **重複除去の記録の大きさ**：タスクの終わりまで出来事の id を全部持ちます。45 分で数千件（推測）で、計画のチェックポイントが大きくなります。上限を決めるかは、実物で測ってから決めたいです。
3. **引き継ぎの予約の期限 300 ms**：待つ上限で、合格の条件ではありません。実走 45 の反射の手（2 打で約 1.5 秒）の中で足りるかは、隔離ラボで確かめます。
4. **`stepsValid` の訂正の範囲**：下った段の足場が後で無くなった時（下の段を誰かが掘った等）にも引くか。今は「体の通った段のブロックの更新」だけを見る案にしました。
5. **頭の再起動の後に体が受け取りを送り直すか**：今の体は受け取りを頭が受け取ったと知らせるまで送り続けます（確か：`acknowledged`）。頭の再起動でそれが 1 度届くので、b8-head-restart の訂正の回数は 0 か 1 としました。

### 直さなかった指摘と理由（版 3.1）
Codex の 3 回目の「入る前に直す物」5 つは、今のコードで確かめた上ですべて直しました。確かめた物は、体が受け取りを ACK まで送り直すこと（poll は ふつう 200 ms ごと）、頭の ACK がストアの `settle()` の直後であること、計画の保存が段の commit の時であることです。違っていた指摘はありません。

### 直さなかった指摘と理由（版 3）
Codex の 2 回目の指摘は、今のコードで確かめた上ですべて直しました。確かめた物は、ストアの `settle()` が内容の違う受け取りを受けず `reconciledReceipt` の後だけ置き換えること、`safe()` が unknown を未解決にすること、実行層が settled の時に文脈を消してロックを放すこと、fight が盾を常駐の盾に任せていること、黒箱が 90 秒の輪であること、体の片付けの中断が 3 秒であること、などです。違っていた指摘はありません。

### 直さなかった指摘と理由（版 2）
Codex の指摘は、今のコードで確かめた上でほぼすべて直しました。次の 2 つは、指摘そのものではなく直し方を変えました。
- **「token を上げる対象」（指摘 6）**：Codex は token を足す前提で対象を絞る案でした。今のコードには motor port の失効の確かめが既にあるので、token は作らず、そこに統合しました（取りまとめ役の決めの直す物 3 と同じ）。
- **「`where`（構造）を直接読む」が成立しない（(2) の計画）**：指摘のとおり、`where` は今も文字列です。構造の位置は作らず、位置の読み手を 1 か所に置く形にしました（7 章の表の 16）。

確かめて違っていた指摘はありません。確かめた物は、act の中だけの次元の止め、パン 11 点、`FloorBudget` が arrow・eat・armor の予算であること、melee の上限が episode の手数と打ちの数であること、query でも世代が上がること、片付けで盾が下がること、常駐の盾の直接の操作、`near`・`furnace` が常に判定できないこと、知らない WorkingEvent の seq が進むこと、最初の計画の `parent` が string であること、attack が見えなくなった相手で ok を返すこと、make の count が追加の数であること、repeat の 2 周目で行が消えること、などです。

---

## 13. 実装の担当へ（実装の途中で直してよい物）
Codex の 3 回目の見直しで「実装の途中で直してよい」とされた物です（決まった規則を実装して確かめる事。担当の間で解釈が変わる物ではない）。担当がここから拾い、直したら見本と、この節を更新します。

| 物 | 担当 | 決め方 |
|---|---|---|
| 初めの値の調整（引き継ぎの予約 300 ms、片付けの 5 秒、規範の 24 m・3 件・10 秒、vertical の段あたりの秒、pillar の margin 0.2） | 体（300 ms・0.2・段の秒）、頭（5 秒・規範の数） | 隔離ラボと台で測る。止める・settled・取得の時間は分けて測る |
| 重複除去の記録の保存の仕方（チェックポイントの配列か、保存表か） | 頭 | 45 分の通しで、件数・大きさ・保存の時間を測って決める |
| 操作の連続記録のファイルの容量と負荷 | 体 | 台の 45 分の通しで測る。上限は判断の記録と同じ考えで |
| 最大の入力の見本に足りない具体的な値：満腹 11、約束の残りの量、回復の見込み、列の状態と残りの時間 | 頭 | `measure/urgent-max-input.json` に足す（v3.1 で一部を足した。残りは実物の live の形が決まってから） |
| 持ち物を確かめてから置きを送るまでを、同じ motor の持ち主で通す試験（保留 9） | 体 | `result/r45-hold9-hand-at-send.json` を、本物の motor port の下で通す試験にする |
| meter の時計を、保留・再開・再起動をまたいで試す | 頭 | `measure/meter-clock-excludes-holds.json` を、再開と頭の再起動を挟む場面へ広げる |
| README（Codex の材料の `00-README.md`）の古い説明（実走 45「進行中」） | 取りまとめ役 | 実走 45 は終わった（45 分・黒曜石 7・ネザー無し） |

---

## 14. 追記（実装の途中で、取りまとめ役が決めた物）
体と頭の担当は、ここを正本として読む。それぞれ自分のリポジトリの本文と見本へ同じ文で入れた。番号は「A-n」。本文の該当の所（1 章の `ActHandLine`・判定表・3 章の `InventoryEvent`・6 章の `Progress`）は、この追記で読み替える。

### A-1（10/28、体の担当の質問 1〜7 から）

1. **手の行の `motorOps`**：`ActHandLine` に `motorOps`（その手が効かせた操作の数）を足す。
   - skipped の手には付けない。
   - 頭の読み手も、この欄を読む。not_started と failed の境目は、この数で決める。
2. **(goal `not_started`, end `cut`)**：外から止められ、操作が 0 の手。依存の判定表の `outcomes` に、この 1 行を足す。
   - 扱いは、既にある not_started の行と同じ（成功ではないので、頼る項目は始めない。操作 0 なので failed にはしない）。
   - released は、ふつうの決まりのとおり。
3. **欄の名前**：体の担当の名前で決める。頭も同じ名前を使う。
   - 受け取り（`MinecraftControlReceipt`）：`unit`、`bodyTimes`
   - `ActResult`：
     - `outcome`（ActOutcome）
     - `handover`
     - `eventsMore`：受け取りに載らなかった出来事を取りに行く先
     - `earlierPasses`・`earlierEvents`：古い周回の行を数にまとめた時でも、出来事は落とさず、この欄で運ぶ
   - poll：`bodyVersion`
   - 返事：`headBoot`
   - 観測：`facts.life`・`state.life`・`state.bodyRun`・`state.control`・`state.world.utilities`
4. **箱の出し入れ**：`InventoryEvent.reason` に `stored`（箱へ入れた）と `retrieved`（箱から出した）を足す。
   - chest の手も、持ち物の出来事を作る。
   - 約束の帳簿では、`stored` は消費ではなく「置き場所が変わった」として出す（残りの量の正本は持ち物の観測なので、手元の残りは減る）。
5. **`fightsFirst` の直し**（既にある不具合）：args は配列なので、0 番を読む。今までは、fight で始まる act が melee を止める経路が一度も効いていなかった。
   - 直すと、実走 45 の +929 の形で、ふるまいが変わる。最後の報告に書き、測りの実走で見る。
6. **vertical**
   - `range` は、塞ぐ半径。
   - 既定：`maxDig` 200・`maxPlace` 100・`seconds` 60。`seconds` の範囲は 5〜120（go と同じ上限）。
   - LLM への短い書き方では、この既定と範囲を見せる。頭は同じ範囲で検査する。
   - `seen`（途中で見た物）は、`StepOutcome.data` ではなく、構造の `Progress.seen` に載せる。頭はそこを読む。
   - 予定の足場へ踏み出せない時は、止まりの code に `no_foothold` を足して返す（`displaced` とは分ける。押し戻しと、足場が無いのとでは、LLM の次の手が違うため）。止まりの code は 14 個になる（実走46 の後、露出の守りの止めを `threat_exposed` に分けて 15 個。下の「実走46 の後の体の直し」）。
   - pillar の置きの時機は、`bodyOverlap`＋余白 0.2 にする（mayLayAt は同じ柱の真上の空中では必ず false になるため）。0.2 は仮説のまま。隔離ラボで確かめる。
7. **引き継ぎ**：`SkillExecutor.acquire` の `onGranted` で、ロックを取った瞬間に予約を確かめる形でよい。300 ms は初めの値のまま、隔離ラボで測る。

### A-2（10/28、体の担当の段 2〜3 の報告 a〜e から）

1. **見本の項目名**（a）：`continue/queue-item-depends.json` の `q13b`・`q13c` は見本の誤り。列の ID 規則（`q`＋数字）はそのまま。見本を `q131`・`q132` に直す。
   - 体が形の誤りで断るのは正しい。
   - 両側で見本を同じに直し、manifest の sha256 を合わせる。
2. **cancelled の後ろを捨てた時の文**（b）：体で `code='cancelled'` を入れる。文は「（cancelled）」にする。
   - LLM が読むのは文なので、「failed」と出すと「自分の手が失敗した」と読み違える。`unit.end` の cut は構造としては残すが、文も正しくする。
   - 頭は、捨てた項目の結果が cancelled の時に「失敗」と数えない（依存の判定表のとおり）。
3. **armor の装着の出来事**（c）：`equip`（head/torso/legs/feet）の tap で出す形でよい。
   - 帳簿では消費ではなく「身に着けた」として出す（持ち物から防具の欄へ移っただけ）。
4. **vertical と LAYING_HANDS**（d）：vertical を入れる。
   - 理由：vertical は柱・塞ぎで置きを続ける手で、置きの途中に反射の note で止まると、実走 45 の止め 8・9 と同じ形の失敗になる。入れない理由は契約に無い。
   - 入れた時に、他のふるまいが変わる所（例：落下・溺れの反射が抑えられる等）があれば、報告に書く。隔離ラボで「置きの途中で止まらない」ことと「命に関わる反射は効く」ことを 1 回ずつ確かめる。
5. **fight の「逃げた」**（e）：成功の軸は ok のまま。終わり方を構造で返す。
   - `fight` の結果に、相手の終わり方（倒した／範囲の外へ出た・生きている／見失った）を入れる。形と名前は `attack-target-lost` の見本と揃える（体の担当が決め、頭へ知らせる）。
   - 頭は、逃げた時に「相手は生きていて、範囲の外にいる」と文で見せる。倒したと同じ文にしない（次の手が違うため）。
   - 見本は 1 つ足す（`result/fight-target-escaped`）。両側に同じ物を置く。
   - 体の決め（10/28）：成功の軸は ok・goal done のまま、code で返す。`target_killed`（死を観測）／`target_escaped`（生きていて range の外・追わない）／`target_left`（stance flee で range に着いた、または逃げている間に見えなくなった）。見失いは attack と同じ goal unknown・code `target_lost`。

### A-3（10/28、体の隔離ラボ B の結果から）

1. **vertical と LAYING_HANDS の範囲**：vertical を「置きの手」として扱うのは、その時の 1 段が置き（pillar・塞ぎ）の間だけにする。掘り（stairs・shaft の掘り）の間は置きの手として扱わない。
   - 理由：ラボで、vertical の実行中はずっと、低体力の last stand／flee の判定と melee の開始が抑えられていた。掘りは最長 60 秒続くので、その間に敵に殴られても反撃も逃げもしない形になる。置きの途中で切られる害（止め 8・9 の形）は置きの間だけの話なので、範囲を置きに絞る。
   - ラボで「掘りの途中に敵が来たら melee が始まる」「柱の置きの途中は note で止まらない」を 1 回ずつ確かめる。
2. **pillar の `stockUsed`**：置いた 8・確かめた 8 なのに `stockUsed` 4。4 つの数の意味（契約 6 章）が崩れているので、原因を調べて直す。
   - 拾い直し・同じ種類の別の積み・数え始めの時機のどれかの見込み（仮説）。直した後、ラボで置いた数と在庫の減りが合うことを確かめる。

### A-4（10/28、頭の担当の途中報告から）

1. **`bodyTimes.acceptedAt`**：必須のまま。produced の受け取りは、制御ループ（accept→begin→afterEnd）を通した物で作る（ラボの probe が直に手を呼ぶ形では作らない）。`failedAt` は失敗した時だけ付く。
2. **操作の連続記録の行の形**：契約どおり `kind`（`hand_start`・`op`）と `at` にする。体の `opLog.ts` の `k`・`t` を直す。頭は契約の形だけを読む（両方を読む形にしない。形が 2 つあると、後で読み手が増えた時にまた割れるため）。
3. **produced の各ファイルの先頭**：体の形（`bodyRevision`・`answers`・`fixtureSha256`・`bench`）を正とする。頭の sync はこれに合わせる。
4. **打たれた記録**：体が観測に `state.combat.recentHits` を足す。
   - 1 件は `{at, attackerId, attackerType, damage, life}`。直近 10 秒・最大 20 件。
   - 体力の落ちから作ると、1 フレームの間に 2 回打たれた時に 1 回と数え、戦いの事実がずれるため。頭はこれが来たら、体力の落ちからの推定をやめて置き換える。
5. **境界 8 の場面の数**：7 つ（表と `boundaries.json` が正）。8 章の本文の「6 つ」は書き誤り。
6. **vertical の `liquid`**：型のとおり必須。短い書き方も必須として見せる。
7. **`TraceIds` の `obsSeq`・`obsAt`**：必須のまま。見本 `measure/trace-ids.json` の ids に 2 つを足す。両側で同じに直し、sha256 を合わせる。判定の台本は必須の形だけを読む。
8. **約束の型に足す物**（頭の帳簿で要った物を契約に入れる）：
   - `PromiseEvent.kind` に `moved`（体の `stored`・`retrieved`・防具の装着）と `item` を足す。
   - `PlanPromise.have`。
   - `LedgerSeen` に死・接続・ahead。
   - 名前と形は頭の実装のとおり。頭が型の写しを 14 章に書く。
9. **produced の rev**：コードの rev で比べる。`backend/src` と `package.json` に差が無い rev は同じとみなす（produced を入れる commit は、自分の rev を書けないため）。
10. **形の決まっていない物**：
    - `ActResult.earlierPasses`・`earlierEvents` の形と、`events` 命令の返事の置き場：体の実装の形を正とする。体が 14 章に型を書き、頭はそれに合わせる。
    - `ItemOutcome` に `code` を足す。その項目の終わりを決めた手の code を写す（`cleanup_stop` など）。頭は手の code から読むのをやめ、ここを読む。

#### A-4 の 10 の型（体の実装の形。体が書き、頭はこれに合わせる）
```ts
/** ActResult の欄。受け取りの 16,000 字に収まらない時の逃がし先（実装：utils/actReport.ts fitReceipt）。 */
interface ActResultOverflow {
  /** 古い周回の行を数にまとめた物（新しい 2 周の行だけが lines に残る）。 */
  earlierPasses?: { pass: number; lines: number; done: number; stopped: number }[];
  /** その古い周回の行が持っていた持ち物の出来事。落とさずここで運ぶ（deliverySeq の小さい順）。 */
  earlierEvents?: InventoryEvent[];
  /** 受け取りに載らなかった出来事の取りに行く先。載った物は deliverySeq の小さい順の先頭で、nextSeq 以降を events 命令で取る。 */
  eventsMore?: { command: string; nextSeq: number; total: number };
}
/**
 * events 命令（内部の読み取り。skill 名 `events`、arguments は { command, fromSeq, max? }）の返事は、その命令の受け取りの `result`（文字列）に入った JSON 1 つ：
 * EventsReply = { command, from, to, total, nextSeq, done, lost, events: InventoryEvent[] }（continueContract.ts）。ActResult の中ではない。
 */
```
- `unit.code`（ItemOutcome）は、その項目の終わりを決めた手の code（行の `code`）か、列で捨てた時はその理由（`cleanup_stop`・`precondition`・`queue_dropped` など）。
- 観測の `state.combat.recentHits` は `{ at: ISO, attackerId: number | null, attackerType: string, damage: number, life: number }[]`（直近 10 秒・最大 20 件・古い順）。`damage` はその 1 打の後の体力の落ちを、同じ更新を待っていた打ちの数で割った値（鎧や盾で落ちなければ 0）。
- 操作の連続記録（`oplog`）の 1 行は `{ kind: 'hand_start', ...HandStart }` か `{ kind: 'op', at, command, hand, pass, life, op, detail?, by, action }`（`at` は ISO）。

#### A-4 の 8 の型（頭の実装の形。頭が書き、体は読み物として同じ文を入れる）
```ts
/** 3 章の PromiseEvent への足し。 */
interface PromiseEvent {
  kind: 'made' | 'revised' | 'consumed' | 'gained' | 'moved' | 'lost_death' | 'unexplained' | 'released' | 'closed';
  /** moved：持ち物の場所が変わった（箱へ入れた stored・箱から出した retrieved・防具の装着）。消費ではない。count は動いた量（いつも正。unexplained だけ符号つきで、負は「出来事が説明する量より少ない」）。 */
  item?: string;                // 帰属先の定義（送った時の写し）の item
}
/** 3 章の PlanPromise への足し。 */
interface PlanPromise { have?: number }   // 前の観測の値（have を足し引きせず数え直すための物。item が変わる改訂では捨てる）
/** 3 章の LedgerSeen（頭が計画のチェックポイントの `fcaPlanLedgerSeen` に保存）。eventIds・lastObs が契約の 2 欄で、残りは任意。 */
interface LedgerSeen {
  eventIds: string[]; lastObs: { bodyBoot: string; connectionId: string; obsSeq: number } | null;
  death?: { deathEpoch: string; deathSeq: number } | null;   // 前に読んだ死の数え方（deathBetween に渡す）
  connections?: string[];                                    // 置き換わった接続（遅れて届いた古い接続の観測で have を戻さない）
  ahead?: { promise: number; delta: number; connection: string; obsSeq: number | null }[];   // 観測より先に届いた出来事の効き（次の観測で「説明できない差」にしない）
}
```

### A-5（10/28、頭の最終報告から）

1. **docs の末尾**：頭が足した「A-4 の 8 の型」の文を、体の docs にも同じ字で入れる。両側の docs を同じにする。
2. **受け取りの無いまま体が再起動した命令（境界 8 の `b8-body-restart`）**：頭は、その命令の結果を `settled_unknown` のまま、出来事について `lost: true` を記録し、LLM に「体が再起動したため、この命令の結果と出来事は分からない。観測で確かめる」と 1 度出す。
   - 体が再起動すると出来事の記録は残らないので、events を取りに行っても返らない。取りに行かずに lost と書くのが正しい。
   - 境界 8 の 7 場面がすべて通ることを確かめる。
3. **置きが ok の後で世界が違っていた時の訂正**（`result/r45-hold3-place-ok-then-world-differs`）：体が実際に何を載せているか（欄と形）を 14 章に書く。頭はそれを `offerOnce` につなぐ。
4. **`V2_ALWAYS` の PLAN 節**：「準備の必須は、reason を書いても省けない」は契約 7 章（`prep: skipped` と理由を書ける）と食い違う。契約が正。同じトークン数以内で「準備を省く時は skipped と理由を書く」の形に直す（8,800 以内を守る）。
5. **体の `handReasons` に `equip`**：act の `equip` で防具を着けた時の理由が `unexplained` になる。体が `equip` を足し、帳簿は A-2 の 3（身に着けた）で出す。
7. **`PREP_DESCENT_RULE` の「未達の必須は、reason や why に書いても省けない」**：4 と同じ食い違い（契約 7 章：`skipped` は LLM が書く。頭は事実だけ出す）。同じ形で「省く時は prep に skipped と理由を書く。省いた節は達成に数えない」に直す。トークン数は増やさない。
6. **local-gate の段 5**：頭のパッチ（`tools/continue-verify/local-gate-stage5.patch`）を体の担当が読み、OK なら取りまとめ役が Syzygy に当てる（main への合流の時に一緒に）。

#### A-5 の 3 の型（体の実装の形。体が書く）
```ts
/** 6 章の Progress への足し（vertical）。置きが ok の後で世界が違っていた時の訂正の事実。 */
interface Progress {
  /** 数えた後で「もう無い」と分かった段（ブロックの更新・押し戻し・手の終わりの見直しで見つけた物。最大 8 件）。`done`（stepsValid）はこれで減る。 */
  corrected?: { at: ActPos; was?: string; now: string; step: number }[];
}
```
- 載る所は、vertical の手の行の `progress.corrected` と、成功の行の文（「置いた (191,59,188) が無くなった（今 air）（有効な段数を直した）」。失敗で止まった行は構造だけ。160 字を越えるため）。
- 訂正で減るのは `progress.done`（stepsValid）だけで、`work.placeAttempts`・`placedConfirmed`・`stockUsed`・予算は戻らない。
- 同じ訂正の元の証拠（block の更新・押し戻し）は、操作の連続記録に `{ kind: 'block_update' | 'forced_move', at, command, hand, life, ... }` の行で残る（境界 2 の照らし方）。
- 手が終わった後で起きた訂正（手の途中でも終わりの見直しでも見ていない変化）は、体は載せない（観測の持ち物・地図で LLM が見る）。
- act の `equip`（防具の欄・オフハンド）で持ち物から減った分は、理由 `reflex_armor` の出来事で出す（頭は「身に着けた」として扱う。名前に反射と付いているが、手の equip でも同じ）。

### A-6（10/29、Codex の最終の見直しから。全文は codex-final-review.md）

測りの実走の前に、全部直す（段に分けない）。行は Codex の答えの (1)〜(5) の番号。

#### 体
1. **引き継ぎの入口**（(1)-1）：`fightsFirst()` は先頭の手だけを見ない。`planHandover()` と同じ「最初に体を動かす手」の決め方（既に済の手を飛ばす）で判定する。`equip（既に持っている）→ fight #同じ相手` で引き継ぎが働くこと。
2. **予約中の盾**（(1)-2）：盾 true の予約がある間は、常駐盾の `lower()` をしない。取得の時に今の盾の状態を確かめ、途切れずに上がっていた時だけ `kept`。途切れたら `dropped`（新しい値）で返す。
3. **pillar の頭上の掘り**（(1)-3）：A-3 のとおり、置いている間だけ `vertical-place`。頭上を掘る `openAll()` の間は外す。
4. **開始直前の依存不成立**（(1)-4）：項目を閉じた後に `afterEnd()` を通して列を進める。独立した後ろの項目が始まること。
5. **`outcome.life`**（(2)-2）：act を走らせた命（開始時の life）を付ける。死の後の life で付け直さない。
6. **未 ACK の出来事**（(4)-3）：`EventStore.prune()` は ACK 済みだけを消す。未 ACK は時間・件数で消さない。どうしても上限（5,000 件）を超えて消す時は、その命令に `lost` を明示して頭に届ける。
7. **cap の後**（(4)-4）：`reflex.capped` の後は、その episode が終わるまで、どの種類の新しい反射の手も選ばない（今の動きを続けるだけ）。
8. **last stand の打ちの待ち**（(4)-5）：止められたら即終わる待ちにする（melee と同じ）。
9. **測りのための記録**：
   - 盾（(5)-3）：予約・停止・取得・最初の操作の各時点の実際の盾の状態（`deactivateItem` の有無と、上がっているか）を操作の記録に出す。
   - 分割配送（(5)-4）：produced で出来事の配列を件数に置き換えない。非空のページの実物を残す。
10. **隔離ラボで実物を足す**：盾を上げたままの引き継ぎ（盾を持たせ、矢などで常駐盾を上げた状態で同じ相手の引き継ぎ）、last stand の引き継ぎ、cap の後に手の種類が変わる場面。

#### 頭
11. **`earlierPasses`**（(2)-1）：契約と体の形（`{pass, lines, done, stopped}[]`）で読む。
12. **帳簿の保存と処理済みの印**（(1)-5）：計画の checkpoint を保存した後に `markProcessed()`。間で止まって再起動したら、同じ受け取りをもう一度反映する（出来事の ID の重複除去で二重に数えない）。この間で止まる試験を足す。
13. **約束の品目の改訂**（(4)-1）：差分は品目ごとに計算する。古い品目の出来事は古い品目（と古い rev）に帰し、今の品目の期待在庫に混ぜない。文にも品目を出す。改訂と受け取りの間に新しい在庫観測を挟む試験を足す。
14. **精錬の材料**（(2)-3）：受け取りから帳簿を作る入口で、手の番号から手の種類（`by.do`）をつないで渡す。
15. **vertical の速さ**（(4)-2）：体が返す `msPerUnit` を保存し、列の見積もり（`ActTimeTuning`）に渡す。
16. **文**（(3)）：トークンは増やさない（system 8,800 以内）。
    - go と vertical の使い分け：上り下り（高さの差が大きい）は vertical、横の移動と短い段差は go。system・道具の説明・`search_timeout` の次の手の文を揃える。旧い「上り下りは go」「階段・橋・柱は go 1 手」は直す。
    - 準備：「準備も省かない」「未達の間は下りない」と「skipped と理由」を 1 つの決まりにする：「未達の間は下りない。省くなら prep に skipped と理由（省いた節は達成に数えない）」。
    - 液体の結果文：実際の指定と止まった原因だけを書く（`seal_water` を「止まった」と書かない）。
    - 列が空：「列に項目なし」。「体が止まっている」と言わない。
17. **測りの判定**（(5)-2・3・4）：
    - 長い縦の移動ごとに、go／vertical の選択・届いた高さ・動いた段数・有効な段数・止まりの理由・同じ所の掘り直し・止まりから次の有効な操作までの秒を出す。wait と成果の無い go を実行時間から分ける。
    - 盾は自己申告（`shield === 'kept'`）で合格にしない。体の操作の記録の実際の盾の状態と照らす。melee／last stand、既に済の前置き、盾あり、を分け、被弾数・HP・食事の始まりまで出す。
    - 帳簿：非空のページの実物を読み手に通し、出来事の ID と理由を照らす。

#### 取りまとめ役
18. 直った後、Sonnet の短い通し（上限 500 円）で、vertical を選ぶか・dependsOn を書くか・約束を作るか・精錬中に別の仕事を足すか・引き継ぎの後に回復を選ぶか、を見る。
19. 測りの実走の判定は、版×シードごとの成否と秒をそのまま出し、仕組み別の測りで判断する。4 本でネザーの確率の差は判定しない。費用の上限で 45 分前に終わった回の扱いと、「差がはっきりしない」の数値の基準は、実走の前に決めてユーザーに出す。

#### A-6 の 2・6・9 の型（体の実装の形。体が書く）
```ts
/** 4 章の Handover の足し。盾の値に `dropped` を足した（`kept` は予約から取得まで途切れなかった時だけ）。 */
interface Handover { shield: 'kept' | 'lowered' | 'dropped' | 'none' }
```
- `kept`：予約を作る時に盾が上がっていて、取得の時まで、盾が下げられず・`deactivateItem` も呼ばれず、今も上がって使われている。
- `dropped`：予約は盾 true だったが、取得の時には途切れていた（引き継ぎ自体は `confirmed`）。act は自分の手で盾を上げ直す。
- `lowered`：引き継ぎが `confirmed` にならず、予約が外れて盾も下げた。`none`：予約が盾を持っていなかった。
- 予約の間、常駐盾は盾を下げない（盾 true の予約がある時の `lower()` は何もしない）。
- 操作の連続記録の行（盾の実際の状態。頭の判定器 `tools/continue-verify/judge.ts` の `motor_state` の形に合わせた）：`{ kind: 'motor_state', at, command, point: 'reservation' | 'stop' | 'acquire' | 'first_op', shield: boolean, deactivateItem: boolean, ... }`。`shield` はその時点で盾が上がっていて使われているか（旗が立っていても `usingHeldItem` が false なら false。旗そのものは `flagUp`）、`deactivateItem` は予約を作ってから `deactivateItem` が呼ばれたか。足してある欄：`flagUp`・`using`（盾を使い続けているか）、`hasDeactivate`、`loweredSince`・`deactivatedSince`（予約からの回数）、`reserved`・`reflex`（reservation の行）、`result`・`confirmed`（acquire の行。`result` は上の Handover.shield の値）、`op`（first_op の行）。`command` は引き継ぎの相手の命令（まだ操作の範囲に入っていない時でも付く）。
- `EventsReply.lost` は、記録が無い時のほかに、体が 5,000 件の上限を超えて未 ACK の命令の出来事を捨てた時も `true`（`total` はその命令の件数、`events` は空）。頭は `lost` を「出来事が分からない」と扱う。ACK 済みの記録は時間（30 分）と件数で消えてよいが、未 ACK のものは時間・件数では消えない。
- `outcome.life` は act を走らせた命（開始時の番号）。死の後の命で付け直さない。

### A-7（10/29、Sonnet の短い通しから。頭だけ）

通しの結果（17 場面 × 2、USD 0.91）：vertical 6/6（下りの別場面も 6/6、go 0）・精錬の後の別の仕事と取り出し 4/4・戦いの後の回復 4/4。dependsOn 0/8、約束 0/6（1 節足しても 0）。準備を省く時の prep skipped は 1/2。送る前の確認で断られた答え：vertical の liquid 無し 2・maxDig 250 が 1・stopIf の引用符の二重 3（45 回中）。

1. **約束を act に載せる**：LLM は 1 判断に act だけを出し、plan_update を別に呼ばない（1 節足しても 0）。書き方の入口を、LLM が必ず書く act に移す。
   - act に `keep` を足す（例 `keep=spruce_planks:4:作業台`、複数可）。頭は、送る時に計画の道具の 1 つの入口（`op: 'promise'` と同じ処理）で約束を作る。既に同じ item・use の開いた約束があれば改訂（count を変える）。
   - `plan.update` の `op: 'promise'` も残す（最初の計画の `promises` も今どおり）。
   - 道具の説明に 1 例、system の優先の行に「後で使う物は act の keep で残す（帳簿に載る）」を足す。トークンは 8,800 以内。
   - 体には何も足さない（頭だけで約束に変える）。
2. **vertical の liquid と範囲**：道具の説明の vertical の例に必ず `liquid=` を書き、既定と範囲（maxDig 200・maxPlace 100・seconds 5〜120）を見せる。断る時の文に、直し方（「liquid=stop|seal_water|… を足す」「maxDig は 200 まで」）を書く。
3. **stopIf の引用符**：外側に余分な引用符が 1 重付いた物（`"\"hostileWithin=8 hpBelow=10\""`）は、1 重はがして読む。読めない時の断りの文に正しい書き方の例を出す。
4. **dependsOn**：変えない。1 つの act の中で手を順に並べる使い方で足りている。実走で、別の項目に分けた時に書くかを見る。
5. **確かめ**：直した後、同じ台で p1〜p3・v3・k2 と、keep を狙う場面を 2 回ずつ回す（残りの予算の内）。最初の計画（Opus）が `promises` を書くかも 1 場面見る。

### A-8（10/29、開いた約束を Sonnet が守らなかった件。頭だけ）

通し（db5fb83）：keep 0/16（最初の計画の Opus は promises を 1 つ書いた）。開いた約束（板 4・地下の作業台）があっても、板 7 で燃料の場面では 3/3 で約束の 4 を割り、約束の語に触れた答えは 0/8。帳簿の行は「事実の行」として読まれ、手を決める理由になっていない（推測）。

「なぜ重要視されないか」の切り分け：入力には有る（行は出ている）。理由と重要度が無い（割ると何が起きるか、約束を割る時にどうするかの決まりが無い。「約束を理由に手は断らない」だけがある）。書き方で直す（コードで断らない方針は変えない）。

1. **帳簿の行に「使える残り」を出す**（計算できる物はコードで）：`約束 #1 地下の作業台用の板 4: 今 7（約束の外で使えるのは 3）`。約束の外で使える数＝今 − 開いた約束の数の合計（0 未満は 0）。
2. **act が約束を割る時、送る前の確認の結果の文で 1 度知らせる**（断らない）：act の消費の見込み（燃料・材料の数）が「約束の外で使える数」を超える時、送った後の結果の文に「この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 6 を使い、残り 1）」を 1 行出す。見込みは手の args から頭が計算できる範囲だけ（smelt の fuelCount・make の材料）。
3. **system の決まりを 1 つにする**：「開いた約束の物は、その用途のために残す。割るなら why に約束の番号と理由を書く」。今の「約束を理由に手は断らない」は頭と体の決まり（LLM への決まりではない）なので、LLM への文からは外す。system 8,800 以内。
4. **確かめ**：同じ台で p1（約束あり）3 回・kp3（鉄 7 の使い道に約束を開く）2 回・p3（食料の約束）2 回。

### A-9（10/29、約束を使う場所で見せる。頭だけ）

切り分け（p1・約束あり・1 段目）：Sonnet medium 3/3 割った・考えの要約に約束の語 0/3（「作業台が近いので板は燃料にできる」と持ち物から残りを数えている）。Opus low は 2/2 で約束を読み、1 回は守って keep と uses を書いた。Sonnet は、離れた帳簿の行と、手を組む時に見る持ち物を結び付けていない（推測）。

1. **持ち物の行に約束の取り分を書く**：live の持ち物で、開いた約束のある品目に「（約束 #1 に 4・外 3）」を付ける。例 `spruce_planks 7（約束 #1 地下の作業台に 4・外 3）`。Sonnet が燃料や材料を数える時に見る場所に置く。帳簿の行はそのまま。
2. トークンは live の側なので system は増やさない。急ぎの版でも持ち物の行に付ける。
3. **確かめ**：p1（約束あり）を Sonnet low で 3 回、1 段目と、つないだ「割る見込み」の文を受けた 2 段目。

### A-10（10/29、ユーザーの決め「割る時だけ Opus」。頭だけ）

通し（e40ef30）：持ち物の取り分・帳簿の外の数・決まりの 1 行・割る見込みの知らせ、の 4 つとも Sonnet には効かず（p1 で 3/3 板 6 を燃やす、約束の語 0）。Opus は約束を読んだ（2 回中 1 回守った）。ユーザーの決め（10/29）：約束を割る見込みの act の時だけ Opus に決め直させる。試算は 1 本 約 960〜1,090 円（今は 約 900 円）。

1. **入口**：Sonnet の act が送る前の確認を通り、割る見込み（A-8 の 2 と同じ数え方）が 1 つ以上ある時、列に入れる前に Opus（claude-opus-5-5、考える量は最初の計画と同じ設定）に 1 度だけ決め直させる。
   - Opus への要求は、同じ system・道具・live に、「Sonnet が出した act（そのままの短い書き方）」と「割る見込みの行」を足した物。Opus の答え（act・keep・plan.update）を Sonnet の答えの代わりに使う。Opus が同じ act を出したら、そのまま列に入れる（割ってよい理由は why に）。
   - 1 つの act につき 1 回だけ。Opus の答えがまた割っても、もう Opus には回さない（輪にしない）。
   - Opus が失敗・時間切れの時は、Sonnet の act をそのまま入れ、記録に残す。
2. **数え方を広げる**：make・craft の材料も、割る見込みに数える。頭に小さなレシピの表を持つ（計画の範囲の物：板・棒・作業台・かまど・木と石と鉄とダイヤの道具・バケツ・盾・松明・箱・火打石など）。表に無い物は数えない（記録に「数えなかった」と残す）。
3. **記録と費用**：判断の記録に、決め直しの回数・Opus の費用・Sonnet の act と Opus の act の違いを残す。予算の上限（1 本 1,600 円）の数えに Opus の分も入れる。
4. **確かめ**：同じ台で p1（板の約束あり）3 回を、Sonnet → 決め直し → Opus の経路で通し、Opus が約束を守るか・費用・秒を見る。make の材料で割る場面を 1 つ足す。

### A-11（10/29、決め直しの通しから。頭だけ）

通し（eb2331d、5 回、USD 0.48）：決め直しは 5/5 で起き、実 API の誤り 0。Opus は約束の番号を出し、4/5 で約束を満たす形にした（1 回は板を残す、3 回は作業台を拾って instead を満たす）。Opus の 2 回目以降はキャッシュが効いた（1 回目 USD 0.195、以降 0.025〜0.044、3.8〜12 秒）。1 回は Opus の act が `equip shield slot=off-hand` で断られ、Sonnet の割る act がそのまま入った。

1. **instead を満たす act は「割る」と数えない**：割る見込みを数える時、その act の手で約束の instead が満たされる見込み（作業台を拾う dig・作る make など、手の args と観測から頭が分かる範囲）なら、割る見込みの行の代わりに「約束 #1 は代わりの条件（作業台 1）で満たす見込み」と出し、決め直しにも回さない。既に instead が成り立っている約束（kept_by_instead）も数えない。
2. **Opus の act が送る前の確認で断られた時**：断りの文を付けて Opus に 1 度だけ直させる（書き方の直しだけ。決め直しの 1 回とは別に数える）。それも断られたら Sonnet の act をそのまま入れて記録。
3. **slot の言い換え**：`off-hand`・`off_hand` は `offhand`、`main-hand`・`mainhand` は `hand` として読む（stopIf の引用符と同じ、明らかな書き方の揺れだけ）。


### A-12（10/29、ユーザーの決め「新しい版だけ・詰まったら止めて直す」。頭）

測りの比べの実走 4 本はやめる。新しい版だけをシード A で 1 本、`--hold-on-failure` で走らせ、詰まりに 1 つでも当たれば保留して現場を残し、直して再開する（実走 45 の仕組み）。保留の種類に次を足す（今ある go_search_timeout・long・go_stuck は残す）：
1. `node_stalled`：計画の今の節（current）が、保留を除いた秒で 120 秒、進み（節の状態・meter の数・持ち物の進み）が無い。
2. `same_spot_stops`：go か vertical が、同じ所（半径 3 マス）で 2 回、done 以外で止まった。
3. `wait_loop`：wait だけの act が 3 回続いた（間に体を動かす手が無い）。
4. `decide_error`：決め直し（A-10）の失敗・時間切れ、Opus の act の 2 度目の断り、送る前の確認の断りが同じ判断で 2 回。
5. `death`：死んだ（死の直後に保留。全ロスでも同じ）。
各保留は黒箱と現場の保存（既存）を使い、保留の理由と、判断の記録の直近の行を黒箱に入れる。スイッチは付けない（`--hold-on-failure` の時だけ働く、は今と同じ）。

#### A-12 の体の型（体の実装の形。体が書く。頭が保留を体に伝える入口）
頭が見つけた保留（`head:<kind>:…` の id）は、体の黒箱・現場・世界の停止を伴う。頭は、保留したい時に体へ `incident.take` を送る。
```ts
/** 命令の context への足し（release でも act でもよい）。 */
interface BodyTaskContext {
  incident?: {
    hold?: boolean; resume?: string; cancel?: string;
    /** 頭が見つけた詰まり。体は今の重い失敗の保留と同じに保留する。id は頭の id（resume・cancel が同じ id を書く。1〜150 字）。notes は頭の判断の記録の末尾（20 行まで、1 行 400 字で切る）。 */
    take?: { id: string; why: string; notes?: string[] };
  };
}
/** release の受け取りの result は `{"incident": {...}}`。take の時の中身（resume・cancel の `done`・`hold`・`unfreeze` と同じ形に足したもの）。 */
interface IncidentTakeResult {
  op: 'take'; id: string;
  /** 体が保留を持っている（今回作った・同じ take をもう一度受けた）か、保留しないまま記録だけ取った時に true。別の保留を持っていて何も変えなかった時は false。 */
  done: boolean;
  /** 体が今持っている保留の id。保留しなかった時は null。別の保留を持っている時は、その id。 */
  hold: string | null;
  held?: boolean; frozen?: boolean | null;
  /** 世界を止められなかった時の理由（誰かが入っている・RCON 無し等）。この時は保留せず、黒箱と現場だけ取った。 */
  notHeld?: string; freeze?: string;
  /** 黒箱のファイルの場所と、現場の保存の場所（体の PC／VM 上の絶対の場所）。無い時は null。 */
  box?: string | null; scene?: string | null;
  /** 同じ take をもう一度受けた（既に持っている）。 */
  again?: boolean;
}
```
- 頭が見つけた保留の id は `[A-Za-z0-9_.:-]` の文字だけ（頭が作る。体はこの外の文字が来ても受けるが、黒箱のファイル名と現場の場所の名前では `_` にする）。
- 順序：世界を止める（`/tick freeze`。他の人が居れば止めない）→ 現場の保存 → 黒箱（kind は `head`。`reason` は `why`、`head: { id, why, notes }`）→ 保留の記録（`incident-hold.json`、`id` は頭の id、`task` は context の taskId、`why` は `why`）。黒箱のファイル名と現場の場所の名前は、id の英数字と `._-` 以外を `_` にしたもの（保留そのものは頭の id のまま）。
- act に付いた時：体はまず take をし、保留した場合その act は「保留中」で断る（`failureType: held`。result は `{"held": "...", "incident": {...}}`。`incident` の欄は重い失敗の保留と同じ：`id・heavy・why・held・frozen・freeze・notHeld・box・scene`）。保留しなかった場合は act をそのまま走らせ、その受け取りに `incident`（`held: false`・`notHeld`）を付ける。release に付いた時は上の `IncidentTakeResult`。
- 再開：頭の保留の `resume`（release に `incident.resume = <頭の id>`）で、体は世界を戻し（`/tick unfreeze`）、保留の記録を消す（`done: true`）。別の id の resume は何もしない（`done: false`・`hold` に今の保留）。体が何も保留していない時の resume・cancel は、世界だけ動かして `done: true`。
- 体は `take` を頭が自分で見つけた詰まりの時にだけ受ける。`--hold-on-failure` の判断は頭がする（体は context の `hold` を見ない）。

#### A-12 の体の型（足し：空き枠と、水の中の掘りの停止の文）
```ts
/** 観測の state.world への足し。体の `freeSlots(bot)` と同じ数え（持ち物の 9〜44 番のうち空の枠。pickup の「空き 0 枠」と同じ）。観測の inventory は種類ごとに 1 行にまとめた形なので、行の数では数えない。 */
interface WorldState { freeSlots: number }
```
- 頭の完了条件 `free>=n` は `state.world.freeSlots` を読む。
- 水の中で掘る手（`dig`・`mine`・`obsidian`）が泳ぎの反射（息が半分以下）に止められた時、その手の行（`stopped`）の文の後ろに理由と次の手が付く：「水の中で掘っている（頭が水／足元が水）。水の中の掘りは遅く、息が続かない（息 n/20）。水源を汲むか、ブロックで水を塞ぐか、水の外の立ち位置から掘る」。同じ所（足のマス）で 2 回目以降は「（同じ所で n 回目）」を足す。反射そのものは変えていない。
- `obsidian` の手は、どう終わっても、自分で注いだ水の源が残っていれば終わりにもう一度汲み戻す。持ち物が満杯の時は水を注ぐ前に `inventory_full`（「持ち物が満杯（36/36）で黒曜石を拾えない。drop で空ける」）で止まる。
- `dig` は、掘り始めてからそのブロックの掘る時間を 3 秒越え、体が届く所（`DIG_REACH`）を 1 マスより外へ流されている時、掘りを止めて `out_of_reach`（「掘っている間に体が流されて届かなくなった」）で返す。

### A-13（10/29、実走46 の保留 1 から。頭）
same_spot_stops の誤検出（+303 の dead_end 0 歩と +388 の no_floor 0 歩。間に鉄・作業台・かまど・焼きで仕事が進んでいた）。
1. 数えるのは、go か vertical が実際に時間か仕事を使った止まりだけ（3 秒以上走った、または 1 歩以上動いた・1 つ以上掘った／置いた）。道 0 歩で 3 秒未満のすぐの断りは数えない。
2. 2 回の間に、体を動かす別の手が done で済み、持ち物か世界が変わったら数え直す。

### A-14・A-15（10/29、実走46 の VM 停止から。頭）
体の取り戻し（`fcaBodyRecovery`）が止めた依頼（`paused`・`fca_stopped`。保留の行は無い）を、operator が続けられるようにする。
- **A-14**：operator の `resume` は、保留の行が無い取り戻しの paused（`fca_stopped`）も受け付ける。`--latest` は「開いた保留」と「取り戻しで止まった依頼」の新しい方。id を名指しすれば両方に使える。体へは `incident.resume = recovered:<taskId の先頭 12 字>` を送り、体が断れば再開しない。
- **A-15**（再開 3 の 3 つの不具合）：
  1. 閉じた保留の act を出し直さない。再開の「出し直さない」の記録（`settled`・`skipped`）を、実行時の再開より前に書く（これを待つと `resumePending` が「出し直す保留あり」と読んで古い act を送った）。
  2. 失われた操作の結果は分からない、を最初の判断に 1 度だけ事実として渡す（「体が動けなかった間に失われた操作（<q の番号> <最初の手>）の結果は分からない。観測で確かめる」）。
  3. 依頼の時間の上限から、取り戻しで止まっていた時間（`paused` の記録から再開まで）と、`resume --deduct-minutes N`（1〜1440 の整数）で指した分（VM の停止）を引く。`time_limit` で止まった依頼も、引いた後に上限の内なら続けられる（外なら `--deduct-minutes` を案内して断る）。引いた分は再開の記録（`deduct=<ms>`）に残る。VM 停止より前の分は自動では測れない。
- **失われた操作の選び方**（実走46 の再開 3 の直し）：2 の知らせが名指しする操作は、取り戻しの close が閉じた物（受け取りが `reconciled` の最新の skill）にする。無ければ、そのタスクの最新の skill。以前は最新の skill だったので、再開 2 で出し直した q35 を名指しして、VM 停止で失われた q46 を指さなかった。

### A-16（10/29、実走46 の保留 2 から。頭）
「送る前の確認が続けて 2 回 act を断った」（`decide_error`）が、走っている go と列の wait の並びで偽に当たった（alert で起きた 2 回の判断が、列にある wait と同じ wait を出し、2 回とも「同じ手が列にある」で断られた。体は詰まっていなかった）。「同じ手が列にある」の断りは「もう頼んである」という答えで、LLM の誤りではないので、数えない。**A-18 が数える物をさらに絞った**ので、実装は A-18 に含まれる。

### A-17（10/29、実走46 の保留 2〜3 から。頭）
保留中の依頼が、未知の掃除（`retireUnknown`）で failed になった（保留の 3 分後、世界は frozen のまま）。保留の時に走っていた q の停止要求で、依頼は `paused`・`unknown`・`fca_unknown` になり、取り戻しは停止要求のある unknown を見ないので、掃除に引退させられた。
1. **開いた保留の行がある依頼を、掃除は引退させない**（頭の保留も体の保留も、監査の保留の行で見分ける）。保留は持ち主の `resume` を待つ物。
2. **取り戻しは、保留中の unknown を勝手にキューへ戻さない。** 停止要求の有無にかかわらず、体が失われた手の解放を証明したら、止まった状態（`paused`・`fca_stopped`、再開できる）にする。判断は増えない。
3. **掃除が failed にした保留中の依頼は、operator の `resume` で戻せる。** 戻す条件は、保留の行が開いていて、退役の履歴（`fca_unknown_retired` の直後に `fca_recovered_unknown`）があるタスクだけ（それ以外の failed は今どおり続けない）。状態機械の late-report の出口（failed のまま unknown の時刻が残っている物が `stopped` へ戻れる）を使い、`fca_retire_reopened` の記録を残す。DB の行は書き換えない。再開の記録の `accepted` に `reopened=retire_unknown` が付く。戻した後は、普通の保留と同じ道（体の保留を解く → 再開）。
4. `paused`・`unknown` のまま（取り戻しがまだ `stopped` にしていない）の保留は、`resume` が `not_running`（まだ止まりきっていない）で断る。体には何も送らない。
親へは、退役の時に「失敗」を伝えている。戻しても親の記録は戻らない（最上位の依頼では影響が無い）。

### A-18（10/29、実走46 の保留 3 から。頭）
`decide_error` の「送る前の確認の断りが同じ判断で 2 回」は、**形や値の誤りで act が送れなかった時だけ**数える（`invalid_input`：読めない語・範囲外・必須が無い・型が違う）。列や状態の都合の断り（`refused`：同じ手が列にある・急ぎの判断は 3 手まで〔`urgent_limit`〕・列がいっぱい・体が止まっている・前提を満たさない・戦闘の守り）は、LLM への答えで誤りではないので数えず、形の誤りの連続を切る。そういう詰まりは `node_stalled`・`wait_loop`・`same_spot_stops` が拾う。決め直し（A-10・A-11）で Opus の act が列や状態の都合で断られた時も、同じく数えない（直し直しが失敗した時は数える）。

### 実走46 の中で直した満杯の事実（頭。体は `freeSlots` を足した）
- **空き枠は体の数が正。** 観測の `state.world.freeSlots`（A-12 の体の型の足し）を、頭は数え直さずそのまま使う。体の観測の `inventory` は種類ごとに 1 行にまとめた形で、行の数は枠の数ではない（深層岩の丸石 230 は 4 枠）。体の数が無い観測では、1 行が埋める枠の数（1 枠 64 個、16 個・1 個の物の表）で見込む。
- **満杯は先頭の一言で事実として言う。** 「持ち物の空き 0/36（満杯）：これ以上拾えない（黒曜石・鉱石・落とし物も。dig・pickup・make の物も入らず止まる）」。続けて、約束に回していない石・土の余り（丸石・深層岩の丸石・凝灰岩など。一番多い種類は 1 スタックを柱と橋用に残す）を、drop で空けられる物として並べる。短い版にも出る。頭の `body.pack` と事実の行の両方に出る。命令の文は使わない。

#### 実走46 の後の体の直し（vertical・go・プレイヤー一覧。体が書く）
- **vertical の守りの止め**：掘りを露出の守り（見えない敵に身体が見える・届くようになる掘り）が止めた時は、`cannot_dig` ではなく `threat_exposed` で返す：「{ブロック}(x,y,z) を開けると {敵}（約N m）から身体が見える」。ヒントは stairs で「敵が離れるのを待つか、toward を変える」、shaft・pillar で「敵が離れるのを待つか、別の場所から」。手の行は 160 字に収まる形で、長い時は理由の方を切ってヒントを残す。止めたマスは go と同じく道探し（refusedDigs）が、その敵が 3m 動くか消えるまで（最大 90 秒）避ける。向きを体が自分で変えることはしない（toward は LLM のもの）。
- **vertical の canDig に無いブロック**：止まる文は `canDig に {名前} を足せば進む`（ヒントは文の末尾に残す）。壊して困らない邪魔な物（`*_fence`・`*_rail`・`rail`・`cobweb`・`torch`・`wall_torch`・`soul_torch`・`redstone_torch`・`ladder`・`vine`・`string`・`tripwire`・`tripwire_hook`）は canDig に無くても掘り、着いた時の文に「邪魔な物を壊した {名前}×n」を足す。板・扉・箱・ベッドなどは今までどおり canDig に書かれた時だけ。
- **vertical の足場の既定**：stairs と shaft で `canPlace` が書かれていない時（欄が無い時）は、持ち物の `cobblestone`・`cobbled_deepslate`・`dirt`（この順）を足場に置いてよい。断る時は `canPlace: ["none"]`（`none` は物の名ではなく「置かない」）。pillar には既定が無い（書かれた物だけで積む）。
- **go の守りの止め**は A-12（体）の実走46 保留 4 のとおり：違うマス 8 個が 45 秒の間に止められ 2m 以上近づけない時、または道が無くなった後に止めたマスがある時、`threat_exposed`。文は「{敵}（約N m）から見える所を掘らないと進めない（守りが止めた n マス (x,y,z)）」の後に、手の数の尾と「敵が離れるのを待つか、別の道・行き先を」。
- **プレイヤー一覧の読み**：RCON `list` の答えは「There are N of a max of M players online: A, B」の全体の形を持つ時だけ受ける（N と M が数、名前は Minecraft の名前 `[A-Za-z0-9_]{1,16}`、名前の数が N）。別のコマンドの答えが混ざった物・形が崩れた物は 250 ms 置いて最大 3 回読み直し、それでも崩れていれば `players_unknown`（世界は止めない）。体の名前は完全な名前で外す（`I_am_Shannon2` は `I_am_Shannon` ではない）。
- **go の掘り進みの速さ**：実走46 の「掘れたブロックごとの引き直しで次の掘りが止まる」（Digging aborted）は、道探しの更新（block_updated）を握りつぶす直しを試したが、経路の実行が壊れた（掘った後の最後の一歩で探索が尽きた）ため入れていない。隔離ラボで測った深層岩のトンネル（鉄のツルハシ、ブロックの掘る時間 750 ms、28 マス・14 歩、引き直し 0 回）は 28.4 秒＝1 マス 1,016 ms（掘る時間の 1.35 倍）。実走46 の 1 マス約 1 秒もほぼこの範囲で、遅さの大半はブロックの掘る時間。中止された掘りは 10〜40 ms で終わる。
- **go の道（実走47 保留 1）**：開いたはね上げ戸・扉・フェンスゲートは、板が縁に立つ（開いたはね上げ戸は 1 辺に 1 ブロックの高さの薄い板）。道探しは、その板が体の高さ（足・頭。登りは登る先の高さも）で踏み越える縁に立つ一歩を、一歩として数えない（`MapBlock.plates`、go の経路探索と止まりの理由の探索が同じ当たり判定で見る）。板が無い向きからは今までどおり通れる。止まりの印で avoid に入れるのは、行き先のマスそのものを除いたマスだけ（行き先を avoid に入れると、同じ行き先の探索が必ず timeout になる）。
- **pickup（実走47 保留 1）**：落とし物の座標がブロックの中（壁の中など）にある時は、拾いの手が近づく半径をそのブロックの外から取れる広さ（`TAKE_ACROSS - 0.15`）に広げる。ブロックの外にある物は今までどおり 0.5。
- **go の斜めの一歩（実走47 保留 2）**：斜めの一歩は、体の幅 0.6 を中心の線に沿って動かした時に、角の 2 マスの足・頭の高さの当たり判定（開いたはね上げ戸・扉の板、角にある窓の板・柵・格子の細い形）に当たらない時だけ道として数える（全部が 1 ブロックの物は角で滑るので数えない）。当たる時は、掘ってよい物（canDig）なら掘る費用を足して道に入れ、掘れなければ道にしない。道が無くなった時の理由は今までの形：「許した手では道が無い。canDig に {ブロック} を許せば掘 n で道がある」（窓の板・はね上げ戸の名前が入る）。登りの一歩は、登る先の高さから上の板だけを見る（足元より下の 1 ブロックの高さの板は飛び越える）。
- **満杯の扱い（実走47 保留 5）**：持ち物が満杯になった時に act が止めるのは、拾うことが目的の手（pickup・mine・obsidian・chest・furnace・smelt・make・craft と、collect する dig）だけ。go・vertical・walk・portal ほかは満杯でも止めない（着くのに物は要らない。掘った物は拾えずに落ちる）。満杯の時、go と vertical の結果の文に「。持ち物が満杯（掘った {物} は拾えずに落ちた n 個）」を足す（開始後に地面に現れた物の数。落ちた物が無ければ「拾えずに落ちた物は無い」）。
- **go の行き先が固い物の時（実走47 保留 6）**：行き先のマス（range 0.5 より小さい時だけ）の足元の高さ、またはその頭の高さ（1.8 m）が、丸ごとの固いブロックで canDig に無い時は、探索の前に `dead_end` で返す：「行き先 (x,y,z) は clay で canDig に無い。隣の立てる所 (a,b,c)」＋ヒント「canDig に clay を足すか、隣の立てる所 (a,b,c) へ」。半ブロックや絨毯の上に立つ行き先、掘ってよい物は対象外。また、同じ行き先・同じ位置からの探索が時間切れ（5 秒）になった後、同じ位置で同じ探索をもう一度引くことはせず、`search_timeout` で止める。
- **obsidian の岩に囲まれた溶岩源（実走47 保留 7）**：源の面が全部岩（空気・水に触れる面が無い）で、水を注ぐ所も立ち位置も無い時、手は溶岩に届く範囲の外なら先に近づき、源の真上のマスの高さで横から 2 マスの通路（と立ち位置）を掘り、最後に源の真上のマスを掘って面を作る（溶岩は上へ流れない）。掘る許し（`canDig`、欄は任意）が無ければ石・深層岩・土。通路の床が岩で、掘るマスの隣に水・溶岩が無い向きだけを選ぶ。作れない時は「(x,y,z) は岩に囲まれ（面の名前）、掘って面と立ち位置を作る道も無い: 北は (x,y,z)（通路）が {名前}…」で `unreachable`。
- **水の中の歩き（実走47 保留 7）**：水のマスを出る・入る水平の斜めの一歩は道にしない（まっすぐ 2 歩に分ける。水から上へ登る斜めは今までどおり）。go が流れる水（水の流れ n・落ちる水）の中で 2 回直しても進めない時は、`stuck` で「流れる水の中（(x,y,z) は 水の流れ n）で 3秒ずつ進めない（上流へ泳いでも押し戻される）」と、ヒント「上流の水源を汲む（use の bucket）かブロックで塞ぐか、別の道を」を返す。
- **ログイン直後の地図（実走47 保留 8）**：体の周り（足元とその 1 つ下）のブロックがまだ 1 つも読み込まれていない時、観測の地図（`localMap`）は「?」の絵ではなく「地図はまだ作り中（周りのチャンクを読み込み中）。view で周りを見るか、少し待ってから」と返し、その絵はためない。チャンクの読み込み・ログイン・スポーンで地図を描き直す印を立てる（再起動の後の最初の絵が、足が動くまで残っていた）。
- **go の時間切れと流れる水（実走47 保留 8）**：go が `limit_time` で切れた時、足元が流れる水（水の流れ n・落ちる水）なら、文に「。流れる水の中（(x,y,z) は 水の流れ n）で押し戻された」を足し、ヒントを「上流の水源を汲むかブロックで塞ぐか、別の道を」にする（`seconds` の長さによらない）。
- **行き先の固いブロックを掘れない時（実走47 保留 10・11）**：go の行き先（range 0.5 より小さい時）の足元の高さ・頭の高さが、canDig にあるブロックでも、隣（東西南北・上）が水・溶岩で掘ると流れ込む、または上が canDig に無い落ちるブロック（gravel・sand）で掘ると落ちてくる時は、道探しはそのマスを掘らない（行き先に入れない）ので、探索が 5 秒かかって時間切れになる代わりに、すぐ `dead_end` で返す：「行き先 (x,y,z)の頭 (x,y+1,z) の stone は隣の (a,b,c) が water で掘ると流れ込む」＋ヒント「水を塞ぐか、隣の立てる所 (…) へ」（落ちるブロックなら「canDig に gravel を足すか、…」）。探索が時間切れになった時も同じ確かめをして、当たれば search_timeout の代わりにこれを返す。canDig に落ちるブロック（gravel・sand など）を入れた go は、その下のマスも掘る（落ちた分は次に掘る）。
- **obsidian の掘りの上限（実走47 保留 11）**：岩に囲まれた源へ面を作る道の掘りの上限は、手の欄 `maxDig`（1〜100、無ければ 30）。前の 12 は体の最初の仮の値で、契約の根拠は無かった。足りない時は「(x,y,z) まで掘ると 掘る所が N 要り、上限 M を超える。maxDig=N+2 なら作れる（obsidian の maxDig）」を `unreachable` で返す。通路の上のマスも掘る（穴の中から源の真上が見えるように）。
- **vertical の洞窟（実走47 の後）**：次の足場（縦穴は足元の 2 マス下、階段は次の段の床）が空気でも、その下 1〜2 マス以内に液体でも危ない床でもない岩があれば、落ちる高さは合わせて 3 以下（ダメージ無し）なので、そのまま下りる（途中の空気のマスも段として数える）。着地する先の周り（4 方向）に溶岩・水があれば止まる（`lava`・`water`）。3 を超える洞窟、上りの階段は今までどおり `no_floor`。階段で止まる位置が 1 マス進行方向にずれた時（同じ高さ）は、段を踏んだものとして次の段をそこから引く。
- **obsidian の落とし物（実走47 保留 12）**：掘った黒曜石が穴に落ちて歩いて拾えない時は、落ちた先のマスまで canDig（無ければ石・深層岩・土）で掘って行って拾う（掘る数は maxDig）。落とし物の探す範囲は源から 12 マス。作ったのに拾えなかった黒曜石は「作った黒曜石 n 個が (x,y,z) に落ちたまま（拾えていない）」と結果の文に出す。待った時間は理由ごとに（溶岩が固まるのを・水が引くのを・穴に水が満ちるのを・落とし物が現れるのを・拾うのを）1.5 秒以上のものを「…待った n 秒」と文に出す。岩に囲まれた源で面を作れない時の理由は 4 方向すべて。
- **流れる水の上流（実走47 保留 7〜9）**：水がその列を天井まで満たす所で、上流（水の流れの数が小さい側）へ登る水平の一歩は、道探しは道にしない（押し戻されて進めない）。道が無くなった時の理由は「道は流れる水を天井の下で上流へ遡る一歩だけ（押し戻されて進めない）」（`dead_end`）。
- **保留にするかどうか（実走47 の後、体の `heavyReason`）**：歩・掘・段が進んでいた手が時間切れ（`limit_time`）になったものは `long` でも保留にしない（結果の文で続きを出させる）。体が理由まで言える止まり（`threat_exposed`、流れる水の `stuck`、行き先が固い・水の隣の `dead_end`、canDig に足す物を言う `cannot_dig`）は、同じ所（文の最初の (x,y,z)）の 1 回目は保留にせず、2 回目から `explained:` として保留にする。頭が保留の id で `incident.take` を送り直し、体が「保留のまま起動」していた時は、世界を止め直して保留を保つ。
- **obsidian の欄 `maxDig`**：1〜100 の整数（無ければ 30）、岩に囲まれた源へ面を作る道と落とし物へ掘る道に使う。
- **鉱石の名を canDig に書いた時（実走48 保留 1）**：`copper_ore` のように鉱石の id を canDig に書いた vertical・go は、その鉱石を掘る（頭が「canDig に足せば進む」と言われて足したのに、体が鉱石は決して掘らない決まりで断っていた）。`stone` `dirt` `sand` `wood` の言葉は今までどおり鉱石を含まない。書かれていても体が壊さない物（扉・スポナー・ベッド・黒曜石など）は、vertical の `cannot_dig` で「canDig に書かれているが体は壊さない決まりのブロック」と言い、足せば進むとは言わない。
- **置きの断り（実走48 保留 2）**：go の置きがサーバーに断られた時、体が地面に立っていて、断られたマスが足の高さ以上（登る段）なら、1 回目は止めずに引き直す（同じ置き場をもう一度試す。断られたマスを高くしない：高くすると、隣の溝へ下りる道を選んだ）。同じマスが 2 回、または続けて 3 回断られた時、または足の下の床（溝に渡す橋）が断られた時は、今までどおりすぐ `stuck`：「置いたブロックが世界に現れない（置きを断られた (x,y,z) に n 回。直前に掘った (x,y,z)）」＋ヒント「別の道か canPlace の物を変える」（置くマスの向き・足の高さなどの事実は黒箱の refused_place）。引き直した道が歩くマスは、前の道の置きが残っていても置かない（`place_held_back` の `route_walks_it`）。保留は、この止まりも体が直し方を言える止まりとして、同じマスの 1 回目は保留にしない。
- **equip の既定の slot（実走48）**：slot を書かない equip で、防具（`*_helmet`・`*_chestplate`・`*_leggings`・`*_boots`・`elytra`）は着ける場所に着ける（文は「… を torso に着けた」）。手に持たせたい時は slot=hand。防具でない物は今までどおり手に持つ。
- **長い手と保留（実走48 保留 3）**：60 秒を超えた手でも、失敗した行に進み（道 n 歩・段 n・掘 n・置 n・黒曜石 n 個・「n 個のうち m 個」の m）があれば `long` で保留にしない（結果の文で続きを出させる）。何も進んでいない長い手は今までどおり `long:` で保留。
- **obsidian の止まりの文（実走48 保留 3）**：「obsidian 止まった {code}: 黒曜石 n 個・水の注ぎ p 回・立ち直し r 回。{理由}…（{count} 個のうち n 個）」。数を最初に出す（160 字で後ろから切られても、作った数・拾った数が残る）。
- **柱の置きの時（実走48 保留 4）**：跳んで足元に積む置き（go の登り・vertical の pillar）は、足が置くマスの上面から十分上にあるだけでなく、落ちる速さのまま 2 ティック（サーバーが置きを処理する頃）進んだ足の高さも、マスの上面より 0.03 以上上にある時だけ送る（落ちている間に送った置きは、サーバーに着く頃に体がマスに入り、断られていた）。
- **柱の置きにサーバーが答えない時（実走48 保留 5）**：置きが 1.5 秒答えられず（置けたと返ったが無い）、足元に積まれていない時は、体が地面に戻ってからもう一度跳んで置く（2 回目も同じなら `not_placed`）。文の「足 y=」「体と重なり」は、置きを出した時の足（跳びの最高点ではなく）で数える（これは前からそうで、黒箱の place 行の `feet` は 1.5 秒待った後の足で、置きを出した時ではない）。

## 実走48の後の直し（2026-10-30、契約3.2、Codex引き継ぎ）

- **完成時の持ち物の記録**：craft/make の最後の待ちが act の done 条件で中断されても、観測できた生成品と材料の実消費を finally で一度記録する。生成品が増えていなければ成功したと推測しない。実走48の火打ち金では、この待ちの中断で鉄1の消費の出来事が失われていた。
- **約束の用途を満たす消費**：期限・代替条件を明示しない約束で、用途がレシピの品名そのもの（または火打ち金・作業台・かまど・バケツ・盾・松明の明確な品名）の時、その品を作る材料の消費は約束違反ではない。自由文の用途は推測しない。ほかの用途の取り分は残す。同じ command/pass/hand の材料消費と生成品の実記録がそろい、約束の数を使った時だけ closedBy=used として閉じる。別ページ・checkpoint をまたぐ受信にも対応する。明示した until/instead は従来どおり優先する。
- **実際の作業と計画**：実走48の保存計画には n1 までしかなく、act の n2〜n4 は存在しなかった。存在しない札では current を移せない理由と plan_update の直し方を LLM に示す。節を作る判断は LLM に残す。node_stalled は実際に始めた札・節目の追加・品目ごとの増加も進みとして見る。
- **同じ場所の停止**：反射・運用者の取消を失敗した道の試行に数えない。threat_exposed・falling_above など直し方を示す停止は、同じ原因・3マス以内の2回目から数える。別原因を混ぜて2回としない。
- **上りの砂利**：stairs up が現在の頭上の支えを開く時、その上が落ちるブロックなら支えを掘らず falling_above と理由・別の場所や向きから掘るヒントを返す。体が勝手に向きや形を変えない。
- **mine の見出し**：敵の視線を開く掘りの停止は threat_exposed（見られる）として返し、溶岩の danger と区別する。
- **準備の理由**：鉄のある高さで先に火打ち金を作る理由として、実走48で黒曜石取得後の鉄・火打石に約690秒使った事実を LLM に渡す。動作や順番を体で強制しない。

## A-21: 瀕死から回復するための再開（実走50、2026-10-30）

瀕死の保留を運用者がresumeした時、同じタスクで確認済みの低体力が変わっていないことだけでは、新しい瀕死の保留にしない。skip-replayで次の別の手から判断する時も同じ。食事による満腹度だけのhealth通知や、軽い置きの失敗で回復の判断前に止め直さない。元の保留はファイルから復元でき、resumeの確認はunfreezeより前に行う。

追加の体力低下、瀕死の境界（4）より上への回復、死亡、別のタスクへの切替で、この確認は終わる。新しい被害や死亡は、出し直した手でも「前と同じ理由」として保留を省かない。経路の詰まりなど別の重い失敗の保留は従来どおり。体力・持ち物・世界を書き換えず、回復・退避・食事を選ぶのはモデルのまま。wireの項目と契約版3.2は変更しない。
