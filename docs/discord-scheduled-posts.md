# Discord定時投稿の生成・障害調査

## 現行経路

既存の `saves/schedule.json` → Scheduler → LLM inbound → EventRouter → AgentOrchestrator → 投稿生成・画像生成 → Discord outbound。配信のPromiseはSchedulerまで返し、完了と例外を観測する。時刻・宛先・投稿内容の種類は変更しない。

ニュースと「今日は何の日」の探索は共有FCA核を使う。検索回数、総ツール回数、モデルターン数、経過時間の上限に近づいたら、収集済みの履歴を保持したまま検索ツールを外し、`submit_post`だけへ移る。総呼出し枠と最終ターンを提出・書式修正用に予約する。明示設定されたscheduled-postモデルだけが、単一のsubmitツール時にtool choiceを強制する。他のFCA呼出しには適用しない。未知ツールは引き続き拒否する。

本文上限はプロンプトの300〜500文字と整合する500文字。審査、鮮度・メタ文ガード、画像プロンプト、画像生成を維持する。NGトピックで不合格なら、再試行は別の条件を満たす題材を選ぶ。

## 2026-09-29の原因と証拠

- 9月28日22時のニュース生成は通常3試行＋フォールバックの全てが `SCHEDULED_POST_TOOL_BUDGET` で中断した。上限例外が探索履歴を破棄し、次の試行が同じ探索を始めていた。
- 本番版の非配信プローブで検索APIは成功し、検索を8回続けてから提出する実行を観測した。上限内に確実に提出する制御が不足していた。
- コードの本文上限400文字と、生成・審査プロンプトの300〜500文字が矛盾していた。
- 非同期配信のPromiseがEventRouter／inboundで捨てられ、Schedulerのcatchへ配信失敗が届かないことをコードと回帰試験で確認した。
- 修正候補はオフライン81ファイル／1,191件に合格。common build、backendのnoCheck変換、修正生成処理のstrict型検査、foundation境界検査に合格。backend全体のstrict検査合格を意味しない。
- 実API・非配信プローブ: news 18.7秒／392文字、about_today 11.8秒／375文字。どちらも1試行・審査合格・画像プロンプトあり・fallbackなし・検索予算例外0。これは画像生成やDiscordへの実投稿の証拠ではない。

## 安全な確認

オフライン検証はダミーのOpenAI/Mongo設定で行い、通常DB・Botを起動しない。配備候補はaccepted sourceと今回の修正だけから作り、無関係なdev変更を含めない。依存は現行releaseのrootおよびbackend workspaceの両方を揃える。Viteの検証cacheを本物のnode_modulesと取り違えない。current経由の依存リンクはrelease切替で循環するため、安定した実ディレクトリへ解決する。

実モデル・検索を使う確認は明示的に `node scripts/probe-scheduled-post-generation.mjs --live` を実行する（API課金あり）。ビルド済みbackendと意図して供給した秘密設定が必要。本文・検索語・秘密値は出力せず、成功、文字数、画像プロンプト有無、試行数、上限例外数のみを出す。Discord／Xへ投稿せず、全体Botを起動しない。

本番切替前に旧release、現在のsource、秘密設定、mutable savesを確認・保全し、配備後はサービス状態、Discord接続、healthを確認する。検証目的で既存チャンネルへ余分な投稿をしない。次の定時枠の実配信は、非配信の生成試験と区別して記録する。
