/**
 * Centralized event type constants.
 *
 * This file documents every event type string used with eventBus.publish()
 * and eventBus.subscribe() across the backend codebase.
 *
 * NOTE: Consumers have NOT been updated to use these constants yet.
 * This is a documentation / reference step only.
 */

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
export const DISCORD_EVENTS = {
  /** Send a text/image message to a Discord channel */
  POST_MESSAGE: 'discord:post_message',
  /** Post a scheduled message (auto-tweet cross-post, etc.) */
  SCHEDULED_POST: 'discord:scheduled_post',
  /** Query service status */
  STATUS: 'discord:status',
  /** Retrieve server emoji list */
  GET_SERVER_EMOJI: 'discord:get_server_emoji',
  /** React with a server emoji */
  SEND_SERVER_EMOJI: 'discord:send_server_emoji',
  /** Push planning / task-tree update to Discord */
  PLANNING: 'discord:planning',
  /** Voice: start queuing audio chunks */
  VOICE_QUEUE_START: 'discord:voice_queue_start',
  /** Voice: enqueue a single audio chunk */
  VOICE_ENQUEUE: 'discord:voice_enqueue',
  /** Voice: signal end of audio queue */
  VOICE_QUEUE_END: 'discord:voice_queue_end',
  /** Voice: stream partial text for live captions */
  VOICE_STREAM_TEXT: 'discord:voice_stream_text',
  /** Voice: status query/update */
  VOICE_STATUS: 'discord:voice_status',
  /** Voice: play filler audio while LLM processes */
  PLAY_VOICE_FILLER: 'discord:play_voice_filler',
  /** Voice: post final voice response */
  POST_VOICE_RESPONSE: 'discord:post_voice_response',
} as const;

// ---------------------------------------------------------------------------
// Twitter / X
// ---------------------------------------------------------------------------
export const TWITTER_EVENTS = {
  /** Query service status */
  STATUS: 'twitter:status',
  /** Post a scheduled tweet */
  POST_SCHEDULED_MESSAGE: 'twitter:post_scheduled_message',
  /** Post a regular tweet */
  POST_MESSAGE: 'twitter:post_message',
  /** Fetch tweet content by URL/ID */
  GET_TWEET_CONTENT: 'twitter:get_tweet_content',
  /** Like a tweet */
  LIKE_TWEET: 'twitter:like_tweet',
  /** Retweet */
  RETWEET_TWEET: 'twitter:retweet_tweet',
  /** Quote retweet */
  QUOTE_RETWEET: 'twitter:quote_retweet',
} as const;

// ---------------------------------------------------------------------------
// LLM / Routing
// ---------------------------------------------------------------------------
export const LLM_EVENTS = {
  /** Incoming web chat message for LLM processing */
  GET_WEB_MESSAGE: 'llm:get_web_message',
  /** Incoming Discord message for LLM processing */
  GET_DISCORD_MESSAGE: 'llm:get_discord_message',
  /** Incoming YouTube live chat message for LLM processing */
  GET_YOUTUBE_MESSAGE: 'llm:get_youtube_message',
  /** Post a scheduled message via LLM pipeline */
  POST_SCHEDULED_MESSAGE: 'llm:post_scheduled_message',
  /** Reply to a tweet via LLM pipeline */
  POST_TWITTER_REPLY: 'llm:post_twitter_reply',
  /** Quote-RT a tweet via LLM pipeline */
  POST_TWITTER_QUOTE_RT: 'llm:post_twitter_quote_rt',
  /** Respond to a member's tweet */
  RESPOND_MEMBER_TWEET: 'llm:respond_member_tweet',
  /** Generate an auto-tweet */
  GENERATE_AUTO_TWEET: 'llm:generate_auto_tweet',
  /** Reply to a YouTube comment */
  REPLY_YOUTUBE_COMMENT: 'llm:reply_youtube_comment',
  /** Get registered skills */
  GET_SKILLS: 'llm:get_skills',
} as const;

// ---------------------------------------------------------------------------
// Minebot (Minecraft bot)
// ---------------------------------------------------------------------------
export const MINEBOT_EVENTS = {
  /** Query service status */
  STATUS: 'minebot:status',
  /** Query specific bot status */
  BOT_STATUS: 'minebot:bot:status',
  /** Bot has spawned in-game */
  SPAWNED: 'minebot:spawned',
  /** Bot error */
  ERROR: 'minebot:error',
  /** Bot stopped */
  STOPPED: 'minebot:stopped',
  /** Incoming chat for minebot processing */
  CHAT: 'minebot:chat',
  /** Incoming voice chat for minebot */
  VOICE_CHAT: 'minebot:voice_chat',
  /** Voice response from minebot to LLM */
  VOICE_RESPONSE: 'minebot:voice_response',
  /** Load / reload skills */
  LOAD_SKILLS: 'minebot:loadSkills',
  /** Stop a running instant skill */
  STOP_INSTANT_SKILL: 'minebot:stopInstantSkill',
  /** Get list of available instant skills */
  GET_INSTANT_SKILLS: 'minebot:getInstantSkills',
  // NOTE: individual skill events are dynamic: `minebot:${skill.skillName}`
  //       e.g. 'minebot:move-to', 'minebot:mine-block', etc.
} as const;

