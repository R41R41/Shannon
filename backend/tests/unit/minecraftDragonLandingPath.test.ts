import { describe, expect, it, vi } from 'vitest';
// Geometry imports the existing read-only danger/knock helpers. Cut their service-loader
// edge so these tests never read .env, load a live skill catalog or need credentials.
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import { appendLandingObservation, dragonLandingTarget, interpolateLanding, landingBurstDue, landingDamageDistance,
  landingStandContacts, landingEndHead, landingHeadResidual, landingMode, landingPreparationCorridor, landingReadiness, landingShotWindow, predictLandingPath, type LandingObservation } from '../../src/services/minebot/utils/dragonLandingPath.js';
import { bedCanReplace, supportedBedCells, bedCentre, bedDamage, bedEyeReach, bedSelfEstimate, landingBedLayouts, landingBedRefusal, landingBedSelf } from '../../src/services/minebot/utils/dragonBedGeometry.js';
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
  it.each(['fire', 'soul_fire', 'short_grass', 'tall_grass', 'fern', 'vine', 'leaf_litter'])('replaces %s in both bed halves and support cells without digging', name => {
    const t = terrain(), corridor = landingPreparationCorridor(observations(2), target);
    const l = landingBedLayouts(target, corridor, t.read, 16)[0];
    l.screen.forEach(p => t.blocks.set(key(p), solid()));
    const near = corridor.filter(p => Math.hypot(p.head.x - bedCentre(l.head).x, p.head.y - bedCentre(l.head).y, p.head.z - bedCentre(l.head).z) <= 2);
    const read = (p: P3) => [l.head, l.foot].some(c => key(c) === key(p)) ? { ...air, name } : t.read(p);
    expect(landingBedRefusal(l, l.stand, near, read, 20)).toBeNull();
    const cell = { x: 140, y: 80, z: -40 };
    expect(supportedBedCells([cell], p => p.y < cell.y ? solid() : { ...air, name }, 1)).toEqual([cell]);
  });
  it('does not mistake empty shapes, unknown cells or thick snow for replaceable blocks', () => {
    for (const name of ['torch', 'rail', 'white_bed', 'dandelion', 'obsidian', 'unknown']) expect(bedCanReplace({ ...air, name })).toBe(false);
    expect(bedCanReplace(null)).toBe(false);
    expect(bedCanReplace({ ...air, name: 'snow' })).toBe(false);
    for (const layers of [1, 2, 7, 8]) expect(bedCanReplace({ ...air, name: 'snow', getProperties: () => ({ layers }) })).toBe(layers === 1);
  });
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
  const base = { phase: 3, now: 21, lastBlast: 10, head: { x: 2.07, y: 0, z: 0 }, pillow: { x: 0, y: 0, z: 0 }, beds: 4 as const, error: 0 };
  it('admits any tick after the minimum 11-tick receipt gap inside 2.07/3.22 m INCLUDING the prediction error', () => {
    expect(landingBurstDue(base)).toBe(true);
    for (const now of [19, 20]) expect(landingBurstDue({ ...base, now })).toBe(false);
    for (const now of [21, 25, 34, 58]) expect(landingBurstDue({ ...base, now })).toBe(true);
    for (const lastBlast of [NaN, Infinity, 10.5]) expect(landingBurstDue({ ...base, lastBlast })).toBe(false);
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

describe('M2 r245 regression and near firing horizon', () => {
  it('keeps phase-2 completion through a stale-packet veto; separates every entry predicate', () => {
    const plan = { readyTick: 363, phaseStart: 228, target };
    const h = observations(2);
    // Same failure as r245 at 409: prediction empty at receipt age four.
    expect(predictLandingPath(h, target, 19, 3)).toEqual([]);
    expect(landingReadiness(plan, target, 691)).toEqual({ completedInPhase2: true, beforeEntry: true, targetObserved: true, sameTarget: true, ready: true });
    expect(plan.readyTick).toBe(363);
    expect(landingReadiness({ ...plan, readyTick: null }, target, 691).ready).toBe(false);
    expect(landingReadiness({ ...plan, readyTick: 691 }, target, 691).beforeEntry).toBe(false);
    expect(landingReadiness({ ...plan, readyTick: 227 }, target, 691).completedInPhase2).toBe(false);
    expect(landingReadiness(plan, null, 691).targetObserved).toBe(false);
    expect(landingReadiness(plan, { ...target, y: target.y + 1 }, 691).sameTarget).toBe(false);
  });
  it.each([4, 5] as const)('requires the observed head AND only the +1 head, ignoring a +20 crossing (%s beds)', beds => {
    const h = observations(), window = landingShotWindow(h, target, 15);
    expect(window.map(p => p.tick)).toEqual([15, 16]);
    expect(window[0].head).toEqual(predictLandingPath(h, target, 15, 0)[0].head);
    const pillow = { ...window[1].head };
    expect(window.every(p => landingBurstDue({ phase: 3, now: 15, lastBlast: null, head: p.head, pillow, beds, error: .5 }))).toBe(true);
    const distant = predictLandingPath(h, target, 15, 20).at(-1)!.head;
    expect(landingBurstDue({ phase: 3, now: 15, lastBlast: null, head: distant, pillow: distant, beds, error: 0 })).toBe(true);
    expect(window.every(p => landingBurstDue({ phase: 3, now: 15, lastBlast: null, head: p.head, pillow: distant, beds, error: 0 }))).toBe(false);
    expect(landingShotWindow(h, target, 19)).toEqual([]);
    expect(landingShotWindow(observations(2), target, 15)).toEqual([]);
    // The latest packet remains an observation, not an extrapolated 'now' pose.
    expect(landingShotWindow(h, target, 16).map(p => p.tick)).toEqual([15, 17]);
  });
  it('accepts a fast crossing whose +2 and +3 heads are already outside, but never a predicted-only crossing', () => {
    const h = observations(), hits = landingShotWindow(h, target, 15);
    const pillow = { ...hits[0].head, z: hits[0].head.z - 3 };
    const within = (p: typeof hits[number]) => landingBurstDue({ phase: 3, now: 15, lastBlast: null, head: p.head, pillow, beds: 5, error: 0 });
    expect(hits.every(within)).toBe(true);
    expect(landingShotWindow(h, target, 15, 3).every(within)).toBe(false);
    expect(hits.every(p => within({ ...p, head: { ...p.head, z: p.head.z - 7 } }))).toBe(false);
  });
  it('labels body overlap as diagnostic while preserving head/neck/wing danger and the 0.5m margin', () => {
    const point = predictLandingPath(observations(), target, 15, 0)[0];
    const body = { minX: point.position.x - .1, maxX: point.position.x + .1,
      minY: point.position.y + 1, maxY: point.position.y + 1.1, minZ: point.position.z - .1, maxZ: point.position.z + .1 };
    const contacts = landingStandContacts([point], body);
    expect(contacts.some(c => c.part === 'body' && !c.blocking)).toBe(true);
    expect(contacts.some(c => c.blocking && c.part === 'wing1')).toBe(true);
    expect(landingStandContacts([point], { ...body, minY: point.position.y + 5, maxY: point.position.y + 6 })).toEqual([]);
    const neckBody = { ...point.headBox };
    expect(landingStandContacts([point], neckBody).some(c => c.blocking && c.part === 'head')).toBe(true);
    const wingBody = { ...body, minY: point.position.y, maxY: point.position.y + 1, minX: point.position.x - 4.6, maxX: point.position.x - 4.4 };
    expect(landingStandContacts([point], wingBody).some(c => c.blocking && c.part === 'wing1')).toBe(true);
  });
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('calculates the terminal head from inbound progress and seated height, translated (yaw %s)', yaw => {
    const dir = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const h: LandingObservation[] = [0, 3].map(tick => ({ tick, phase: 3, yaw: yaw + 1,
      position: { x: target.x - dir.x * (8 - tick), y: target.y + 2, z: target.z - dir.z * (8 - tick) } }));
    const end = landingEndHead(h, target)!;
    expect(end.source).toBe('inbound_packet_progress');
    expect(end.head.x).toBeCloseTo(target.x + dir.x * 6.5); expect(end.head.z).toBeCloseTo(target.z + dir.z * 6.5);
    expect(end.head.y).toBe(target.y - 1);
    expect(end.head).toEqual(dragonHeadVanilla({ position: target, yaw: end.yaw, p: 0, hy: -1, yRotA: 0 })!.feet);
    const corridor = landingPreparationCorridor(h, target);
    expect(corridor.some(p => Math.hypot(p.head.x - end.head.x, p.head.y - end.head.y, p.head.z - end.head.z) < .001)).toBe(true);
  });
  it('uses a target bearing while circling, and refuses an unknown direction at the target', () => {
    const h = observations(2); h[5].position.z = h[4].position.z - 1;
    expect(landingEndHead(h, target)?.source).toBe('target_bearing');
    expect(landingEndHead([{ tick: 0, phase: 3, yaw: 1, position: target }], target)).toBeNull();
  });
  it('adds terminal pillows and midpoint hypotheses while retaining the collision and shielding vetoes', () => {
    const h = observations(2).map(p => ({ ...p, yaw: Math.PI / 4, position: { ...p.position, x: target.x - 20 + p.tick * .2 } }));
    const end = landingEndHead(h, target)!, corridor = landingPreparationCorridor(h, target);
    // A translated, observed durable shelf, not a claim about r245 terrain.
    const read = (p: P3) => p.y === target.y - 5
      || (p.x === Math.floor(target.x) && p.z === Math.floor(target.z) && p.y < target.y) ? solid('bedrock') : air;
    const layouts = landingBedLayouts(target, corridor, read, 16, 20, end.head);
    expect(layouts.some(l => l.region === 'central')).toBe(true);
    expect(layouts.some(l => l.region === 'terminal')).toBe(true);
    const midpoint = { x: (target.x + end.head.x) / 2, y: target.y - 1, z: (target.z + end.head.z) / 2 };
    expect(corridor.some(p => Math.hypot(p.head.x - midpoint.x, p.head.y - midpoint.y, p.head.z - midpoint.z) < .001)).toBe(true);
    for (const l of layouts) {
      const projected = (p: P3) => l.screen.some(c => key(c) === key(p)) ? solid() : read(p);
      expect(landingBedSelf(projected, l.head, l.foot, l.stand).exposure).toBe(0);
      expect(l.screen.some(p => p.x === Math.floor(target.x) && p.z === Math.floor(target.z))).toBe(false);
    }
  });
});
