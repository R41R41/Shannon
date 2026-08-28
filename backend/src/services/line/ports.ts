import type { LineChatMessage, LineSendResult } from '../../modules/conversation/lineConversation.js';
/** Text generation only. Cannot dispatch, link accounts, read private memory, or invoke tools. */
export interface LineChatPort {
  reply(input: { kind: 'personal' | 'group'; messages: readonly LineChatMessage[]; signal: AbortSignal }): Promise<string>;
}
export interface LineTransport {
  reply(replyToken: string, text: string, signal: AbortSignal): Promise<LineSendResult>;
  push(userId: string, text: string, retryKey: string, signal: AbortSignal): Promise<LineSendResult>;
}