// ---------------------------------------------------------------------------
// Minecraft (vanilla server)
// ---------------------------------------------------------------------------
export const MINECRAFT_EVENTS = {
  /** Query Minecraft server status */
  STATUS: 'minecraft:status',
} as const;

// ---------------------------------------------------------------------------
// Web (dashboard / WebSocket agents)
// ---------------------------------------------------------------------------
export const WEB_EVENTS = {
  /** Post a message to web dashboard */
  POST_MESSAGE: 'web:post_message',
  /** Push service status update to web */
  STATUS: 'web:status',
  /** Push log entry to web monitoring */
  LOG: 'web:log',
  /** Push emotion update to web */
  EMOTION: 'web:emotion',
  /** Push planning / task-tree to web */
  PLANNING: 'web:planning',
  /** Push skill info to web */
  SKILL: 'web:skill',
  /** Push search results to web */
  SEARCH_RESULTS: 'web:searchResults',
  /** Push schedule info to web */
  POST_SCHEDULE: 'web:post_schedule',
} as const;

// ---------------------------------------------------------------------------
// Tool result events (request/response pairs for LLM tools)
// ---------------------------------------------------------------------------
export const TOOL_EVENTS = {
  /** Result of a tweet post */
  POST_TWEET_RESULT: 'tool:post_tweet_result',
  /** Result of tweet content fetch */
  GET_TWEET_CONTENT: 'tool:get_tweet_content',
  /** Result of like tweet */
  LIKE_TWEET: 'tool:like_tweet',
  /** Result of retweet */
  RETWEET_TWEET: 'tool:retweet_tweet',
  /** Result of quote retweet */
  QUOTE_RETWEET: 'tool:quote_retweet',
  /** Result of get server emoji */
  GET_SERVER_EMOJI: 'tool:get_server_emoji',
  /** Result of send server emoji */
  SEND_SERVER_EMOJI: 'tool:send_server_emoji',
  /** Result of get video info */
  GET_VIDEO_INFO: 'tool:get_video_info',
  /** Result of get Notion page markdown */
  GET_PAGE_MARKDOWN: 'tool:getPageMarkdown',
} as const;

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------
export const YOUTUBE_EVENTS = {
  /** Query service status */
  STATUS: 'youtube:status',
  /** Check for unreplied comments */
  CHECK_COMMENTS: 'youtube:check_comments',
  /** Check subscriber count */
  CHECK_SUBSCRIBERS: 'youtube:check_subscribers',
  /** Reply to a comment */
  REPLY_COMMENT: 'youtube:reply_comment',
  /** Get video info by ID */
  GET_VIDEO_INFO: 'youtube:get_video_info',
  /** Subscriber count update notification */
  SUBSCRIBER_UPDATE: 'youtube:subscriber_update',
  /** Live chat service status */
  LIVE_CHAT_STATUS: 'youtube:live_chat:status',
  /** Post a message to live chat */
  LIVE_CHAT_POST_MESSAGE: 'youtube:live_chat:post_message',
} as const;

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
export const SCHEDULER_EVENTS = {
  /** Get a schedule by name */
  GET_SCHEDULE: 'scheduler:get_schedule',
  /** Trigger a scheduled action */
  CALL_SCHEDULE: 'scheduler:call_schedule',
} as const;

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------
export const NOTION_EVENTS = {
  /** Query service status */
  STATUS: 'notion:status',
  /** Retrieve page content as markdown */
  GET_PAGE_MARKDOWN: 'notion:getPageMarkdown',
} as const;

// ---------------------------------------------------------------------------
// Service status (generic)
// ---------------------------------------------------------------------------
export const SERVICE_EVENTS = {
  /** Generic service status query */
  STATUS: 'service:status',
} as const;

// ---------------------------------------------------------------------------
// Auth (web dashboard auth)
// ---------------------------------------------------------------------------
export const AUTH_EVENTS = {
  /** Initial auth response */
  INIT_RESPONSE: 'auth:init_response',
  /** Auth response */
  RESPONSE: 'auth:response',
} as const;
