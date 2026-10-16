# ShannonUIMod v2 と共通 FCA の体（2026-10-17）

`MINEBOT_COMMON_FCA=on` の体では、タスクの列・計画器・常時スキル・反応設定を持たない（心が API で決める）。そのため ShannonUIMod v2.0.0 のタスクタブ・状況カード・デバッグログ・指示メニューには何も届かず、操作も 400/404 になっていた。この変更で、Mod が使う口を FCA の体の上に作り直した。Mod 本体（R41R41/ShannonUIMod v2.0.0）は変更しない。prod 未反映、env・DB・設定は変更していない。

## 体 → Mod（`integration/commonFca/uiModBridge.ts`）

`CommonFcaControlLoop` に読み取り専用の `observer`（`commandStarted` / `commandEnded`）を足し、`CommonFcaUiModBridge` がそれを見て Mod に送る。体が受ける命令はどれも `context`（目標・完了条件・`taskState` の進み具合と直近の結果）を持つので、新しい情報源は要らない。

| 送り先 | 内容 |
| --- | --- |
| `/task` | 目標、完了条件（strategy）、進み具合（currentThinking）、各命令を 1 ステップとして実行中・完了・失敗。`stop`（理由 cancel）で `aborted`、`release` で `completed` |
| `/task_list` | 実行中のタスク 1 件（`currentTaskId`）。120 秒命令が無ければ現在のタスクから外す（ステップは残す） |
| `/task_logs` | 命令の開始・結果。0.5 秒ごとにまとめて送り、順番を保つ（失わない） |

送りは 2 秒で打ち切る送りっぱなしで、観測側が例外を出しても体は止まらない。送信の部品は `integration/uiModPush.ts`（ラボの `LabUiModBridge` と共有）。

## Mod → 体（`MinebotHttpServer` + `integration/commonFca/uiModControls.ts`）

FCA の体では `setFcaControls` が入り、ボタンは心への言葉になる。心が返事を書き（ゲーム内チャットと `/bot_chat`）、必要なら API が体に命令を出す。体が自分でやるのは立ち止まることだけ。

- `POST /bot_command`（STOP・FOLLOW・COME・RESUME・CANCEL）→ 「止まって」「ついてきて」「こっちに来て」「続けて」「今の作業をやめて」。STOP と CANCEL は先に走っている命令を中止する（`CommonFcaControlLoop.abortActive`、受け取りは `cancelled`）。心に届かなくても止まる。旧体（FCA でない）は従来どおり 404 を返し、Mod が旧経路に落ちる。
- `/task_continue` → RESUME、`/task_delete` → 表示中のタスクだけ CANCEL、`/task_prioritize` → 409（順番は心が決める）。
- `/chat_message` → 受理して 202 を返し、心の返事は `/bot_chat` で届く（心の返事は数秒かかり、Mod の読み取りは 10 秒で切れる）。
- `/throw_item` → 「<item>を<count>個ちょうだい」。`/constant_skill_switch` の `auto-follow` → FOLLOW / STOP。Mod はこの 2 つに名前を付けないので、体のほかにプレイヤーがちょうど 1 人の時だけ動く（複数なら 409）。
- `/reaction_setting_update` `/reaction_settings_reset` と、`auto-follow` 以外のスイッチ → 409。
- `GET /task_list` → ブリッジの現在の状態。

## 音声の聞き取り結果

`VoiceProcessor` が Discord に聞き取り結果を載せる時に、Mod の `POST /voice_transcript`（`integration/uiModVoice.ts`）へ `{text, speaker, mcUsername, mode}` を送る。Mod は同名のオンラインのプレイヤーにだけ出す。`codex/shannonuimod-v2-bridge` にあった同じ機能の移植。

## まだやっていないこと

- `codex/shannonuimod-v2-bridge` の旧実行器向け部分（`BotCommandService`・`resumeByControl`・返事の候補 `replyChoices`）は取り込んでいない。FCA の体には返事待ちの状態がないため。旧実行器で使う時は別に扱う。
- Mod 側の変更（`/throw_item` に送り手の名前を足す等）は未実施。足せば「プレイヤー 1 人」の条件が要らなくなる。
- 実 Minecraft・実 Mod・実の心での確認は未実施。単体テスト `tests/unit/minebotFcaUiMod.test.ts`（偽の Mod 受信・偽のアクチュエータ・実物の HTTP サーバー）で確認した。
