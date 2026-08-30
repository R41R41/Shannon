/**
 * EventPayloadMap: Maps each EventType to its specific payload type.
 *
 * This enables type-safe EventBus.subscribe() and EventBus.publish()
 * so that event.data is automatically narrowed based on the event name.
 */
import { ILog, MemoryZone, ServiceInput, ServiceOutput, StatusAgentInput } from './common.js';
import {
  DiscordClientInput,
  DiscordGetServerEmojiInput,
  DiscordGetServerEmojiOutput,
  DiscordPlanningInput,
  DiscordScheduledPostInput,
  DiscordSendServerEmojiInput,
  DiscordSendServerEmojiOutput,
  DiscordSendTextMessageInput,
  DiscordSendTextMessageOutput,
} from './discord.js';
import { SkillInfo } from './llm.js';
import {
  MinebotInput,
  MinebotOutput,
  MinebotVoiceChatInput,
  MinebotVoiceResponseOutput,
  SkillParameters,
  SkillResult,
} from './minebot.js';
import { MinecraftInput, MinecraftServerName } from './minecraft.js';
import { NotionClientInput, NotionClientOutput } from './notion.js';
import { SchedulerInput, SchedulerOutput } from './scheduler.js';
import { TaskInput, TaskTreeState } from './taskGraph.js';
import {
  MemberTweetInput,
  TwitterActionResult,
  TwitterAutoTweetInput,
  TwitterClientInput,
  TwitterClientOutput,
  TwitterQuoteRTOutput,
  TwitterReplyOutput,
} from './twitter.js';
import {
  OpenAIInput,
  OpenAIMessageOutput,
  WebSkillInput,
} from './web.js';
import {
  YoutubeClientInput,
  YoutubeClientOutput,
  YoutubeCommentOutput,
  YoutubeLiveChatInput,
  YoutubeLiveChatMessageInput,
  YoutubeLiveChatMessageOutput,
  YoutubeSubscriberUpdateOutput,
  YoutubeVideoInfoOutput,
  YoutubeVideoInput,
} from './youtube.js';

// ---------------------------------------------------------------------------
// EventPayloadMap: static event name → payload type
// ---------------------------------------------------------------------------
export interface EventPayloadMap {
  // === Discord ===
  'discord:start': ServiceInput;
  'discord:stop': ServiceInput;
  'discord:status': ServiceInput;
  'discord:post_message': DiscordSendTextMessageInput | DiscordClientInput;
  'discord:scheduled_post': DiscordScheduledPostInput;
  'discord:get_server_emoji': DiscordGetServerEmojiInput;
  'discord:send_server_emoji': DiscordSendServerEmojiInput;
  'discord:planning': DiscordPlanningInput;

  // === Twitter ===
  'twitter:status': ServiceInput;
  'twitter:start': ServiceInput;
  'twitter:stop': ServiceInput;
  'twitter:post_scheduled_message': TwitterClientInput;
  'twitter:post_message': TwitterClientInput;
  'twitter:post_quote_tweet': TwitterClientInput;
  'twitter:like_tweet': TwitterClientInput;
  'twitter:retweet_tweet': TwitterClientInput;
  'twitter:quote_retweet': TwitterClientInput;
  'twitter:check_replies': TwitterClientInput;
  'twitter:get_message': TwitterClientInput;
  'twitter:get_tweet_content': TwitterClientInput;

  // === YouTube ===
  'youtube:get_stats': YoutubeClientInput;
  'youtube:get_message': YoutubeClientInput;
  'youtube:post_message': YoutubeClientInput;
  'youtube:check_comments': YoutubeClientInput;
  'youtube:check_subscribers': YoutubeClientInput;
  'youtube:reply_comment': YoutubeVideoInput;
  'youtube:status': ServiceInput;
  'youtube:subscriber_update': YoutubeSubscriberUpdateOutput;
  'youtube:get_video_info': YoutubeVideoInput;
  'youtube:live_chat:status': YoutubeLiveChatInput;
  'youtube:live_chat:post_message': YoutubeLiveChatMessageInput;

