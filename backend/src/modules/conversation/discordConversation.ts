/** Internal capability for the originating Discord text conversation, not ingress authentication. */
export interface DiscordConversationRequest {
  channel: string; requestId: string; conversationId: string; sourceUserId: string;
  discord?: { guildId?: string; channelId?: string; messageId?: string; isDM?: boolean; isVoiceChannel?: boolean };
}
export interface DiscordConversationBinding {
  readonly requestId: string; readonly conversationId: string; readonly subjectId: string;
  readonly guildId: string; readonly channelId: string; readonly messageId: string; readonly isDM: boolean;
}
const issued = new WeakSet<object>();
export const DISCORD_CONVERSATION_REQUIRED = '現在のDiscordテキスト会話への許可がないため実行しません。';
export class ConversationDeniedError extends Error { constructor() { super(DISCORD_CONVERSATION_REQUIRED); } }
export function discordId(value: unknown): value is string { return typeof value === 'string' && /^[0-9]{1,25}$/.test(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()); }
export function bindDiscordConversation(request?: DiscordConversationRequest): DiscordConversationBinding | undefined {
  const d = request?.discord;
  if (!request || request.channel !== 'discord' || !d || d.isVoiceChannel === true
      || !nonempty(request.requestId) || !nonempty(request.conversationId)
      || (d.isDM !== undefined && typeof d.isDM !== 'boolean')
      || (d.isVoiceChannel !== undefined && typeof d.isVoiceChannel !== 'boolean')
      || !discordId(request.sourceUserId) || !discordId(d.channelId) || !discordId(d.messageId)) return undefined;
  const isDM = d.isDM === true;
  if (isDM ? Boolean(d.guildId) : !discordId(d.guildId)) return undefined;
  const binding = Object.freeze({ requestId: request.requestId, conversationId: request.conversationId,
    subjectId: request.sourceUserId, channelId: d.channelId, guildId: d.guildId ?? '', messageId: d.messageId, isDM });
  issued.add(binding); return binding;
}
export function hasDiscordConversation(binding: unknown): binding is DiscordConversationBinding {
  return typeof binding === 'object' && binding !== null && issued.has(binding);
}
export function targetsBoundConversation(binding: DiscordConversationBinding, target: { channelId?: string; guildId?: string }): boolean {
  return hasDiscordConversation(binding) && (target.channelId === undefined || target.channelId === binding.channelId)
    && (target.guildId === undefined || target.guildId === binding.guildId);
}
export interface DiscordHistoryEntry { readonly messageId: string; readonly authorId: string; readonly text: string; readonly timestamp: number }
export interface ConversationReplyInput { message: string; channelId?: string; guildId?: string; imageUrl?: string }
export interface ConversationReplyResult { status: 'sent' | 'denied' | 'unknown'; message: string }
export interface DiscordReactInput { messageId?: string; emojiId: string; channelId?: string; guildId?: string }
export interface DiscordEmojiListResult { status: 'ok'; emojis: string[] }
export interface DiscordConversationPort {
  reply(input: ConversationReplyInput): Promise<ConversationReplyResult>;
  recent(input?: { channelId?: string; limit?: number }): Promise<readonly DiscordHistoryEntry[]>;
  react(input: DiscordReactInput): Promise<ConversationReplyResult>;
  listEmojis(input?: { guildId?: string }): Promise<DiscordEmojiListResult | ConversationReplyResult>;
  publishPlanning(input: { planning: unknown; taskId: string }): Promise<ConversationReplyResult>;
}
