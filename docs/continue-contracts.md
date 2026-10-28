# 「続ける力」の契約（2026-10-28、契約の版 1）

次の大きな版「続ける力」（設計は共有メモ `next-version-design-20261028.md` の案 2）を、体の担当と頭の担当の 2 人で作るための契約です。
同じ文書が、頭（`shannon-ios` の `docs/continue-contracts.md`）、体（`Shannon` の `docs/continue-contracts.md`）、共有メモ（`continue-contracts.md`）にあります。
**変える時は 3 つを同時に変え、見本（fixture）の manifest の版を上げます。**

- 書いたのは契約・見本・通しの確かめの骨組みだけです。実装はまだ無く、ここに書いた型はまだどこにもありません。
- 分かっている所（今のコードを読んで確かめた）と、決めた所（この契約で決めた）を分けて書きます。数字の見込みは、確かめていない物です。
- 基にした版：頭 `e4e1174`、体 `288839c`（どちらも `codex/shannon/continue-contracts` の元）。
- 方針（00-README の 1〜7）：判断は LLM、細部は体。LLM が従わない時は書き方で直し、コードで強制しない。スイッチは付けない。段階に分けず、1 つの版で入れる。

## 目次

0. 共通の決まり（名前・単位・番号・見本の置き場）
1. 結果（目的の結果 × 実行の終わり方）
2. 続け方（dependsOn・pre が無い時・`BodyQueue.admit`）
3. 約束（帳簿）
4. 制御（持ち主の集め方と引き継ぎ）
5. 命の番号（life）
6. vertical（縦の長い移動の手。下りも上りも）
7. 計画（kind と準備の状態）
8. 計測（共通の番号と時間の段）
9. 見本（fixture）と、体の実物を頭の試験へ渡す仕組み
10. 通しの確かめの骨組み（10 の境界）
11. 担当の分け方と作る順
12. 決めきれなかった所

---

## 0. 共通の決まり

- **型の名前は両側で同じ**にします。頭は `services/api/src/contracts/`、体は `backend/src/services/minebot/integration/commonFca/`（今の `minecraftControlContract.ts` と同じ「写し」の扱い）に置きます。新しいファイルは両側とも `continueContract.ts` です。
- 時刻はすべて ISO 8601 の UTC 文字列（`observedAt` と同じ）。長さはミリ秒の整数（`ms`）。
- 座標は `{x,y,z}` の整数のマス（`ActPos`）。
- 文（LLM が読む物）は日本語。コード（閉じた語・理由の番号）は英小文字とアンダースコア。
- **互換は要りません**（頭と体は同時に反映します）。古い形を読み続ける分岐は作りません。読み替えが要るのは、保存されている物（計画ツリー・保留のファイル・場所の記憶・判断の記録）だけで、各契約の「移し方」に書きます。
- 見本の置き場：頭は `services/api/tests/fixtures/continue/`、体は `backend/tests/fixtures/continue/`。中身は同じで、`manifest.json` に各ファイルの sha256 があります（9 章）。

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
  | 'not_started'  // 体は何も動かしていない
  | 'failed'       // 動いたが、ねらいへは何も進んでいない
  | 'unknown';     // 実行の終わり方が unknown で、体の報告も無い（頭だけが作る値）

/** 実行の終わり方: その単位の実行が、どう終わったか。 */
export type RunEnd =
  | 'finished'   // 自分で終わった（成功でも失敗でも）
  | 'cut'        // 外から止められた（反射・stopIf・取り消し・期限・満杯・死・命の番号の食い違い）
  | 'not_run'    // 始まらなかった（前の手で止まった・列で捨てた・前提を満たさない・保留中）
  | 'unknown';   // 終わり方が分からない（受け取りの outcome が unknown、または解放を確かめていない。列の項目の単位だけ）

/** 外から止めた物（RunEnd が cut の時）。今の ActResult.stoppedBy に 'death' と 'stale_life' と 'handover' を足した物。 */
export type CutBy = 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall'
  | 'death' | 'stale_life' | 'handover';

/** 進んだ量と残り。単位は手の種類で決まる（下の表）。 */
export interface Progress {
  unit: 'step' | 'block' | 'item' | 'meter' | 'blow' | 'second';
  done: number;
  left: number | null;          // 分からない時は null
  at?: ActPos;                  // 止まった時の足の位置
  msPerUnit?: number;           // 実際にかかった 1 単位の平均（頭の残り時間の見積もりの直しに使う）
}

/** 1 つの手の結果（今の ActHandLine に足す欄）。 */
export interface HandOutcome {
  goal: GoalOutcome;
  end: RunEnd;
  cutBy?: CutBy;                // end が cut の時だけ
  code?: string;                // 閉じた理由の番号（'stuck'・'search_timeout'・'full'・'target_not_found' など。今の「go 止まった <code>」の code）
  progress?: Progress;
  delta?: InventoryDelta;       // 約束の帳簿のため（3 章）
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
  /** 列で捨てられた時: どの項目が止まったせいか（今の droppedBecause の文の構造版）。 */
  droppedBecause?: { item: string; code: string };
  /** 頼りが外れなかったので、前の項目が止まっても動かした時（2 章）。 */
  keptDespite?: { item: string; code: string };
}
```

- `MinecraftControlReceipt` は今の欄をすべて残し、`unit?: ItemOutcome` を足します（act でない命令には付けない）。
- `ActResult`（`result` の JSON）は今の欄をすべて残し、`outcome: ActOutcome` を足します。`ActHandLine` には `HandOutcome` の欄を平らに足します（`goal`・`end`・`cutBy`・`code`・`progress`・`delta`）。
- `status`（done・stopped・skipped・failed）は表示のため残します。対応は次のとおりで、両側のテストで確かめます。

| status（今） | end | goal の取り得る値 |
|---|---|---|
| done | finished | done・already |
| failed（onFail continue で次へ進んだ） | finished | failed・partial |
| stopped（自分の失敗で act が止まった） | finished | failed・partial |
| stopped（外から止められた） | cut | partial・failed・not_started |
| skipped | not_run | not_started |

### 意味：手の種類ごとの「既に済」「進み」
「既に済」は、体が事実を見て決めます（選ぶのではない）。手の種類ごとに、次のとおりです。

| 手 | already になる時 | progress の unit |
|---|---|---|
| eat | 満腹が 20（食べられない）。今の「満腹（20/20）なので … は食べられない」 | — |
| dig | そのマスが既に空気・水（今の「既に air（掘らずに次へ）」） | block |
| place | そのマスに既に同じ物がある | block |
| go・walk | 始めた時に行き先の range 内にいる | meter（行き先までの残り） |
| make・craft | 持ち物に既に count 以上ある | item |
| equip | 既にその物を着けている・持っている | — |
| mine | count 以上を既に持っている | item |
| smelt | 何も入れなかった（入れる物が持ち物に無い）は failed。already は無い | item |
| attack・fight | 相手が見えた所で死んだのを体が見ていた（30 秒以内）。見ていなければ failed（target_not_found） | blow |
| pillarUp・jump | 無し | block |
| vertical | 下りで既に toY 以下、上りで既に toY 以上 | step（6 章） |
| wait | 無し（いつも done） | second |

act と列の項目の `goal` は、手の goal から機械的に決めます。
- すべての手が done か already で、少なくとも 1 つ done → `done`。すべて already → `already`。`done` 条件（`doneMet`）で済んだ → `done`。
- 1 つでも done（または partial）があり、ねらいの全部には届かない → `partial`。
- どの手も動いていない（act が始まらなかった・保留中・反射が放さず期限・命の番号の食い違い） → `not_started`。
- 手は動いたが done も partial も無い → `failed`。
- 頭の `receiptOf()` が受け取りを得られず、体の報告も無い → 頭が `unknown` を作る。

### 不明の結果
- 今は、頭の `receiptOf()` が `outcome === 'unknown' || !inputsReleased` で `FCA_BODY_OUTCOME_UNKNOWN` を投げ、段が丸ごと不明になります（確か：`minecraftControl.ts` の `receiptOf()`）。
- **新しい形**：`receiptOf()` は投げずに受け取りを返します。列（`settle()`）は `end: 'unknown'` の結果を LLM に「不明」として届けます（「結果は不明（体の操作の解放を確かめていない）。同じ手を自動では出し直さない」）。
- **不明の項目は、頭も体も自動で出し直しません**（境界 8）。保留の出し直し（`resume`）は、体が理由を言った失敗にだけ使います。
- 体は今どおり、解放を確かめるまで `held` で新しい命令を断ります。頭は今どおり、段の片付け（stop・release）で解放を確かめます。

### 誰が書き、誰が読むか
- 体が書く：`HandOutcome`（`runAct()`）、`ActOutcome`（`runAct()` と `NativeCommonFcaBody.execute()`）、`ItemOutcome`（`CommonFcaControlLoop.launch()`・`closeUnstarted()`・`begin()`）。
- 頭が読む：`readActResult()`、`createLlmcQueue()` の `settle()`・`drop()`・`itemResult()`、結果の文（LLM へ）、判断の記録。
- 頭が書く：`goal: 'unknown'`（受け取りが無い時だけ）。

### 今のコードのどこが変わるか
- 体：`instantSkills/act.ts` の `runAct()`（手の結果に goal・end・code・progress・delta）、`utils/actReport.ts`（`HandLine`・`ActReport`・`renderActReport()`）、各 primitive の already の判定（`utils/primitives/*.ts`）、`integration/commonFca/nativeBody.ts` の `execute()`（`afterReflex` の late・aborted、保留の断り、死を `ActOutcome` に）、`controlLoop.ts` の `launch()`・`closeUnstarted()`・`begin()`（`ItemOutcome`）、`minecraftControlContract.ts`（写し）。
- 頭：`contracts/minecraftActContract.ts`（`ActHandLine`・`ActResult`・`readActResult()`）、`contracts/minecraftControlContract.ts`（`MinecraftControlReceipt.unit`）、`surfaces/minecraft/minecraftControl.ts` の `receiptOf()`、`surfaces/minecraft/minecraftLlmcQueue.ts` の `settle()`・`drop()`・`itemResult()`・`neverRan()`、結果の文を作る所（`minecraftLlmcResult*.ts` など）。

### 移し方
保存されている物は無し（受け取りは保存しない）。判断の記録（`decision-records`）の古い行は、`unit` が無い物として読みます。

### 見本
`result/r43-reflex-ate-first.json`、`result/r45-hold1-dig-already-go-partial.json`、`result/unknown-receipt.json`、`result/act-not-started-reflex-late.json`。

---

## 2. 続け方（dependsOn・pre が無い時・`BodyQueue.admit`）

### ねらい
失敗の時に「後ろの手をどこまで捨てるか」を、**LLM が明示した頼り（`dependsOn`）と始まりの条件（`pre`）**で決めます。前提を書いていない事は、頼らない証拠にしません。**頼りが明示されていない後ろの手は、今どおり捨てます。** 手の単位（act の中の手）と列の項目の単位で、別々に決めます。

### 形
```ts
// act の中の手（ActHand に 1 欄足す。体の Hand の zod にも同じ欄）
interface ActHand {
  // …今の欄…
  /**
   * この手が頼る、同じ act の前の手の番号（1 から。ActHandLine.i と同じ数）。
   * 無い（undefined）: 今どおり。前の手が止まれば、この手も動かない。
   * []: どの手にも頼らない。前の手が失敗しても動く。
   * [1,3]: 手 1 と手 3 が done か already の時だけ動く。
   */
  dependsOn?: number[];
}

