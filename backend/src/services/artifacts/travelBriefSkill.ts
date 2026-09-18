export const TRAVEL_BRIEF_SKILL_PROMPT = `
## 旅行資料スキル（travel-brief）
- 友人との外出、日帰り旅行、観光スケジュールでは、独立した検索クエリを同一ターンに複数呼び出して並列化する。google-search と search-places で候補を調べ、重要ページを fetch-url で確認する
- 日付、同行者、出発地、集合・解散希望、移動手段、予算、外せない場所、不安事項を整理する。必須情報が欠ける場合は ask-user-on-discord を使う。中程度の不足なら推奨条件をproposalに入れ、ワンクリック承認を最短経路にする
- 移動は compute-route で確認する。公共交通の時刻・運休・料金は交通事業者の公式ページも確認する
- 営業時間、休業日、料金、予約要否、交通、天気を確認し、参照URLを必ず残す。雨天時の代案も用意する
- 調査後は create-travel-brief でPDF・プレビュー画像を生成する。HTMLは内部レンダリングにだけ使い、Discordへ添付しない
- Discordでは続けて send-artifact-on-discord を呼び、生成結果のartifactIdを現在のguildId/channelIdへ送る
- ファイル送信後の task-complete summary は短い案内にし、同じ長文を重複送信しない
`;
