# ShannonUIMod v2 と共通 FCA の体（2026-10-17）

`MINEBOT_COMMON_FCA=on` の体では、タスクの列・計画器・常時スキル・反応設定を持たない（心が API で決める）。そのため ShannonUIMod v2.0.0 のタスクタブ・状況カード・デバッグログ・指示メニューには何も届かず、操作も 400/404 になっていた。この変更で、Mod が使う口を FCA の体の上に作り直した。Mod 本体（R41R41/ShannonUIMod v2.0.0）は変更しない。prod 未反映、env・DB・設定は変更していない。

## 体 → Mod（`integration/commonFca/uiModBridge.ts`）

`CommonFcaControlLoop` に読み取り専用の `observer`（`commandStarted` / `commandEnded`）を足し、`CommonFcaUiModBridge` がそれを見て Mod に送る。体が受ける命令はどれも `context`（目標・完了条件・`taskState` の進み具合と直近の結果）を持つので、新しい情報源は要らない。

| 送り先 | 内容 |
| --- | --- |
| `/task` | 目標、完了条件（strategy）、進み具合（currentThinking）、各命令を 1 ステップとして実行中・完了・失敗。`stop`（理由 cancel）で `aborted`、`release` で `completed`。計画があるときは `planRevision` と、計画の節ごとの `where`・`doneWhen`・`note`（文字列）と `forbid`・`caution`（文字列の配列、最大 4 行）を、あるものだけ付ける（Mod の計画の節のツールチップ用）。体を握っている反射のラベルを `activeReflex`（無ければ null）に出す |
| `/task_list` | 実行中のタスク 1 件（`currentTaskId`）。120 秒命令が無ければ現在のタスクから外す（ステップは残す） |
| `/task_logs` | 命令の開始・結果。0.5 秒ごとにまとめて送り、順番を保つ（失わない） |

送りは 2 秒で打ち切る送りっぱなしで、観測側が例外を出しても体は止まらない。送信の部品は `integration/uiModPush.ts`（ラボの `LabUiModBridge` と共有）。

## Mod → 体（`MinebotHttpServer` + `integration/commonFca/uiModControls.ts`）

FCA の体では `setFcaControls` が入り、ボタンは心への言葉になる。心が返事を書き（ゲーム内チャットと `/bot_chat`）、必要なら API が体に命令を出す。体が自分でやるのは立ち止まることだけ。

- `POST /bot_command`（STOP・FOLLOW・COME・RESUME・CANCEL）→ 「止まって」「ついてきて」「こっちに来て」「続けて」「今の作業をやめて」。STOP と CANCEL は先に走っている命令を中止する（`CommonFcaControlLoop.abortActive`、受け取りは `cancelled`）。心に届かなくても止まる。旧体（FCA でない）は従来どおり 404 を返し、Mod が旧経路に落ちる。
- `/task_continue` → RESUME、`/task_delete` → 表示中のタスクだけ CANCEL、`/task_prioritize` → 409（順番は心が決める）。
- `/chat_message` → 受理して 202 を返し、心の返事は `/bot_chat` で届く（心の返事は数秒かかり、Mod の読み取りは 10 秒で切れる）。
- `/throw_item` → 「<item>を<count>個ちょうだい」。`/constant_skill_switch` の `auto-follow` → FOLLOW / STOP。Mod は `sender`（プレイヤー名）を送る。`/throw_item`・`/constant_skill_switch`・`/task_delete`・`/task_prioritize` は、正しい名前の `sender` があればその人として心に言い、無いときは今までどおり体のほかにプレイヤーがちょうど 1 人の時だけ動く（複数なら 409）。
- `/reaction_setting_update` `/reaction_settings_reset` と、`auto-follow` 以外のスイッチ → 409。
- `GET /task_list` → ブリッジの現在の状態。

## 音声の聞き取り結果

`VoiceProcessor` が Discord に聞き取り結果を載せる時に、Mod の `POST /voice_transcript`（`integration/uiModVoice.ts`）へ `{text, speaker, mcUsername, mode}` を送る。Mod は同名のオンラインのプレイヤーにだけ出す。`codex/shannonuimod-v2-bridge` にあった同じ機能の移植。

## 確認の手順（隔離した使い捨てのラボ）

隔離ラボ（`MINECRAFT_LAB_UI_MOD=true`、キャンペーンの実走）は旧来の実行経路（`LabUiModBridge`）で動き、FCA の体を通らない。この変更の確認には使えない。代わりに、本物の Minebot クライアント（FCA の体）を使い捨てのワールドに入れ、心だけを偽物（`backend/scripts/lab/fake-fca-mind.mjs`）にする。