// 列の項目（ActInput と、体へ送る封筒 MinecraftQueueEnvelope に 1 欄足す）
interface ActInput { /* … */ dependsOn?: string[] }            // 頼る項目の印（'q12'）。[] は「どれにも頼らない」
interface MinecraftQueueEnvelope { /* item, after, node, pre, maxMs, startBy */ dependsOn?: string[] }
```

### 意味
- **`after` は順番だけ**です（今の意味のまま）。頼るかどうかは `dependsOn` が言います。
- **手の単位**（`runAct()`）：手 k が自分で失敗して act を止める時（`onFail` が stop）、後ろの手 j は次の時だけ動きます。
  - j の `dependsOn` が配列で、そこに書かれた手がすべて done か already であること。
  - 止まった手・動かなかった手を含む `dependsOn` の手は、動かさずに `not_run` にします。
  - `dependsOn` が無い手は、今どおり動かしません。
  - `onFail: 'continue'` は今どおりです（失敗した手の側の言い方。その手の後ろを止めない）。
- **外から止められた時は、続けません**：反射・stopIf・取り消し・期限・満杯・死・命の番号の食い違い・引き継ぎ（`end: 'cut'`）。今と同じで、act の実行そのものが終わったからです。
- **列の単位**（体 `controlLoop.ts` と頭 `minecraftLlmcQueue.ts`）：項目 q が `completed && inputsReleased` 以外で終わった時、待っている項目 w ごとに次のとおりにします。
  - `w.dependsOn` が配列で、q も、捨てられた項目も含まない → 残して、順番が来たら始める。始める直前に `pre` を今どおり確かめる。
  - それ以外（無い・q を含む・捨てた項目を含む） → 今どおり捨てる（`droppedBecause`）。
  - **体が held（解放を確かめていない）の時は、何も始めません**（今どおり）。`end: 'unknown'` の後は、片付けが済むまで続けません。
- **`BodyQueue.admit()`**：今は、`after` の項目が止まっていると新しい項目を `queue_after_gone` で断ります。新しい形では、`after` が止まっていても、新しい項目の `dependsOn` が配列でそれを含まなければ受けます（`'start'` か `'wait'`）。
- **`pre` が無い時**：前提を書いていない事を、頼らない証拠にしません。`pre` は「始める直前に確かめる条件」で、頼りの有無とは別です。`dependsOn: []` かつ `pre` が無い項目は、「何にも頼らず、条件も無い」と LLM が言った物として始めます。
- 頭は、`dependsOn` に列に無い印を書いた項目を、送らずに断ります（「送らなかった: dependsOn の q9 は列に無い」）。
- 項目を残した時は、`ItemOutcome.keptDespite` に、止まった前の項目と理由を入れます。LLM は列の知らせで読みます。

### 誰が書き、誰が読むか
- LLM が書く（act の入力。短い書き方は `dependsOn=1,3`、項目は `dependsOn=q12`）。
- 頭は、読み取り・検査をして、封筒へ写します。体は、それに従って続けるか捨てるかだけを決めます（何を頼るかは決めない）。

### 今のコードのどこが変わるか
- 体：`instantSkills/act.ts`（Hand の zod に `dependsOn`、`runAct()` の止まりの後の続け）、`integration/commonFca/bodyQueue.ts`（`ENVELOPE` に `dependsOn`、`admit()`、残す・捨てるの選り分け。今の `removeFrom()` は後ろを全部取る）、`controlLoop.ts` の `launch()` の終わり（今の `dropWaiting(droppedBecause(…))`）と `begin()`・`dropExpired()`・`cancelOne()`。
- 頭：`contracts/minecraftActContract.ts`（`ActHand.dependsOn`、`ActInput.dependsOn`、`ACT_INPUT_SCHEMA`、`actProblem()`）、`contracts/minecraftActShortHands.ts`（`dependsOn=` の読み書き）、`contracts/minecraftControlContract.ts`（封筒）、`surfaces/minecraft/minecraftLlmcQueue.ts`（`drop()` は頼る物だけ、`add()` で封筒へ）、`surfaces/minecraft/minecraftControlValidation.ts`（下の欄の数）。
- **欄の数**：体の Hand は今 43 欄で、頭の `SKILL_SCHEMA_PROPERTIES` は 48 です。この版で足す欄は `dependsOn`（2 章）と、vertical の `toward`・`toY`・`shape`・`liquid`（6 章）の 5 つで、ちょうど 48 になります。余裕が無いので、頭の上限を 56 に上げます（頭の担当。12 章の 1）。

### 移し方
保存されている物は無し。

### 見本
`continue/act-hand-depends.json`、`continue/queue-item-depends.json`、`continue/admit-after-stopped.json`、`continue/no-depends-as-now.json`。

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
  item: string;                 // ActCondition の have と同じ読み方（'planks' は *_planks も数える）。特別な語 'food' は食料の点
  count: number;                // 残す量
  use: string;                  // 用途（LLM の言葉、40 字まで。例 '作業台'・'地下で食べる分'）
  until?: { node?: string; condition?: ActCondition };  // 期間: その節が done になるまで／その条件を満たすまで。無ければ解くまで
  instead?: ActCondition;       // 代わりの条件: 満たす間は、物が足りなくても約束を果たしているとみなす（例 作業台を持つ・近くにある）
  state: 'open' | 'kept_by_instead' | 'closed';
  closedBy?: 'until' | 'released';
  ledger: PromiseEvent[];       // 古い順。32 件まで（古い物から落とし、落とした数を残す）
  dropped?: number;
}

export interface PromiseEvent {
  at: string;
  kind: 'made' | 'revised' | 'consumed_for_use' | 'consumed_other' | 'gained' | 'lost_death' | 'released' | 'closed';
  count: number;                // 動いた量（made・revised は新しい count）
  have: number;                 // その後に持っている量
  by?: { command: string; item?: string; hand?: number; kind?: string };  // どの命令・項目・手で（kind は 'smelt_fuel'・'craft'・'eat'・'place'・'reflex_eat' など）
  note?: string;
}

/** 手ごとの持ち物の増減（体が書く。1 章の HandOutcome.delta）。 */
export interface InventoryDelta {
  spent: { item: string; count: number; as?: 'fuel' | 'ingredient' | 'food' | 'placed' | 'thrown' | 'tool_broke' }[];
  gained: { item: string; count: number }[];
}
/** act の間に反射が動かした分（反射が食べた・防具を着た）。ActResult に足す。 */
export interface ReflexDelta { reflex: string; delta: InventoryDelta }

// plan.update の ops に 2 種を足す（実行器は ops・current 以外を今どおり断る）
type PlanOp =
  | /* 今の add・split・set・move・drop・forbid・caution・lift */ never
  | { op: 'promise'; id?: number; item: string; count: number; use: string; until?: { node?: string; condition?: string }; instead?: string }
  | { op: 'release'; id: number; why?: string };

// act の入力に 1 欄（頭だけが読む。体へは送らない。replace と同じ扱い）
interface ActInput { /* … */ uses?: number[] }   // この act が「用途どおりに」使ってよい約束の番号
```

