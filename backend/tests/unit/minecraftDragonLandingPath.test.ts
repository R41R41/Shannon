import { describe, expect, it, vi } from 'vitest';
// Geometry imports the existing read-only danger/knock helpers. Cut their service-loader
// edge so these tests never read .env, load a live skill catalog or need credentials.
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import { appendLandingObservation, dragonLandingTarget, interpolateLanding, landingBurstDue, landingDamageDistance,
  landingHeadResidual, landingMode, landingPreparationCorridor, predictLandingPath, type LandingObservation } from '../../src/services/minebot/utils/dragonLandingPath.js';
import { bedCentre, bedDamage, bedEyeReach, bedSelfEstimate, landingBedLayouts, landingBedRefusal, landingBedSelf } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { dragonHeadVanilla } from '../../src/services/minebot/utils/dragonHeadVanilla.js';
import type { P3 } from '../../src/services/minebot/utils/dragonParts.js';

const solid = (name = 'obsidian') => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const target = { x: 103.5, y: 74, z: -39.5 };
const observations = (phase = 3): LandingObservation[] => [0, 3, 6, 9, 12, 15].map(tick => ({ tick, phase, yaw: 0,
  position: { x: target.x, y: target.y + 3, z: target.z - 20 + tick * 0.2 } }));
function terrain() {
  const blocks = new Map<string, ReturnType<typeof solid>>();
  const read = (p: P3) => blocks.get(key(p)) ?? (p.y < target.y - 3 && Math.hypot(p.x + 0.5 - target.x, p.z + 0.5 - target.z) < 4 ? solid('bedrock')
    : p.x === Math.floor(target.x) && p.z === Math.floor(target.z) && p.y < target.y ? solid('bedrock') : air);
  return { blocks, read };
}

describe('M2 packet history and landing target', () => {
  it('uses the highest blocking cell in only the translated central column, rejecting unloaded sky', () => {
    const t = terrain();
    expect(dragonLandingTarget(target, 60, 100, t.read)).toEqual(target);
    t.blocks.set(key({ x: 104, y: 90, z: -40 }), solid());
    expect(dragonLandingTarget(target, 60, 100, t.read)).toEqual(target);
    t.blocks.set('103,74,-40', solid());
    expect(dragonLandingTarget(target, 60, 100, t.read)).toEqual({ ...target, y: 75 });
    expect(dragonLandingTarget(target, 60, 100, p => p.y === 95 ? null : t.read(p))).toBeNull();
  });
  it('interpolates 3-tick positions/yaw, replaces same-tick packets and never fills long gaps', () => {
    const h = observations();
    expect(interpolateLanding(h, 4)?.position.z).toBeCloseTo(target.z - 19.2);
    expect(interpolateLanding(h, 16)).toBeNull();
    const updated = appendLandingObservation(h, { ...h[5], position: { ...h[5].position, y: 99 } });
    expect(updated).toHaveLength(6); expect(updated.at(-1)?.position.y).toBe(99); expect(h[5].position.y).not.toBe(99);
    expect(appendLandingObservation(h, { ...h[5], tick: 30 })).toHaveLength(1);
    expect(appendLandingObservation(h, { ...h[5], phase: 7 })).toEqual([]);
    const wrapped = [{ ...h[0], yaw: Math.PI - 0.1 }, { ...h[1], yaw: -Math.PI + 0.1 }];
    expect(Math.abs(interpolateLanding(wrapped, 1)!.yaw)).toBeGreaterThan(3);
  });
  it.each([2, 3])('forecasts a straight approach in phase %s for all 1..20 ticks and applies the vanilla head formula', phase => {
    const h = observations(phase), path = predictLandingPath(h, target, 15);
    expect(path.map(p => p.tick)).toEqual(Array.from({ length: 21 }, (_, i) => 15 + i));
    expect(path[20].position.z).toBeCloseTo(h[5].position.z + 4);
    expect(path[20].head).toEqual(dragonHeadVanilla({ position: path[20].position, yaw: 0, yRotA: 0, p: 0, hy: 0 })!.feet);
    expect(predictLandingPath(h, target, 19)).toEqual([]);
    expect(predictLandingPath(h.slice(-2), target, 15)).toEqual([]);
  });
  it('advances between packets, preserves an upward impulse and records future-versus-observed residuals at the SAME tick', () => {
    const h = observations(), predicted = predictLandingPath(h, target, 16)[1];
    const future = { ...h[5], tick: 18, position: { ...h[5].position, z: h[5].position.z + 0.6 } };
    const actual = predictLandingPath([...h, future], target, 18, 0)[0];
    const forecast = predictLandingPath(h, target, 15).find(p => p.tick === 18)!;
    expect(landingHeadResidual(forecast, actual)?.metres).toBeCloseTo(0);
    expect(landingHeadResidual(predicted, actual)).toBeNull();
    h[5] = { ...h[5], velocity: { x: 0, y: 0.33, z: 0.2 } };
    expect(predictLandingPath(h, target, 15)[5].position.y).toBeGreaterThan(h[5].position.y);
    h[5].velocityTick = 17;
    expect(predictLandingPath(h, target, 16, 0)[0].position.y).toBe(h[5].position.y);
    expect(predictLandingPath(h, target, 17, 0)[0].position.y).toBeGreaterThan(h[5].position.y);
  });
});

