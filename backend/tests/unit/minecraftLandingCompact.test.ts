import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import { advanceBedSearch, bedCellSupported, bedEyeReach, landingBedSelf, landingCompactStandSearch,
  landingFountainStandSearch, landingProjectedRead, type BedSearch } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import type { LandingObservation } from '../../src/services/minebot/utils/dragonLandingPath.js';
import type { P3 } from '../../src/services/minebot/utils/dragonParts.js';

const solid = { name: 'bedrock', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const drain = <T>(search: BedSearch<T>): T => { let result = search.next(); while (!result.done) result = search.next(); return result.value; };
const terrain = (target: P3) => (p: P3) => p.y < target.y - 4
  || (p.x === Math.floor(target.x) && p.z === Math.floor(target.z) && p.y < target.y) ? solid : air;
const inbound = (target: P3): LandingObservation[] => [0, 3, 6, 9, 12, 15].map(tick => ({ tick, phase: 2, yaw: 0,
  position: { x: target.x, y: target.y + 20, z: target.z - 40 + tick / 3 } }));

describe('compact M2 preparation from present phase-2 geometry', () => {
  it.each([{ x: 103.5, y: 74, z: -39.5 }, { x: -27.5, y: 86, z: 115.5 }])('adds a lower pillow and transverse bed on observed natural support: %j', target => {
    const read = terrain(target), history = inbound(target);
    const here = { x: target.x + 12, y: target.y - 4, z: target.z };
    const plan = drain(landingFountainStandSearch(target, here, read, 12, 20, history));
    expect(plan).not.toBeNull();
    expect(plan!.options).toHaveLength(2); // same prepared side/stand, separately built existing heights; entry rechecks the selected blueprint
    const layout = plan!.options[0];
    expect(layout.head.y).toBe(target.y - 1);
    expect(layout.stand.y).toBe(target.y - 4);
    expect(layout.foot.z).toBe(layout.head.z); // current observed inbound direction is +z; foot runs across it
    expect(Math.abs(layout.foot.x - layout.head.x)).toBe(1);
    const construction = [...plan!.footing, ...plan!.screen];
    expect(new Set(construction.map(key)).size).toBe(construction.length);
    expect(construction.length).toBeLessThanOrEqual(12);
    const confirmed: P3[] = [];
    for (const p of construction) {
      expect(bedCellSupported(landingProjectedRead(read, confirmed), p)).toBe(true);
      expect(bedEyeReach(plan!.stand, p)).toBeLessThanOrEqual(4.5);
      expect(p.x !== Math.floor(target.x) || p.z !== Math.floor(target.z)).toBe(true);
      confirmed.push(p);
    }
    const built = landingProjectedRead(read, construction);
    expect(landingBedSelf(built, layout.head, layout.foot, plan!.stand).exposure).toBe(0);
    expect(landingBedSelf(built, layout.head, layout.foot, plan!.stand).expected).toBe(1);
    expect([...layout.supports, ...layout.screen].every(p => ['bedrock', 'obsidian'].includes(built(p)!.name))).toBe(true);
    expect([layout.head, layout.foot, { ...layout.foot, y: layout.foot.y - 1 }].every(p => bedEyeReach(plan!.stand, p) <= 4.5)).toBe(true);
  });

  it('counts every new support cell once against real inventory; confirmed construction is reusable with zero stock', () => {
    const target = { x: 3.5, y: 74, z: 8.5 }, read = terrain(target), history = inbound(target);
    expect(drain(landingCompactStandSearch(target, target, read, 0, 20, history))).toBeNull();
    for (const budget of [1, 2, 3, 4, 12]) {
      const plan = drain(landingCompactStandSearch(target, target, read, budget, 20, history));
      if (plan) expect(new Set([...plan.footing, ...plan.screen].map(key)).size).toBeLessThanOrEqual(budget);
    }
    const plan = drain(landingCompactStandSearch(target, target, read, 12, 20, history))!;
    const built = landingProjectedRead(read, [...plan.footing, ...plan.screen]);
    const reused = drain(landingCompactStandSearch(target, target, built, 0, 20, history));
    expect(reused).not.toBeNull();
    expect([...reused!.footing, ...reused!.screen]).toEqual([]);
  });

  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('orders transverse axes from the present inbound bearing (yaw %s)', yaw => {
    const target = { x: -12.5, y: 80, z: 17.5 }, direction = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const history = inbound(target).map(p => ({ ...p, yaw, position: { x: target.x - direction.x * (40 - p.tick / 3),
      y: p.position.y, z: target.z - direction.z * (40 - p.tick / 3) } }));
    const plan = drain(landingCompactStandSearch(target, target, terrain(target), 12, 20, history));
    expect(plan).not.toBeNull();
    const { head, foot } = plan!.options[0];
    expect(Math.abs((foot.x - head.x) * direction.x + (foot.z - head.z) * direction.z)).toBeCloseTo(0);
    expect(head.y).toBe(target.y - 1);
  });

  it('does not invent a floor in unread space, excavate a fragile stand floor, or prepare without a current phase-2 bearing', () => {
    const target = { x: 3.5, y: 74, z: 8.5 }, read = terrain(target), history = inbound(target);
    expect(drain(landingCompactStandSearch(target, target, () => null, 12, 20, history))).toBeNull();
    const missingSupport = (p: P3) => p.y <= target.y - 2 ? null : read(p);
    expect(drain(landingCompactStandSearch(target, target, missingSupport, 12, 20, history))).toBeNull();
    const fragileFloor = (p: P3) => { const b = read(p); return b === solid ? { ...solid, name: 'end_stone' } : b; };
    expect(drain(landingCompactStandSearch(target, target, fragileFloor, 12, 20, history))).toBeNull();
    expect(drain(landingCompactStandSearch(target, target, read, 12, 20, []))).toBeNull();
    expect(drain(landingCompactStandSearch(target, target, read, 12, 20, history.map(p => ({ ...p, phase: 3 }))))).toBeNull();
    expect(drain(landingCompactStandSearch(target, target, read, 12, 5, history))).toBeNull();
  });

  it('does not count an occupied end-stone support as already durable or replace it without digging', () => {
    const target = { x: 3.5, y: 74, z: 8.5 }, read = terrain(target), history = inbound(target);
    const cap = (p: P3) => p.y === target.y - 2 ? { ...solid, name: 'end_stone' } : read(p);
    const plan = drain(landingCompactStandSearch(target, target, cap, 12, 20, history));
    if (plan) {
      const built = landingProjectedRead(cap, [...plan.footing, ...plan.screen]);
      expect(plan.options[0].supports.every(p => ['bedrock', 'obsidian'].includes(built(p)!.name))).toBe(true);
      expect([...plan.footing, ...plan.screen].some(p => cap(p).name === 'end_stone')).toBe(false);
    }
  });

  it('keeps the successful all-bearing layout first and returns control between bounded pieces of the fallback search', () => {
    const target = { x: 3.5, y: 74, z: 8.5 }, read = terrain(target), history = inbound(target);
    const old = drain(landingFountainStandSearch(target, target, read, 16, 20));
    const withHistory = drain(landingFountainStandSearch(target, target, read, 16, 20, history));
    expect(withHistory).toEqual(old);
    expect(withHistory!.options).toHaveLength(20);
    let now = 0, slices = 0;
    const search = landingFountainStandSearch(target, target, read, 12, 20, history);
    let result;
    do { slices++; result = advanceBedSearch(search, 2, () => now += .25); } while (!result.done);
    expect(slices).toBeGreaterThan(1);
    expect(result.value).not.toBeNull();
  });
});