### 意味
- **約束を書くのは LLM だけ**です（最初の計画か `plan.update` の `op: 'promise'`）。`id` を書けば改訂（`rev` を 1 上げ、`revised`）、無ければ新しい番号です。
- **帳簿を持つのは頭**です。体は持ち物の増減（`delta`）を手ごとに書くだけで、約束を知りません。
- **消費の記録**（頭が受け取りを読むたび）：開いている約束ごとに、同じ物の `spent` を次のように記録します。
  - その act の `uses` に約束の番号があれば `consumed_for_use`（地下で食べる分の食料は、食べると減って正しい）。
  - 無ければ `consumed_other`。
  - `gained` は `gained` として記録します。
  - 反射が使った分（`ReflexDelta`）は `consumed_other`、`by.kind = 'reflex_eat'` です。
- **死**（5 章の命の番号が進んだ）：開いている約束ごとに `lost_death`（持っていた量）を記録します。約束は開いたまま残し、解くのは LLM です。
- **期間**：`until.node` の節が done になった時、または `until.condition` を満たした時に `closed`（`closedBy: 'until'`）にします。`release` は `closed`（`released`）にします。
- **代わりの条件**：`instead` を満たす間は、`state = 'kept_by_instead'` にします。量が足りなくても、live では「代わりの条件を満たす」と書きます。
- **live の 1 行**（事実だけ。並びは番号順、開いている物だけ、4 つまで）：
  - `約束 #3 作業台用の板 4: 今 2・直前に燃料で 2 消費（足りない 2）`
  - `約束 #4 地下で食べる分の食料 20 点: 今 26 点`
  - `約束 #3 作業台用の板 4: 今 0・代わりの条件を満たす（作業台 1）`
  - `約束 #3 作業台用の板 4: 今 0・死んで 5 失った`
  - 「直前に」は、前の判断から後の記録だけです。急ぎの版にも同じ行を入れます（10 章の境界 10）。
- **断らない**：頭も体も、約束を理由に手を断りません。下りる・燃やす・置くは、LLM の判断です。
- **再起動**：頭の再起動の後も、計画ツリーと一緒に読み戻します。体の再起動は帳簿に影響しません（体は帳簿を持たない）。

### 誰が書き、誰が読むか
LLM が書きます（約束・解除・`uses`）。頭が帳簿を書き、live の 1 行を作ります。体は `delta` を書きます。読むのは LLM（live）と計測（判断の記録）です。

### 今のコードのどこが変わるか
- 頭：
  - `packages/mind/src/planTree.ts`（`PlanTree.promises`、`applyPlanUpdate()` に `promise`・`release`、保存の形 v2）
  - `mind/action/fca/fcaPlanTools.ts`（`PLAN_UPDATE_DEFINITION`・`PLAN_UPDATE_RULES_DEFINITION` の op の enum と欄、実行器は ops・current のまま）
  - `surfaces/minecraft/minecraftFirstPlan.ts`（`FIRST_PLAN_SCHEMA_R4` に `promises` を足すか。12 章の 6）
  - 帳簿を書く所（新しい `surfaces/minecraft/minecraftLlmcPromises.ts`。`settle()` の受け取りの後に呼ぶ）
  - live への 1 行（`minecraftLlmcLive.ts`・`minecraftLlmcUrgent.ts`）
  - `ActInput.uses`（`minecraftActContract.ts`、`minecraftLlmcQueue.ts` の項目に持つ）
  - 表示（`BodyPlanView`）
- 体：`instantSkills/act.ts`（手の前後の持ち物を数えて `delta`、`as` は手の種類と primitive の報告から）、`utils/actReport.ts`、`nativeBody.ts`（反射の台帳 `ReflexLedger` から `ReflexDelta`）。

### 移し方
- 計画ツリー v1 は `promises: []` として読みます（7 章の移し方と同じ時に）。
- 保留のファイル・場所の記憶は変わりません。

### 見本
`promise/r43-planks-burned-as-fuel.json`、`promise/table-crafted-placed-picked.json`、`promise/food-for-underground.json`、`promise/death-loses-promised.json`。

---

## 4. 制御（持ち主の集め方と引き継ぎ）

### ねらい
今、体の「誰が動かしているか」は 4 か所にあります（確か）。
1. 通信側の `CommonFcaControlLoop.owner`
2. 操作側の `executeAction()` と `SkillExecutor` のロック（優先度つき。溶岩 400・壁 420・creeper/矢の退避 350・掘り出し 300・低体力の逃げと melee 250・食事 200・反射 100）
3. 戦いの `markHeadCombat()` と `holdMeleeForHead()`
4. 反射の状態（`floorReflexes.busy`・`fleeEpisode`・`melee`・`lavaReflex.engaged`・`breathingReflex.engaged`。読むのは `reflexHeld()`）

新しい持ち主の欄（5 つ目の本当の事）は作りません。**取得・解放を 2 の実行層に集め、ほかはその写しにします。** 実走 45 の 6.4 秒は `fight()` の外、`NativeCommonFcaBody.afterReflex()` の待ちで、待ったのは `attack` の列でした（確か：run45-live、`nativeBody.ts`）。

### 形
```ts
/** 体の制御の持ち主（観測の state.control。実行層のロックの写し）。 */
export type ControlHolder =
  | { kind: 'idle' }
  | { kind: 'command'; command: string; item?: string; life: number; since: string }
  | { kind: 'reflex'; reflex: string; priority: number; target?: number; since: string; until?: string }
  | { kind: 'bridge'; after: string; hold: 'shield' | 'step_back'; target?: number; since: string; until: string }  // 反射の上限の後のつなぎ
  | { kind: 'cleanup'; command: string; since: string };

export interface ControlView {
  holder: ControlHolder;
  waiting: { command: string; since: string; behind: string }[];   // 反射の後を待っている命令（behind は反射の名）
  token: number;                                                   // 持ち主が替わるたびに 1 増える（古い処理の禁止に使う）
}

/** act の結果に足す欄: 反射から引き継いだ時。 */
export interface Handover { from: string; target: number; waitedMs: number; reflexStoppedAt: string; confirmed: boolean }

/** 体から頭への出来事に 1 種足す（MinecraftBodyEvent.kind）。 */
type ReflexCapped = { kind: 'reflex.capped'; subject: string /* reflex */; data: { count: number; windowMs: number; bridge: 'shield' | 'step_back' | 'none'; until: string } };
```

### 意味
- **持ち主の決め方**は 1 つだけです。実行層の取得（`executeAction()` の `acquire`）が持ち主を替え、`token` を 1 上げます。`CommonFcaControlLoop.owner` は通信の持ち主（どの lease の命令を受けるか）のままです。`state.control` は実行層の写しで、live の「今の持ち主」はこれを読みます。
- **古い処理の禁止**：体の操作（キー・道探しの行き先・盾の構え・手の物の使用）は、`token` を持つ文脈からだけ効きます。持ち主が替わった後の古い処理の片付け（`clearControlStates()`・`pathfinder.setGoal(null)`・`deactivateItem()`）は、何もしません。今の `createMotorPort()` を、作った時の `token` を覚える形にします（境界 6）。
- **すぐの引き継ぎ**（`afterReflex()` を直す）：act の最初の体を動かす手（already になる手は飛ばす）が `fight` か `attack` で、その相手が、今体を持つ反射の `target` と同じ時は、待たずに次のとおり引き継ぎます。
  - 引き継げる反射は `floor-melee` と、体力が `HEAD_COMBAT_YIELD_HEALTH`（5）より上の時の `floor-last-stand`（hit の手）だけです。
  - 反射を `handover` の理由で止め（実行層の `preemptLowerPriorityActions` と同じ道）、反射の台帳に `handed_over` を書いてから、act を始めます。
  - 結果の `handover` に `confirmed: true` を入れます。反射が止まったのを実行層で確かめた（その反射の文脈が settled）という意味です。
  - 確かめられない時（300 ms 以内に settled にならない）は、今どおり待ちます。その時は `confirmed: false` で、待った秒も書きます。
- **相手が違う時**：反射は今の 1 手（melee は 2 打まで）を終え、次の手を始めません（今の `holdMeleeForHead()` を attack にも広げる）。act はその後に始めます。
- **優先の高い反射は奪いません**：溶岩・壁・creeper/矢の退避・掘り出し・息（泳ぎ）・食事・防具。act は今どおり待ちます。待った秒と反射の名は `afterReflex` に入れます。
- **反射の上限の後**：反射が回数の上限（`FloorBudget`）に着いた時、体は `reflex.capped` の出来事をすぐ出します（頭はこれを急ぎの理由にする）。
  - 頭の命令が来るまでのつなぎは、今ある反射の範囲だけです。盾を構える（`shield`）か、一歩下がる（`step_back`）のどちらかで、`until` は 3 秒まで。
  - 終わりの条件は、命令が始まった・相手がいなくなった・体力が 5 以下（その時は低体力の反射へ戻す）・期限の 4 つです。
  - 新しい長い戦い方は作りません。
- **急ぎの live**（頭）：体力・満腹・食べられる物・直近の被弾・今の持ち主（`state.control.holder` の 1 行）・命の番号を、急ぎの版にも必ず残します（境界 10）。

### 誰が書き、誰が読むか
体が `state.control`・`handover`・`reflex.capped` を書きます。頭が live と急ぎの理由に読み、判断の記録に残します。

