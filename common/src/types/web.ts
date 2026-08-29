import {
  ConversationType,
  RealTimeAPIEndpoint,
  ServiceStatus,
  ILog,
} from "./common";
import { MinecraftServerName } from "./minecraft";
import { Schedule } from "./scheduler";
import { BaseMessage } from "@langchain/core/messages";

export interface OpenAITextInput {
  type: ConversationType | "ping";
  text: string;
  senderName: string;
  recentChatLog: BaseMessage[] | null;
}

export interface OpenAICommandInput {
  type: ConversationType | "ping";
  command: RealTimeAPIEndpoint;
}

export interface OpenAIRealTimeTextInput {
  type: ConversationType | "ping";
  realtime_text: string;
  command?: RealTimeAPIEndpoint | null;
}

export interface OpenAIRealTimeAudioInput {
  type: ConversationType | "ping";
  realtime_audio: string;
  command?: RealTimeAPIEndpoint | null;
}
export type OpenAIInput =
  | OpenAITextInput
  | OpenAIRealTimeTextInput
  | OpenAIRealTimeAudioInput
  | OpenAICommandInput;

export interface OpenAIMessageOutput {
  type: ConversationType | "pong";
  text?: string | null;
  realtime_text?: string | null;
  realtime_audio?: string | null;
  command?: RealTimeAPIEndpoint | null;
  senderName?: string | null;
}

export type WebScheduleInputType = "get_schedule" | "call_schedule";

export interface WebScheduleInput {
  type: WebScheduleInputType | "ping";
  name?: string | null;
}

export type WebScheduleOutputType = "post_schedule" | "call_schedule";

export interface WebScheduleOutput {
  type: WebScheduleOutputType | "pong";
  data?: Schedule[];
}

export type StatusAgentOutputType = "service:status" | "service:command";

export interface StatusAgentOutput {
  type: StatusAgentOutputType | "pong";
  service:
    | "twitter"
    | "discord"
    | "minecraft"
    | `minecraft:${MinecraftServerName}`;
  data: ServiceStatus;
}

export interface SearchQuery {
  startDate?: string;
  endDate?: string;
  memoryZone?: string;
  content?: string;
}

export type WebMonitoringInputType = "search" | "ping";

export interface WebMonitoringInput {
  type: WebMonitoringInputType;
  query?: SearchQuery | null;
}

export type WebMonitoringOutputType = "web:log" | "web:searchResults";

export interface WebMonitoringOutput {
  type: WebMonitoringOutputType | "pong";
  data?: ILog | ILog[];
}

export type WebSkillInputType = "get_skills" | "ping";

export interface WebSkillInput {
  type: WebSkillInputType;
}

export type WebEventType =
  | "web:post_message"
  | "web:post_schedule"
  | "web:log"
  | "web:planning"
  | "web:status"
  | "web:skill";

export interface UserInfo {
  name: string;
  email: string;
  isAdmin: boolean;
}
