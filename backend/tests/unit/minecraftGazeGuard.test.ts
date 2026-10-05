import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { avertedPitch, gazeGuardTick, viewVector } from '../../src/services/minebot/utils/gazeGuard.js';

const TOLERANCE = 0.025;
/** The server's test: does a look from `eyes` fall on the creature's eyes? */
function staring(eyes: Vec3, yaw: number, pitch: number, target: Vec3): boolean {
  const line = target.minus(eyes), distance = line.norm();
  return viewVector(yaw, pitch).dot(line.scaled(1 / distance)) > 1 - TOLERANCE / distance;
}
const yawTo = (from: Vec3, to: Vec3) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

describe('the look is kept off the eyes of a creature that attacks what looks at it (paid run L64 was killed by an enderman it had walked towards)', () => {
  const eyes = new Vec3(0.5, 71.62, 0.5);

  it('a level look along the way the body walks falls on the eyes of one twenty metres ahead; the guard lowers it', () => {
    const creature = new Vec3(22.5, 72.55, 0.5);
    const yaw = yawTo(eyes, creature);
    expect(staring(eyes, yaw, 0, creature)).toBe(true);
    const pitch = avertedPitch(eyes, yaw, 0, [{ eyes: creature, tolerance: TOLERANCE }]);
    expect(pitch).toBeLessThan(0);
    expect(pitch).toBeGreaterThan(-0.2); // a few degrees, not at the ground
    expect(staring(eyes, yaw, pitch, creature)).toBe(false);
    // The same from close by, where the eyes are well above the body's: a level look is already under them.
    const near = new Vec3(3.5, 72.55, 0.5);
    expect(avertedPitch(eyes, yawTo(eyes, near), 0, [{ eyes: near, tolerance: TOLERANCE }])).toBe(0);
  });

  it('leaves a look that is on no such eyes alone', () => {
    const creature = new Vec3(22.5, 72.55, 0.5);
    const yaw = yawTo(eyes, creature);
    expect(avertedPitch(eyes, yaw + 0.4, 0, [{ eyes: creature, tolerance: TOLERANCE }])).toBe(0);
    expect(avertedPitch(eyes, yaw, -0.5, [{ eyes: creature, tolerance: TOLERANCE }])).toBe(-0.5);
    expect(avertedPitch(eyes, yaw, 0, [{ eyes: new Vec3(100.5, 72.55, 0.5), tolerance: TOLERANCE }])).toBe(0); // out of its range
  });

  it('clears two at once, and looks above eyes that are straight below', () => {
    const one = new Vec3(22.5, 72.55, 0.5), lower = new Vec3(30.5, 69.5, 0.5);
    const yaw = yawTo(eyes, one);
    const pitch = avertedPitch(eyes, yaw, 0, [{ eyes: one, tolerance: TOLERANCE }, { eyes: lower, tolerance: TOLERANCE }]);
    expect(staring(eyes, yaw, pitch, one)).toBe(false);
    expect(staring(eyes, yaw, pitch, lower)).toBe(false);
    const below = new Vec3(0.5, 60, 0.5);
    const up = avertedPitch(eyes, 0, -Math.PI / 2, [{ eyes: below, tolerance: TOLERANCE }]);
    expect(up).toBeGreaterThan(-Math.PI / 2);
    expect(staring(eyes, 0, up, below)).toBe(false);
  });

  it('as a reflex: changes only the pitch, only for such creatures, and can be switched off', () => {
    const at = new Vec3(0.5, 70, 0.5);
    const make = (name: string) => ({ entity: { position: at, yaw: yawTo(at, new Vec3(22.5, 70, 0.5)), pitch: 0 },
      entities: { 7: { name, position: new Vec3(22.5, 70, 0.5) } }, on: () => undefined }) as any;
    const bot = make('enderman');
    const yaw = bot.entity.yaw;
    const state = { enabled: true, averted: 0 };
    expect(gazeGuardTick(bot, state)).toBe(true);
    expect(bot.entity.yaw).toBe(yaw);
    expect(bot.entity.pitch).toBeLessThan(0);
    expect(staring(at.offset(0, 1.62, 0), yaw, bot.entity.pitch, new Vec3(22.5, 72.55, 0.5))).toBe(false);
    expect(gazeGuardTick(bot, state)).toBe(false); // already clear
    const zombie = make('zombie');
    expect(gazeGuardTick(zombie, state)).toBe(false);
    expect(zombie.entity.pitch).toBe(0);
    const off = make('enderman');
    expect(gazeGuardTick(off, { enabled: false, averted: 0 })).toBe(false);
    expect(off.entity.pitch).toBe(0);
  });
});