### 今のコードのどこが変わるか
- 体：
  - `execution/ActionExecution.ts`（取得の時に `token`、`createMotorPort()` の古い操作の禁止、文脈に `target`）
  - `execution/SkillExecutor.ts`
  - `integration/commonFca/nativeBody.ts`（`afterReflex()` の引き継ぎ、`observe()` に `state.control`）
  - `utils/floorReflexes.ts`（melee・last-stand の `target` を状態に、`handover` で止まる、上限で `reflex.capped` とつなぎ）
  - `utils/combatOwner.ts`（`holdMeleeForHead()` を attack にも）
  - `integration/commonFca/bodyEvents.ts`（出来事の種類）
  - `minecraftControlContract.ts`（写し）
- 頭：
  - `contracts/minecraftControlContract.ts`（出来事の種類）
  - `surfaces/minecraft/minecraftLlmcLive.ts`・`minecraftLlmcUrgent.ts`（持ち主の 1 行、`reflex.capped` を急ぎに）
  - `surfaces/minecraft/minecraftControlValidation.ts`（`state.control` の形）

### 移し方
保存されている物は無し。

### 見本
`control/r45-attack-waited-6-4s.json`、`control/different-target.json`、`control/high-priority-not-taken.json`、`control/reflex-capped-bridge.json`、`control/stale-owner-cleanup.json`。

---

## 5. 命の番号（life）

### ねらい
実走 45 の +929 で、死んだ後に、死ぬ前の判断の act（q52 attack）が始まりました（確か：run45-live「始まったのは死んだ後（リスポーンの後に target_not_found）」）。今の頭の死の判定は「前の観測が死亡・次が生存」の移りで、ポーリングがその間を飛ばすと分かりません（確か：`minecraftControl.ts` の `arrivalOf()`）。

### 形
```ts
export interface LifeView {
  life: number;          // 1 から。体が死の出来事で 1 増やす
  since: string;         // その命が始まった時（ログインか、死の出来事の時）
  alive: boolean;        // 死んでからリスポーンまでは false
  diedAt?: string;       // 前の命が終わった時
  deathCause?: string;   // 'minecraft:mob_attack' など（体が知っていれば）
  dimension: 'overworld' | 'the_nether' | 'the_end';
  dimensionSince: string;
}
// 観測: facts.life（number）と state.life（LifeView）
// 命令: BodyTaskContext に life?: number（その命令を作った判断が読んだ観測の life）
```

### 意味
- **体が番号を進めます**。`bot.on('death')` の時に 1 増やし、ファイル（保留のファイルと同じ所の `life.json`、ワールドの id ごと）に書きます。体を再起動しても、番号は戻りません。
- **次元の移りは死ではありません**。ポータル・エンドの門での `spawn`・`game` の出来事（死の出来事が無い）では、番号は変わらず、`dimension`・`dimensionSince` だけが変わります。リスポーンで次元が変わる時は、番号は死の時に既に進んでいます。
- **古い番号の物は全部無効**です。体は次のとおりにします。
  - 命令の受け取り（`accept()`）で、`context.life` が今の番号と違えば、`failureType: 'stale_life'`・`not_started` で断ります（手は動いていない）。
  - 待っている項目は、死の出来事で全部捨てます（`droppedBecause` の code は `death`）。
  - 実行中の手は、死の出来事で止めます（`cutBy: 'death'`）。
  - 次の手を始める直前（`runAct()` の手ごと）にも、番号を照らします。違えば `cutBy: 'stale_life'` です。
  - ロック待ち（`SkillExecutor.acquire` を待つ物・`afterReflex` で待つ物）は、死の出来事で `aborted` にします。
- **頭は次のとおりにします**。
  - 判断の入力に読んだ観測の `life` を、判断の記録と命令の `context.life` に入れます。
  - 考え中の判断の返事は、使う直前に最新の観測の `life` と比べます。違えば `discarded`（理由 `life_changed`。今の `queue_changed` と同じ扱い）にして、新しい観測で判断し直します。
  - 列の項目（頭の `QueueItem`）は、`life` が違う物を送りません。
- **lease・タスクの世代（`generation`）とは別**です。命の番号が進んでも、lease は替わりません。lease が替わっても、命の番号は変わりません。保留（incident）は、命の番号を照らしません（`release` は手ではない）。
- `arrivalOf()` は `facts.life` の増えで `death` を決めます（移りを見落とさない）。

### 誰が書き、誰が読むか
体が番号を書きます（`life.json`・観測）。頭が読み、命令に写します。体は命令の番号を照らします。

### 今のコードのどこが変わるか
- 体：
  - `integration/commonFca/nativeBody.ts`（`observe()` に `facts.life`・`state.life`、`execute()` の照らし）
  - `controlLoop.ts`（`accept()` の照らし、死の時の `dropWaiting`）
  - `instantSkills/act.ts`（手ごとの照らし）
  - `execution/ActionExecution.ts`・`SkillExecutor.ts`（ロック待ちを止める）
  - 番号を持つ新しい部品（`utils/life.ts`）
  - `utils/incidents.ts`（保留のファイルに `life` を足す。読むだけ）
- 頭：
  - `contracts/bodyControlContract.ts`（`BodyTaskContext.life`）
  - `surfaces/minecraft/minecraftControl.ts`（`arrivalOf()`）
  - `surfaces/minecraft/minecraftTaskContext*`（`context.life` を入れる）
  - `mind/action/fca/fcaRunner.ts`（`life_changed` の破棄）
  - `surfaces/minecraft/minecraftLlmcQueue.ts`
  - 判断の記録（`request` と `sent` に `life`）

### 移し方
`life.json` が無い時は 1 から始めます。保留のファイルに `life` が無い時は、読むだけなので何もしません。

### 見本
`life/r45-death-then-old-attack.json`、`life/portal-is-not-death.json`、`life/death-at-each-moment.json`。

---

## 6. vertical（縦の長い移動の手。下りも上りも）

### ねらい
実走 45 の保留 1・4〜6 は、岩の中を深く下りる `go` の道探しの時間切れ（`search_timeout`・`limit_time`）でした。保留 7 は、柱を積んで y=7 から 56 へ上る `go` が 120 秒で着かなかった件で、掘 6・置 48・引き直し 12 回、最後はブロックの変化で引き直しを続けました（確か：run45-live）。
縦の長い移動の形と危険の扱いを LLM が決め、体は一段ずつ機械的に掘る・置く・歩く手を、**`mc.act` の中の手の 1 種 `vertical`** として足します。下りも上りも同じ手です（向きは `toY` と今の y から決まる）。独立のスキルにはしません（列は `skill === 'act'` だけを受けるため）。名前は、案 2 の `descend` から変えました（取りまとめ役の追記 2026-10-28）。

### 形
```ts
interface ActHand {
  do: 'vertical';
  /**
   * stairs: 階段（1 歩ごとに 1 段。下りは掘り下げ、上りは前の上を掘って上がる）
   * shaft: 縦穴で真下へ（下りだけ）
   * pillar: 足の下に置いて真上へ（上りだけ。頭の上は掘る）
   * 体は形を勝手に変えない。
   */
  shape: 'stairs' | 'shaft' | 'pillar';
  toward?: 'north' | 'east' | 'south' | 'west';  // stairs では必須。shaft・pillar では使わない
  toY: number;                            // どの y まで（足の y）。今より下なら下り、上なら上り
  canDig: string[];                       // 掘ってよい物（go と同じ読み方）。pillar でも頭の上を掘るのに使う
  maxDig?: number;                        // 掘る数の上限（go と同じ）
  canPlace?: string[];                    // 置いてよい物（pillar の足場、liquid が seal の時の塞ぎ）
  maxPlace?: number;                      // 置く数の上限
  liquid: 'stop' | 'seal' | 'seal_water'; // 溶岩・水が見えた時: 止める／塞いで続ける／水だけ塞ぎ溶岩で止める
  range?: number;                         // 塞ぐ範囲（掘るマスから何マスまでの液体を塞ぐか。既定 1、最大 2）
  seconds?: number;                       // 上限の秒（go と同じ）
  // dependsOn・onFail・note・rel は、どの手とも同じ
}
// 短い書き方（頭の minecraftActShortHands.ts）:
//   vertical stairs south y=10 dig=stone,dirt,gravel [maxDig=80] [place=cobblestone] [maxPlace=20] [liquid=stop|seal|seal_water] [range=1] [seconds=120]
//   vertical shaft y=-50 dig=stone,deepslate,tuff place=cobblestone [maxPlace=30] liquid=seal
//   vertical pillar y=63 place=cobblestone [maxPlace=60] [dig=stone,dirt] liquid=seal_water [seconds=120]
```
- 頭は、形と向きの食い違いを送る前に断ります（`shaft` で上り、`pillar` で下り、`stairs` に `toward` が無い。断りの文は見本 `vertical/short-hands.json`）。

### 意味
- **LLM が決める物**：形・向き・どの y まで・掘る/置くの許し・溶岩と水の扱い・上限の秒。
- **体がする物**：一段ずつ掘る・置く・歩くだけです。道探し（pathfinder）は使いません。保留 7 の「ブロックの変化で引き直しを続けた」は起きない形にします。
  - `stairs` の下り：向きへ 1・下へ 1 のマスと頭の上の 2 マスを掘って歩きます（`tunnelWalk.ts` の段ごとの掘りと歩き）。
  - `stairs` の上り：向きへ 1・上へ 1 の 2 マスと、今の頭の上の 1 マスを掘って上がります。足場が無ければ、`canPlace` の物を置きます。
  - `shaft`：足の下を掘って 1 段落ちます（`shaftDown.ts` の `shaftStepRefusal()` で確かめる）。
  - `pillar`：頭の上 2 マスが空いていなければ掘り（`canDig` に無ければ止める）、跳んで足の下に置きます。置くのは、足がそのマスの上端より 0.2 以上高い、跳びの頂点の近くだけです。保留 8 の調べで、足がマスの上端の 0.1 上の置きはサーバーに断られました（サーバーの見る体の位置が 1 tick 遅れる、という仮説）。
  - `planStairLine()` は呼びません（高低差が大きいと縦穴を混ぜるため）。`StairMine.runImpl()` の、海なら陸へ・向きを変える部分も使いません。