describe('M2 preparation geometry', () => {
  it('finds pillows and a zero-exposure reachable durable stand from a translated fountain', () => {
    const t = terrain(), corridor = landingPreparationCorridor(observations(2), target);
    const candidates = landingBedLayouts(target, corridor, t.read, 16);
    expect(candidates.length).toBeGreaterThan(0);
    for (const l of candidates.slice(0, 12)) {
      const projected = (p: P3) => l.screen.some(c => key(c) === key(p)) ? solid() : t.read(p);
      const near = corridor.filter(p => Math.hypot(p.head.x - bedCentre(l.head).x, p.head.y - bedCentre(l.head).y, p.head.z - bedCentre(l.head).z) <= 2);
      expect(landingBedRefusal(l, l.stand, near, projected, 20)).toBeNull();
      expect(landingBedSelf(projected, l.head, l.foot, l.stand).exposure).toBe(0);
      for (const p of [l.head, l.foot, ...l.screen]) expect(bedEyeReach(l.stand, p)).toBeLessThanOrEqual(4.5);
      expect(l.screen.every(p => p.x !== Math.floor(target.x) || p.z !== Math.floor(target.z))).toBe(true);
    }
  });
  it('ignores all end-stone shielding and keeps the original self-damage limits', () => {
    const head = { x: 2, y: 3, z: 0 }, foot = { x: 2, y: 3, z: 1 }, feet = { x: 0.5, y: 0, z: 0.5 };
    const wall = (p: P3) => p.x === 1 ? solid('end_stone') : air;
    expect(bedSelfEstimate(wall, head, foot, feet).exposure).toBe(0);
    expect(landingBedSelf(wall, head, foot, feet).exposure).toBe(1);
    const t = terrain(); expect(landingBedLayouts(target, landingPreparationCorridor(observations(2), target), t.read, 16, 5)).toEqual([]);
    expect(landingBedLayouts(target, landingPreparationCorridor(observations(2), target), () => null, 16)).toEqual([]);
  });
  it('vetoes fire, an unloaded neighbour, lost supports, actual reach and a dragon box overlapping the stand', () => {
    const t = terrain(), corridor = landingPreparationCorridor(observations(2), target);
    const l = landingBedLayouts(target, corridor, t.read, 16)[0];
    const near = corridor.filter(p => Math.hypot(p.head.x - bedCentre(l.head).x, p.head.y - bedCentre(l.head).y, p.head.z - bedCentre(l.head).z) <= 2);
    l.screen.forEach(p => t.blocks.set(key(p), solid()));
    const neighbour = { x: Math.floor(l.stand.x) + 1, y: l.stand.y + 1, z: Math.floor(l.stand.z) };
    const changed = (block: ReturnType<typeof solid> | null) => (p: P3) => key(p) === key(neighbour) ? block : t.read(p);
    expect(landingBedRefusal(l, l.stand, near, changed({ ...air, name: 'fire' }), 20)).toBe('landing_fire_or_unloaded_neighbour');
    expect(landingBedRefusal(l, l.stand, near, changed(null), 20)).toBe('landing_fire_or_unloaded_neighbour');
    expect(landingBedRefusal(l, { ...l.stand, x: l.stand.x + 20 }, near, t.read, 20)).toBe('landing_out_of_reach');
    expect(landingBedRefusal(l, l.stand, near, t.read, 5)).toBe('self_damage');
    expect(landingBedRefusal(l, l.stand, [{ ...near[0], position: { ...l.stand } }], t.read, 20)).toBe('landing_stand_in_dragon');
    const support = l.supports.find(p => t.read(p).name === 'obsidian')!;
    expect(landingBedRefusal(l, l.stand, near, p => key(p) === key(support) ? air : t.read(p), 20)).toBe('landing_shield_missing');
    expect(landingBedSelf(t.read, l.head, l.foot, l.stand, { height: 1.5 }).box.maxY).toBeCloseTo(l.stand.y + 1.8);
  });
});

describe('M2 cadence, radii and phase routing', () => {
  const base = { phase: 3, now: 20, lastBlast: 10, head: { x: 2.07, y: 0, z: 0 }, pillow: { x: 0, y: 0, z: 0 }, beds: 4 as const, error: 0 };
  it('admits only the +10 tick slot inside 2.07/3.22 m INCLUDING the prediction error', () => {
    expect(landingBurstDue(base)).toBe(true);
    for (const now of [19, 21, 25]) expect(landingBurstDue({ ...base, now })).toBe(false);
    expect(landingBurstDue({ ...base, error: 0.01 })).toBe(false);
    expect(landingBurstDue({ ...base, beds: 5, head: { x: 3.22, y: 0, z: 0 } })).toBe(true);
    expect(landingBurstDue({ ...base, beds: 5, head: { x: 3.23, y: 0, z: 0 } })).toBe(false);
    for (const phase of [2, 4, 5, 6, 7]) expect(landingBurstDue({ ...base, phase })).toBe(false);
  });
  it('routes 2 -> 3 -> 6 -> 7 -> 5 -> 4 and inverts health losses without treating healing as damage', () => {
    expect([2, 3, 6, 7, 5, 4, null].map(landingMode)).toEqual(['prepare', 'burst', 'seated', 'seated', 'seated', 'leave', 'wait']);
    for (const d of [0, 1, 2.07, 3.22]) expect(landingDamageDistance(bedDamage(d, 1))).toBeCloseTo(d);
    expect(landingDamageDistance(-1)).toBeNull();
  });
});
