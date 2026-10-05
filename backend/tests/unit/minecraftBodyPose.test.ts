import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { bodyPose, eyeCell, eyeHeight } from '../../src/services/minebot/utils/bodyPose.js';
import { recordAirTrail, retraceFeasible, retraceWaypoint } from '../../src/services/minebot/utils/breathingReflex.js';

const block = (name: string) => ({ name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block', type: name === 'water' ? 34 : name === 'air' ? 0 : 1,
  getProperties: () => ({}), metadata: 0 });
// Water in cells y=60 and y=61 with dirt overhead from `ceilingY`; open air above the hole at x=0,z=2.
function pocket(position: Vec3, ceilingY = 62) {
  return { entity: { position, isInWater: true }, oxygenLevel: 20 as number,
    blockAt: (p: Vec3) => p.x === 0 && p.z === 2 && p.y >= 62 ? block('air') : p.y >= ceilingY ? block('dirt') : p.y >= 60 ? block('water') : block('stone') } as any;
}

describe('the head is where the server holds it, not always 1.62 above the feet (drowned 1.5 m from the hole, L38)', () => {
  it('stands where there is room, crouches under a low ceiling, lies flat under a lower one', () => {
    expect(bodyPose(pocket(new Vec3(0.5, 60.2, 0.5)))).toMatchObject({ name: 'standing', eye: 1.62 });
    // Risen against the ceiling: a standing body would reach into the dirt, so the server has it crouched.
    const risen = pocket(new Vec3(0.5, 60.47, 0.5));
    expect(bodyPose(risen)).toMatchObject({ name: 'crouching', height: 1.5 });
    expect(eyeHeight(risen)).toBe(1.27);
    expect(eyeCell(risen)).toMatchObject({ x: 0, y: 61, z: 0 }); // in the water, not in the dirt
    expect(bodyPose(pocket(new Vec3(0.5, 60.47, 0.5), 61))).toMatchObject({ name: 'flat', eye: 0.4 });
    // Open sky, or nothing to read the world with: standing.
    expect(bodyPose({ entity: { position: new Vec3(0.5, 64, 0.5) } } as any).name).toBe('standing');
  });

  it('keeps the way back to the last breath while pressed under the ceiling, and offers it', () => {
    const bot = pocket(new Vec3(0.5, 62.0, 2.5));
    recordAirTrail(bot, 1000);                                  // at the hole, head in air
    for (const [i, at] of [new Vec3(0.5, 60.6, 2.5), new Vec3(0.5, 60.47, 1.5), new Vec3(0.5, 60.47, 0.5)].entries()) {
      bot.entity.position = at; recordAirTrail(bot, 1500 + i * 500);
    }
    // Before: the eyes were taken to be in the dirt, "not in water", and each tick restarted the trail right here.
    expect(retraceFeasible(bot)).toBe(true);
    const back = retraceWaypoint(bot, 3000)!;
    expect(back.z).toBeGreaterThan(0.5);
  });

  it('does not call a place "air" while the server\'s air count is still falling', () => {
    const bot = pocket(new Vec3(0.5, 62.0, 2.5));
    recordAirTrail(bot, 1000);
    // Somewhere the client's geometry reads as air at the eyes, but the count keeps dropping.
    bot.entity.position = new Vec3(0.5, 62.0, 2.5 - 1.2);
    bot.blockAt = (p: Vec3) => p.y >= 63 ? block('dirt') : p.y >= 62 ? block('air') : block('water');
    bot.oxygenLevel = 19; recordAirTrail(bot, 1750);
    bot.entity.position = new Vec3(0.5, 62.0, 2.5 - 2.4);
    bot.oxygenLevel = 18; recordAirTrail(bot, 2500);
    const back = retraceWaypoint(bot, 3000)!;
    expect(back).toBeTruthy();
    expect(back.z).toBeGreaterThan(0.2); // still leads back toward the breath, not "here"
    // Once the count stops falling, the place is air again and the trail starts over from it.
    recordAirTrail(bot, 2500 + 2100);
    expect(retraceWaypoint(bot, 5000)?.z ?? bot.entity.position.z).toBeCloseTo(bot.entity.position.z, 1);
  });
});
