import type { RequestEnvelope } from '@shannon/common';
import { deriveMemoryScope, hasMemoryScope, MEMORY_SCOPE_REQUIRED, type MemoryPort, type MemoryDraft, type RecallCategory } from '../../modules/memory/index.js';
import { ShannonMemoryService } from './shannonMemoryService.js';

/** Snapshot scope at construction; never accept owner/audience from an LLM tool argument. No I/O in construction. */
export function createRequestMemory(envelope?: RequestEnvelope): MemoryPort {
  const scope = deriveMemoryScope(envelope);
  const source = envelope?.channel ?? 'unknown';
  return Object.freeze({
    async search(category: RecallCategory, query: string, limit = 5) {
      if (!hasMemoryScope(scope)) return [];
      const service = ShannonMemoryService.getInstance();
      return category === 'experience' ? service.searchExperiences(query, limit, scope) : service.searchKnowledge(query, limit, scope);
    },
    async save(draft: MemoryDraft) {
      if (!hasMemoryScope(scope)) return { saved: false, message: MEMORY_SCOPE_REQUIRED };
      return ShannonMemoryService.getInstance().saveWithDedup({ ...draft, source }, scope);
    },
  });
}

export function bindRequestMemory(tools: readonly unknown[], envelope?: RequestEnvelope): void {
  const port = createRequestMemory(envelope);
  for (const tool of tools) {
    const candidate = tool as { setMemoryPort?: (port: MemoryPort) => void };
    if (typeof candidate.setMemoryPort === 'function') candidate.setMemoryPort(port);
  }
}

/** Copy the memory-relevant scalar fields before asynchronous processing; never persist bot/runtime objects. */
export function snapshotMemoryEnvelope(envelope: RequestEnvelope): RequestEnvelope {
  const d = envelope.discord; const m = envelope.minecraft;
  return Object.freeze({
    requestId: envelope.requestId, channel: envelope.channel, sourceUserId: envelope.sourceUserId,
    sourceDisplayName: envelope.sourceDisplayName, conversationId: envelope.conversationId,
    threadId: envelope.threadId, text: envelope.text, timestampIso: envelope.timestampIso,
    tags: Object.freeze([...(envelope.tags ?? [])]) as unknown as string[],
    discord: d ? Object.freeze({ guildId: d.guildId, guildName: d.guildName, channelId: d.channelId,
      channelName: d.channelName, isDM: d.isDM, isVoiceChannel: d.isVoiceChannel, messageId: d.messageId }) : undefined,
    minecraft: m ? Object.freeze({ serverId: m.serverId, worldId: m.worldId, dimension: m.dimension }) : undefined,
    metadata: Object.freeze({ isDM: envelope.metadata?.isDM }),
  });
}
