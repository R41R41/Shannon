# Discord生成物（HTML / PDF）

## 目的

Discord版Shannonが調査結果を本文だけでなく、再利用しやすいHTML・PDFと、Discord内ですぐ見られるプレビュー画像として共有する。

初期スキルは `travel-brief`。浜松などの日帰り予定について、公式情報を調べ、時系列・費用・予約・雨天案・参照元をひとつの資料にまとめる。

## 構成

1. Shannonが `google-search` → `fetch-url` で一次情報を確認する
2. `create-travel-brief` が構造化データをサーバー所有テンプレートへ渡す
3. `ArtifactService` がHTML・PDF・JPEGプレビューを生成する
4. `ArtifactStore` がランダムなartifact ID、マニフェスト、有効期限と共に保管する
5. `send-artifact-on-discord` がartifact IDだけをDiscord配送層へ渡す
6. Discordクライアントが保管層から解決したファイルだけを添付する

LLMへ任意ファイルパスを渡す機能は提供しない。HTML内の値はエスケープし、JavaScriptとローカルファイルアクセスを無効にしてレンダリングする。

## 生成物

- `shannon-trip-guide.html`: スマートフォンでも読める共有用ページ
- `shannon-trip-guide.pdf`: A4印刷・保存用
- `shannon-trip-preview.jpg`: Discord内の即時確認用（8MB以下）

既定の保管期間は7日。`SHANNON_ARTIFACT_TTL_MS` で変更できる。1ファイルの既定上限は8MBで、`SHANNON_ARTIFACT_MAX_FILE_BYTES` で変更できる。
期限切れ成果物は参照できず、次の成果物生成時にディスクから自動削除される。

## 実行環境

PDF・プレビュー生成には `wkhtmltopdf` と `wkhtmltoimage` が必要。既定では `PATH` から解決し、別の場所にある場合は `WKHTMLTOPDF_PATH` / `WKHTMLTOIMAGE_PATH` に実行ファイルの絶対パスを指定する。レンダラーはJavaScriptとローカルファイルアクセスを無効化して起動する。

成果物の既定保存先は `backend/saves/artifacts/`。別ボリュームへ置く場合は `SHANNON_ARTIFACT_DIR` を指定する。

## テストサーバー

`backend/scripts/runDiscordArtifactHarness.mjs` はLLMグラフとDiscordだけを起動する。スケジューラー、X、YouTube、Minecraft、Webサーバーは起動しない。

必須環境変数:

- `SHANNON_ENABLE_DISCORD_ARTIFACT_TEST=true`
- `DISCORD_TOKEN_TEST`
- `TEST_GUILD_ID`
- `TEST_X_CHANNEL_ID`

確認用の依頼例:

> 友人3人で浜松へ日帰り旅行したい。浜松駅10時集合、音楽と浜松らしい食を楽しみたい。公式情報を調べて、雨の日の代案も含む見やすいPDFとHTMLを作って送って。

合格条件:

- 依頼への通常返信ができる
- HTML・PDF・プレビュー画像の3ファイルが同じDiscordメッセージに付く
- PDFが開き、日本語の欠落・文字化け・重なりがない
- HTMLが開き、外部スクリプトを実行しない
- 参照URLが資料内にあり、調査していないURLを捏造しない
- 添付に失敗した場合もプロセスが落ちず、テキストで失敗を通知する
