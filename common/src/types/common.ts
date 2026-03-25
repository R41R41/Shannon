import {
  DiscordClientInput,
  DiscordClientOutput,
  DiscordEventType,
  DiscordGuild,
  DiscordVoiceEnqueueInput,
  DiscordVoiceFillerInput,
  DiscordVoiceMessageOutput,
  DiscordVoiceQueueEndInput,
  DiscordVoiceQueueStartInput,
  DiscordVoiceResponseInput,
  DiscordVoiceStatusInput,
} from './discord.js';
import { LLMEventType, SkillInfo } from './llm.js';
import {
  MinebotEventType,
  MinebotInput,
  MinebotOutput,
  MinebotVoiceChatInput,
  MinebotVoiceResponseOutput,
  SkillParameters,
  SkillResult,
} from './minebot.js';
import {
  MinecraftEventType,
  MinecraftInput,
  MinecraftOutput,
} from './minecraft.js';
import {
  NotionClientInput,
  NotionClientOutput,
  NotionEventType,
} from './notion.js';
import {
  SchedulerEventType,
  SchedulerInput,
  SchedulerOutput,
} from './scheduler.js';
import {
  EmotionType,
  TaskEventType,
  TaskInput,
  TaskTreeState,
} from './taskGraph.js';
import { ToolEventType } from './tools.js';
import {
  MemberTweetInput,
  TwitterClientInput,
  TwitterClientOutput,
  TwitterEventType,
  TwitterSchedulePostEndpoint,
} from './twitter.js';
import {
  OpenAIInput,
  OpenAIMessageOutput,
  WebEventType,
  WebSkillInput,
} from './web.js';
import { YoutubeClientOutput, YoutubeEventType } from './youtube.js';

export type Platform =
  | 'web'
  | 'discord'
  | 'minecraft'
  | 'scheduler'
  | 'twitter'
  | 'youtube'
  | 'notion'
  | 'minebot'
  | 'youtube:live_chat';

/**
 * タスク実行のコンテキスト情報
 * Platformに加えて、より詳細な情報を保持
 */
export interface TaskContext {
  /** プラットフォーム（メッセージの入出力先） */
  platform: Platform;

  /** Discord固有の情報 */
  discord?: {
    guildId?: string;
    guildName?: string;
    channelId?: string;
    channelName?: string;
    messageId?: string;
    userId?: string;
    userName?: string;
  };

  /** Twitter固有の情報 */
  twitter?: {
    tweetId?: string;
    authorId?: string;
    authorName?: string;
  };

  /** YouTube固有の情報 */
  youtube?: {
    videoId?: string;
    channelId?: string;
    commentId?: string;
    liveId?: string;
  };

  /** 会話追跡用 */
  conversationId?: string;

  /** 追加のメタデータ */
  metadata?: Record<string, unknown>;
}

/**
 * MemoryZone から TaskContext への変換ヘルパー
 * @deprecated Since v1.5. Use TaskContext directly. Will be removed in v2.0.
 */
export function memoryZoneToContext(memoryZone: MemoryZone, channelId?: string): TaskContext {
  if (memoryZone === 'web') {
    return { platform: 'web' };
  }
  if (memoryZone.startsWith('discord:')) {
    return {
      platform: 'discord',
      discord: {
        guildName: memoryZone.replace('discord:', ''),
        channelId,
      },
    };
  }
  if (memoryZone.startsWith('twitter:')) {
    return { platform: 'twitter' };
  }
  if (memoryZone === 'youtube') {
    return { platform: 'youtube' };
  }
  if (memoryZone === 'minecraft' || memoryZone === 'minebot') {
    return { platform: memoryZone as Platform };
  }
  if (memoryZone === 'notion') {
    return { platform: 'notion' };
  }
  return { platform: 'web' };
}

/**
 * TaskContext から MemoryZone への変換ヘルパー
 * @deprecated Since v1.5. Use TaskContext directly. Will be removed in v2.0.
 */
export function contextToMemoryZone(context: TaskContext): MemoryZone {
  if (context.platform === 'discord' && context.discord?.guildName) {
    return `discord:${context.discord.guildName}` as MemoryZone;
  }
  if (context.platform === 'twitter') {
    return 'twitter:post';
  }
  return context.platform as MemoryZone;
}

