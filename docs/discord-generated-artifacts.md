# Discord調査・質問フォーム・PDF生成

## 目的

Discord版Shannonが不足要件を会話内で確認し、調査結果をPDFとDiscord内ですぐ見られるプレビュー画像として共有する。HTMLは安全なサーバーレンダリングの内部形式に限定し、Discordへは送らない。

初期スキルは `travel-brief`。浜松などの日帰り予定について、公式情報を調べ、時系列・費用・予約・雨天案・参照元をひとつの資料にまとめる。

## 構成

1. 必須情報が足りない場合は `ask-user-on-discord` が選択・数値・自由入力フォームを1枚表示する。推奨条件は「この条件で開始」で承認できる
2. 回答は依頼者本人だけが送信でき、永続化後に元の依頼を自動再開する
3. `google-search` が Anthropic Web Search → Brave Search → Google CSE の順で検索する。独立した検索と `search-places` は並列化し、重要ページを `fetch-url` で確認する
4. `compute-route` がGoogle Routes APIで距離・時間・ルート線を取得する
5. `create-travel-brief` が構造化データをサーバー所有テンプレートへ渡す
6. `ArtifactService` が内部HTML・PDF・JPEGプレビューを生成し、ルート線があればMaps Static画像をPDFへ埋め込む
7. `ArtifactStore` がランダムなartifact ID、マニフェスト、有効期限と共に保管する
8. `send-artifact-on-discord` がartifact IDだけをDiscord配送層へ渡す
9. Discordクライアントが保管層から解決したPDFとJPEGだけを添付する

LLMへ任意ファイルパスを渡す機能は提供しない。HTML内の値はエスケープし、JavaScriptとローカルファイルアクセスを無効にしてレンダリングする。

## 生成物

- `shannon-trip-guide.pdf`: A4印刷・保存用
- `shannon-trip-preview.jpg`: Discord内の即時確認用（8MB以下）

`shannon-trip-guide.html` はレンダリング用に一時保管されるが、マニフェストとDiscord添付には含めない。

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
- `TEST_DEV_CHANNEL_ID`（未設定時のみ `TEST_X_CHANNEL_ID`）

devモードは既定でテストGuild以外を無視し、スラッシュコマンドもテストGuildだけへ登録する。本番Botトークンへはフォールバックしない。アイマイラボでdev Botを使う特殊な検証に限り、明示的に `SHANNON_DEV_ALLOW_AIMINE=True` を指定する。

通常はハーネス起動後にテストサーバーの `#dev` へ本人が依頼を投稿する。`SHANNON_ARTIFACT_TEST_PROMPT` で合成依頼を投入する場合は、確認フォームを本人だけが操作できるよう `SHANNON_ARTIFACT_TEST_USER_ID` も指定する。

機能別環境変数:

- `ANTHROPIC_API_KEY`: 第一検索プロバイダ
- `BRAVE_SEARCH_API_KEY`: 第二検索プロバイダ
- `GOOGLE_API_KEY` / `SEARCH_ENGINE_ID`: 移行期間中の検索フォールバック
- `GOOGLE_MAPS_API_KEY`: Places、Routes、Maps Static
- `WEB_SEARCH_PROVIDER_ORDER`: 既定 `anthropic,brave,google`
- `SHANNON_TOOL_CONCURRENCY`: 読み取り専用ツールの同時実行数。既定4、最大8

Google CSEは移行期間の最終フォールバックに限定する。2027年1月1日より前に本番環境へ`ANTHROPIC_API_KEY`と`BRAVE_SEARCH_API_KEY`を設定し、`WEB_SEARCH_PROVIDER_ORDER=anthropic,brave`へ切り替えてもツール名やプロンプトを変更せず運用できる。

Google Cloud側では、キーを置くだけでなく同じ請求先プロジェクトで `Places API (New)`、`Routes API`、`Maps Static API` を有効化する。キー制限にはこの3 APIと実行元を明示し、無制限キーは使わない。

確認用の依頼例:

> 友人3人で浜松へ日帰り旅行したい。まだ日付・予算・移動手段は決めていない。必要なことを確認して、公式情報と正確な移動ルートを調べ、雨の日の代案も含む見やすいPDFを作って送って。

合格条件:

- 依頼への通常返信ができる
- 選択肢と自由入力を含む確認フォームが1枚だけ表示される
- 別ユーザーは回答できず、依頼者の回答後に自動再開する
- 作業中の進捗は1枚だけ更新され、詳細ボタンはエフェメラル表示、完了時に片付く
- PDF・プレビュー画像の2ファイルが同じDiscordメッセージに付く（HTMLは付かない）
- PDFが開き、日本語の欠落・文字化け・重なりがない
- ルート地図がある場合は経路線が読み取れる
- 参照URLが資料内にあり、調査していないURLを捏造しない
- 添付に失敗した場合もプロセスが落ちず、テキストで失敗を通知する
