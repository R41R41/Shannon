import { describe, it, expect } from 'vitest';
import { Vec3 } from 'vec3';
import { assessBreathingWork } from '../../src/services/minebot/utils/breathingWork.js';
import { airRunningOut } from '../../src/services/minebot/utils/breathingReflex.js';

function bot(oxygen: number, ceiling = false) {
  return { entity: { position: new Vec3(0.5, 10, 0.5), isInWater: true }, oxygenLevel: oxygen, health: 20,
    digTime: () => 2000,
    blockAt: (p: Vec3) => {
      const name = ceiling ? 'water' : p.y >= 13 ? 'air' : 'water';
      return { name, boundingBox: 'empty', diggable: true };
    } };
}
describe('work reserves enough breath to return', () => {
  it('allows a short job with a known surface and rejects the same job with too little breath', () => {
    expect(assessBreathingWork(bot(20), 2).allowed).toBe(true);
    expect(assessBreathingWork(bot(6), 2).reason).toBe('insufficient_air');
  });
  it('does not turn a route outside the observed search into zero return time', () => {
    const deep = bot(20, true);
    expect(assessBreathingWork(deep, 1).reason).toBe('return_unknown');
    // The dig is the thing refused. The reflex still waits for the critical threshold: engaging at full air with no way known pinned the
    // body jumping against the ceiling for as long as it stayed in the water (minecraftBreathingReflex.test.ts keeps that rule).
    expect(airRunningOut(deep as any)).toBe(false);
    expect(airRunningOut({ ...deep, oxygenLevel: 5 } as any)).toBe(true);
  });
  it('does not limit a dry job by the last underwater oxygen reading', () => {
    const dry = bot(0); dry.blockAt = () => ({ name: 'air', boundingBox: 'empty', diggable: true });
    expect(assessBreathingWork(dry, 80).reason).toBe('dry');
  });
  it('does not approve an unmeasured underwater dig or an unknown oxygen reading', () => {
    expect(assessBreathingWork(bot(20), Infinity).allowed).toBe(false);
    expect(assessBreathingWork({ ...bot(20), oxygenLevel: undefined }, 1).reason).toBe('air_unknown');
  });
  it('counts actual ceiling excavation once but does not exempt another block with an escape label', () => {
    const b = bot(12);
    b.blockAt = (p: Vec3) => p.y === 12 ? { name: 'stone', boundingBox: 'block', diggable: true }
      : { name: p.y > 12 ? 'air' : 'water', boundingBox: 'empty', diggable: true };
    const escape = assessBreathingWork(b, 5, { x: 0, y: 12, z: 0 });
    expect(escape.escapeWork).toBe(true);
    expect(escape.allowed).toBe(true);
    expect(assessBreathingWork(b, 5, { x: 1, y: 12, z: 0 }).allowed).toBe(false);
  });
});