- **砂・砂利**：落ちてくる物は、そのマスを掘り直します（体の細部）。`canDig` に無い物（岩盤・守られた物を含む）では止めます（`code: 'cannot_dig'`）。
- **液体**：次に掘る・入るマスの周り（`range` まで）に溶岩・水が見えた時の扱いです。
  - `stop` → `code: 'lava'` か `'water'` で止めます（`where` はその液体のマス）。
  - `seal` → `canPlace` の物を液体のマスか、液体に面した空きに置いてから続けます。`maxPlace` か、持ち物が尽きたら `code: 'limit_place'` で止めます。
  - `seal_water` → 水は塞ぎ、溶岩なら止めます。上りで頭の上に液体がある時も同じ扱いです。
- **足元**：下りで落ちる段が 1 を超える穴・空洞に出たら止めます（`code: 'no_floor'`。今の go の `no_floor` と同じ語）。上りの `stairs` で足場を置けない時は `code: 'no_place'` です。途中で体が勝手に回り道はしません。
- **鉱石**：見えた鉱石は `seen`（種類と座標、8 件まで）で知らせるだけで、追いません。
- **止まった時**：`progress: { unit: 'step', done, left, at, msPerUnit }` を返します。LLM は、その `at` からもう一度 `vertical`（か別の手）を出して続けます。体は前の手を覚えません（指示し直しは、今の位置からの新しい手）。
- **既に済**：下りで始めた時に既に `toY` 以下、上りで既に `toY` 以上なら `already` です。
- **頭の見積もり**：所要時間と残りは、1 段あたりの見積もり × 段数から始めます（stairs 約 1.6 秒、shaft 約 1.0 秒、pillar 約 0.9 秒。確かめていない）。体が返す `msPerUnit` で直します（`minecraftActTime.ts`）。
- **下りる前の警告**（頭の今の準備の警告）は、下りの `vertical` にも go と同じように出します。

### 今のコードのどこが変わるか
- 体：`instantSkills/act.ts`（`HAND_KINDS`・Hand の zod・`runHand()`）、新しい `utils/primitives/vertical.ts`（`tunnelWalk.ts`・`shaftDown.ts` の部品と、保留 8 の調べ（`go.ts` の `mayLayAt()` が go の中では体の真下への置きを送らない理由）を踏まえた置きの時機だけを足す）、`utils/actHandRules.ts`（許可の欄）、`utils/actLabel.ts`、`utils/actReport.ts`（閉じた語に `cannot_dig`・`lava`・`water`・`limit_place`・`no_floor`・`no_place`）。
- 頭：`contracts/minecraftActContract.ts`（`HAND_KINDS`・`ActHand`・`ACT_INPUT_SCHEMA`・`ACT_DESCRIPTION`）、`contracts/minecraftActHandRules.ts`（手ごとの欄）、`contracts/minecraftActShortHands.ts`（読み書きと断り）、`contracts/minecraftActTime.ts`（見積もり）、下りる前の警告（`minecraftLlmcReadiness.ts` ほか）。

### 移し方
保存されている物は無し。

### 見本
`vertical/r45-hold1-stairs-down-to-iron.json`、`vertical/r45-hold5-shaft-down-to-diamond.json`、`vertical/r45-hold7-pillar-up.json`、`vertical/lava-seal-and-stop.json`、`vertical/short-hands.json`。

---

## 7. 計画（kind と準備の状態）

### ねらい
今の節の種類は、題名の正規表現で決まっています（21 か所。下の表）。題名を言い換えると知識・不足・meter が変わります。準備の「省いた」は、`done` と注記「準備を省いた…」で表しています（`descentClosed()`、`prepSkipped()`）。**札（`kind`）と準備の状態（`prep`）を、計画ツリーの本当の欄にします。**

### 形
```ts
export type PlanKind =
  | 'wood' | 'stone_tools' | 'food' | 'bed' | 'village' | 'prep_descent'
  | 'iron' | 'iron_armor' | 'diamond' | 'water' | 'lava' | 'obsidian' | 'portal'
  | 'nether' | 'fortress' | 'blaze' | 'pearl' | 'stronghold' | 'end' | 'dragon'
  | 'chest' | 'other';

/** 準備の節の状態（作業の状態 state とは別）。 */
export type PrepState = 'met' | 'skipped' | 'unmet_now';   // 済み・省いた・今は満たせない

export interface PlanNode {        // packages/mind/src/planTree.ts
  // id, parentId, order, title, state, where?, doneWhen?, note?, reason?, forbid?, caution? は今のまま
  kind?: PlanKind;
  prep?: { state: PrepState; why?: string; at?: string };   // kind が prep_descent・food など準備の節の時だけ
}
export interface PlanTree {
  schema: 'shannon.plan-tree.v2';
  revision: number; current: string | null; nodes: readonly PlanNode[];
  promises: readonly PlanPromise[];   // 3 章
}
// PlanNodeDraft・plan.update の add/split/set と最初の計画の答え（FIRST_PLAN_SCHEMA_R4 の節）に kind と prep を足す
```

### 意味
- **`kind` を付けるのは LLM**です（最初の計画と `plan.update`）。頭は付けません（題名から推しません）。付いていない節は `other` として読みます。
- **`prep` は準備の節の状態**で、作業の状態（`state`：done・blocked・continue・wait）とは別です。
  - `met`：準備の条件（`doneWhen`）を満たした。
  - `skipped`：LLM が省くと決めた、または体がもう地下にいて、準備の前に下りたと分かった（今の `descentClosed()` の場合）。
  - `unmet_now`：今は満たせない（例：食料の動物がいない。`why` に理由）。
  - `prep` を書くのは LLM（`plan.update` の set）と、頭の `descentClosed()`（`skipped` だけ）です。
- **最初の計画・`plan.update`・保存・meter で同じ意味**です。meter（`meterLine()`）は、`prep.state` が `skipped` の節を「省いた」と書き、達成とは数えません。`descentClosed()` は注記ではなく `prep: { state: 'skipped' }` を書きます。
- **題名で決めていた所は、全部 `kind` で選ぶ形に替えます**。題名を言い換えても、知識・不足・meter・近くの候補が変わらないことを、境界 9 で確かめます。

| # | 今の所（頭 `services/api/src/surfaces/minecraft/`） | 今の決め方（題名・文） | 新しい形 |
|---|---|---|---|
| 1 | `minecraftLlmcReadiness.ts` `preparationStage()` | 今の節の題名を END/GATE/DIAMOND の正規表現 | 今の節（と先祖）の `kind`：end・stronghold・pearl → end、portal・obsidian・nether → nether_entry、diamond → diamonds |
| 2 | `minecraftLlmcReadiness.ts` `gateBack()` | `/ゲート\|ポータル/` | `kind === 'portal'` で `where` を持つ節 |
| 3 | `minecraftLlmcReadiness.ts` `foodFirstLine()` | `FOOD_NODE` か `food>=` | `kind === 'food'` |
| 4 | `minecraftLlmcNode.ts` `isPrepNode()`（`planNowOf`・`followNode`・`openPreparation`・`heldByPreparation`） | `PREP_TITLE` か `food>=` | `kind` が `prep_descent` か `food` |
| 5 | `minecraftLlmcNode.ts` `chestNodesDone()` | `CHEST_NODE` | `kind === 'chest'` |
| 6 | `minecraftPlanDone.ts` `isPrepMilestoneNode()` | `/地下の準備/` か `food>=40〜99` | `kind === 'prep_descent'` |
| 7 | `minecraftPlanDone.ts` `descentClosed()` | doneWhen の `UNDERGROUND_WORK`、#6、`/確かめられない/` | 地下の仕事は `kind` が iron・iron_armor・diamond・obsidian・nether。閉じる時は `prep.state = 'skipped'` |
| 8 | `minecraftPlanDone.ts` `prepSkipped()` | 注記が「準備を省いた」で始まる | `prep.state === 'skipped'` |
| 9 | `minecraftLlmcRoad.ts` `isDragonPlan()` | `/ドラゴン\|エンドラ/` | いずれかの節が `kind === 'dragon'`（か最初の計画の種類） |
| 10 | `minecraftLlmcRoad.ts` `meterLine()`（`doneInPlan`・`prepEnd`・`names`） | #6・#8・#9 | `kind` と `prep` |
| 11 | `minecraftLlmcRoad.ts` `label`（表示だけ） | 題名の括弧の前 | そのまま（表示だけなので題名でよい） |
| 12 | `minecraftLlmcV2Knowledge.ts` `stagesFor()`・`STAGE_WHEN` | planNow と plan.next の文を 5 つの正規表現 | 今の節と次の節の `kind` から段（prep・nether・blaze・pearl・end）を引く表 |
| 13 | `minecraftLlmcObsidianWays.ts` `obsidianWays()` | planNow に `/黒曜石/` | 今の節か次の節の `kind` が obsidian・portal |
| 14 | `minecraftLlmcLiveRewrite.ts` `addPack()` | planNow に `/エンド\|ストロング\|ドラゴン\|アイ/` | `kind` が end・stronghold・pearl・dragon |
| 15 | `minecraftLlmcReachWords.ts` `nearNeeds()` | plan.next と planNow に FOOD/BED/TRADE の正規表現 | `kind` が food・bed・village |
| 16 | `minecraftLlmcRoute.ts` `goalOf()` | 表示した planNow の文から座標を切り出す | 節の `where`（構造）を直接読む |
| 17 | `minecraftLlmcLiveRewrite.ts` `rewritePlan()` | 表示した文の `p1.2` の形 | 節の id を直接比べる |
| 18 | `minecraftLlmcUrgent.ts` `planNowTitle()`（表示だけ） | 表示した文の切り出し | 節の題名を直接読む |
| 19 | `minecraftFirstPlan.ts` `carryDone()` | 題名の同じさ | `kind` と `doneWhen` が同じ（題名は見ない） |
| 20 | `minecraftFirstPlan.ts` `gateFirst`・`ironFirst`・`DROPPED_BEFORE_GATE` | 種の定数の題名の同じさ | 種の節に `kind` を付け、`kind` で選ぶ |
| 21 | `minecraftFirstPlan.ts` `planGoal()` | タスクの目的の文（節ではない） | そのまま（節の札の話ではない） |

