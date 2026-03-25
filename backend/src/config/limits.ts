/**
 * Rate limits, timeouts, max iterations, and other numeric thresholds
 * used across the backend.
 *
 * NOTE: Consumers have NOT been updated to import from here yet.
 * This is a centralisation / documentation step only.
 */

// ---------------------------------------------------------------------------
// LLM agent iteration / tool-call limits
// ---------------------------------------------------------------------------

/** Maximum tool calls in a single auto-tweet generation run */
export const AUTO_TWEET_MAX_TOOL_CALLS = 12;

/** Maximum exploration iterations for auto-tweet agent */
export const AUTO_TWEET_MAX_EXPLORATION_ITERATIONS = 18;

/** Maximum review retries (shared across auto-tweet, news, about-today, fortune agents) */
export const MAX_REVIEW_RETRIES = 3;

/** Maximum generate retries for auto-tweet agent */
export const AUTO_TWEET_MAX_GENERATE_RETRIES = 3;

/** Maximum tool calls in postAboutToday agent */
export const ABOUT_TODAY_MAX_TOOL_CALLS = 8;

/** Maximum exploration iterations for postAboutToday agent */
export const ABOUT_TODAY_MAX_EXPLORATION_ITERATIONS = 15;

/** Maximum tool calls in postNews agent */
export const NEWS_MAX_TOOL_CALLS = 10;

/** Maximum exploration iterations for postNews agent */
export const NEWS_MAX_EXPLORATION_ITERATIONS = 15;

/** Maximum iterations for member tweet agent */
export const MEMBER_TWEET_MAX_ITERATIONS = 3;

/** Maximum iterations for the FunctionCallingAgent (graph node) */
export const FUNCTION_CALLING_MAX_ITERATIONS = 50;

// ---------------------------------------------------------------------------
// LLM timeouts
// ---------------------------------------------------------------------------

/** Single LLM call timeout (FunctionCallingAgent) */
export const LLM_TIMEOUT_MS = 30_000;

/** Total time budget for a FunctionCallingAgent run */
export const LLM_MAX_TOTAL_TIME_MS = 300_000;

// ---------------------------------------------------------------------------
// Memory / recall thresholds
// ---------------------------------------------------------------------------

/** Top-K results for semantic search in RecallEngine */
export const RECALL_SEMANTIC_TOP_K = 7;

/** Top-K results for semantic search in MemoryNode */
export const MEMORY_SEMANTIC_TOP_K = 5;

/** Random-N results mixed into semantic recall */
export const SEMANTIC_RANDOM_N = 2;

/** Token threshold above which conversation is summarised before recall */
export const SUMMARIZE_TOKEN_THRESHOLD = 1_000;

/** Average characters per token for Japanese text */
export const AVG_CHARS_PER_TOKEN_JA = 2;

// ---------------------------------------------------------------------------
// Recall ranking bonuses
// ---------------------------------------------------------------------------

export const SAME_USER_BONUS = 1.3;
export const SAME_CHANNEL_BONUS = 1.2;
export const SAME_WORLD_BONUS = 1.15;

// ---------------------------------------------------------------------------
// Retry / backoff defaults
// ---------------------------------------------------------------------------

/** Default max retries for retryWithBackoff */
export const RETRY_MAX_RETRIES = 3;

/** Default initial delay (ms) for retryWithBackoff */
export const RETRY_INITIAL_DELAY_MS = 2_000;

/** Default max delay (ms) for retryWithBackoff */
export const RETRY_MAX_DELAY_MS = 60_000;

// ---------------------------------------------------------------------------
// Minebot timeouts
// ---------------------------------------------------------------------------

/** Timeout for a single minebot skill invocation (MinebotDispatcher) */
export const MINEBOT_SKILL_TIMEOUT_MS = 30_000;

/** Timeout for minebot move-to skill */
export const MINEBOT_MOVE_TIMEOUT_MS = 30_000;

/** Default follow-entity duration */
export const MINEBOT_FOLLOW_DURATION_MS = 30_000;

/** Task history max age before cleanup */
export const MINEBOT_TASK_HISTORY_MAX_AGE_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Voicepeak
// ---------------------------------------------------------------------------

/** Voicepeak HTTP request timeout */
export const VOICEPEAK_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Minebot skill-result cache TTLs (ms)
// ---------------------------------------------------------------------------

export const SKILL_CACHE_TTL = {
  FIND_BLOCKS: 30_000,
  CHECK_RECIPE: 60_000,
  INVESTIGATE_TERRAIN: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Realtime API
// ---------------------------------------------------------------------------

/** Session refresh interval for OpenAI Realtime API (55 min) */
export const REALTIME_SESSION_REFRESH_MS = 55 * 60 * 1_000;

/** Max reconnect attempts for Realtime API WebSocket */
export const REALTIME_MAX_RECONNECT_ATTEMPTS = 5;

/** Base reconnect delay for Realtime API WebSocket */
export const REALTIME_RECONNECT_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Person memory
// ---------------------------------------------------------------------------

/** Timeout for person memory operations */
export const PERSON_MEMORY_TIMEOUT_MS = 300_000;
