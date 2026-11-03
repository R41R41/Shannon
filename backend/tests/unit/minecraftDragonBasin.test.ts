import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { approachClear, dragonApproach, perchClearance } from '../../src/services/minebot/utils/dragonApproach.js';
import { endObservation } from '../../src/services/minebot/utils/dragonState.js';
import { boxDistance, partBox } from '../../src/services/minebot/utils/dragonParts.js';
import { dragonHazards } from '../../src/services/minebot/utils/dragonDanger.js';
import { goWalkRouteChecker } from '../../src/services/minebot/utils/primitives/go.js';

const island: Ground = (_x, y, _z) => y === 64 ? 'end_stone' : 'air';
function fixture(terrain: Ground = island, yaw = 0) {
  const s = makeSim(terrain, { start: [12.5, 65, 0.5] });
  s.bot.game.dimension = 'minecraft:the_end';
  const metadata: unknown[] = []; metadata[16] = 6; metadata[9] = 200;
  const d = { id: 100, name: 'ender_dragon', position: new Vec3(0.5, 68, 0.5), yaw, metadata };
  s.bot.entities = { 100: d };
  s.world.set(0, 67, 0, 'bedrock');
  return { ...s, d };
}
function cloud(s: ReturnType<typeof fixture>, x: number, z: number) {
  const metadata: unknown[] = []; metadata[8] = 3; metadata[10] = { type: 'dragon_breath' };
  const c = { id: 300, name: 'area_effect_cloud', position: new Vec3(x, 65, z), metadata };
  s.bot.entities[300] = c; return c;
}
const hints = (s: ReturnType<typeof fixture>) => dragonApproach(s.bot, s.d, 6);
afterEach(() => { vi.restoreAllMocks(); });

