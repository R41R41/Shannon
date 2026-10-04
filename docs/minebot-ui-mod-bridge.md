# ShannonUIMod v2 との接続（2026-10-03）

ShannonUIMod v2.0.0（状況カード・すぐ話す・指示メニュー・詳細画面）に合わせた Minebot 側の変更。prod 未反映、env・DB・Bot 設定は変更していない。

## 変更

- **`POST /bot_command`** を追加した。本体は `{ command, sender }`。command は `STOP`・`FOLLOW`・`COME`・`RESUME`・`CANCEL` のどれか、sender は Minecraft のプレイヤー名。処理は `minebot/commands/BotCommandService.ts` にまとめた。
  - 自由文を受け取らず、LLM を呼ばず、記憶に書かない。決まった操作だけを行う。
  - STOP は実行中のタスクの強制停止、`auto-follow` のオフ、`stop-movement` を行う。
  - FOLLOW と COME は送信者が見える場合だけ、実行中のタスクを止めて `follow-entity` を使う。FOLLOW は時間無制限、COME は到着まで最長60秒。
  - RESUME は下記の `resumeByControl`。CANCEL は現在のタスクを `removeTask` する。
- **`MinebotTaskRuntime.resumeByControl()`** を追加した。返事待ち（`awaiting_user`）または失敗したタスクを「続けて」で再開する。
  - タスクを始めたときの envelope をそのまま使う。新しい文は入らないので、タスクの記憶の audience は変わらない。
  - world・dimension が変わっていれば拒否する。
- **`POST /task_continue`** は `onChatMessageCallback('system', '続けて')` で新しいタスクを作っていた。これを `resumeByControl` に置き換えた。
- **`POST /chat_message`** はタスクが終わるまで応答を返さず、呼び出し元のサーバースレッドを止めていた。受理した時点で 202 を返すように変えた。返事は従来どおり `/bot_chat` で Mod に届く。
- **Mod からのメッセージ**（`skillAgent.handleModMessage`）の扱いを変えた。
  - タスク実行中は、実行中のタスクに混ぜずにキューへ入れる。従来は記憶境界の検査で例外になり「エラーが発生しました」と返っていた。
  - 返事待ちのときは、ゲーム内チャットで答えるように案内する。Mod の入力で game-chat のタスクを再開しない。
- **Mod にも同じ発言を送る**ようにした（`minebot/uiMod/uiModChat.ts`）。対象は、即時の了解、処理エラー、MAX_ITERATIONS の「続けますか？」、指示への応答。どれもゲーム内チャットにも出す言葉なので、Mod に届く情報は増えない。
- **音声の聞き取り結果**を、話した本人の Minecraft にも出すようにした（`notifyUiModVoiceTranscript`）。`VoiceProcessor` が Discord に聞き取り結果を投稿するときに、Mod の `POST /voice_transcript` へ `{ text, speaker, mcUsername, mode }` を送る。
  - `mcUsername` は `CONFIG.resolveMinecraftName` で Discord 名から求める。Mod はその名前のオンラインのプレイヤーにだけ届け、いなければ捨てる。ほかのプレイヤーには見えない。
  - 送る言葉は Discord のチャンネルにすでに出ているものと同じ。Mod が無ければ何もしない。
- **返事の候補**を、返事待ちの `/task` に `replyChoices`（文字列2〜4個）として付けるようにした（`minebot/uiMod/replyChoices.ts`）。
  - いまの Minecraft で返事待ちになるのは `ShannonExecutor` の MAX_ITERATIONS（「…続けますか？」）だけで、そこで作る。
  - 質問文・目標・進捗だけを Haiku に渡し、プレイヤーが言う短い返事を作らせる。記憶には書かず、ゲーム内チャットに出ている情報しか使わない。
  - 4秒で返らない、失敗する、2個に満たない、長すぎるなどのときは「続けて」「やめて」に戻す。返事待ちの流れは止めない。
  - Mod は候補を押すと「シャノン、<候補>」をゲーム内チャットに送る。答えの扱いは、手で打った返事と同じ。
- **開発者ログ**を `ShannonExecutor` のツール実行から `/task_logs` へ送るようにした。宛先は `/task` と同じ。FCA 経路の `ToolExecutor` には envelope を渡すようにした。従来は envelope を渡しておらず、ログが一度も送られていなかった。

## 変えていないもの

- Mod と音声の入力は従来どおり `memoryDisabled`。game-chat の直近履歴にも混ぜない。continuation の検査（`assertMinecraftContinuation`）も変えていない。
- `canPostMinebotUiFromEnvelope` による UI 送信の宛先検査も変えていない。

## 検証

- `tests/unit/minebotModBridge.test.ts` に13件を追加した（音声の聞き取り結果の3件を含む）。
- `tests/unit/minebotReplyChoices.test.ts` に6件を追加した。出力の取り出しと整え方、モデルへ渡す内容、失敗・不正な出力・タイムアウトで決まった候補に戻ることを確かめる。指示の解析、各指示の動作、HTTP の検証と 202、`resumeByControl` が元の envelope と固定文で再開することを確かめる。
- `tests/unit` 全体はダミーの必須 env で 78 ファイル・1183 件が合格した。env なしでは、OPENAI_API_KEY を import 時に要求する3ファイルが失敗する。これは変更前と同じ。
- `check:foundation` の型エラー37件と dead-code 検査の結果は、変更前の main と同じ。変更したファイルに型エラーはない。
- Mod は実 Minecraft 1.21.11（開発用サーバーとクライアント、mineflayer の I_am_Shannon、ボット本体の代わりの記録用サーバー）で確認した。実際のボット本体との接続は未確認。
