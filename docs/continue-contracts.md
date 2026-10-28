# 「続ける力」の契約（2026-10-28、契約の版 3）

次の大きな版「続ける力」（設計は共有メモ `next-version-design-20261028.md` の案 2）を、体の担当と頭の担当の 2 人で作るための契約です。
同じ文書が、頭（`shannon-ios` の `docs/continue-contracts.md`）、体（`Shannon` の `docs/continue-contracts.md`）、共有メモ（`continue-contracts.md`）にあります。
**変える時は 3 つを同時に変え、見本（fixture）の manifest の版を上げます。**

- 書いたのは契約・見本・通しの確かめの骨組みだけです。実装はまだ無く、ここに書いた型はまだどこにもありません。
- 「確か」は今のコードや記録で確かめた事、「決め」はこの契約で決めた事、「仮説」は確かめていない見込みです。数字の見込みは、どれも確かめていません。合格の条件・仮説・観測の結果を混ぜません。
- 基にした版：頭 `06f5e55`、体 `4e8c3df`（どちらも main。頭は v2 の後にミニシャノンの 2 commit が main に入ったので、その上に付け直した。契約の範囲のファイルには触れていない）。
- 実走 45 は終わりました（45 分、黒曜石 7、ネザー無し。保留 1〜11）。直しの実走で、途中で版が変わったので、版の効き目の比べには使いません。この契約では、失敗の型の題材としてだけ使います。
- 方針（00-README の 1〜7）：判断は LLM、細部は体。LLM が従わない時は書き方で直し、コードで強制しない。スイッチは付けない。段階に分けず、1 つの版で入れる。

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

- **片付けの手順**：`settled_unknown` になったら、頭はすぐ stop（今の片付けの命令）を送ります。期限は stop を入れた時から 5 秒の上限（仮。成功の保証ではない）で、体側の片付けの中断の期限 3 秒（確か：`controlLoop.ts`）を内に含みます。5 秒で解放が確かめられなければ `held`。通信できない時も `held` です。
- **片付けの範囲は正式な結果です**：今の stop は待ちを全部捨て、実行中を止めます（確か：`controlLoop.ts`）。その時に捨てた・止めた項目は、受け取りの `cutBy: cancelled`・code `cleanup_stop` が確定した結果です。後から q1（不明だった物）の本当の成功が届いて q1 が `corrected` になっても、片付けで捨てた q3 は戻しません（頭が結果の順から列を作り直さない、2 章と同じ）。
- **解放を確かめるまで**、頭は体を動かす新しい命令を送りません（観測だけの命令は送ってよい）。
- **帳簿**：受け取りの持ち物の出来事は、`settled_known` か `corrected` で反映します。出来事の id で 1 度だけです（3 章）。
- **再起動**：
  - 頭の再起動：状態はストアにあるので残ります。起きた時に `settled_unknown` の操作があれば、体を動かす命令より先に片付けを送ります（5 章の頭の起動の登録の後）。
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
`result/r43-reflex-ate-first.json`、`result/r45-hold1-go-partial.json`、`result/r45-resume1-dig-already-go-no-floor.json`、`result/unknown-receipt-cleanup.json`、`result/unknown-state-machine.json`、`result/act-not-started-reflex-late.json`、`result/count-keeps-its-meaning.json`、`result/attack-target-lost.json`、`result/resume-order.json`、`result/r45-resume9-replay-holds-again.json`、`result/r45-hold2-local-go-partial.json`、`result/r45-hold10-goal-blocked.json`、`result/r45-hold3-place-ok-then-world-differs.json`、`result/r45-hold9-face-air.json`、`result/r45-hold9-hand-at-send.json`。

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
- **依存先の状態**（`DependState`、実際の値で決める）：
  - `succeeded`：goal が `done` か `already`、end が `finished`、かつ `released: true`。
  - `pending`：まだ終わっていない（走っている・待っている）。
  - `failed`：終わったが `succeeded` でない（`released: true` で、goal・end がそれ以外。`done` でも end が `cut` なら failed）。
  - `unknown`：end が `unknown`、`released` が確かめられていない、または覚えていない印。
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
  - **出来事は件数だけに潰しません**。受け取りの 16,000 字に入りきらない時、体は受け取りに先頭から入るだけの出来事と `eventsMore: { command, nextSeq, total }` を載せ、残りは命令ごとの出来事の記録に持っておきます。頭は観測だけの命令 `events`（`{ command, fromSeq }`）で残りを取り、取り終えたら poll の `acknowledged` で知らせます。体はそれまで記録を消しません。
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
`promise/r43-planks-burned-as-fuel.json`、`promise/table-crafted-placed-picked.json`、`promise/food-for-underground.json`、`promise/death-loses-promised.json`、`promise/revised-after-send.json`、`promise/make-intermediate-and-reflex.json`、`promise/instead-lost-after-descent.json`、`promise/same-receipt-twice.json`、`promise/seen-after-32-and-restart.json`、`promise/late-old-observation.json`、`promise/events-split-delivery.json`、`promise/life-file-reset-is-not-death.json`。

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
export interface Handover { from: string; target: number; waitedMs: number; reflexSettledAt: string; confirmed: boolean; shield: 'kept' | 'lowered' | 'none' }

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
  deathSeq?: number;     // 死の出来事の通し番号（死んだ時だけ増える。ファイルに一緒に保存する）
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
  - **失効の識別と死の証拠は分けます**：番号が進んだら古い命令は失効します（理由を問わない）。しかし死として扱う（帳簿の `lost_death`、頭の arrival の `death`）のは、`advancedBy: 'death'`（`deathSeq` が増えた）時だけです。ファイルの作り直しでは、持ち物は残っているので死にしません。
