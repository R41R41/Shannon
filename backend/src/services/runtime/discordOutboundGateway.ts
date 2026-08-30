import type {
  DiscordGetServerEmojiInput,
  DiscordPlanningInput,
  DiscordScheduledPostInput,
  DiscordSendServerEmojiInput,
  DiscordSendTextMessageInput,
  MemoryZone,
  YoutubeSubscriberUpdateOutput,
} from '@shannon/common';

export interface DiscordOutboundPort {
  postMessage(input: DiscordSendTextMessageInput): Promise<void>;
  postScheduledPost(memoryZone: MemoryZone, input: DiscordScheduledPostInput): Promise<void>;
  publishPlanning(input: DiscordPlanningInput): void;
  getServerEmoji(input: DiscordGetServerEmojiInput): Promise<unknown>;
  sendServerEmoji(input: DiscordSendServerEmojiInput): Promise<unknown>;
  announceSubscriberUpdate(input: YoutubeSubscriberUpdateOutput): Promise<void>;
}

let discordOutbound: DiscordOutboundPort | null = null;

export function registerDiscordOutboundPort(port: DiscordOutboundPort): void {
  if (discordOutbound) throw new Error('DiscordOutboundPort already registered');
  discordOutbound = port;
}

export function getDiscordOutboundPort(): DiscordOutboundPort {
  if (!discordOutbound) throw new Error('DiscordOutboundPort is not registered');
  return discordOutbound;
}

export function clearDiscordOutboundPort(): void {
  discordOutbound = null;
}
