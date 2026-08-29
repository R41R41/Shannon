import { describe, expect, it } from 'vitest';
import { WorldKnowledgeService } from '../../src/services/minebot/knowledge/WorldKnowledgeService.js';
import { SkillResultCache } from '../../src/services/minebot/knowledge/SkillResultCache.js';
import { bindMinecraftMemory, boundMinecraftServerId } from '../../src/services/minebot/runtime/memoryContext.js';
import { minecraftTaskContinuation } from '../../src/services/minebot/runtime/minecraftTaskContinuation.js';

describe('minecraft world isolation', () => {
  it('does not open WorldKnowledge for missing, default, or display-name server ids', () => {
    expect(WorldKnowledgeService.forServer(undefined)).toBeNull();
    expect(WorldKnowledgeService.forServer('default')).toBeNull();
    expect(WorldKnowledgeService.forServer('unknown')).toBeNull();
    expect(WorldKnowledgeService.forServer('play.example.net')).toBeNull();
    expect(WorldKnowledgeService.forServer('1.21.11-fabric-test')).toBeNull();
    expect(WorldKnowledgeService.forServer('dev:server-a')).toBeTruthy();
    expect(WorldKnowledgeService.forServer('dev:server-a')).toBe(WorldKnowledgeService.forServer('dev:server-a'));
    expect(WorldKnowledgeService.forServer('prod:server-b')).not.toBe(WorldKnowledgeService.forServer('dev:server-a'));
    expect((WorldKnowledgeService as { getInstance?: unknown }).getInstance).toBeUndefined();
  });

  it('does not treat a Minecraft display name as a knowledge identity', () => {
    const bot = { connectedServerName: '1.21.11-fabric-test', game: { dimension: 'minecraft:overworld' } };
    expect(boundMinecraftServerId(bot)).toBeUndefined();
    expect(WorldKnowledgeService.forServer(bot.connectedServerName)).toBeNull();
    bindMinecraftMemory(bot, { serverId: 'dev:server-a', worldId: 'world-a' });
    expect(boundMinecraftServerId(bot)).toBe('dev:server-a');
    expect(boundMinecraftServerId(bot)).not.toBe(bot.connectedServerName);
    expect(WorldKnowledgeService.forServer(boundMinecraftServerId(bot))).toBeTruthy();
  });

  it('does not share query skill cache across bound servers', () => {
    const cache = new SkillResultCache();
    const pos = { x: 0, y: 64, z: 0 };
    cache.set('find-blocks', ['iron_ore'], { success: true, result: 'server-a' }, pos, 'server-a');
    expect(cache.get('find-blocks', ['iron_ore'], pos, 'server-b')).toBeNull();
    expect(cache.get('find-blocks', ['iron_ore'], pos, 'server-a')?.result).toBe('server-a');
    expect(cache.get('find-blocks', ['iron_ore'], pos, '')).toBeNull();
  });

  it('keeps task continuation per server+world, not process-global', () => {
    expect(minecraftTaskContinuation()).toBeUndefined();
    expect(minecraftTaskContinuation({ serverId: 'default', worldId: 'w' })).toBeUndefined();
    const a = minecraftTaskContinuation({ serverId: 's1', worldId: 'w1' });
    const b = minecraftTaskContinuation({ serverId: 's1', worldId: 'w2' });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    a!.lastGoal = 'mine iron';
    a!.lastSummary = 'got iron';
    expect(b!.lastGoal).toBeNull();
    expect(minecraftTaskContinuation({ serverId: 's1', worldId: 'w1' })!.lastGoal).toBe('mine iron');
  });
});