- **次元の移りは死ではありません**。番号は変わらず、`dimension`・`dimensionSince` だけが変わります。ただし次元の移りは、2 章の失効の 3 番で、移る前の観測で作ったほかの命令を失効させます。
- **照らす時機**（2 章の失効の 2 番）：受け取った時・待ちから起きた時・ロックを取った後・体を動かす操作の前。`alive: false` の間に動かす命令は始めません（`not_alive`）。
- **体がする事**：
  - 動かす命令で `context.life` が無ければ `life_missing` で断ります。
  - `context.life` が今の番号と違えば `stale_life`・`not_run` で断ります（手は動いていない）。
  - 死の出来事で、待っている項目を全部捨て（`droppedBecause: death`）、実行中の手を止め（`cutBy: death`）、ロック待ちと反射の後の待ちを `aborted` にします。
- **頭がする事**：
  - 命令の `context.life` は、**判断の入力に読んだ観測の life** を入れます（送る時の最新ではない）。今の context は送る時に `minecraftReflexAdapter.ts` で作っています（確か）。判断の入力の life を、項目に持たせて渡します。
  - 考え中の判断の返事は、使う直前に最新の観測の life・次元・`bodyRun` と比べます。違えば `discarded`（理由 `life_changed`・`dimension_changed`・`connection_changed`）にして、新しい観測で判断し直します。
  - `arrivalOf()` は `deathSeq` の増えで `death` を決めます（`facts.life` の増えだけでは決めない）。
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
`life/r45-death-then-old-attack.json`、`life/portal-is-not-death.json`、`life/portal-pending-other-dimension.json`、`life/same-dimension-return.json`、`life/head-boot-registration.json`、`life/reconnect-decision-belongs.json`、`life/death-at-each-moment.json`、`life/life-file-unreadable.json`。

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
  - `canDig` に無い物（岩盤・守られた物を含む） → `cannot_dig`
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
`vertical/r45-hold1-stairs-down.json`、`vertical/r45-hold5-shaft-down.json`、`vertical/r45-hold7-pillar-up.json`、`vertical/lava-seal-and-stop.json`、`vertical/stop-cases.json`、`vertical/counts-and-budget.json`、`vertical/short-hands.json`。

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
- **手の始まりと操作の記録は、続けて取ります**：黒箱は直近 90 秒の輪で、成功した act には書かないことがあります（確か：`blackbox.ts`、実走 45 の記録）。120 秒の手では最初の 30 秒が消えます。通しの台（A・B・C）では、体は始めから終わりまで、`hand_start` と体を動かす操作の 1 件ずつ（時刻・命令・手・life・操作の種類）を、輪とは別のファイルに追記し続けます（成功した手・120 秒を越えた手も含む）。本番でも同じ入口を使い、大きさの上限は判断の記録と同じ考えで決めます。
- **命令の種類ごとの証拠の組**（境界の判定で使う）：
  - 始める前に断った：受け取り（`not_run` と理由）だけ。`hand_start` は無くてよい。
  - already：受け取りと手の行。
  - 普通の操作：受け取り・`BodyTimes`（`lockAt`・`firstMotorAt`・`motorOps`）・`hand_start`。
  - unknown：受け取りと、片付けの受け取り（`released` の行）。
