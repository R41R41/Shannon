import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { crystalOpenings } from '../../src/services/minebot/utils/dragonOpenings.js';
import { approachClear, dragonApproach, dragonWindows } from '../../src/services/minebot/utils/dragonApproach.js';
import { crystalsOf, endObservation } from '../../src/services/minebot/utils/dragonState.js';
import { boxDistance, boxesOverlap, bodyBoxAt, flameCloudCentre, inflate, partBox, shift, BREATH_RADIUS_MIN } from '../../src/services/minebot/utils/dragonParts.js';
import { cloudReaches, dragonHazards } from '../../src/services/minebot/utils/dragonDanger.js';
import { feetCentre, inland, walkGround, walkRoute } from '../../src/services/minebot/utils/dragonWalk.js';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';
import { aimPitch, arrowBlockedAt } from '../../src/services/minebot/utils/primitives/shoot.js';
import { goWalkRouteChecker } from '../../src/services/minebot/utils/primitives/go.js';
import { resolvePosition } from '../../src/services/minebot/utils/primitives/common.js';

const island: Ground = (x, y, z) => Math.abs(x) <= 45 && Math.abs(z) <= 35 && y === 63 ? 'end_stone' : 'air';
function fixture(terrain: Ground = island, start: [number, number, number] = [0.5, 64, 0.5]) {
  const s = makeSim(terrain, { start });
  s.bot.game.dimension = 'minecraft:the_end';
  s.bot.entities = {};
  return s;
}
function crystal(s: ReturnType<typeof fixture>, id: number, x: number, z: number, cage = false) {
  const y = 68;
  s.bot.entities[id] = { id, name: 'end_crystal', position: new Vec3(x + 0.5, y, z + 0.5), metadata: [] };
  s.world.set(x, y - 1, z, 'bedrock');
  if (cage) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy <= 2; dy++) {
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 2) s.world.set(x + dx, y + dy, z + dz, 'iron_bars');
    }
  }
}
function dragon(s: ReturnType<typeof fixture>, yaw = 0) {
  const metadata: unknown[] = []; metadata[16] = 6; metadata[9] = 200;
  const d = { id: 100, name: 'ender_dragon', position: new Vec3(0.5, 68, 0.5), yaw, metadata };
  s.bot.entities[100] = d; return d;
}
// Deterministic algorithm tests use the cell bound; the clock-budget test below advances the injected clock.
const fixedClock = () => 0;

