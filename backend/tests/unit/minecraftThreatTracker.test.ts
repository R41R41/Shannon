import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { approachSpeed, closingSpeed, sampleThreatMotion, secondsToContact, soonestContact, type ThreatMotionState } from '../../src/services/minebot/utils/threatTracker.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { describeSituation, situationSummary } from '../../src/modules/minecraftLearning/situation.js';
import DigShelter from '../../src/services/minebot/instantSkills/digShelter.js';

function world() {
  const state: ThreatMotionState = { samples: new Map() };
  const bot: any = {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, threatMotion: state,
    registry: { entitiesByName: { zombie: { type: 'hostile' }, cow: { type: 'animal' }, skeleton: { type: 'hostile' } } },
    entities: {
      2: { id: 2, name: 'zombie', position: new Vec3(14, 64, 0) },
      3: { id: 3, name: 'cow', position: new Vec3(5, 64, 0) },
      4: { id: 4, name: 'skeleton', position: new Vec3(0, 64, 20) },
    },
  };
  return { bot, state };
}

/** Two seconds of observation: the zombie walks 2.3 m/s at the body, the skeleton stands still. */
function observe(bot: any, state: ThreatMotionState, startX = 14) {
  for (let step = 0; step <= 8; step++) {
    bot.entities[2].position = new Vec3(startX - 2.3 * step * 0.25, 64, 0);
    sampleThreatMotion(bot, state, 1_000 + step * 250);
  }
}

describe('threat approach is measured, not looked up', () => {
  it('reports the closing rate of a hostile and nothing for animals or before enough was seen', () => {
    const { bot, state } = world();
    sampleThreatMotion(bot, state, 1_000);
    expect(closingSpeed(bot, 2)).toBeNull();
    observe(bot, state);
    expect(closingSpeed(bot, 2)).toBeCloseTo(2.3, 1);
    expect(closingSpeed(bot, 4)).toBeCloseTo(0, 5);
    expect(closingSpeed(bot, 3)).toBeNull();
    expect(secondsToContact(9.4, 2.3)).toBeCloseTo(3.2, 1);
    expect(secondsToContact(9.4, 0)).toBeNull();
    expect(secondsToContact(9.4, -3)).toBeNull();
  });

  it('forgets entities that left, and keeps only a short window', () => {
    const { bot, state } = world();
    observe(bot, state);
    delete bot.entities[2];
    sampleThreatMotion(bot, state, 4_000);
    expect(state.samples.has(2)).toBe(false);
    for (let at = 5_000; at <= 15_000; at += 250) sampleThreatMotion(bot, state, at);
    expect(state.samples.get(4)!.length).toBeLessThanOrEqual(12);
  });

  it('shows the planner and the experience log how long is left before contact', () => {
    const { bot, state } = world();
    observe(bot, state);
    const observation = captureWorldObservation(bot);
    const zombie = observation.nearbyThreats!.find(entity => entity.name === 'zombie')!;
    expect(zombie.closingSpeed).toBeCloseTo(2.3, 1);
    expect(zombie.secondsToContact).toBeCloseTo(3.2, 1);
    const skeleton = observation.nearbyThreats!.find(entity => entity.name === 'skeleton')!;
    expect(skeleton.closingSpeed).toBeUndefined();
    expect(skeleton.secondsToContact).toBeUndefined();
    const features = describeSituation(observation as any);
    expect(features.threats).toEqual([{ name: 'zombie', distance: 9, contact: 3 }, { name: 'skeleton', distance: 20 }]);
    expect(situationSummary(features)).toContain('zombie@9m(到達まで約3秒),skeleton@20m');
  });

  it('names the hostile that arrives first, counting one already within reach as zero seconds', () => {
    const { bot, state } = world();
    observe(bot, state);
    expect(soonestContact(bot)).toMatchObject({ name: 'zombie' });
    expect(soonestContact(bot)!.seconds).toBeCloseTo(3.2, 1);
    bot.entities[4].position = new Vec3(0, 64, 2.5);
    expect(soonestContact(bot)).toMatchObject({ name: 'skeleton', seconds: 0 });
    expect(soonestContact({ entity: bot.entity, entities: bot.entities })).toBeNull();
  });
});

describe('dig-shelter does not start a shaft the attacker reaches first (paid run L18)', () => {
  function shelterBot(startX: number) {
    const { bot, state } = world();
    delete bot.entities[4];
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    observe(bot, state, startX);
    const dug: string[] = [];
    Object.assign(bot, {
      // 750ms a block with the pickaxe (item type 7); fifteen seconds with anything else, the bare hand included.
      blockAt: (pos: Vec3) => ({ position: pos, diggable: true, digTime: (type: number | null) => type === 7 ? 750 : 15_000,
        ...(pos.y >= 64 ? { name: 'air', boundingBox: 'empty' } : { name: 'dirt', boundingBox: 'block' }) }),
      heldItem: { name: 'dirt', type: 3 },
      setControlState: () => {}, look: () => {},
      inventory: { items: () => [{ name: 'dirt', count: 8, type: 3 }, { name: 'iron_pickaxe', count: 1, type: 7 }] },
      instantSkills: { getSkill: () => ({ run: async (x: number, y: number, z: number) => { dug.push(`${x},${y},${z}`); return { success: false, result: 'stop here' }; } }) },
    });
    return { bot, dug };
  }

  // The time is the pickaxe's though a block of dirt is in the hand: counted with what was held, three blocks of
  // deepslate came to 47 seconds for a body carrying an iron pickaxe, and its shelter was refused (paid run L78).
  it('refuses with both times when the zombie is seconds away', async () => {
    const { bot, dug } = shelterBot(14);
    const result: any = await new DigShelter(bot).runImpl();
    expect(result).toMatchObject({ success: false, failureType: 'threat_too_close' });
    expect(result.result).toContain('zombie');
    expect(result.result).toMatch(/約3秒で届く見込みで、縦穴を掘って塞ぐには約4秒/);
    expect(dug).toHaveLength(0);
  });

  it('digs when the same zombie is far enough to finish first', async () => {
    const { bot, dug } = shelterBot(40);
    const result: any = await new DigShelter(bot).runImpl();
    expect(result.failureType).toBe('dig_failed');
    expect(dug).toHaveLength(1);
  });

  it("tells the mob's own approach from the body's (paid run L74: an emergency for a creeper forty blocks off that the body was running toward)", () => {
    // The mob stands still at x=40; the body ran from x=0 to x=10 in two seconds.
    const stand = { id: 7, name: 'creeper', type: 'hostile', position: new Vec3(40, 64, 0) };
    const bot: any = { entity: { position: new Vec3(10, 64, 0) }, entities: { 7: stand },
      threatMotion: { samples: new Map([[7, [{ at: 0, distance: 40, x: 40, y: 64, z: 0 }, { at: 2000, distance: 30, x: 40, y: 64, z: 0 }]]]) } };
    expect(closingSpeed(bot, 7)).toBeCloseTo(5);
    expect(approachSpeed(bot, 7)).toBeCloseTo(0);
    // The mob walked from x=40 to x=35 while the body stood at x=10.
    bot.threatMotion.samples.set(7, [{ at: 0, distance: 30, x: 40, y: 64, z: 0 }, { at: 2000, distance: 25, x: 35, y: 64, z: 0 }]);
    expect(approachSpeed(bot, 7)).toBeCloseTo(2.5);
    // Positions not kept: the closing speed stands in.
    bot.threatMotion.samples.set(7, [{ at: 0, distance: 30 }, { at: 2000, distance: 25 }]);
    expect(approachSpeed(bot, 7)).toBeCloseTo(2.5);
  });
});

