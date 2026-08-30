import type { MinebotSkillInput, MinebotVoiceChatInput } from '@shannon/common';

type ChatHandler = (input: MinebotSkillInput) => void | Promise<void>;
type VoiceChatHandler = (input: MinebotVoiceChatInput) => void | Promise<void>;

let chatHandler: ChatHandler | null = null;
let voiceChatHandler: VoiceChatHandler | null = null;

export function registerMinebotChatHandler(handler: ChatHandler): void {
  chatHandler = handler;
}

export function dispatchMinebotChat(input: MinebotSkillInput): void {
  void chatHandler?.(input);
}

export function registerMinebotVoiceChatHandler(handler: VoiceChatHandler): void {
  voiceChatHandler = handler;
}

export function dispatchMinebotVoiceChat(input: MinebotVoiceChatInput): void {
  void voiceChatHandler?.(input);
}

export function clearMinebotInboundHandlers(): void {
  chatHandler = null;
  voiceChatHandler = null;
}
