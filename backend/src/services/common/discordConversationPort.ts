import {
  bindDiscordConversation, targetsBoundConversation, ConversationDeniedError, DISCORD_CONVERSATION_REQUIRED,
  type DiscordConversationRequest, type DiscordConversationBinding, type DiscordConversationPort, type DiscordHistoryEntry,
} from '../../modules/conversation/discordConversation.js';

export interface DiscordConversationTransport {
  reply(binding: DiscordConversationBinding, message: string, signal?: AbortSignal): Promise<void>;
  recent(binding: DiscordConversationBinding, limit: number, signal?: AbortSignal): Promise<readonly DiscordHistoryEntry[]>;
}
let registeredTransport: DiscordConversationTransport | undefined;
/** Bootstrap only. No connections or timers are started by this module. */
export function registerDiscordConversationTransport(transport: DiscordConversationTransport): void {
  if (registeredTransport && registeredTransport !== transport) throw new Error('Discord conversation transport already registered');
  registeredTransport = transport;
}
export function createRequestDiscordConversation(
  request?: DiscordConversationRequest, signal?: AbortSignal,
  transport: DiscordConversationTransport | undefined = registeredTransport,
): DiscordConversationPort {
  const binding = bindDiscordConversation(request);
  return Object.freeze({
    async reply(input) {
      if (!binding || !transport || signal?.aborted || !targetsBoundConversation(binding, input)
          || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 12000 || Boolean(input.imageUrl)) {
        return { status: 'denied' as const, message: DISCORD_CONVERSATION_REQUIRED + ' 別会話・添付ファイルはこの経路では許可していません。' };
      }
      try {
        await transport.reply(binding, input.message, signal);
        return { status: 'sent' as const, message: '現在のDiscord会話への送信完了を確認しました。' };
      } catch (error) {
        return error instanceof ConversationDeniedError
          ? { status: 'denied' as const, message: DISCORD_CONVERSATION_REQUIRED }
          : { status: 'unknown' as const, message: '配信結果を確認できません。重複を避けるため自動再送はしないでください。' };
      }
    },
    async recent(input = {}) {
      const limit = input.limit ?? 10;
      if (!binding || !transport || signal?.aborted || !targetsBoundConversation(binding, input)
          || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new ConversationDeniedError();
      const entries = await transport.recent(binding, limit, signal);
      signal?.throwIfAborted();
      return entries;
    },
  } satisfies DiscordConversationPort);
}
export function bindRequestDiscordConversation(tools: readonly unknown[], request?: DiscordConversationRequest, signal?: AbortSignal): void {
  const port = createRequestDiscordConversation(request, signal);
  for (const tool of tools) {
    const target = tool as { setDiscordConversationPort?: (port: DiscordConversationPort) => void };
    target.setDiscordConversationPort?.(port);
  }
}
