import type {
  DiscordVoiceEnqueueInput,
  DiscordVoiceFillerInput,
  DiscordVoiceQueueEndInput,
  DiscordVoiceQueueStartInput,
  DiscordVoiceStatusInput,
  DiscordVoiceStreamTextInput,
  MinebotVoiceChatInput,
} from '@shannon/common';

export interface VoiceGateway {
  publishStatus(input: DiscordVoiceStatusInput): void;
  postTranscript(channelId: string, guildId: string, text: string): void;
  startQueue(input: DiscordVoiceQueueStartInput): void;
  enqueueAudio(input: DiscordVoiceEnqueueInput): void;
  endQueue(input: DiscordVoiceQueueEndInput): void;
  streamSentence(input: DiscordVoiceStreamTextInput): void;
  playFiller(input: DiscordVoiceFillerInput): void;
  routeToMinebotVoice(input: MinebotVoiceChatInput): void;
  waitForTextReply(channelId: string, excludeMicPrefix?: boolean): Promise<string>;
}

let voiceGateway: VoiceGateway | null = null;

export function registerVoiceGateway(gateway: VoiceGateway): void {
  if (voiceGateway) throw new Error('VoiceGateway already registered');
  voiceGateway = gateway;
}

export function getVoiceGateway(): VoiceGateway {
  if (!voiceGateway) throw new Error('VoiceGateway is not registered');
  return voiceGateway;
}

export function clearVoiceGateway(): void {
  voiceGateway = null;
}
