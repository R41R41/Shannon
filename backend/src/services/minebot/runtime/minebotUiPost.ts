import type { RequestEnvelope } from '@shannon/common';
import { minecraftMemoryContext, type MemoryBot } from './memoryContext.js';

export function canPostMinebotUiFromEnvelope(envelope?: RequestEnvelope): boolean {
  return Boolean(envelope?.minecraft?.serverId && envelope?.minecraft?.worldId);
}

export function canPostMinebotUiFromBot(bot: MemoryBot): boolean {
  return minecraftMemoryContext(bot) != null;
}