- **入力の変化を分けて記録します**（`input_change`）：プロンプトのハッシュ、thinking の破棄（実走 45 の `prefix_binding_mismatch` 16 回）、再開による履歴の変化。前後を比べる時は、これらを D1・D4 の効果と混ぜません。
- **サーバーの tick**：体は、今ある RCON（`SceneSaver` の command）で `tick query` を送り、生の応答・取った時刻・失敗をそのまま残します。止まっている時（frozen）や読めない時を 0 ms にしません。間隔は 10 秒の仮の案で、負荷を測って決めます。
- **大きさ**：受け取りの結果の JSON は今 16,000 字が上限です（確か：`minecraftControlValidation.ts`、`actReport.ts` は地図を落としても上限内になる保証が無い）。出来事・周回の行が増えるので、体は上限の手前で「古い周回の行・出来事を数だけ残して落とす」を決まった順で行い、落とした数を書きます。境界 10 は最大の長さで試します。

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
`services/api/tests/fixtures/continue/manifest.json` を見てください。版 3 で足し・直し、契約ごとに 5〜15 個です。どれも次の形です。
```json
{ "contract": "result", "version": 3, "scene": "…", "source": "実走 43 +2,123（run43-report.md 105 行）",
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
| 2 | 途中の成果 | A | 途中で止めた vertical の `progress.done`（確かめた段数）と、黒箱の移動の段数が合う。掘った数・置いた数は、それぞれ黒箱の dig・place の数と照らす（段数と掘りの数を等しいとは見ない）。次の手が `progress.at` から始まり、掘った段を掘り直さない |
| 3 | 約束と消費 | A＋C | 作る途中の材料・燃料・作業台の設置と回収・食事をまたいで、帳簿の `have` と観測の持ち物が毎回合う。同じ出来事の id が 2 度反映されない |
| 4 | すぐの引き継ぎ | B＋C | 同じ相手：引き継いだ act の `handover.confirmed` と、盾が下がらない（`shield: kept`）。別の敵：melee が次の手を始めない。溶岩・息・食事：奪わない |
| 5 | 死と非同期 | B＋C | 実行中・反射待ち・列待ち・LLM の返事待ちの各瞬間に `/kill` し、**死の時刻より後に、古い life の命令が効かせた操作が 0 件**。待っていた古い命令は 1 つも始まらない（死の前の操作は数えない） |
| 6 | 古い持ち主 | B | 新しい持ち主が始めた後に、古い処理の片付けが走っても、新しい持ち主のキー・盾・道探しの行き先が消えない（motor port の断りの記録） |
| 7 | 次元と復活 | B | ポータルで life が変わらない。移る前の観測で作った待ちの項目は `dimension_changed` で始まらない。死んで別の次元に生き返った時は life が 1 増える |
| 8 | 通信と再起動 | B＋C | 下の「境界 8 の場面の表」の 6 つの場面を、決めた ID・注入する時・対象の命令で起こす。どれでも、同じ命令の操作が 2 回の実行に分かれない、不明の項目が自動で出し直されない、帳簿に同じ出来事が 2 度入らない、期待した訂正の回数どおり |
| 9 | 計画 | C | `kind`・`prep` が、最初の計画 → `plan.update` → 保存 → 頭の再起動 → 読み戻しで残る。題名の言い換えの前後で、判定の値（段・不足・選ばれる知識・近くの候補）が同じ。表示の文は別に照らす |
| 10 | 実際の LLM の入力 | D | **最大の長さの入力**（急ぎの版・情報の多い live・長い結果と帳簿）でも、8 章の規範の表の物が最後の要求のバイトに残る |

### 境界 8 の場面の表（`e2e/boundaries.json` の `boundary8Scenes` が正本）
| ID | 注入する時 | 対象の命令 | 期待する訂正の回数 | 期限 | 要る記録 |
|---|---|---|---|---|---|
| b8-lost-receipt | q1 の受け取りを頭が受ける直前に 1 度捨てる | q1 | 1（`settled_unknown` → `released` → `corrected`） | 片付け 5 秒 | 受け取り・片付けの受け取り・訂正の行 |
| b8-dup-poll | q1 の受け取りを載せた poll を 2 度送る | q1 | 0 | — | 受け取り 1 件の反映・帳簿の出来事 1 度 |
| b8-reconnect | q2 の実行中に体の接続を切ってつなぎ直す | q2 と待ちの q3 | 0（q2 は `released`、結果は unknown のまま） | つなぎ直しの最初の poll | 新しい接続の最初の poll・q3 の `connection_changed` |
| b8-head-restart | q2 の実行中に頭を再起動 | q2 | 0 か 1（体が受け取りを送り直せば 1） | 起きてからの片付け 5 秒 | 起きた時の片付け・`headBoot` の登録・q2 の状態 |
| b8-body-restart | q2 の実行中に体を再起動 | q2 | 0 | つなぎ直しの最初の poll | `released`・`unexplained` の差 |
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

### 版 3 で新しく決めきれなかった所
1. **出来事を取りに行く命令の形**：観測だけの命令 `events`（`{ command, fromSeq }`）にしました。今の catalog に読み取りのスキルを 1 つ足すことになります（欄の数には影響しない）。poll の欄で返す案もあります。
2. **重複除去の記録の大きさ**：タスクの終わりまで出来事の id を全部持ちます。45 分で数千件（推測）で、計画のチェックポイントが大きくなります。上限を決めるかは、実物で測ってから決めたいです。
3. **引き継ぎの予約の期限 300 ms**：待つ上限で、合格の条件ではありません。実走 45 の反射の手（2 打で約 1.5 秒）の中で足りるかは、隔離ラボで確かめます。
4. **`stepsValid` の訂正の範囲**：下った段の足場が後で無くなった時（下の段を誰かが掘った等）にも引くか。今は「体の通った段のブロックの更新」だけを見る案にしました。
5. **頭の再起動の後に体が受け取りを送り直すか**：今の体は受け取りを頭が受け取ったと知らせるまで送り続けます（確か：`acknowledged`）。頭の再起動でそれが 1 度届くので、b8-head-restart の訂正の回数は 0 か 1 としました。

### 直さなかった指摘と理由（版 3）
Codex の 2 回目の指摘は、今のコードで確かめた上ですべて直しました。確かめた物は、ストアの `settle()` が内容の違う受け取りを受けず `reconciledReceipt` の後だけ置き換えること、`safe()` が unknown を未解決にすること、実行層が settled の時に文脈を消してロックを放すこと、fight が盾を常駐の盾に任せていること、黒箱が 90 秒の輪であること、体の片付けの中断が 3 秒であること、などです。違っていた指摘はありません。

### 直さなかった指摘と理由（版 2）
Codex の指摘は、今のコードで確かめた上でほぼすべて直しました。次の 2 つは、指摘そのものではなく直し方を変えました。
- **「token を上げる対象」（指摘 6）**：Codex は token を足す前提で対象を絞る案でした。今のコードには motor port の失効の確かめが既にあるので、token は作らず、そこに統合しました（取りまとめ役の決めの直す物 3 と同じ）。
- **「`where`（構造）を直接読む」が成立しない（(2) の計画）**：指摘のとおり、`where` は今も文字列です。構造の位置は作らず、位置の読み手を 1 か所に置く形にしました（7 章の表の 16）。

確かめて違っていた指摘はありません。確かめた物は、act の中だけの次元の止め、パン 11 点、`FloorBudget` が arrow・eat・armor の予算であること、melee の上限が episode の手数と打ちの数であること、query でも世代が上がること、片付けで盾が下がること、常駐の盾の直接の操作、`near`・`furnace` が常に判定できないこと、知らない WorkingEvent の seq が進むこと、最初の計画の `parent` が string であること、attack が見えなくなった相手で ok を返すこと、make の count が追加の数であること、repeat の 2 周目で行が消えること、などです。
