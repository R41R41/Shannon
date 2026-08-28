import type { RequestEnvelope } from '@shannon/common';
import { minecraftContextKey, minecraftConversationKeys, normalizeMinecraftDimension, type MinecraftWorldIdentity, type MinecraftMemoryContext } from '../../../modules/memory/minecraftIdentity.js';

interface MemoryBot { game?: { dimension?: unknown }; }
const bindings = new WeakMap<object, MinecraftWorldIdentity | null>();
const revoked = new WeakSet<object>();
/** Called once for the exact bot instance returned by createBot. Reconnection must create a new owner. */
export function bindMinecraftMemory(bot: object, identity: MinecraftWorldIdentity | null): void {
  if (bindings.has(bot) || revoked.has(bot)) throw new Error('MINECRAFT_MEMORY_ALREADY_BOUND');
  bindings.set(bot, identity ? Object.freeze({ ...identity }) : null);
}
export function revokeMinecraftMemory(bot: object): void { bindings.delete(bot); revoked.add(bot); }
export function assertMinecraftConnected(bot: object): void {
  if (revoked.has(bot)) throw new Error('MINECRAFT_MEMORY_DISCONNECTED');
}
export function minecraftMemoryContext(bot: MemoryBot): MinecraftMemoryContext | null {
  const identity = bindings.get(bot); const dimension = normalizeMinecraftDimension(bot.game?.dimension);
  if (!identity || !dimension || revoked.has(bot)) return null;
  return Object.freeze({ ...identity, dimension });
}
/** Validate queued/supplied envelopes without silently changing the audience of existing text/history. */
export function validateMinecraftEnvelope(envelope: RequestEnvelope, bot: MemoryBot): RequestEnvelope {
  assertMinecraftConnected(bot);
  if (envelope.channel !== 'minecraft') return { ...envelope, tags: [...envelope.tags], metadata: { ...envelope.metadata } };
  const context = minecraftMemoryContext(bot);
  const expected = minecraftContextKey(context); const supplied = minecraftContextKey(envelope.minecraft);
  if (expected !== supplied || (!expected && (envelope.minecraft?.serverId || envelope.minecraft?.worldId))) {
    throw new Error('MINECRAFT_MEMORY_CONTEXT_CHANGED');
  }
  const keys = minecraftConversationKeys(context, envelope.sourceUserId);
  if (keys && (keys.threadId !== envelope.threadId || keys.conversationId !== envelope.conversationId)) {
    throw new Error('MINECRAFT_MEMORY_CONVERSATION_MISMATCH');
  }
  return { ...envelope, tags: [...envelope.tags], minecraft: envelope.minecraft ? { ...envelope.minecraft,
    dimension: context?.dimension ?? envelope.minecraft.dimension } : undefined, metadata: { ...envelope.metadata } };
}
export function assertMinecraftContinuation(previousKey: string | null | undefined, envelope: RequestEnvelope, bot: MemoryBot): void {
  validateMinecraftEnvelope(envelope, bot);
  if (!previousKey || envelope.metadata?.memoryDisabled === true || envelope.channel !== 'minecraft' || previousKey !== minecraftContextKey(envelope.minecraft)) {
    throw new Error('MINECRAFT_MEMORY_CONTINUATION_MISMATCH');
  }
}

/** Local game-chat history only; Mod/voice have not established the same audience. */
export class MinecraftRecentHistory<T> {
  readonly messages: T[] = [];
  private key: string | null = null;
  constructor(private readonly bot: MemoryBot) {}
  add(message: T, gameChat: boolean): T[] {
    if (!gameChat) return [message];
    const key = minecraftContextKey(minecraftMemoryContext(this.bot));
    if (!key || key !== this.key) this.messages.length = 0;
    this.key = key;
    this.messages.push(message);
    if (this.messages.length > 50) this.messages.splice(0, this.messages.length - 50);
    return [...this.messages];
  }
}