（表は 2026-10-28 に頭 `e4e1174` を調べた物。作る時に、題名・`planNow` の文を正規表現で読む所が残っていないか、もう一度 grep で確かめる。）

### 誰が書き、誰が読むか
LLM が `kind`・`prep` を書きます。頭の `descentClosed()` は `prep: skipped` だけを書きます。読むのは頭（上の表の所）と、表示（体の UI MOD は `BodyPlanView` で `kind` を表示に使ってよい。動きには使わない）です。

### 今のコードのどこが変わるか
- 頭：`packages/mind/src/planTree.ts`（型・`PlanNodeDraft`・`draftNode()`・`applyPlanUpdate()`・`validPlanTree()`・`PLAN_TREE_SCHEMA`）、`mind/action/fca/fcaPlanTools.ts`（op の欄に `kind`・`prep`）、`surfaces/minecraft/minecraftFirstPlan.ts`（`FIRST_PLAN_SCHEMA_R4`・`seedFields()`・`planFromAnswer()`・種の節）、上の表の所、`contracts/bodyControlContract.ts`（`BodyPlanView` に `kind`）。
- 体：`BodyPlanView` の写し（表示だけ）。

### 移し方（保存されている計画ツリー）
- v1 のツリーを読んだ時、1 回だけ v2 に読み替えます。
  - `kind` は、今の題名の正規表現（上の表の 1〜15 の物）で推して付けます。正規表現が残るのは、この読み替えの関数 1 つだけです。
  - 注記が「準備を省いた」で始まる節は `prep: { state: 'skipped' }`、準備の節で `state: done` の物は `prep: { state: 'met' }` です。
  - `promises: []` を足します。
- 読み替えた事は、計画の改訂の記録に 1 行残します。

### 見本
`plan/first-plan-with-kind.json`、`plan/title-renamed-same-knowledge.json`、`plan/descent-closed-skipped.json`、`plan/migrate-v1-to-v2.json`。

---

## 8. 計測（共通の番号と時間の段）

### ねらい
D1（結果と続け方）と D4（制御）の効きを分けて測ります。そのため、止まってから次の有効な操作までの時間を段に分け、すべての記録を同じ番号でつなぎます。判断の記録（`docs/decision-records-2026-10.md`）を土台にして広げます。

### 形
```ts
/** すべての記録に付ける番号。 */
export interface TraceIds {
  run: string;              // 実走の番号（頭の task id。判断の記録のフォルダ名と同じ）
  decision?: string;        // 判断の番号（判断の記録の request id、'd0015'）
  command?: string;         // 命令の番号（MinecraftControlCommand.id）
  item?: string;            // 列の印（'q15'）
  hand?: number;            // act の中の手の番号（ActHandLine.i）
  life: number;             // 命の番号（5 章）
  obsSeq: number;           // 観測の番号（BodyObservation.sequence）
  obsAt: string;            // 観測の時刻（BodyObservation.stateAt）
}

/** 体が受け取りに付ける時刻（MinecraftControlReceipt に足す）。 */
export interface BodyTimes {
  acceptedAt: string;       // 体が命令を受けた
  startedAt?: string;       // 列から始めた（待った物）
  lockAt?: string;          // 実行層のロックを取った
  firstMotorAt?: string;    // 最初の有効な操作（キー・掘り・置き・使うの最初）
  failedAt?: string;        // 失敗が決まった（止まった手の終わり）
  endedAt: string;
  reflexWaitMs?: number;    // afterReflex で待った
}

/** 頭が判断の記録に足す行（events.jsonl）。 */
type StageRow =
  | { ev: 'received'; at: string; ids: TraceIds; receipt: { outcome: string; unit?: ItemOutcome }; bodyTimes: BodyTimes }
  | { ev: 'woke'; at: string; ids: TraceIds; why: 'failure' | 'remaining' | 'message' | 'alert' | 'furnace'; predictedRemainingMs?: number }
  | { ev: 'live'; at: string; ids: TraceIds; raw: string /* 部品の参照 */; shown: string /* 部品の参照 */; dropped: { field: string; count: number; why: string }[] };

/** 手の始まりの記録（体の黒箱に足す種類 'hand_start'）。 */
export interface HandStart {
  ids: TraceIds;
  at: string;
  pos: ActPos; hp: number; food: number; saturation: number;
  inventory: string;        // 'cobblestone×20,oak_planks×5,…'（並びは名前順）
  holder: ControlHolder;    // 4 章
  lastOps: { at: string; op: string; detail?: string }[];   // 直前の操作 16 件（掘り・置き・道の引き直し・反射）
}

/** サーバーの tick（体が出す出来事 'server.tick'）。 */
type ServerTick = { kind: 'server.tick'; data: { msptAvg: number; source: 'rcon_tick_query'; sampleSec: 10 } };

/** 体の版（ポールに足す）。今は観測から推している（minecraftBodyVersion.ts）。 */
interface BodyVersion { revision: string; catalogHash: string }
```

### 意味：時間の段
止まってから次に動くまでを、次の段に分けます。

| 段 | 始まり | 終わり | 誰の時計 |
|---|---|---|---|
| 1 失敗 → 知らせ | `BodyTimes.failedAt` | 頭の `received.at` | 体・頭（同じ VM なので時計は同じ） |
| 2 知らせ → 判断の始まり | `received.at` | 判断の記録の `request.at` | 頭 |
| 3 判断 | `request.at` | `response.at` | 頭 |
| 4 返事 → 送信 | `response.at` | `sent.at` | 頭 |
| 5 送信 → 体の受け取り | `sent.at` | `BodyTimes.acceptedAt` | 体 |
| 6 受け取り → ロック | `acceptedAt`（列で待った物は `startedAt`） | `lockAt` | 体 |
| 7 ロック → 最初の有効な操作 | `lockAt` | `firstMotorAt` | 体 |

- 段の和を、止まってから次に動くまでの秒とします。重なる手戻り（列で先読みして送った物）は、壁時計で 1 度だけ数えます。
- **先読み**：頭が列の残りで起きた時（`woke` の `remaining`）は、見積もった残り（`predictedRemainingMs`）と、実際の終わり（受け取りの `endedAt`）との差を測ります。
- **live の加工の前後**（D6）：頭は、体の生の観測（部品）と、LLM に見せた live（部品）の両方を記録します。切った項目は `dropped` に、何件・なぜを残します。食べ物の候補は「消さなかった」ではなく「判断に届いた」で確かめます（`shown` に有るか）。
- **手の始まりの記録**：黒箱の 90 秒の輪とは別に、手ごとの始まりを残します。失敗した act の分は、保留の現場と一緒にファイルに書きます。
- **サーバーの tick**：体の physics tick とは別です。体は、今ある RCON（`SceneSaver` の command）で 10 秒ごとに `tick query` を送り、平均の mspt を出来事で出します。RCON が無い時は出しません（無いと分かる）。
- **判断の記録との結び付け**：`request`・`sent` に `TraceIds` を足します。`received`・`woke`・`live` の行を足します。`decision-record show --item q15` で、その項目の受け取りと段の秒まで出るようにします。
- **大きさ**：判断の記録の上限（1 本 256 MB）の中です。手の始まりの記録は 1 件 1 KB 前後で、45 分で 2,000 件なら約 2 MB（見込み）です。

### 今のコードのどこが変わるか
- 頭：
  - `infra/decisionRecords/*`（行の種類・`TraceIds`）
  - `surfaces/minecraft/minecraftControl.ts`（`received` の行、受け取りの `bodyTimes`）
  - `surfaces/minecraft/minecraftLlmcQueue.ts`（`woke` の行、先読みの見積もり）
  - live を作る所（`minecraftLlmcLive.ts`・`minecraftLlmcLiveRewrite.ts`：`live` の行）
  - `minecraftBodyVersion.ts`（ポールの `bodyVersion` を読む）
  - `scripts/decision-record.ts`（show に段）