部品（すべて `~/uimod-fca-lab` の下、専用の tmux サーバー `-L uimod-fca-lab`、待ち受けはループバックのみ。VM の既存のフォルダー・プロセス・ファイアウォール・本番の心には触れない）:

| 部品 | 内容 |
| --- | --- |
| ワールド | Fabric 1.21.11、`127.0.0.1:25570`、offline-mode、フラット、平和、Fabric API と ShannonUIMod 2.0.0（VM の `uimod-test` にある jar のコピー） |
| Mod の設定 | `backendPort` 38092、`httpServerPort` 38081、`backendToken` は 48 桁の乱数（`mod.token`、権限 600） |
| 偽の心 | `127.0.0.1:34329`。`/control` に読み取り専用の命令を返し、`/turns` に「止まって」「続けて」などの返事を返す。モデル・DB・実データなし |
| 体 | `scripts/lab/uimod-fca-lab.ts`（実物の `MinebotClient`、`MINEBOT_COMMON_FCA=on`、`MINEBOT_LAB_OFFLINE_AUTH=on`＝Microsoft ログインなしで入れるのはこのラボ名のワールドだけ） |

手順（操作は `backend/scripts/lab/uimod-fca-lab.sh`）:

1. `git archive` で作ったソースの tarball を VM の `/tmp` に置き、`uimod-fca-lab.sh setup <tarball>`（`node_modules` は VM の開発用チェックアウトからのハードリンクで、元は書き換えない。不足の `@langchain/community` と `date-fns-tz`（nested の date-fns v3）は `~/uimod-fca-lab/extra` に入れてラボの `node_modules` にだけ足す）。
2. `uimod-fca-lab.sh start`（ワールド → 偽の心 → 体の順）。`status` で 4 つのポートと偽の心の状態（`polls` が増える）を見る。体のログは `~/uimod-fca-lab/logs/body.log`（`LAB_BOT_STARTED`、`MINEBOT_COMPANION_STARTED`）。
3. 自分の PC で `ssh -L 25570:127.0.0.1:25570 azure-constant-server` をつなぎっぱなしにし、Minecraft 1.21.11（Fabric Loader 0.18 以降、Fabric API、`shannonuimod-2.0.0.jar`）で `localhost:25570` に入る（offline-mode なので名前は何でもよい。`Rai1241` 等）。
4. `uimod-fca-lab.sh task "木を見て回る" 8` で偽の心がタスクを始める。見るもの:
   - 状況カードが「作業中」になり、目標・進み具合（`n/8`）が出る。`U` の詳細画面のタスクタブにステップ（`goal-evidence` など）が増えていく。
   - 設定タブのデバッグログに、命令の開始と結果が出る。
   - 終わると「待機中」に戻る。
5. 操作の確認（`G` の指示メニューなど）: 「止まって」「続けて」を押すと、偽の心の `turns`（`uimod-fca-lab.sh turns`）に `止まって` などが届き、偽の心が返事を `/bot_chat` 経由でチャットに出す。タスクの途中で「今の作業をやめて」を押すとタスクタブが「中止」になり、体は止まる。
6. 終わったら `uimod-fca-lab.sh stop`、片付けは `clean`（`~/uimod-fca-lab` だけを消す）。

2026-10-17 に実行して確認したこと（Mod の画面を人が見る確認は未実施）: 体がワールドに入り（`LAB_BOT_STARTED`、ワールドのログに `I_am_Shannon joined`）、偽の心へ 380 回超ポーリングし、4 ステップのタスクが命令 → receipt → `release` まで完了した。実物の Mod の受信口に、ブリッジと同じ形の `/task` `/task_list` `/task_logs` `/bot_chat` を送ると 200、壊れた JSON は 400。体の `GET /task_list` は 200、`POST /bot_command` は本物のトークンで 200。

ラボの限り: 体のカタログが `goal-evidence` の 1 つだけだった（偽の心はこれを使う。ts-node で動かしているためスキルの読み込みが本番の `dist`（`.js`）と違うのでは、と推測しているが、原因は未確認）。体の本物のスキル（掘る・歩く）の確認ではない。

## まだやっていないこと

- `codex/shannonuimod-v2-bridge` の旧実行器向け部分（`BotCommandService`・`resumeByControl`・返事の候補 `replyChoices`）は取り込んでいない。FCA の体には返事待ちの状態がないため。旧実行器で使う時は別に扱う。
- Mod が `sender` を送るようになるまでは「プレイヤー 1 人」の条件が残る（体は `sender` を受け取る側まで対応済み）。
- 実 Minecraft・実 Mod・実の心での確認は未実施。単体テスト `tests/unit/minebotFcaUiMod.test.ts`（偽の Mod 受信・偽のアクチュエータ・実物の HTTP サーバー）で確認した。
