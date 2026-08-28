/** Request-owned memory policy. No SDK, database, timers or display-name authority. */
export interface MemoryRequest {
  channel: string;
  sourceUserId: string;
  conversationId: string;
  threadId: string;
  discord?: { guildId?: string; channelId?: string; isDM?: boolean };
  minecraft?: { serverId?: string; worldId?: string; dimension?: string };
  metadata?: Record<string, unknown>;
}
export interface MemoryScope {
  readonly scopeVersion: 1;
  readonly scopeKey: string;
  readonly visibilityScope: 'private_user' | 'shared_channel' | 'shared_world';
  readonly ownerUserId: string;
}
export interface MemoryStamp {
  scopeVersion?: number;
  scopeKey?: string;
  visibilityScope?: string;
  ownerUserId?: string;
}
const issued = new WeakSet<object>();
const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512 && s.trim() === s && !/[\x00-\x1f]/.test(s) && !['unknown', 'default'].includes(s);
const discordId = (s: unknown): s is string => id(s) && /^\d+$/.test(s);

/** Only canonical adapter fields count. Tags, names, inferred generalization and projects cannot grant access. */
export function deriveMemoryScope(request?: MemoryRequest | null): MemoryScope | null {
  if (!request || !id(request.conversationId) || !id(request.threadId)) return null;
  let parts: string[];
  let visibilityScope: MemoryScope['visibilityScope'];
  let ownerUserId: string;
  if (request.channel === 'discord') {
    const d = request.discord;
    if (!d || !discordId(d.channelId) || !discordId(request.sourceUserId)) return null;
    if (typeof request.metadata?.isDM === 'boolean' && request.metadata.isDM !== d.isDM) return null;
    ownerUserId = `discord:${request.sourceUserId}`;
    if (d.isDM === true && !d.guildId) {
      visibilityScope = 'private_user';
      parts = ['discord', 'dm', request.sourceUserId, d.channelId, request.conversationId, request.threadId];
    } else if (d.isDM !== true && discordId(d.guildId)) {
      visibilityScope = 'shared_channel';
      parts = ['discord', 'channel', d.guildId, d.channelId, request.conversationId, request.threadId];
    } else return null;
  } else if (request.channel === 'minecraft') {
    const m = request.minecraft;
    if (!m || !id(m.serverId) || !id(m.worldId) || !id(m.dimension) || !id(request.sourceUserId) || request.metadata?.isDM === true) return null;
    visibilityScope = 'shared_world';
    ownerUserId = `minecraft:${request.sourceUserId}`;
    parts = ['minecraft', 'world', m.serverId, m.worldId, m.dimension];
  } else {
    // Web needs verified UID/project + audience binding; other adapters lack a reviewed scope contract.
    return null;
  }
  const scope: MemoryScope = Object.freeze({ scopeVersion: 1, scopeKey: JSON.stringify(parts), visibilityScope, ownerUserId });
  issued.add(scope);
  return scope;
}
export function hasMemoryScope(scope?: MemoryScope | null): scope is MemoryScope {
  return !!scope && issued.has(scope);
}
export function memoryScopeFilter(scope?: MemoryScope | null): Record<string, unknown> {
  if (!hasMemoryScope(scope)) return { scopeVersion: -1 }; // caller must also skip I/O when absent
  return { scopeVersion: 1, scopeKey: scope.scopeKey, visibilityScope: scope.visibilityScope,
    ...(scope.visibilityScope === 'private_user' ? { ownerUserId: scope.ownerUserId } : {}) };
}
export function canReadMemory(scope: MemoryScope | null | undefined, memory: MemoryStamp): boolean {
  return hasMemoryScope(scope) && memory.scopeVersion === 1 && memory.scopeKey === scope.scopeKey
    && memory.visibilityScope === scope.visibilityScope
    && (scope.visibilityScope !== 'private_user' || memory.ownerUserId === scope.ownerUserId);
}
export type RecallCategory = 'experience' | 'knowledge';
export interface MemoryDraft { category: RecallCategory; content: string; feeling?: string; importance: number; tags: string[]; }
export interface MemoryRecord { content: string; feeling?: string; createdAt: Date; }
export interface MemorySaveResult { saved: boolean; message: string; }
export interface MemoryPort {
  search(category: RecallCategory, query: string, limit?: number): Promise<MemoryRecord[]>;
  save(draft: MemoryDraft): Promise<MemorySaveResult>;
}
export const MEMORY_SCOPE_REQUIRED = '記憶の公開範囲を確認できないため、この経路での保存・検索は停止しています。';
