import { BaseMessage } from "@langchain/core/messages";
import { ServiceInput, ServiceOutput } from "./common.js";
import { TaskTreeState } from "./taskGraph.js";
import { TwitterSchedulePostEndpoint } from "./twitter.js";
export type DiscordGuild =
  | "discord:toyama_server"
  | "discord:douki_server"
  | "discord:aiminelab_server"
  | "discord:test_server"
  | "discord:colab_server";

export interface DiscordGetServerEmojiInput extends ServiceInput {
  guildId: string;
}

export interface DiscordSendServerEmojiInput extends ServiceInput {
  guildId: string;
  channelId: string;
  messageId: string;
  emojiId: string;
}

export interface DiscordSendTextMessageInput extends ServiceInput {
  channelId: string;
  guildId: string;
  text: string;
  imageUrl: string;
  /**
   * Server-owned generated artifacts. The Discord client resolves these IDs
   * through ArtifactStore; callers cannot attach arbitrary filesystem paths.
   */
  artifactIds?: string[];
}

export interface DiscordScheduledPostInput extends ServiceInput {
  command: TwitterSchedulePostEndpoint;
  text: string;
  imageBuffer?: Buffer;
}

export interface DiscordPlanningInput extends ServiceInput {
  planning: TaskTreeState;
  channelId: string;
  taskId: string;
}

export type DiscordClarificationQuestionKind =
  | "single_select"
  | "multi_select"
  | "number"
  | "text"
  | "confirm";

export interface DiscordClarificationQuestion {
  id: string;
  label: string;
  kind: DiscordClarificationQuestionKind;
  description?: string;
  required?: boolean;
  options?: string[];
  defaultValue?: string;
}

export interface DiscordClarificationInput extends ServiceInput {
  clarificationId: string;
  taskId: string;
  guildId: string;
  channelId: string;
  requesterUserId: string;
  requesterUserName?: string;
  originalRequest: string;
  proposal?: string;
  questions: DiscordClarificationQuestion[];
  expiresAt: string;
}

export type DiscordClientInput =
  | DiscordGetServerEmojiInput
  | DiscordSendServerEmojiInput
  | DiscordSendTextMessageInput
  | DiscordScheduledPostInput
  | DiscordPlanningInput
  | DiscordClarificationInput;

export interface DiscordGetServerEmojiOutput extends ServiceOutput {
  emojis: string[];
}

export interface DiscordSendServerEmojiOutput extends ServiceOutput {
  isSuccess: boolean;
  errorMessage: string;
}

export interface DiscordSendTextMessageOutput extends ServiceOutput {
  type: "text";
  guildName: string;
  channelName: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  userName: string;
  text: string;
  recentMessages: BaseMessage[];
}

export type DiscordClientOutput =
  | DiscordGetServerEmojiOutput
  | DiscordSendTextMessageOutput
  | DiscordSendServerEmojiOutput;

export interface DiscordVoiceMessageOutput extends ServiceOutput {
  type: "voice";
  guildName: string;
  channelName: string;
  guildId: string;
  channelId: string;
  voiceChannelId: string;
  userId: string;
  userName: string;
  text: string;
  recentMessages: BaseMessage[];
}

export interface DiscordVoiceResponseInput extends ServiceInput {
  channelId: string;
  voiceChannelId: string;
  guildId: string;
  text: string;
  audioBuffer: Buffer;
  /** When set, play these buffers sequentially instead of audioBuffer */
  audioBuffers?: Buffer[];
}

export interface DiscordVoiceFillerInput extends ServiceInput {
  guildId: string;
  audioBuffers: Buffer[];
}

export interface DiscordVoiceQueueStartInput extends ServiceInput {
  guildId: string;
  channelId: string;
}

export interface DiscordVoiceEnqueueInput extends ServiceInput {
  guildId: string;
  audioBuffer: Buffer;
}

export interface DiscordVoiceQueueEndInput extends ServiceInput {
  guildId: string;
  channelId: string;
  text: string;
}

export interface DiscordVoiceStreamTextInput extends ServiceInput {
  guildId: string;
  channelId: string;
  sentence: string;
}

export type VoiceStatus =
  | "listening"
  | "stt"
  | "filler_select"
  | "llm"
  | "tts"
  | "speaking"
  | "idle";

export interface DiscordVoiceStatusInput extends ServiceInput {
  guildId: string;
  status: VoiceStatus;
  detail?: string;
}

export type DiscordEventType =
  | "discord:start"
  | "discord:stop"
  | "discord:status"
  | "discord:post_message"
  | "discord:scheduled_post"
  | "discord:get_server_emoji"
  | "discord:send_server_emoji"
  | "discord:planning"
  | "discord:request_clarification"
  | "discord:post_voice_response"
  | "discord:play_voice_filler"
  | "discord:voice_queue_start"
  | "discord:voice_enqueue"
  | "discord:voice_queue_end"
  | "discord:voice_stream_text"
  | "discord:voice_status";