  // === Minecraft (base events) ===
  'minecraft:status': MinecraftInput;
  'minecraft:start': MinecraftInput;
  'minecraft:stop': MinecraftInput;
  'minecraft:action': MinecraftInput;
  'minecraft:env_input': MinecraftInput;
  'minecraft:get_message': MinecraftInput;
  'minecraft:post_message': MinecraftInput;

  // === Web ===
  'web:post_message': OpenAIInput | OpenAIMessageOutput;
  'web:post_schedule': OpenAIInput | SchedulerOutput;
  'web:log': ILog;
  'web:planning': TaskTreeState;
  'web:status': StatusAgentInput | ServiceOutput;
  'web:skill': SkillInfo[] | WebSkillInput;

  // === LLM ===
  'llm:post_scheduled_message': TwitterClientInput;
  'llm:post_twitter_reply': TwitterReplyOutput;
  'llm:post_twitter_quote_rt': TwitterQuoteRTOutput;
  'llm:respond_member_tweet': MemberTweetInput;
  'llm:generate_auto_tweet': TwitterAutoTweetInput;
  'llm:reply_youtube_comment': YoutubeCommentOutput;
  'llm:get_discord_message': DiscordSendTextMessageOutput | DiscordClientInput;
  'llm:get_web_message': OpenAIInput | OpenAIMessageOutput;
  'llm:get_skills': SkillInfo[] | WebSkillInput;
  'llm:get_youtube_message': YoutubeLiveChatMessageOutput;

  // === Task ===
  'task:stop': TaskInput;
  'task:start': TaskInput;

  // === Scheduler ===
  'scheduler:call_schedule': SchedulerInput;
  'scheduler:get_schedule': SchedulerInput | SchedulerOutput;

  // === Notion ===
  'notion:status': ServiceInput;
  'notion:start': ServiceInput;
  'notion:stop': ServiceInput;
  'notion:getPageMarkdown': NotionClientInput;

  // === Tool response events (common patterns) ===
  'tool:get_tweet_content': TwitterClientOutput;
  'tool:like_tweet': TwitterActionResult;
  'tool:retweet_tweet': TwitterActionResult;
  'tool:quote_retweet': TwitterActionResult;
  'tool:getPageMarkdown': NotionClientOutput;
  'tool:get_video_info': YoutubeVideoInfoOutput | YoutubeClientOutput;
  'tool:get_server_emoji': DiscordGetServerEmojiOutput;
  'tool:send_server_emoji': DiscordSendServerEmojiOutput;
}

// ---------------------------------------------------------------------------
// EventData<T>: resolves payload type for a given EventType string
// ---------------------------------------------------------------------------
// For static event names, uses the map directly.
// For template-literal event names (minebot:*, tool:*, minecraft:*:*), uses fallbacks.
type FallbackEventData =
  | MinebotInput
  | MinebotOutput
  | SkillParameters
  | SkillResult
  | MinecraftInput
  | TwitterClientOutput
  | TwitterActionResult
  | NotionClientOutput
  | YoutubeVideoInfoOutput
  | DiscordGetServerEmojiOutput
  | DiscordSendServerEmojiOutput;

export type EventData<T extends string> = T extends keyof EventPayloadMap
  ? EventPayloadMap[T]
  : T extends `minecraft:${MinecraftServerName}:${string}`
    ? MinecraftInput | ServiceInput
    : T extends `minebot:${string}`
      ? MinebotInput | MinebotOutput | SkillParameters | SkillResult | MinebotVoiceChatInput | MinebotVoiceResponseOutput
      : T extends `tool:${string}`
        ? FallbackEventData
        : unknown;

// ---------------------------------------------------------------------------
// TypedEvent<T>: a fully-typed event object
// ---------------------------------------------------------------------------
export interface TypedEvent<T extends string = string> {
  type: T;
  memoryZone: MemoryZone;
  data: EventData<T>;
  targetMemoryZones?: MemoryZone[];
}
