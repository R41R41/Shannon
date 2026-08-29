# RF-04：共有FCA核（2026-08-29）

対象：Azure VMの`Shannon-dev`。状態：dev実装。本番LINEサービスへのbundle差し替えと本体グラフの本番反映は別工程。

## あるべき姿

送信先・読み込む記憶・使えるツールは、FCAループの中に焼き付けない。ループは1つだけ持ち、runごとにcatalogと終了条件を注入する。

```
modules/fca（SDK / Discord / LINE / Mongo / EventBus 非依存）
  runFcaLoop(system, messages, tools, model, limits, policy, hooks)
    ├ Radar digest: 読み取りスキル + submit_personal_digest。transportなし
    ├ LINE chat: 公開search_web / search_youtube。Replyはwebhook側
    ├ Discord会話: 会話記憶・Discord tool・task-complete を注入
    └ 定期投稿: google-search / search-by-wikipedia / submit_post。X送信はループの外
```

核に入れないもの：Discord/LINE/Twitter送信、人物記憶、EventBus、感情、Minecraft知識、Radarの同意/outbox/receipt。

## 契約

- 1回限りのmessages蓄積。ephemeralはmodel入力にだけ付き、履歴へ残さない
- 未登録toolはfail closed
- turn / call / 1応答あたりのcall / 経過時間の上限
- tool結果は未信頼データ
- 終了：文章応答（`policy.kind=text`）または terminal tool
- `Date.now`以外のplatform API、動的import、process/fetch/timerはmodules/fcaから禁止

## 変更したもの

- `RadarFca`は独自whileを捨てて`runFcaLoop`を使う
- LINE `createLineChatModel`も同じ核。ツールなしなら以前と同じ1回の文章応答
- `FunctionCallingSession`のメインループを同じ核へ置換。Minecraft復旧の細かい強制継続などは薄いhookに落ち、完全再現ではない
- YouTube `search.list`はchat用`broker.search`だけ。Radarの`get`は従来通りsubscriptions/channels/playlistItemsのみ
- `PostNewsAgent` / `PostAboutTodayAgent` は同じ核 + 同じ検索袋。プロンプトとヘッダーだけが違う。X投稿ツールは核に入れない

## 検証

`check:foundation`に`modules/fca`を追加。対象unitは核、Radar FCA、LINE chat/skills、YouTube search、FCA session isolation。実LINE再配備・本体ライブ起動はしない。
