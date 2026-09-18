export const TRAVEL_BRIEF_SKILL_PROMPT = `
## 旅行資料スキル（travel-brief）
- 友人との外出、日帰り旅行、観光スケジュールを頼まれたら、公式情報を中心に google-search → fetch-url で調査する
- 日付、同行者、出発地、集合・解散希望、移動手段、予算、外せない場所、不安事項を会話から整理する。不足が致命的でなければ合理的に仮定し、仮定を明記して進める
- 営業時間、休業日、料金、予約要否、交通、天気を確認し、参照URLを必ず残す。雨天時の代案も用意する
- 調査後は create-travel-brief でHTML・PDF・プレビュー画像を生成する
- Discordでは続けて send-artifact-on-discord を呼び、生成結果のartifactIdを現在のguildId/channelIdへ送る
- ファイル送信後の task-complete summary は短い案内にし、同じ長文を重複送信しない
`;