- 体：
  - `controlLoop.ts`（`acceptedAt`・`startedAt`）
  - `nativeBody.ts`（`lockAt`・`reflexWaitMs`）
  - `execution/ActionExecution.ts`（`firstMotorAt` をモーターの最初の操作で）
  - `instantSkills/act.ts`（`failedAt`・手の始まり）
  - `utils/blackbox.ts`（`hand_start` の種類）
  - `utils/sceneSave.ts`（`tick query`）
  - ポールの `bodyVersion`

### 移し方
判断の記録の古い本は、新しい行が無い物として読みます（`decision-record` は無い段を「無し」と出す）。

### 見本
`measure/trace-one-command.json`、`measure/hand-start.json`、`measure/live-before-after-fish.json`、`measure/prefetch-woke.json`。

---

## 9. 見本（fixture）と、体の実物を頭の試験へ渡す仕組み

### 2 種類の見本
1. **契約の見本**（手書き。この branch で作った物）
   - 契約ごとの入出力の実物を、実走の場面から作りました。
   - 頭と体に同じ物を置きます。頭は `services/api/tests/fixtures/continue/`、体は `backend/tests/fixtures/continue/` です。
   - `manifest.json` に、各ファイルの sha256 と契約の版があります。
   - 両側のテストは、まず自分の写しが manifest と合うかを確かめます。local-gate は、体と頭の両方の木を持っているので、2 つの写しが同じかを確かめます（違えば落とす）。
   - 見本は「何を入れたら何が出るべきか」の約束です。各担当は、自分の側の関数をこの見本で試します。
2. **体が作った実物**（作る物。実装の時）
   - 実走 39 の教訓（体の本当の 11 択の形と、頭の受け入れが食い違った）から、**手書きの見本同士を合わせるだけにしません**。
   - 体の担当は、体のビルドから次を作る台本 `backend/scripts/lab/continue-produce.ts` を書きます。
     - **catalog**：今の `catalog-contract.mjs --json` と同じ作り方（`bodySkillCatalog(...)` の `definitions`）。
     - **受け取り**：契約の見本の `input`（act・封筒・場面）を、体の本物のコード（`runAct()`・`NativeCommonFcaBody.execute()`・`CommonFcaControlLoop`）に通して出た受け取りと観測。場面が要る物（vertical・制御・死）は、再生の台か隔離ラボで本物のサーバーに通します（10 章）。
   - 出力は `backend/contracts/continue/produced/<見本の名>.json` です。各ファイルに、体の版（git の rev）・作った台本と台・入力の見本の sha256 を書きます。
   - 頭の担当は、`scripts/sync-body-produced.sh <体の rev>` で、それを `services/api/tests/fixtures/continue/produced/` へ写します（版つき）。頭のテスト `continueProduced.test.ts` は、その実物を、頭の本物の読み手（`readActResult()`・`settle()`・live の 1 行・帳簿）に通します。
   - local-gate の head の段に（5）を足します。指定の体の rev から、オフラインで作れる物（catalog と、偽の bot で通せる部品の出力）をその場で作り、頭に写してある実物と同じか（古くないか）を確かめます。場面が要る物は、作った時の rev と台を書いた写しを使い、体の rev が進んだら作り直しを求めます（gate は「体の rev と写しの rev が離れている」を警告します）。

### 見本の一覧（この branch の物）
`services/api/tests/fixtures/continue/manifest.json` を見てください。契約ごとに 3〜5 個、計 33 個と、通しの確かめの表 `e2e/boundaries.json`（10 章を機械で読める形にした物）です。どれも次の形です。
```json
{ "contract": "result", "version": 1, "scene": "…", "source": "実走 43 +2,123（run43-report.md 105 行）",
  "known": ["分かっている事"], "decided": ["この契約で決めた事"],
  "input": { }, "expected": { }, "checks": ["頭の試験で確かめる事", "体の試験で確かめる事"] }
```
- `known` は記録から確かめた事、`decided` は契約で決めた事です。
- `expected` の文（LLM が読む文）は、意味が同じなら言い回しを変えてよい物です。`checks` に「この語を含む」と書いた物だけを、テストで決まった文字として確かめます。

---

## 10. 通しの確かめの骨組み（10 の境界）

各担当の関数の合格数では判定しません。**同じ命令の番号（`TraceIds.command`）で、受け取り → 実際の操作 → 中断 → 解放 → 頭での結果の読みまでつながった記録**で判定します。
記録は、判断の記録（頭）・受け取り（`BodyTimes`）・黒箱（`hand_start` と出来事）です。判定は、1 本の台本 `tools/continue-verify/judge.ts`（頭のリポジトリ。作るのは頭の担当）が、3 つを `command` で突き合わせて行います。

### 台
- **A 再生の台**（VM、`run-replay.sh` と `scene-case.py`）：本物の体（`runAct()`・道探し）と、写したワールド。頭は台本の代役。vertical・続け方・約束の消費を見ます。
- **B 隔離ラボ**（VM、本物のサーバー・本物の bot・本物の反射・盾・道探し。`run-incident-lab.sh` と `run-hands-live.ps1` を広げる）：**D4 はここで確かめます。** 今の保留の通し（`minecraftHoldResumeLab.ts`）は、act とサーバーが代役なので、D4 の合格には使いません。敵は `summon` で置き、`/kill` で死なせ、`/tp` と `/execute in` で次元を移ります。
- **C 本物の頭の通し**（PC か VM、`minecraftHoldResumeLab.ts` を広げた物。頭は本物、モデルは台本）：B の体と組み、頭の読み・帳簿・判断の破棄（life_changed）・不明の扱いを見ます。
- **D 入力の取り出し**（API を呼ばない）：頭の `recordedClient` を、送らずに要求のバイトを返す形で使い、最後の要求に必要な物が残るかを見ます。
- **E Sonnet の試験**（上限 ¥500。この骨組みの外。測りの実走の前に）。

### 10 の境界

| # | 境界 | 台 | 場面（見本） | 判定（同じ command の記録で） |
|---|---|---|---|---|
| 1 | 結果と列 | B＋C | `result/r43-reflex-ate-first`、`continue/queue-item-depends` | 反射が先に食べた後、eat は `already`。`dependsOn: []` の後ろの項目は始まり（`startedAt` 有り）、頼る項目だけ `droppedBecause` |
| 2 | 途中の成果 | A | `vertical/r45-hold5-shaft-down-to-diamond`、`vertical/r45-hold7-pillar-up` | 途中まで掘った vertical を `seconds` で止め、`progress.done` と黒箱の dig の数が合う。次の vertical が `progress.at` から始まり、掘った段を掘り直さない |
| 3 | 約束と消費 | A＋C | `promise/*` | 作る途中の材料・燃料・作業台の設置と回収・食事をまたいで、帳簿の `have` と観測の持ち物が毎回合う（ずれ 0） |
| 4 | すぐの引き継ぎ | B＋C | `control/r45-attack-waited-6-4s`、`control/different-target`、`control/high-priority-not-taken` | 同じ相手：act の `lockAt − acceptedAt` が 300 ms 以下、`handover.confirmed`。別の敵：melee が次の手を始めない。溶岩・息：奪わない。盾：引き継ぎの間に構えが外れない（古い処理の禁止） |
| 5 | 死と非同期 | B＋C | `life/death-at-each-moment` | 実行中・反射待ち・列待ち・LLM の返事待ちの 4 つの瞬間に `/kill` し、生き返った後に、古い life の command の `firstMotorAt` が 1 つも無い |
| 6 | 古い持ち主 | B | `control/stale-owner-cleanup` | 新しい持ち主が始めた後に、古い処理の片付けが走っても、新しい持ち主のキー・盾・道探しの行き先が消えない（`token` の記録） |
| 7 | 次元と復活 | B | `life/portal-is-not-death` | ポータルの移りで life が変わらない。死んで別の次元に生き返った時は life が 1 増え、前の次元の座標の act は使われない |
| 8 | 通信と再起動 | B＋C | `result/unknown-receipt` | 受け取りの紛失・重複のポール・接続の交代・lease の交代で、同じ command の `firstMotorAt` が 2 回無い。`unknown` の項目が自動で出し直されない。約束の帳簿に同じ消費が 2 回無い |
| 9 | 計画 | C | `plan/*` | `kind`・`prep` が、最初の計画 → `plan.update` → 保存 → 頭の再起動 → 読み戻しで残る。題名を言い換えても、段の知識・不足・meter・近くの候補の文が同じ |
| 10 | 実際の LLM の入力 | D | `measure/live-before-after-fish`、急ぎの版の見本 | 情報の多い急ぎの live でも、食料・体力・持ち主・命の番号・約束の 1 行が、最後の要求のバイトに残る |

### 台本の骨組み（`tools/continue-verify/`、頭の担当が作る）
```
continue-verify/
  scenes/            境界ごとの台本（B の lab の手順: summon・kill・tp、C の頭の台本のモデル）
  run-boundary.sh    1 つの境界を、指定の頭・体の rev で回す（VM）
  collect.sh         判断の記録・受け取り・黒箱を 1 つのフォルダに集める
  judge.ts           command でつないで、上の表の判定をする。合否と、つながらなかった command の一覧を出す
  report.md          境界ごとの結果（rev・台・合否・つながった数）
```
- 境界・台・使う見本・合格の条件は、見本の `e2e/boundaries.json` にも同じ物があります（`judge.ts` はこれを読む）。
- 合格は「10 の境界すべてで、判定に使った command が全部つながり、条件を満たす」です。
- つながらない command が 1 つでもあれば不合格です（計測の穴なので）。

