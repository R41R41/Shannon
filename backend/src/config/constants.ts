/**
 * Domain constants — social media accounts, search queries, and other
 * business-logic values that are referenced from multiple places or are
 * likely to change independently of the code.
 *
 * NOTE: Consumers have NOT been updated to import from here yet.
 * This is a centralisation / documentation step only.
 */

// ---------------------------------------------------------------------------
// Twitter / Auto-tweet
// ---------------------------------------------------------------------------

/** Large accounts monitored for auto-tweet exploration */
export const BIG_ACCOUNTS = [
  'sama',
  'elonmusk',
  'GoogleDeepMind',
  'OpenAI',
  'AnthropicAI',
  'xaborsa',
  'nvidia',
  'Shizuku_AItuber',
  'cumulo_autumn',
] as const;

/** Genre-based Twitter search queries for auto-tweet topic discovery */
export const GENRE_SEARCH_QUERIES = [
  { genre: 'AI・テクノロジー', query: '"AI" OR "LLM" OR "ChatGPT" OR "GPT" min_faves:100 lang:ja' },
  { genre: 'ゲーム', query: '"Minecraft" OR "マイクラ" OR "Nintendo" OR "ゲーム" min_faves:100 lang:ja' },
  { genre: 'アニメ・漫画', query: '"アニメ" OR "漫画" OR "今期アニメ" min_faves:200 lang:ja' },
  { genre: '食・グルメ', query: '"マクドナルド" OR "新商品" OR "期間限定" min_faves:100 lang:ja filter:media' },
  { genre: '音楽', query: '"新曲" OR "MV" OR "ライブ" min_faves:150 lang:ja' },
  { genre: 'VTuber', query: '"VTuber" OR "ホロライブ" OR "にじさんじ" OR "配信" min_faves:100 lang:ja' },
  { genre: '科学・宇宙', query: '"科学" OR "宇宙" OR "NASA" OR "研究" min_faves:100 lang:ja' },
  { genre: 'スポーツ', query: '"サッカー" OR "野球" OR "大谷" OR "オリンピック" min_faves:200 lang:ja' },
] as const;

// ---------------------------------------------------------------------------
// Twitter API
// ---------------------------------------------------------------------------

export const TWITTER_API_BASE = 'https://api.twitterapi.io' as const;