describe('observed basin footing and go entry', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('prefers lateral footing and measures the actual walk and nearest part (yaw %s)', yaw => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture(island, yaw);
    s.bot.entity.position = new Vec3(0.5 + Math.cos(yaw) * 12, 65, 0.5 - Math.sin(yaw) * 12);
    const basin = hints(s)?.basin!;
    expect(basin).toHaveLength(3);
    for (const p of basin) {
      expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeGreaterThanOrEqual(2);
      expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeLessThanOrEqual(3.2);
      expect(p.side).toBeCloseTo(0);
      expect(p.inWingPush).toBe(true); expect(p.inBreathNow).toBe(false);
      expect(p.walkMeters).toBeGreaterThanOrEqual(Math.hypot(p.x - s.bot.entity.position.x, p.z - s.bot.entity.position.z));
      expect(p.walkSeconds).toBeCloseTo(p.walkMeters / 4.317);
      const reach = Math.min(...(['head', 'neck', 'body', 'wing1', 'wing2'] as const).map(part => boxDistance({ ...p, y: p.y + 1.62 }, partBox(s.d, part))));
      expect(p.headReach).toBeCloseTo(reach);
      expect(perchClearance(s.bot, s.d, 0, false)(p)).toBe(true);
    }
    expect(endObservation(s.bot)?.dragon?.approach?.basin).toEqual(basin);
  });

  it.each([3, 4, 5, 6, 7])('offers waiting footing 10 to 14 m sideways of the facing at phase %s', phase => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture(island, 0); s.d.metadata[16] = phase;
    const wait = dragonApproach(s.bot, s.d, phase)?.wait!;
    expect(wait.length).toBeGreaterThan(0);
    for (const p of wait) {
      const r = Math.hypot(p.x - 0.5, p.z - 0.5);
      expect(r).toBeGreaterThanOrEqual(10); expect(r).toBeLessThanOrEqual(14);
      expect(Math.abs(p.side)).toBeLessThanOrEqual(0.25);
      expect(p.walkSeconds).toBeCloseTo(p.walkMeters / 4.317);
    }
    if (phase === 3 || phase === 4) expect(dragonApproach(s.bot, s.d, phase)?.basin).toBeUndefined();
  });

  it('excludes the front in the forecast breath disc and reports the rear with a negative side', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture((x, y, z) => Math.abs(x) <= 1 && z >= -15 && z <= 12 ? island(x, y, z) : 'air');
    s.bot.entity.position = new Vec3(0.5, 65, -11.5);
    const basin = hints(s)?.basin!;
    expect(basin.length).toBeGreaterThan(0);
    expect(basin.every(p => p.z < 0.5 && p.side < -0.8)).toBe(true);
    expect(perchClearance(s.bot, s.d, 0, false)({ x: 0.5, y: 65, z: 3.5 })).toBe(false);
  });

  it('invalidates cached routes when the same cloud moves, and excludes footing in it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture(), c = cloud(s, -20, -20), before = hints(s)!;
    expect(before.basin).toHaveLength(3);
    expect(hints(s)).toBe(before);
    c.position = new Vec3(0.5, 65, 0.5);
    const after = hints(s)!;
    expect(after).not.toBe(before); expect(after.basin).toBeUndefined();
  });

  it('does not advertise a clear basin across an existing breath cloud', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture((x, y, z) => z === 0 || (x === 0 && z === 9) ? island(x, y, z) : 'air');
    s.bot.entity.position = new Vec3(20.5, 65, 0.5);
    cloud(s, 11.5, 0.5);
    expect(hints(s)?.basin).toBeUndefined();
  });

  it('offers a one-level rise only when go can really jump up it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture(); s.world.set(3, 65, 0, 'end_stone');
    const p = hints(s)?.basin?.find(p => p.x === 3.5 && p.z === 0.5);
    expect(p?.y).toBe(66);
    expect(goWalkRouteChecker(s.bot)([{ x: 4, y: 65, z: 0 }, { x: 3, y: 66, z: 0 }])).toBe(true);
  });

  it('omits the sole one-level higher footing when the approach ceiling prevents a jump (no implicit canPlace)', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const corridor: Ground = (x, y, z) => ((z === 0 && x >= 3 && x <= 14) || (x === 0 && z === 9)) ? island(x, y, z) : 'air';
    const s = fixture(corridor);
    s.world.set(3, 65, 0, 'end_stone'); s.world.set(4, 67, 0, 'end_stone');
    expect(goWalkRouteChecker(s.bot)([{ x: 4, y: 65, z: 0 }, { x: 3, y: 66, z: 0 }])).toBe(false);
    expect(hints(s)?.basin).toBeUndefined();
  });

  it('invalidates on edited ground and height changes; omits basin outside a perch or without a loaded fountain', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = fixture(), before = hints(s)!;
    const p = before.basin![0];
    s.world.set(Math.floor(p.x), p.y - 1, Math.floor(p.z), 'air');
    s.bot.emit('blockUpdate', { position: new Vec3(Math.floor(p.x), p.y - 1, Math.floor(p.z)) }, null);
    const after = hints(s)!;
    expect(after).not.toBe(before); expect(after.basin).not.toContainEqual(p);
    s.bot.entity.position.y += 1;
    expect(hints(s)?.basin).toBeUndefined();
    s.bot.entity.position.y -= 1;
    // landing and take-off offer the waiting footing only: no strike, no stage, no basin
    for (const phase of [3, 4]) { const a = dragonApproach(s.bot, s.d, phase); expect(a?.basin).toBeUndefined(); expect(a?.strike ?? []).toEqual([]); expect(a?.stage ?? []).toEqual([]); }
    s.world.set(0, 67, 0, 'air');
    expect(hints(s)?.basin).toBeUndefined();
  });

  it('bounds both scans and validation by the shared observation budget', () => {
    const s = fixture(); let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time += 2);
    expect(hints(s)?.basin).toBeUndefined();
    expect(time).toBeLessThanOrEqual(130);
  });

  it.each([5, 6, 7])('allows the wing-only walking step at phase %s, and the reflex no longer counts sitting wings as a danger', phase => {
    const s = fixture(); s.d.metadata[16] = phase;
    const p = { x: 9.5, y: 65, z: 0.5 };
    expect(approachClear(s.bot, s.d, p)).toBe(false);
    expect(goWalkRouteChecker(s.bot)([{ x: 10, y: 65, z: 0 }, { x: 9, y: 65, z: 0 }])).toBe(true);
    s.bot.entity.position = new Vec3(p.x, p.y, p.z);
    expect(dragonHazards(s.bot).map(h => h.kind)).not.toContain('wing');
  });

  it.each([3, 4])('preserves go\'s existing non-perched phase gate at phase %s', phase => {
    const s = fixture(); s.d.metadata[16] = phase;
    expect(goWalkRouteChecker(s.bot)([{ x: 10, y: 65, z: 0 }, { x: 9, y: 65, z: 0 }])).toBe(true);
  });

  it('still blocks head/neck contact, existing breath and forecast breath when walking from safe ground', () => {
    const s = fixture();
    s.world.set(0, 66, 5, 'end_stone'); s.world.set(0, 66, 6, 'end_stone');
    expect(goWalkRouteChecker(s.bot)([{ x: 0, y: 67, z: 6 }, { x: 0, y: 67, z: 5 }])).toBe(false);
    s.d.metadata[16] = 4;
    expect(goWalkRouteChecker(s.bot)([{ x: 0, y: 67, z: 6 }, { x: 0, y: 67, z: 5 }])).toBe(true);
    s.d.metadata[16] = 6;
    expect(goWalkRouteChecker(s.bot)([{ x: 0, y: 65, z: 1 }, { x: 0, y: 65, z: 2 }])).toBe(false);
    cloud(s, -10.5, -10.5);
    expect(goWalkRouteChecker(s.bot)([{ x: -10, y: 65, z: -3 }, { x: -10, y: 65, z: -4 }])).toBe(false);
  });
});