describe('crystal positions, without moving or shooting', () => {
  it('returns three nearby inland positions and up to three shared shooting sets with real ballistic clearance', () => {
    const s = fixture(); crystal(s, 200, 24, 0); crystal(s, 201, 28, 8);
    const hints = crystalOpenings(s.bot, crystalsOf(s.bot), 0, fixedClock);
    expect(hints.openings).toHaveLength(2);
    const read = bodyReader(s.bot);
    for (const entry of hints.openings) {
      expect(entry.positions).toHaveLength(3);
      const target = s.bot.entities[entry.id].position.offset(0, 1, 0);
      const distances = entry.positions.map(p => new Vec3(p.x, p.y, p.z).distanceTo(s.bot.entity.position));
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
      for (const p of entry.positions) {
        expect(p.distance).toBeGreaterThanOrEqual(13); expect(p.distance).toBeLessThanOrEqual(64);
        expect(inland(read, { x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) })).toBe(true);
        const eyes = new Vec3(p.x, p.y + 1.52, p.z), aim = aimPitch(3, Math.hypot(target.x - p.x, target.z - p.z), target.y - eyes.y)!;
        expect(p.pitchDeg).toBeCloseTo(aim.pitch * 180 / Math.PI);
        expect(p.flightTicks).toBe(aim.ticks);
        expect(arrowBlockedAt(s.bot, eyes, Math.atan2(-(target.x - p.x), -(target.z - p.z)), aim.pitch, 3, aim.ticks + 2, target)).toBeNull();
      }
    }
    expect(hints.shootSets).toHaveLength(3);
    expect(hints.shootSets.map(set => set.walkMeters)).toEqual([...hints.shootSets.map(set => set.walkMeters)].sort((a, b) => a - b));
    expect(hints.shootSets.every(set => set.crystals.length >= 2)).toBe(true);
    expect(hints.stats.examinedCells).toBeGreaterThan(0);
  });

  it('reports bars and only hypothetical positions for a cage, leaving the world untouched', () => {
    const s = fixture(); crystal(s, 200, 24, 0, true);
    const before = [...s.world.changed];
    const entry = crystalOpenings(s.bot, crystalsOf(s.bot), 0, fixedClock).openings[0];
    expect(entry.caged).toBe(true); expect(entry.positions).toEqual([]);
    expect(entry.blockedBy?.name).toBe('iron_bars'); expect(entry.afterCageRemoved).toHaveLength(3);
    expect([...s.world.changed]).toEqual(before);
  });

  it('does not remove an obsidian wall when imagining the cage removed', () => {
    const s = fixture((x, y, z) => x === 4 && y >= 64 && y <= 100 ? 'obsidian' : island(x, y, z));
    crystal(s, 200, 24, 0, true);
    // Enclose the origin side, so the wall cannot be walked around to obtain an opening.
    for (let x = -45; x < 4; x++) for (let z = -35; z <= 35; z++) if (z !== 0) s.world.set(x, 63, z, 'air');
    expect(crystalOpenings(s.bot, crystalsOf(s.bot), 0, fixedClock).openings[0].afterCageRemoved).toEqual([]);
  });

  it('rejects an unconnected patch of island, low ceilings, unknown terrain and unsupported edges', () => {
    const s = fixture((x, y, z) => x >= 2 && x <= 5 ? null : island(x, y, z));
    const search = walkGround(s.bot, { deadline: Infinity, maxCells: 300, clock: fixedClock });
    expect(search.cells.every(n => n.cell.x < 2)).toBe(true);
    expect(inland(search.read, { x: 0, y: 64, z: 0 })).toBe(false);
    s.world.set(0, 65, 0, 'end_stone');
    expect(walkGround(s.bot, { deadline: Infinity }).cells).toEqual([]);
  });

  it('holds the cache for 1.5 seconds, rebuilds only on movement/count changes, and bounds slow work', () => {
    const s = fixture(); crystal(s, 200, 24, 0);
    const first = crystalOpenings(s.bot, crystalsOf(s.bot), 0, fixedClock);
    s.bot.entity.position.x += 4;
    expect(crystalOpenings(s.bot, crystalsOf(s.bot), 1499, fixedClock)).toBe(first);
    const moved = crystalOpenings(s.bot, crystalsOf(s.bot), 1500, fixedClock);
    expect(moved).not.toBe(first);
    expect(crystalOpenings(s.bot, crystalsOf(s.bot), 9000, fixedClock)).toBe(moved);
    crystal(s, 201, 28, 4);
    expect(crystalOpenings(s.bot, crystalsOf(s.bot), 9001, fixedClock)).not.toBe(moved);
    const slow = fixture(); crystal(slow, 200, 24, 0);
    let time = 0;
    const limited = crystalOpenings(slow.bot, crystalsOf(slow.bot), 0, () => time += 2);
    expect(limited.stats.truncated).toBe(true);
    expect(limited.stats.ms).toBeLessThanOrEqual(34);
    expect(limited.stats.examinedCells).toBeLessThan(300);
  });
});

