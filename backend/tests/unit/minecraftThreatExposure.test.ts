import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { isExposedTo, threatExposure } from '../../src/services/minebot/utils/threatExposure.js';
import { CombatEventHandler } from '../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';

// Solid rock everywhere except the cells carved out as air.
function cave(air: (x: number, y: number, z: number) => boolean, at = new Vec3(0.5, 50, 0.5)) {
  let reads = 0;
  const bot: any = { entity: { position: at, height: 1.8 },
    blockAt: (p: Vec3) => { reads++; return { boundingBox: air(p.x, p.y, p.z) ? 'empty' : 'block' }; } };
  return { bot, reads: () => reads };
}
const mob = (x: number, y: number, z: number) => ({ position: new Vec3(x, y, z), height: 1.99 });
const room = (cx: number, x: number, y: number, z: number) => Math.abs(x - cx) <= 1 && y >= 50 && y <= 51 && Math.abs(z) <= 1;

describe('a hostile is a threat when it can see or reach the body, not when it is merely near (L33: a skeleton through 13 blocks of rock)', () => {
  it('is sealed in another cave with rock between and no opening', () => {
    const { bot } = cave((x, y, z) => room(0, x, y, z) || room(12, x, y, z));
    expect(threatExposure(bot, mob(12.5, 50, 0.5))).toBe('sealed');
    expect(isExposedTo(bot, mob(12.5, 50, 0.5))).toBe(false);
  });

  it('is seen down a straight tunnel, and reachable round a corner it cannot see past', () => {
    const straight = cave((x, y, z) => x >= -1 && x <= 13 && y >= 50 && y <= 51 && z === 0);
    expect(threatExposure(straight.bot, mob(12.5, 50, 0.5))).toBe('seen');
    // Two rooms joined by a tunnel that runs out along z=6 and back: no line of sight, but a way through.
    const bent = cave((x, y, z) => room(0, x, y, z) || room(12, x, y, z)
      || (y >= 50 && y <= 51 && ((x === 0 && z >= 0 && z <= 6) || (z === 6 && x >= 0 && x <= 12) || (x === 12 && z >= 0 && z <= 6))));
    expect(threatExposure(bent.bot, mob(12.5, 50, 0.5))).toBe('reachable');
  });

  it('a gap lower than the mob is no way in for it (lab: a blaze behind a gap one cell high was "able to reach" the body)', () => {
    // Two rooms joined at floor level by a slot one cell high, round a corner (no line of sight).
    const slot = (x: number, y: number, z: number) => room(0, x, y, z) || room(12, x, y, z)
      || (y === 50 && ((x === 0 && z >= 0 && z <= 6) || (z === 6 && x >= 0 && x <= 12) || (x === 12 && z >= 0 && z <= 6)));
    expect(threatExposure(cave(slot).bot, mob(12.5, 50, 0.5))).toBe('sealed');              // 1.99 tall: it does not fit
    expect(threatExposure(cave(slot).bot, { position: new Vec3(12.5, 50, 0.5), height: 0.9 })).toBe('reachable');   // a spider does
  });

  it('counts open ground as reachable without searching all of it, and stays cheap', () => {
    // Surface: air above y=49 everywhere, with a wall hiding the mob.
    const open = cave((x, y) => y >= 50 && !(x === 6 && y <= 53));
    expect(threatExposure(open.bot, mob(12.5, 50, 0.5))).toBe('reachable');
    expect(open.reads()).toBeLessThan(25_000);
  });

  it('judges again as the world changes, but not more than once a second per mob', () => {
    let opened = false;
    const { bot, reads } = cave((x, y, z) => room(0, x, y, z) || room(12, x, y, z) || (opened && y === 51 && z === 0 && x >= 0 && x <= 12));
    const skeleton = mob(12.5, 50, 0.5);
    expect(threatExposure(bot, skeleton, 1000)).toBe('sealed');
    const before = reads();
    opened = true; // the body digs through
    expect(threatExposure(bot, skeleton, 1500)).toBe('sealed');
    expect(reads()).toBe(before);
    expect(threatExposure(bot, skeleton, 2100)).toBe('seen');
  });

  it('treats a mob as exposed when there is nothing to judge with', () => {
    expect(threatExposure({ entity: { position: new Vec3(0, 50, 0) } } as any, mob(5, 50, 0))).toBe('seen');
  });
});

describe('exposure decides what counts as a threat', () => {
  const world = (open: boolean) => cave((x, y, z) => room(0, x, y, z) || room(12, x, y, z) || (open && y >= 50 && y <= 51 && z === 0 && x >= 0 && x <= 12)).bot;

  it('raises no hostile event for mobs sealed behind rock, and raises it once the way is open', () => {
    const bot = world(false);
    bot.entity.id = 1;
    bot.entities = { 2: { id: 2, name: 'skeleton', position: new Vec3(12.5, 50, 0.5), height: 1.99 },
      3: { id: 3, name: 'skeleton', position: new Vec3(11.5, 50, 0.5), height: 1.99 } };
    const sealed = new CombatEventHandler(bot);
    expect(sealed.checkHostileApproach()).toBeNull();
    const opened = world(true);
    opened.entity.id = 1;
    opened.entities = { 2: { id: 2, name: 'skeleton', position: new Vec3(12.5, 50, 0.5), height: 1.99 },
      3: { id: 3, name: 'skeleton', position: new Vec3(11.5, 50, 0.5), height: 1.99 } };
    expect(new CombatEventHandler(opened).checkHostileApproach()).toMatchObject({ eventType: 'hostile_approach', threatLevel: 'critical', mobCount: 2 });
  });

  it('tells the planner which nearby hostile cannot reach the body', () => {
    const bot = world(false);
    bot.registry = { entitiesByName: { skeleton: { type: 'hostile' }, zombie: { type: 'hostile' } } };
    bot.entities = { 2: { id: 2, name: 'skeleton', position: new Vec3(12.5, 50, 0.5), height: 1.99 },
      3: { id: 3, name: 'zombie', position: new Vec3(1.5, 50, 0.5), height: 1.95 } };
    bot.inventory = { items: () => [] };
    const threats = captureWorldObservation(bot).nearbyThreats ?? [];
    expect(threats.find(entity => entity.name === 'skeleton')).toMatchObject({ canReachMe: false });
    expect(threats.find(entity => entity.name === 'zombie')).not.toHaveProperty('canReachMe');
  });
});