---

## 11. 担当の分け方と作る順

### 体の担当（`Shannon` リポジトリ）
- `backend/src/services/minebot/instantSkills/act.ts`（結果の 2 軸・続け方・delta・命の照らし・vertical の配線・手の始まり）
- `backend/src/services/minebot/utils/actReport.ts`、`utils/actHandRules.ts`、`utils/actLabel.ts`
- `backend/src/services/minebot/utils/primitives/vertical.ts`（新）、`tunnelWalk.ts`・`shaftDown.ts`（部品を使うだけ。変えるなら最小）
- `backend/src/services/minebot/utils/primitives/*.ts`（already の判定）
- `backend/src/services/minebot/integration/commonFca/nativeBody.ts`、`controlLoop.ts`、`bodyQueue.ts`、`bodyEvents.ts`、`minecraftControlContract.ts`（写し）、`continueContract.ts`（新、写し）
- `backend/src/services/minebot/execution/ActionExecution.ts`、`SkillExecutor.ts`
- `backend/src/services/minebot/utils/floorReflexes.ts`、`combatOwner.ts`、`blackbox.ts`、`sceneSave.ts`、`incidents.ts`（読むだけの足し）、`utils/life.ts`（新）
- `backend/scripts/lab/continue-produce.ts`（新）、隔離ラボの場面（`backend/scripts/lab/`）
- 体のテストと見本の写し（`backend/tests/fixtures/continue/`）

### 頭の担当（`shannon-ios` リポジトリ）
- `services/api/src/contracts/minecraftActContract.ts`、`minecraftActShortHands.ts`、`minecraftActHandRules.ts`、`minecraftActTime.ts`、`minecraftControlContract.ts`、`bodyControlContract.ts`、`continueContract.ts`（新）
- `services/api/src/surfaces/minecraft/minecraftControl.ts`、`minecraftControlValidation.ts`、`minecraftLlmcQueue.ts`、結果の文の所
- `services/api/src/surfaces/minecraft/minecraftLlmcLive.ts`、`minecraftLlmcLiveRewrite.ts`、`minecraftLlmcUrgent.ts`、`minecraftLlmcReadiness.ts`、`minecraftLlmcNode.ts`、`minecraftPlanDone.ts`、`minecraftLlmcRoad.ts`、`minecraftLlmcV2Knowledge.ts`、`minecraftLlmcObsidianWays.ts`、`minecraftLlmcReachWords.ts`、`minecraftLlmcRoute.ts`、`minecraftFirstPlan.ts`、`minecraftLlmcPromises.ts`（新）
- `services/api/src/mind/action/fca/fcaPlanTools.ts`、`fcaRunner.ts`
- `services/api/src/infra/decisionRecords/*`、`scripts/decision-record.ts`、`minecraftBodyVersion.ts`
- **共有の `packages/mind/src/planTree.ts`**：頭の担当が持ちます（頭のリポジトリの中にあり、体は表示の写し `BodyPlanView` しか読まないため）。
- `tools/continue-verify/`（新）、`scripts/sync-body-produced.sh`（新）、`continueProduced.test.ts`（新）
- 頭のテストと見本の写し（`services/api/tests/fixtures/continue/`）

### 共有の物と持ち主
| 物 | 持ち主 | 変え方 |
|---|---|---|
| この契約の文書（3 か所） | 契約の担当（この文書を書いた者）。担当が決まっていなければ取りまとめ役 | 3 か所を同時に。版を上げる |
| 契約の見本（両側の写しと manifest） | 同上 | 両側を同時に。gate が違いを落とす |
| 体が作った実物（`produced/`） | 体の担当が作り、頭の担当が写す | 体の rev ごとに作り直す |
| `packages/mind/src/planTree.ts` | 頭の担当 | 体は表示の写しだけを追う |
| `minecraftControlContract.ts` の写し | 頭の担当が元、体の担当が写し | 今と同じ（両側を同時に） |
| local-gate の（5）（`Syzygy/tools/shannon-release/`） | 頭の担当 | 体の担当に見せてから |

### 作る順と受け渡し
1. **契約と見本**（この branch）。Codex に見せて直す。
2. **計測・D4・計画の状態**（同時に進める）
   - 体：`TraceIds`・`BodyTimes`・`hand_start`・`server.tick`・`bodyVersion`、`state.control` と `token`、引き継ぎ・上限のつなぎ、命の番号。
   - 頭：判断の記録の行、`kind`・`prep`・v2 の読み替え、題名の正規表現の置き換え（7 章の表）、`life_changed` の破棄、急ぎの live の欄。
   - **受け渡し**：体は、命の番号と `state.control` が入った観測の実物（`produced/`）を頭へ。頭は、`context.life` を入れた命令の実物を体へ（体の試験の入力に）。
3. **D1 を両側でつなぐ**
   - 体：`HandOutcome`・`ActOutcome`・`ItemOutcome`・already の判定・`dependsOn`・`admit`。
   - 頭：`readActResult()`・`settle()`/`drop()`・`receiptOf()` の不明・`dependsOn` の読み書き・結果の文。
   - **受け渡し**：体は `result/*`・`continue/*` の見本を本物の `runAct()` に通した受け取りを `produced/` に出す。頭はそれで `continueProduced.test.ts` を通す。
4. **D2・D3・D6**
   - 体：`delta`・`ReflexDelta`、vertical。
   - 頭：帳簿・live の 1 行・`uses`・`plan.update` の op、vertical の短い書き方と見積もり、live の加工の前後の記録（D6）。
   - D8（精錬の並べ方）は作らず、Sonnet の試験で確かめる。
   - **受け渡し**：catalog（vertical の欄が入った物）を `produced/` へ。gate の（4）（catalog と頭の検査）と（5）が通ること。
5. **通しの確かめ**（10 章）と **Sonnet の試験**。合格の後に、1 つの版として反映する（スイッチは付けない）。

各段の終わりに、両側の local-gate と、その段で使える境界の通しを回します。段は作る順のための物で、反映は最後に 1 回だけです。

---

## 12. 決めきれなかった所（取りまとめ役か Codex に判断してほしい所）

1. **手の欄の数**：足す 5 欄で体の Hand が 48 欄になり、頭の上限 48 にちょうど当たります。上限を 56 に上げる案にしました。48 という上限は、私たちが決めた数（実走 39 の時に「余裕を見て 48」）です。モデル側の上限から来た物かは、確かめていません。
2. **命の番号の置き場**：体のファイル（`life.json`、ワールドの id ごと）にしました。案は 2 つあります。
   - サーバーの統計（`minecraft:deaths`）を読めば、体を作り直しても狂いません。ただし mineflayer で読むには要求が要ります。
   - 接続ごとに 0 から数える形は、体の再起動の直後に古い命令と取り違えるおそれがあり、やめました。
3. **引き継げる反射の範囲**：`floor-melee` と、体力 5 より上の `floor-last-stand`（hit）だけにしました。低体力の逃げ（`floor-flee`）を、同じ相手の fight が奪ってよいかは決めていません（今は奪わない）。
4. **attack・fight の「既に済」**：相手が死んだのを体が 30 秒以内に見ていた時だけ `already` にしました。見えない所で死んだ・消えた相手は `failed`（`target_not_found`）のままです。
5. **約束の物の語**：`have` と同じ読み方（`planks` は `*_planks` も数える）と、食料の点の `food` だけにしました。「燃料」のような用途でまとめた語（石炭・木炭・板・原木のどれでも）は入れていません。
6. **最初の計画で約束を書かせるか**：最初の計画の形（`FIRST_PLAN_SCHEMA_R4`）に `promises` を足すと、強いモデルの最初の計画が長くなります。`plan.update` だけで書かせる案もあります。
7. **不明の結果の後の片付け**：今どおり、頭の段の片付け（stop・release）に任せました。頭が不明を受けた時に、すぐ片付けを送るかは決めていません。
8. **サーバーの tick の取り方**：RCON の `tick query` を 10 秒ごとにしました。shannon-home の重さへの影響は測っていません。
9. **`unmet_now` の扱い**：meter で「今は満たせない」の節を、遅れに数えるかどうか。今の案は「数えない。理由を出す」です。
10. **`PlanKind` を閉じた列にするか**：閉じた列（22 種）にしました。LLM が列に無い物を書いた時は `other` として受けます（断らない）。開いた文字列にする案もあります。
11. **D6・D8 の契約**：D6（live の加工の見直し）は、計測の `live` の行（8 章）と境界 10 で扱い、別の契約は立てませんでした。D8（精錬の並べ方）は、新しい手を作らないので契約は無しです。これでよいか。
12. **縦の移動の手の名前と形**：取りまとめ役の追記で、下りも上りも 1 つの手にしました。名前は `vertical`、向きは `toY` と今の y から決まり、形は `stairs`・`shaft`（下りだけ）・`pillar`（上りだけ）です。下りと上りを別の手（`descend`・`climb`）に分ける案もあります（LLM にとって読みやすいのはどちらか、Sonnet の試験で見る）。
13. **柱の置きの時機**：`pillar` は「足がマスの上端より 0.2 以上高い時」に置くとしました。保留 8 の台で、0.1 上では断られた事からの見込みで、0.2 で足りるかは確かめていません。
