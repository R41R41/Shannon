import { resolveMemberByPlatformId } from '../../config/memberAliases.js';
import { IExchange, MemoryPlatform } from '../../models/PersonMemory.js';
import { logger } from '../../utils/logger.js';

/**
 * Legacy PersonMemory mixed DM, guild and other channels.
 * Conversation paths must not read or write it. Canonical IDs stay platform:user.
 */
export class PersonMemoryService {
  private static instance: PersonMemoryService;
  public static getInstance(): PersonMemoryService {
    if (!PersonMemoryService.instance) PersonMemoryService.instance = new PersonMemoryService();
    return PersonMemoryService.instance;
  }

  resolveCanonicalPersonId(platform: MemoryPlatform, platformUserId: string, _displayName?: string): string {
    const member = resolveMemberByPlatformId(platform, platformUserId);
    if (member) return `member:${member.canonicalName.toLowerCase()}`;
    return `${platform}:${platformUserId}`;
  }

  async lookupByName(_platform: MemoryPlatform, _name: string): Promise<null> {
    return null;
  }

  async getOrCreate(_platform: MemoryPlatform, _platformUserId: string, _displayName: string): Promise<never> {
    throw new Error('LEGACY_PERSON_MEMORY_DISABLED');
  }

  async updateAfterConversation(
    _platform: MemoryPlatform,
    _platformUserId: string,
    _displayName: string,
    _newExchanges: IExchange[],
  ): Promise<void> {
    logger.warn('⚠ 旧 PersonMemory への会話書き戻しは停止しています。scope 付き人物引用だけを使います。');
  }
}
