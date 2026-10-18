import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { DEFAULT_HOSTILE_DETECTION } from '../../src/services/minebot/eventReaction/types.js';
import * as radius from '../../src/services/minebot/utils/threatRadius.js';
import { installCombatKnowledge } from '../../src/services/minebot/utils/combatKnowledge.js';

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
    // The legacy clearance radius: min(detection 16, 2 x critical 8) when nothing says otherwise (not a fixed 24).
    expect(bot.hostileThreatRadius()).toBe(16);
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

describe('the dig guard\'s threat radius is the legacy clearance radius, rule for rule (P8 review M1a)', () => {
  /** Hits from `distance` by `kind`, `ago` ms ago on the injected clock. */
  function hurtBy(bot: any, kind: string, distance: number, damage = 3) {
    const source = { id: 90, name: kind, type: 'hostile', position: new Vec3(distance, 65, 0) };
    bot.entities[90] = source;
    bot.emit('entityHurt', bot.entity, source); const before = bot.health; bot.health = before - damage; bot.emit('health'); bot.health = before;
    return source;
  }
  function withClock() {
    let at = 1_000_000;
    const { bot } = fixture({ entities: {} });
    installCombatKnowledge(bot, { now: () => at });
    return { bot, advance: (ms: number) => { at += ms; }, now: () => at };
  }
  it('is 16 with nothing to widen it, whatever hostile is near', () => {
    const { bot } = withClock();
    expect(bot.hostileThreatRadius()).toBe(16);
    bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(3, 65, 0) };
    expect(bot.hostileThreatRadius()).toBe(16);
  });
  it('widens to the hit that has just landed, as far as it came from plus 6, for five seconds', () => {
    const { bot, advance } = withClock();
    hurtBy(bot, 'skeleton', 20);
    delete bot.entities[90]; // the shooter is out of sight now; the hit is what is known
    expect(bot.hostileThreatRadius()).toBe(26);
    advance(4_900); expect(bot.hostileThreatRadius()).toBe(26);
    advance(200); expect(bot.hostileThreatRadius()).toBe(16);
  });
  it('widens, per kind, to the reach a kind has been measured to hit from plus 6, while one of that kind is in range and exposed', () => {
    const { bot, advance } = withClock();
    hurtBy(bot, 'skeleton', 20); advance(10_000);
    delete bot.entities[90];
    // Nothing of that kind near: back to the base.
    expect(bot.hostileThreatRadius()).toBe(16);
    bot.entities[91] = { id: 91, name: 'skeleton', position: new Vec3(24, 65, 0) };
    expect(bot.hostileThreatRadius()).toBe(26);
    // Beyond reach + 6 it does not count.
    bot.entities[91].position = new Vec3(27, 65, 0); expect(bot.hostileThreatRadius()).toBe(16);
    // A kind never measured to hit from afar adds nothing.
    bot.entities[91] = { id: 91, name: 'zombie', position: new Vec3(24, 65, 0) }; expect(bot.hostileThreatRadius()).toBe(16);
  });
  it('does not keep away from a kind a reflex of the body answers, or one the body is fighting, by its presence alone', () => {
    const { bot, advance } = withClock();
    hurtBy(bot, 'skeleton', 20); advance(10_000);
    delete bot.entities[90]; bot.entities[91] = { id: 91, name: 'skeleton', position: new Vec3(24, 65, 0) };
    expect(bot.hostileThreatRadius()).toBe(26);
    bot.reflexAnswers = { has: (kind: string) => kind === 'skeleton' }; expect(bot.hostileThreatRadius()).toBe(16);
    bot.reflexAnswers = undefined; bot.engagements = [{ kinds: ['skeleton'] }]; expect(bot.hostileThreatRadius()).toBe(16);
  });
  it('widens for a hostile on its way that will be on the body within nine seconds: its distance plus 4', () => {
    const { bot, now } = withClock();
    const t = now();
    bot.entities[5] = { id: 5, name: 'zombie', position: new Vec3(30, 65, 0) };
    // 36 m, then 30 m, a second apart: coming at 6 m/s, 28 m to go to contact (2 m reach): about 4.7 s.
    bot.threatMotion = { samples: new Map([[5, [{ at: t - 1000, distance: 36, x: 36, y: 65, z: 0 }, { at: t, distance: 30, x: 30, y: 65, z: 0 }]]]) };
    expect(bot.hostileThreatRadius()).toBe(34);
    // One that is not coming, or is too far to matter, adds nothing.
    bot.threatMotion = { samples: new Map([[5, [{ at: t - 1000, distance: 30, x: 30, y: 65, z: 0 }, { at: t, distance: 30, x: 30, y: 65, z: 0 }]]]) };
    expect(bot.hostileThreatRadius()).toBe(16);
    bot.entities[5].position = new Vec3(60, 65, 0);
    bot.threatMotion = { samples: new Map([[5, [{ at: t - 1000, distance: 66, x: 66, y: 65, z: 0 }, { at: t, distance: 60, x: 60, y: 65, z: 0 }]]]) };
    expect(bot.hostileThreatRadius()).toBe(16);
  });
  it('is never more than 64, however far the hit came from', () => {
    const { bot } = withClock();
    hurtBy(bot, 'ghast', 70);
    expect(bot.hostileThreatRadius()).toBe(64);
  });
  it('follows a hit from any named source, a player\'s too, for the radius (it never counts as a mob\'s hit)', () => {
    const { bot } = withClock();
    const before = JSON.stringify(bot.combatStats());
    const player = { id: 91, name: 'Steve', type: 'player', position: new Vec3(20, 65, 0) };
    bot.emit('entityHurt', bot.entity, player);
    expect(bot.hostileThreatRadius()).toBe(26);
    expect(JSON.stringify(bot.combatStats())).toBe(before);
  });
  it('keeps the legacy constants: the source of the event reaction system and the combat handler still has them', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const reaction = read('../../src/services/minebot/eventReaction/EventReactionSystem.ts'), handler = read('../../src/services/minebot/eventReaction/handlers/CombatEventHandler.ts');
    const constant = (source: string, name: string) => Number(new RegExp(`const ${name}\\s*=\\s*(\\d+)`, 'u').exec(source)?.[1]);
    expect(constant(reaction, 'REACH_MARGIN')).toBe(radius.REACH_MARGIN);
    expect(constant(reaction, 'ARRIVING_MARGIN')).toBe(radius.ARRIVING_MARGIN);
    expect(reaction).toMatch(/const CLEARANCE_CAP = MAX_HOSTILE_CLEAR_RADIUS;/u);
    expect(reaction).toMatch(/const REACH_SCAN_RADIUS = MAX_HOSTILE_CLEAR_RADIUS;/u);
    expect(read('../../src/services/minebot/cognition/GoalVerifier.ts')).toMatch(new RegExp(`MAX_HOSTILE_CLEAR_RADIUS = ${radius.CLEARANCE_CAP};`, 'u'));
    expect(reaction).toMatch(/Math\.min\(detection\.detectionDistance, detection\.criticalDistance \* 2\)/u);
    expect(reaction).toMatch(/Date\.now\(\) - this\.lastHurt\.at < 5000/u);
    expect(constant(handler, 'SAFE_LEAD_SECONDS')).toBe(radius.SAFE_LEAD_SECONDS);
    expect(constant(handler, 'LEAD_RANGE')).toBe(radius.LEAD_RANGE);
    expect(constant(handler, 'URGENT_LEAD_SECONDS')).toBe(radius.URGENT_LEAD_SECONDS);
    expect(constant(handler, 'CANNOT_WAIT_HEALTH')).toBe(radius.CANNOT_WAIT_HEALTH);
    expect(DEFAULT_HOSTILE_DETECTION).toMatchObject({ detectionDistance: radius.DETECTION_DISTANCE, criticalDistance: radius.CRITICAL_DISTANCE });
  });
});
