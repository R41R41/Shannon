import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { HOSTILE_THREAT_RADIUS, installCombatKnowledge } from '../../src/services/minebot/utils/combatKnowledge.js';

function fixture(patch: Record<string, unknown> = {}) {
  const client = new EventEmitter();
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: new Vec3(0, 65, 0) }, health: 20, food: 20,
    entities: { 2: { id: 2, name: 'zombie', position: new Vec3(2, 65, 0) } } as Record<string, any>, registry: { foodsByName: {}, entitiesByName: { zombie: { type: 'hostile' }, skeleton: { type: 'hostile' } } },
    _client: client, game: { dimension: 'overworld' }, ...patch });
  return { bot, client };
}
afterEach(() => { vi.useRealTimers(); });

describe('combat knowledge (the providers EventReaction used to install, without it)', () => {
  it('installs the readers the observation, the shield and the dig guard ask for, and not the emergency ones', () => {
    const { bot } = fixture();
    expect(installCombatKnowledge(bot)).not.toBeNull();
    expect(bot.combatStats().mobs).toBeDefined();
    expect(bot.hostileThreatRadius()).toBe(HOSTILE_THREAT_RADIUS); expect(HOSTILE_THREAT_RADIUS).toBe(24);
    expect(bot.shootsAtBody('skeleton')).toBe(false);
    expect(bot).not.toHaveProperty('fightFavoured'); expect(bot).not.toHaveProperty('recentInterruptions');
    // Once only.
    expect(installCombatKnowledge(bot)).toBeNull();
  });
  it('records a hit to the mob the server named, with how far it stood, and notes the shots a shield reflex sees', () => {
    const { bot } = fixture(); installCombatKnowledge(bot);
    // The memory starts from the human priors: what is measured is what is added to them.
    const before = bot.combatStats().mobs.zombie ?? { hits: 0, damage: 0 };
    bot.emit('entityHurt', bot.entity, bot.entities[2]); bot.health = 16; bot.emit('health');
    const zombie = bot.combatStats().mobs.zombie;
    expect(zombie.hits - before.hits).toBe(1); expect(zombie.damage - before.damage).toBe(4); expect(zombie.maxHit).toBeGreaterThanOrEqual(4);
    expect(zombie.reach).toBeGreaterThanOrEqual(2);
    bot.shotAtBy('Skeleton'); expect(bot.shootsAtBody('skeleton')).toBe(true); expect(bot.shootsAtBody('zombie')).toBe(false);
  });
  it('guesses the nearest hostile only when the server named no cause, and ignores a hit nothing explains', () => {
    const { bot } = fixture(); installCombatKnowledge(bot);
    const hits = () => bot.combatStats().mobs.zombie?.hits ?? 0, before = hits();
    bot.health = 18; bot.emit('health');
    expect(hits() - before).toBe(1);
    const alone = fixture({ entities: {} }); installCombatKnowledge(alone.bot);
    const priors = JSON.stringify(alone.bot.combatStats());
    alone.bot.health = 10; alone.bot.emit('health'); expect(JSON.stringify(alone.bot.combatStats())).toBe(priors);
    // Health going up, or the body dying, records nothing.
    bot.health = 20; bot.emit('health'); bot.health = 0; bot.emit('health');
    expect(hits() - before).toBe(1);
  });
  it('records combat stats for mobs only: a player\'s blow, or a player standing nearby, is never counted as a mob\'s', () => {
    vi.useFakeTimers();
    const { bot } = fixture({ entities: { 3: { id: 3, name: 'Steve', type: 'player', position: new Vec3(1, 65, 0) } } }); installCombatKnowledge(bot);
    const before = JSON.stringify(bot.combatStats());
    bot.emit('entityHurt', bot.entity, bot.entities[3]); bot.health = 15; bot.emit('health');
    // No named mob, and the nearby player is not guessed at as one.
    bot.health = 12; bot.emit('health'); vi.advanceTimersByTime(2000);
    expect(JSON.stringify(bot.combatStats())).toBe(before);
    expect(Object.keys(bot.combatStats().mobs)).not.toContain('steve');
  });
  it('counts the time hostiles spend in contact, and stops when the body is gone', () => {
    vi.useFakeTimers();
    const { bot } = fixture(); installCombatKnowledge(bot);
    const contact = () => bot.combatStats().mobs.zombie?.contactMs ?? 0, before = contact();
    vi.advanceTimersByTime(1000);
    expect(contact() - before).toBe(1000);
    bot.entities[2].position = new Vec3(10, 65, 0); vi.advanceTimersByTime(1000);
    expect(contact() - before).toBe(1000);
    bot.entities[2].position = new Vec3(1, 65, 0); bot.emit('end'); vi.advanceTimersByTime(1000);
    expect(contact() - before).toBe(1000);
  });
  it('shows the observation how many more hits the body can take (margin.hitsLeft), which was absent without the provider', () => {
    const without = fixture({ health: 10 });
    expect((captureWorldObservation(without.bot).margin as any).hitsLeft).toBeUndefined();
    const { bot } = fixture({ health: 10 }); installCombatKnowledge(bot);
    const first = (captureWorldObservation(bot).margin as any).hitsLeft;
    expect(first).toMatchObject({ from: 'zombie' }); expect(first.hits).toBeGreaterThan(0);
    // A measured heavy hit lowers it.
    for (let i = 0; i < 6; i++) { bot.health = 10; bot.emit('health'); bot.emit('entityHurt', bot.entity, bot.entities[2]); bot.health = 4; bot.emit('health'); }
    bot.health = 10;
    expect((captureWorldObservation(bot).margin as any).hitsLeft.hits).toBeLessThan(first.hits);
  });
  it('does not import the task runtime or the event reaction system', () => {
    const source = readFileSync(new URL('../../src/services/minebot/utils/combatKnowledge.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter(line => /^import /u.test(line)).join('\n');
    expect(imports).not.toMatch(/EventReaction|TaskRuntime|taskRuntime|CombatEventHandler|eventReaction/u);
    expect(imports).toContain('EncounterMemory');
  });
});
