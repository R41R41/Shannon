import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import { bedEyeReach, bedWaitGroundSafe, landingBedSelf, landingEntryPillowSearch, landingFountainStandSearch, landingProjectedRead,
  type BedSearch } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { landingArrival, landingEntryDirection, landingEntryOrder, predictLandingPath, type LandingObservation } from '../../src/services/minebot/utils/dragonLandingPath.js';
import type { P3 } from '../../src/services/minebot/utils/dragonParts.js';

const target = { x: 103.5, y: 74, z: -39.5 };
const solid = (name = 'bedrock') => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
function terrain(t = target) {
  return (p: P3) => p.y < t.y - 4 || (p.x === Math.floor(t.x) && p.z === Math.floor(t.z) && p.y < t.y) ? solid() : air;
}
const drain = <T>(s: BedSearch<T>): T => { let r = s.next(); while (!r.done) r = s.next(); return r.value; };
const history = (yaw = 0): LandingObservation[] => [0, 3, 6, 9, 12, 15].map(tick => ({ tick, phase: 3, yaw,
  position: { x: target.x - Math.sin(yaw) * (40 - tick / 3), y: target.y + 20, z: target.z - Math.cos(yaw) * (40 - tick / 3) } }));

describe('M2 direction-independent fountain stand and entry pillow', () => {
  it('covers the entire middle ring with reachable pillows and 45/45 durable shielding, at translated fountains', () => {
    for (const t of [target, { x: -27.5, y: 86, z: 115.5 }]) {
      const read = terrain(t), plan = drain(landingFountainStandSearch(t, { ...t, x: t.x + 12, y: t.y - 4 }, read, 16, 20));
      expect(plan).not.toBeNull();
      expect(plan!.options).toHaveLength(20);
      expect(Math.hypot(plan!.stand.x - t.x, plan!.stand.z - t.z)).toBe(1);
      expect(plan!.screen.length + plan!.footing.length + 2).toBeLessThanOrEqual(16);
      const built = landingProjectedRead(read, [...plan!.screen, ...plan!.footing]);
      for (const c of plan!.options) {
        expect(c.supports.length).toBeLessThanOrEqual(2);
        expect(bedEyeReach(plan!.stand, c.head)).toBeLessThanOrEqual(4.5);
        expect(bedEyeReach(plan!.stand, c.foot)).toBeLessThanOrEqual(4.5);
        expect(landingBedSelf(built, c.head, c.foot, plan!.stand).exposure, JSON.stringify({ head: c.head, stand: plan!.stand })).toBe(0);
        expect(landingBedSelf(landingProjectedRead(built, c.supports), c.head, c.foot, plan!.stand).exposure).toBe(0);
      }
      // The ideal 3m circle in every bearing is reachable too, not just cardinal cells.
      for (let a = 0; a < 360; a++) expect(bedEyeReach(plan!.stand, { x: t.x + 3 * Math.sin(a) - .5,
        y: t.y, z: t.z + 3 * Math.cos(a) - .5 })).toBeLessThanOrEqual(4.5);
      expect([...plan!.screen, ...plan!.footing].some(p => p.x === Math.floor(t.x) && p.z === Math.floor(t.z))).toBe(false);
    }
  });
  it('uses only the entry bearing, selects once in under 5ms, and rejects lost screens / low health', () => {
    const read = terrain(), plan = drain(landingFountainStandSearch(target, { ...target, x: target.x + 12 }, read, 16, 20))!;
    expect(plan).not.toBeNull();
    const built = landingProjectedRead(read, [...plan.screen, ...plan.footing]);
    const timings: number[] = [];
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const h = history(yaw), started = performance.now();
      const selected = drain(landingEntryPillowSearch(plan, h, target, predictLandingPath(h, target, 15, 3), built, 20));
      timings.push(performance.now() - started);
      expect(selected).not.toBeNull();
      expect(selected!.head).toEqual(landingEntryOrder(plan.options, h, target)[0].head);
      expect(timings.at(-1)).toBeLessThan(5);
    }
    console.log('M2 entry pillow CPU ms', timings);
    const h = history();
    expect(drain(landingEntryPillowSearch(plan, h, target, predictLandingPath(h, target, 15, 3), built, 5))).toBeNull();
    expect(drain(landingEntryPillowSearch(plan, h, target, predictLandingPath(h, target, 15, 3), read, 20))).toBeNull();
    const first = landingEntryOrder(plan.options, h, target)[0];
    const blocked = (p: P3) => first.supports.some(c => key(c) === key(p)) ? solid('end_stone') : built(p);
    const alternative = drain(landingEntryPillowSearch(plan, h, target, predictLandingPath(h, target, 15, 3), blocked, 20));
    expect(alternative?.head ?? null).not.toEqual(first.head);
    expect(drain(landingFountainStandSearch(target, target, () => null, 16, 20))).toBeNull();
    expect(drain(landingFountainStandSearch(target, target, read, 0, 20))).toBeNull();
  });
  it('preserves readiness on interrupted go within 1m, but never completes an unfinished screen', () => {
    const stand = { x: 1, y: 2, z: 3 }, plan = { stand, readyTick: null as number | null };
    expect(landingArrival(plan, { ...stand, x: 2.01 }, 10, true)).toBeNull();
    expect(landingArrival(plan, stand, 10, false)).toBeNull();
    plan.readyTick = landingArrival(plan, { ...stand, x: 1.9 }, 11, true);
    expect(plan.readyTick).toBe(11);
    expect(landingArrival(plan, stand, 14, false)).toBe(11);
  });
  it('uses fresh inbound velocity at entry even when phase-2 packet progress was circling', () => {
    const h = history();
    h[h.length - 1] = { ...h.at(-1)!, velocity: { x: .1, y: -.2, z: .2 }, velocityTick: 15 };
    const end = landingEntryDirection(h, target)!;
    expect(end.direction.x).toBeCloseTo(1 / Math.sqrt(5));
    expect(end.direction.z).toBeCloseTo(2 / Math.sqrt(5));
    h[h.length - 1].velocityTick = 16; // future receipt must not leak into an earlier entry
    expect(landingEntryDirection(h, target)!.direction.x).toBe(0);
  });
});

describe('scene crater destination guard', () => {
  const feet = { x: 10.5, y: 65, z: 4.5 };
  const flat = (p: P3) => p.y < feet.y ? solid('end_stone') : air;
  it('excludes blast centres within 3m even after the floor looks flat', () => {
    expect(bedWaitGroundSafe(flat, feet)).toBe(true);
    expect(bedWaitGroundSafe(flat, feet, [{ ...feet, x: feet.x + 3 }])).toBe(false);
    expect(bedWaitGroundSafe(flat, feet, [{ ...feet, x: feet.x + 3.01 }])).toBe(true);
  });
  it('rejects depressed floor, neighbouring pits, raised lips and unloaded ground', () => {
    expect(bedWaitGroundSafe(flat, { ...feet, y: feet.y - 2 })).toBe(false);
    expect(bedWaitGroundSafe(p => key(p) === '11,64,4' ? air : flat(p), feet)).toBe(false);
    expect(bedWaitGroundSafe(p => key(p) === '11,65,4' ? solid() : flat(p), feet)).toBe(false);
    expect(bedWaitGroundSafe(p => key(p) === '11,64,4' ? { ...solid(), shapes: [[0, 0, 0, 1, .5, 1]] } : flat(p), feet)).toBe(false);
    expect(bedWaitGroundSafe(() => null, feet)).toBe(false);
  });
});