describe('measured perch windows and safe positions', () => {
  it('uses measured ranges and leaves unmeasured flight phases unknown', () => {
    expect(dragonWindows(6, 0)).toMatchObject({ open: true, secondsUntil: [0, 0], lengthSeconds: [2.45, 2.55] });
    expect(dragonWindows(7, 1.25).open).toBe(false);
    expect(dragonWindows(5, 3).secondsUntil).toEqual([6.9, 7]);
    expect(dragonWindows(3, 4).secondsUntil).toEqual([6, 6]);
    expect(dragonWindows(4, 1).secondsUntil).toEqual([22, 47]);
    expect(dragonWindows(0, 1).secondsUntil).toBeNull();
    expect(dragonWindows(null, 1).open).toBe(false);
  });

  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('offers go-reachable positions clear of head/neck/wing contact and future breath (yaw %s)', yaw => {
    const s = fixture(island, [0.5, 64, -10.5]), d = dragon(s, yaw);
    // Position the origin behind this head's forecast breath for each rotation.
    s.bot.entity.position = new Vec3(0.5 - Math.sin(yaw) * 11, 64, 0.5 - Math.cos(yaw) * 11);
    // Clock limits are tested separately; freeze wall time here to avoid host-speed dependent geometry assertions.
    const timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    let hints;
    try { hints = dragonApproach(s.bot, d, 6)!; } finally { timer.mockRestore(); }
    expect(hints.strike.length).toBeGreaterThan(0); expect(hints.strike.length).toBeLessThanOrEqual(3);
    expect(hints.stage?.length).toBeGreaterThan(0); expect(hints.stage!.length).toBeLessThanOrEqual(3);
    expect(hints.retreat.length).toBeGreaterThan(0); expect(hints.retreat.length).toBeLessThanOrEqual(2);
    for (const p of [...hints.strike, ...hints.retreat]) {
      expect(approachClear(s.bot, d, p)).toBe(true);
      for (const part of ['head', 'neck'] as const) expect(boxesOverlap(bodyBoxAt(p), inflate(partBox(d, part), 1.1))).toBe(false);
      for (const part of ['wing1', 'wing2'] as const) expect(boxesOverlap(bodyBoxAt(p), inflate(shift(inflate(partBox(d, part), 4, 2, 4), 0, -2, 0), 0.1))).toBe(false);
      const resolved = resolvePosition({ base: { x: 0, y: 64, z: 0 }, facing: 'north' }, p)!;
      expect(feetCentre(resolved)).toEqual({ x: p.x, y: p.y, z: p.z });
    }
    for (const p of hints.strike) expect(boxDistance({ ...p, y: p.y + 1.62 }, partBox(d, 'head'))).toBeLessThanOrEqual(5);
    const original = s.bot.entity.position.clone();
    for (const p of hints.stage!) {
      expect(inland(bodyReader(s.bot), { x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) })).toBe(true);
      expect(cloudReaches({ ...flameCloudCentre(d), y: 64 }, BREATH_RADIUS_MIN, p, 1.5)).toBe(false);
      s.bot.entity.position = new Vec3(p.x, p.y, p.z);
      for (const phase of [5, 6, 7]) {
        d.metadata[16] = phase;
        expect(dragonHazards(s.bot, { clearance: 1.5 })).toEqual([]);
      }
    }
    s.bot.entity.position = original; d.metadata[16] = 6;
    const takeoff = dragonApproach(s.bot, d, 4); expect(takeoff?.strike ?? []).toEqual([]); expect(takeoff?.stage ?? []).toEqual([]); expect(takeoff?.basin).toBeUndefined();
    expect(goWalkRouteChecker(s.bot)([{ x: -20, y: 64, z: -20 }, { x: -19, y: 64, z: -20 }])).toBe(true);
  });

  it('measures a detour with a wall and a cloud honestly even beyond 8 m, separately from body-to-stage', () => {
    const s = fixture((x, y, z) => x === -2 && z >= -2 && z <= 9 && y >= 64 && y <= 66 ? 'obsidian' : island(x, y, z), [0.5, 64, -10.5]);
    const d = dragon(s);
    const meta: unknown[] = []; meta[8] = 3; meta[10] = { type: 'dragon_breath' };
    s.bot.entities[300] = { id: 300, name: 'area_effect_cloud', position: new Vec3(12.5, 64, 7.5), metadata: meta };
    const timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const hints = dragonApproach(s.bot, d, 5)!;
      expect(hints.stage).toHaveLength(3);
      const original = s.bot.entity.position.clone();
      const fromBody = walkGround(s.bot, { deadline: Infinity, radius: 32, maxCells: 2500, safe: p => approachClear(s.bot, d, p) });
      const distances = hints.stage!.map(p => p.toStrikeMeters);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
      expect(distances[0]).toBeGreaterThan(8);
      for (const p of hints.stage!) {
        expect(dragonHazards({ ...s.bot, entity: { ...s.bot.entity, position: new Vec3(p.x, p.y, p.z) } }, { clearance: 1.5 })).toEqual([]);
        const bodyRoute = fromBody.cells.find(n => n.cell.x === Math.floor(p.x) && n.cell.y === p.y && n.cell.z === Math.floor(p.z))!;
        expect(p.walkMeters).toBeCloseTo(bodyRoute.walkMeters);
        expect(goWalkRouteChecker(s.bot)(walkRoute(bodyRoute))).toBe(true);
        s.bot.entity.position = new Vec3(p.x, p.y, p.z);
        const toStrike = walkGround(s.bot, { deadline: Infinity, radius: 64, maxCells: 9000, safe: at => approachClear(s.bot, d, at) });
        const target = hints.strike[p.strikeIndex];
        expect(target).toBeDefined();
        const reached = toStrike.cells.find(n => n.cell.x === Math.floor(target.x) && n.cell.y === target.y && n.cell.z === Math.floor(target.z))!;
        expect(reached).toBeDefined();
        expect(p.toStrikeMeters).toBeCloseTo(reached.walkMeters);
        expect(goWalkRouteChecker(s.bot)(walkRoute(reached))).toBe(true);
        s.bot.entity.position = original;
      }
    } finally { timer.mockRestore(); }
  });

  it('returns no stage when there is no connected route to a strike', () => {
    const s = fixture((x, y, z) => z === -5 ? null : island(x, y, z), [0.5, 64, -10.5]);
    const d = dragon(s), timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const hints = dragonApproach(s.bot, d, 6)!;
      expect(hints.strike).toEqual([]); expect(hints.stage).toEqual([]);
    } finally { timer.mockRestore(); }
  });

  it('keeps a reachable strike but returns no stage when walls enclose all waiting ground', () => {
    const s = fixture((x, y, z) => y >= 64 && y <= 70 &&
      (((x === 0 || x === 6) && z >= -4 && z <= 5) || ((z === -4 || z === 5) && x >= 0 && x <= 6)) ? 'obsidian' : island(x, y, z), [3.5, 64, -1.5]);
    const d = dragon(s), timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const hints = dragonApproach(s.bot, d, 6)!;
      expect(hints.strike.length).toBeGreaterThan(0);
      expect(hints.stage).toEqual([]);
    } finally { timer.mockRestore(); }
  });

  it('keeps stages in the existing cache and stops all approach work at its shared time budget', () => {
    const s = fixture(island, [0.5, 64, -10.5]), d = dragon(s);
    const timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const first = dragonApproach(s.bot, d, 6)!;
      expect(first.stage?.length).toBeGreaterThan(0);
      expect(dragonApproach(s.bot, d, 5)).toBe(first);
      const slow = fixture(island, [0.5, 64, -10.5]), slowDragon = dragon(slow);
      let time = 0;
      timer.mockImplementation(() => time += 2);
      const limited = dragonApproach(slow.bot, slowDragon, 6)!;
      expect(limited.stage).toEqual([]);
      expect(time).toBeLessThanOrEqual(130);
    } finally { timer.mockRestore(); }
  });

  it('rejects contact boxes and a real cloud, and fails closed when the forecast terrain is unread', () => {
    const s = fixture(), d = dragon(s);
    expect(approachClear(s.bot, d, { x: 0.5, y: 67, z: 7 })).toBe(false);
    expect(approachClear(s.bot, d, { x: -4, y: 68, z: 0.5 })).toBe(false);
    const meta: unknown[] = []; meta[8] = 3; meta[10] = { type: 'dragon_breath' };
    s.bot.entities[300] = { id: 300, name: 'area_effect_cloud', position: new Vec3(3.5, 64, 2.5), metadata: meta };
    expect(approachClear(s.bot, d, { x: 3.5, y: 64, z: 2.5 })).toBe(false);
    const unknown = fixture(() => null);
    expect(approachClear(unknown.bot, d, { x: 3.5, y: 64, z: 2.5 })).toBe(false);
  });

  it('go rejects the future flame on entry and preserves the existing escape when already inside', () => {
    const s = fixture(island, [0.5, 64, -10.5]); dragon(s);
    expect(goWalkRouteChecker(s.bot)([{ x: 0, y: 64, z: 1 }, { x: 0, y: 64, z: 2 }])).toBe(false);
    s.bot.entity.position = new Vec3(0.5, 64, 9.5);
    expect(goWalkRouteChecker(s.bot)([{ x: 0, y: 64, z: 9 }, { x: 0, y: 64, z: 8 }])).toBe(true);
  });

  it('adds optional observation fields and preserves the original fields if a calculation fails', () => {
    const s = fixture(island, [0.5, 64, -10.5]); dragon(s); crystal(s, 200, 24, 0); crystal(s, 201, 28, 8);
    const timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const view = endObservation(s.bot, 0)!;
      expect(view.crystals.openings?.length).toBe(2); expect(view.crystals.shootSets?.length).toBe(3);
      expect(view.dragon?.windows).toBeDefined(); expect(view.dragon?.approach?.strike.length).toBeGreaterThan(0);
      // A fake registry without pathfinder's block definitions: the base observation still survives.
      s.bot.registry = { entitiesByName: {} };
      const failed = endObservation(s.bot, 1600)!;
      expect(failed.dragon?.id).toBe(100); expect(failed.crystals.list).toHaveLength(2);
    } finally { timer.mockRestore(); }
    s.bot.game.dimension = 'overworld'; expect(endObservation(s.bot)).toBeNull();
  });
});