export type ConversationType =
  | 'text'
  | 'audio'
  | 'realtime_text'
  | 'realtime_audio'
  | 'command'
  | 'log'
  | 'user_transcript';

export const promptTypes: PromptType[] = [
  'base_text',
  'base_voice',
  'about_today',
  'news_today',
  'weather_to_emoji',
  'fortune',
  'discord',
  'forecast',
  'forecast_for_toyama_server',
  'reply_twitter_comment',
  'emotion',
  'use_tool',
];

export type PromptType =
  | TwitterSchedulePostEndpoint
  | 'base_text'
  | 'base_voice'
  | 'discord'
  | 'minecraft'
  | 'weather_to_emoji'
  | 'forecast_for_toyama_server'
  | 'reply_youtube_comment'
  | 'planning'
  | 'reply_twitter_comment'
  | 'quote_twitter_comment'
  | 'emotion'
  | 'use_tool'
  | 'reply_youtube_live_comment'
  | 'emergency'
  | 'auto_tweet'
  | 'auto_tweet_explore'
  | 'auto_tweet_review'
  | 'respond_member_tweet'
  | 'about_today_review'
  | 'news_today_review'
  | 'fortune_review'
  | 'extract_person_traits'
  | 'extract_memories';

export type RealTimeAPIEndpoint =
  | 'realtime_text_input'
  | 'realtime_text_commit'
  | 'realtime_audio_append'
  | 'realtime_audio_commit'
  | 'realtime_vad_on'
  | 'realtime_vad_off'
  | 'text_done'
  | 'audio_done';

export type ServiceStatus = 'running' | 'stopped' | 'connecting';

export type ServiceCommand = 'start' | 'stop' | 'status';

export interface ServiceInput {
  serviceCommand?: ServiceCommand | null;
  serverName?: string | null;
}

export interface ServiceOutput {
  status?: ServiceStatus | null;
}

export interface StatusAgentInput extends ServiceInput {
  service: Platform;
  status: ServiceStatus;
}

export type MemoryZone =
  | 'web'
  | DiscordGuild
  | 'twitter:schedule_post'
  | 'twitter:post'
  | 'twitter:get'
  | 'minecraft'
  | 'youtube'
  | 'scheduler'
  | 'minebot'
  | 'null'
  | 'notion';

export type EventType =
  | TaskEventType
  | TwitterEventType
  | YoutubeEventType
  | MinecraftEventType
  | DiscordEventType
  | LLMEventType
  | WebEventType
  | SchedulerEventType
  | MinebotEventType
  | ToolEventType
  | NotionEventType;

export interface Event {
  type: EventType;
  memoryZone: MemoryZone;
  data:
  | TwitterClientInput
  | TwitterClientOutput
  | OpenAIInput
  | DiscordClientInput
  | ILog
  | OpenAIMessageOutput
  | DiscordClientOutput
  | MinecraftInput
  | MinecraftOutput
  | SchedulerInput
  | SchedulerOutput
  | StatusAgentInput
  | ServiceInput
  | YoutubeClientOutput
  | MinebotOutput
  | MinebotInput
  | ServiceOutput
  | TaskInput
  | TaskTreeState
  | EmotionType
  | SkillInfo[]
  | WebSkillInput
  | SkillParameters
  | SkillResult
  | NotionClientInput
  | NotionClientOutput
  | MemberTweetInput
  | DiscordVoiceMessageOutput
  | DiscordVoiceResponseInput
  | DiscordVoiceFillerInput
  | DiscordVoiceQueueStartInput
  | DiscordVoiceEnqueueInput
  | DiscordVoiceQueueEndInput
  | DiscordVoiceStatusInput
  | MinebotVoiceChatInput
  | MinebotVoiceResponseOutput;
  targetMemoryZones?: MemoryZone[];
}

export interface ILog {
  timestamp: Date;
  memoryZone: MemoryZone;
  color: Color;
  content: string;
}

export type Color =
  | 'white'
  | 'red'
  | 'green'
  | 'blue'
  | 'yellow'
  | 'magenta'
  | 'cyan';

export interface LogEntry {
  timestamp: string;
  memoryZone: string;
  color: Color;
  content: string;
}
