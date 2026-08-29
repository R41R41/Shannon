# 削除ゲート（2026-08-29）

## なぜ入れたか

Shannon には、新しい層を建てたあと古い層を消さずに残す癖がある。`config/constants.ts` と
`config/limits.ts` と `services/eventBus/eventTypes.ts` の3ファイルは、どれも冒頭に
「NOTE: Consumers have NOT been updated to import from here yet」と書いたまま残っている。
`ClassifyNode` と `SubTaskPlannerNode` はグラフから外れたあとも残った。`ModelSelector` には
一度も参照されない `ANTHROPIC_CHAIN` が居座っていた。

原因は、作業の完了条件が「新しい経路が動くこと」だけで、「古い経路を消すこと」が
誰にも要求されていなかったこと。人の気づきに頼るのをやめて、機械が要求する形にする。

## 何を検査するか

`npm run check:dead-code`（CI の Check foundation boundaries に登録済み）が2つを見る。

**1. 未参照ファイル（knip）** — `knip.json` の entry から辿れないファイルを列挙する。
1件でも `deletion-ledger.json` に無ければ失敗する。逆に、台帳にあるのに実際は参照されている
（＝削除済み、または使われ始めた）項目も失敗させる。台帳が現実とずれたまま太るのを防ぐため。

**2. 未使用の宣言（eslint）** — `backend/eslint.dead-code.mjs` は `no-unused-vars` だけを
見る。knip はファイルと export の単位でしか見えないので、`ANTHROPIC_CHAIN` のような
モジュール内の宣言はこちらが拾う。既存分が多いので件数の上限（baseline）方式にしてある。
増えたら失敗、減っても「baseline を下げろ」と言って失敗する。数が実態から離れないようにするため。

## deletion-ledger.json

未参照ファイルを残すには、理由・担当・期限を書く。期限を過ぎると CI が落ちるので、
そこで「消す」か「理由を書き直して期限を延ばす」かを必ず選ぶことになる。

```json
{
  "path": "backend/src/config/limits.ts",
  "reason": "constants.ts と同じ一元化の試み。閾値は各所にハードコードされたまま。",
  "owner": "rai",
  "sunset": "2026-09-30"
}
```

期限を延ばすこと自体は悪くない。悪いのは、誰も決めないまま残ることだった。

## 落ちたときにやること

| メッセージ | やること |
| --- | --- |
| 未参照のファイルが台帳にない | そのファイルを消す。残すなら台帳に理由と期限を書く |
| 台帳の項目がもう未参照ではない | 台帳から項目を消す |
| 期限切れ | 消すか、理由を書き直して期限を延ばす |
| 未使用の宣言が増えた | 増えた宣言を消す。意図があるなら `_` 始まりの名前にする |
| 未使用の宣言が減った | `unusedLocals.baseline` をその数に下げる |

## 検査できないこと

これは**参照されているか**しか見ない。**到達するか**は見ない。
`ParallelExecutor` のように、条件分岐で実際には呼ばれないが import はされているコードは
すり抜ける。設定次第で死んでいるコードは、引き続き人が読んで判断する必要がある。

動的読み込みも見えない。`llm/tools/` と `minebot/instantSkills/` と
`minebot/constantSkills/` はディレクトリ走査で読まれるので `knip.json` で entry に
指定してある。同じ仕組みを増やしたら entry も足す。
