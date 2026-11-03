import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { ENDERMAN_EYE, ENDERMAN_FEET, atRoofCentre, endermanLine, endermanStrikePoint, endermanView, looksAtEyes, planRoof, roofBlockFor, roofSites, type Cell3, type RoofPlan, type RoofWorld } from '../../src/services/minebot/utils/huntEnderman.js';
import type { BlockReader } from '../../src/services/minebot/utils/localMap.js';

// The roof over an enderman hunt (S2, 2026-11-02): a plan that leaves no cell round the body where an enderman (2.9 tall, 0.6 wide) can stand lower than the roof
// and reach the body, with every block laid against one already standing.

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
/** A flat world with its floor's top at y = floor (everything at or under it is solid), plus extra solid cells and holes cut in the floor. */
function world(options: { floor?: number; solids?: Array<[number, number, number]>; holes?: Array<[number, number, number]>; unloaded?: (x: number, y: number, z: number) => boolean } = {}): RoofWorld {
  const floor = options.floor ?? -1;
  const solids = new Set((options.solids ?? []).map(([x, y, z]) => key(x, y, z)));
  const holes = new Set((options.holes ?? []).map(([x, y, z]) => key(x, y, z)));
  const solid = (x: number, y: number, z: number) => holes.has(key(x, y, z)) ? false : y <= floor || solids.has(key(x, y, z));
  return { solid: (x, y, z) => options.unloaded?.(x, y, z) ? null : solid(x, y, z), replaceable: (x, y, z) => !solid(x, y, z) };
}

/** Lays the plan in order on a copy of the world: every block must have a standing block beside it when its turn comes, be within reach, and keep out of the body's cells. */
function check(base: RoofWorld, plan: RoofPlan) {
  const laid = new Set<string>();
  const standing = (x: number, y: number, z: number) => laid.has(key(x, y, z)) || base.solid(x, y, z) === true;
  const { x: cx, y: cy, z: cz } = plan.cell;
  for (const c of plan.placements) {
    expect(base.solid(c.x, c.y, c.z)).toBe(false);
    expect([[0, 0], [0, 1]].some(([, up]) => c.x === cx && c.z === cz && c.y === cy + up)).toBe(false);
    const faces: Array<[number, number, number]> = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    expect(faces.some(([a, b, d]) => standing(c.x + a, c.y + b, c.z + d))).toBe(true);
    expect(Math.hypot(c.x + 0.5 - (cx + 0.5), c.y + 0.5 - (cy + 1.62), c.z + 0.5 - (cz + 0.5))).toBeLessThanOrEqual(4.4);
    laid.add(key(c.x, c.y, c.z));
  }
  const solid = (x: number, y: number, z: number) => standing(x, y, z);
  // Round the body: no cell an enderman can stand in, with its head above the body's feet.
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue;
    for (let yn = cy - 2; yn <= cy + 1; yn++) {
      const fits = !solid(cx + dx, yn, cz + dz) && !solid(cx + dx, yn + 1, cz + dz) && !solid(cx + dx, yn + 2, cz + dz) && solid(cx + dx, yn - 1, cz + dz);
      expect(fits, `an enderman stands at (${cx + dx},${yn},${cz + dz})`).toBe(false);
    }
  }
  // The cell above the head is covered.
  expect(solid(cx, cy + 2, cz)).toBe(true);
}

describe('planRoof: the 3x3 over the body', () => {
  it('the live nine-cap plan includes a cap above existing walls, and identifies only its own temporary supports', () => {
    const wall = planRoof(world({ solids: [[1, 0, 0], [1, 1, 0]] }), { x: 0, y: 0, z: 0 }, undefined, undefined, true);
    expect(wall.caps).toBe(9);
    expect(wall.placements).toContainEqual({ x: 1, y: 2, z: 0 });
    expect(wall.supports).toEqual([]);
    const flat = planRoof(world(), { x: 0, y: 0, z: 0 }, undefined, undefined, true);
    expect(flat.supports).toHaveLength(2);
    expect(flat.supports.every(c => c.y >= 0 && c.y < 2)).toBe(true);
    expect(atRoofCentre({ x: 0.7, y: 0, z: 0.3 }, flat.cell)).toBe(true);
    expect(atRoofCentre({ x: 0.701, y: 0, z: 0.5 }, flat.cell)).toBe(false);
  });
  it('on flat ground: the support column, then the nine caps (11 blocks), each laid against one standing', () => {
    const w = world();
    const plan = planRoof(w, { x: 0, y: 0, z: 0 });
    expect(plan.problems).toEqual([]);
    expect(plan.caps).toBe(9);
    expect(plan.placements).toHaveLength(11);
    check(w, plan);
    // the caps are at the body's feet + 2, over the nine columns
    const caps = plan.placements.filter(c => c.y === 2);
    expect(new Set(caps.map(c => key(c.x, c.y, c.z))).size).toBe(9);
    // the two supports stand at the body's height, in one column
    const supports = plan.placements.filter(c => c.y < 2);
    expect(supports).toHaveLength(2);
    expect(supports[0].x).toBe(supports[1].x);
    expect(supports[0].z).toBe(supports[1].z);
  });

  it('the support column goes on the side away from the enderman (it would block the look to it)', () => {
    const w = world();
    const away = planRoof(w, { x: 0, y: 0, z: 0 }, { x: 1, z: 0 });            // the enderman is east
    const column = away.placements.filter(c => c.y < 2);
    expect(column.every(c => c.x === -1)).toBe(true);
    const other = planRoof(w, { x: 0, y: 0, z: 0 }, { x: -1, z: 0 });
    expect(other.placements.filter(c => c.y < 2).every(c => c.x === 1)).toBe(true);
  });

  it('a two-high wall on one side needs no cap over it, and serves as the support', () => {
    const wall: Array<[number, number, number]> = [[1, 0, 0], [1, 1, 0]];
    const w = world({ solids: wall });
    const plan = planRoof(w, { x: 0, y: 0, z: 0 });
    expect(plan.problems).toEqual([]);
    expect(plan.caps).toBe(8);
    expect(plan.placements.length).toBeLessThanOrEqual(9);
    check(w, plan);
  });

  it('a tunnel with its own roof (solid at feet + 2 over everything) needs nothing laid', () => {
    const solids: Array<[number, number, number]> = [];
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) solids.push([x, 2, z]);
    const plan = planRoof(world({ solids }), { x: 0, y: 0, z: 0 });
    expect(plan.problems).toEqual([]);
    expect(plan.placements).toEqual([]);
    expect(plan.caps).toBe(0);
  });

  it('a pit beside the body where an enderman could stand lower and reach it is filled first', () => {
    // The floor cell east of the body is open and the one under it is solid: an enderman at feet y -1 has its head at 1.9, above the body's feet.
    const w = world({ holes: [[1, -1, 0]] });
    const plan = planRoof(w, { x: 0, y: 0, z: 0 });
    expect(plan.problems).toEqual([]);
    expect(plan.placements[0]).toEqual({ x: 1, y: -1, z: 0 });
    check(w, plan);
  });

  it('a hole deep enough that an enderman at the bottom has its head under the body\'s feet is no danger (nothing laid for it)', () => {
    const holes: Array<[number, number, number]> = [];
    for (let y = -1; y >= -5; y--) holes.push([1, y, 0]);                  // a shaft beside the body, five deep: its bottom (y -6) is solid
    const w = world({ holes });
    const plan = planRoof(w, { x: 0, y: 0, z: 0 });
    expect(plan.problems).toEqual([]);
    expect(plan.placements.some(c => c.x === 1 && c.z === 0 && c.y < 0)).toBe(false);
    check(w, plan);
  });

  it('on a pillar over a void: a column of supports from the floor block up is laid first (three of them, then nine caps)', () => {
    const w: RoofWorld = {
      solid: (x, y, z) => x === 0 && z === 0 && y <= -1,
      replaceable: (x, y, z) => !(x === 0 && z === 0 && y <= -1),
    };
    const plan = planRoof(w, { x: 0, y: 0, z: 0 });
    expect(plan.problems).toEqual([]);
    expect(plan.caps).toBe(9);
    expect(plan.placements.length).toBeGreaterThan(11);
    check(w, plan);
  });

  it('says what is wrong: no floor, the body\'s cells filled, a column not loaded', () => {
    expect(planRoof(world({ floor: -3 }), { x: 0, y: 0, z: 0 }).problems.join()).toContain('床が無い');
    expect(planRoof(world({ solids: [[0, 1, 0]] }), { x: 0, y: 0, z: 0 }).problems.join()).toContain('体のマス');
    const partly = planRoof(world({ unloaded: (x, y) => x === 1 && y === 2 }), { x: 0, y: 0, z: 0 });
    expect(partly.problems.join()).toContain('未ロード');
  });
});

describe('the block for the roof, and the look', () => {
  const pack = (...items: Array<[string, number]>) => ({ inventory: { items: () => items.map(([name, count]) => ({ name, count })) } });
  it('the first kind in the order that is carried enough of; else the most of all; else none', () => {
    expect(roofBlockFor(pack(['cobblestone', 20], ['dirt', 64]), 11)).toEqual({ name: 'cobblestone', count: 20 });
    expect(roofBlockFor(pack(['cobblestone', 5], ['dirt', 64]), 11)).toEqual({ name: 'dirt', count: 64 });
    expect(roofBlockFor(pack(['cobblestone', 5], ['dirt', 3]), 11)).toEqual({ name: 'cobblestone', count: 5 });
    expect(roofBlockFor(pack(['sand', 64], ['diamond', 3]), 11)).toBeNull();
  });

  it('the look is on the eyes by the server\'s own measure: within 1 - 0.025 / distance', () => {
    const from = new Vec3(0.5, 1.62, 0.5);
    const enderman = { x: 0.5, y: 0, z: -9.5 };                                // ten blocks north, same level
    const exactPitch = Math.atan2(ENDERMAN_EYE - 1.62, 10);
    expect(looksAtEyes(from, 0, exactPitch, enderman)).toBe(true);
    expect(looksAtEyes(from, 0, exactPitch - 0.03, enderman)).toBe(true);        // 1.7 degrees off: inside the 4-degree cone of ten blocks
    expect(looksAtEyes(from, 0, exactPitch - 0.1, enderman)).toBe(false);        // 5.7 degrees off: outside it
    expect(looksAtEyes(from, 0, -0.3, enderman)).toBe(false);                   // looking down 17 degrees: at its feet
    expect(looksAtEyes(from, Math.PI / 2, exactPitch, enderman)).toBe(false);  // turned away
  });
});

describe('the Nether forests\' floor plants', () => {
  it('roots and sprouts are blocks\' to take the place of (as the game: a roof site on the warped forest\'s floor was refused for them in the lab)', async () => {
    const { PLACE_REPLACEABLE } = await import('../../src/services/minebot/utils/primitives/place.js');
    for (const name of ['warped_roots', 'crimson_roots', 'nether_sprouts', 'hanging_roots', 'air', 'short_grass']) expect(PLACE_REPLACEABLE.has(name), name).toBe(true);
    for (const name of ['warped_fungus', 'crimson_fungus', 'nether_wart', 'netherrack', 'warped_nylium']) expect(PLACE_REPLACEABLE.has(name), name).toBe(false);
  });
});

describe('roofSites: a cell where the roof can be made, on ground where the body\'s own cell cannot', () => {
  it('a step beside the body that cannot be filled refuses its cell and those next to it; the flat cell a block off is offered', () => {
    const base = world({ holes: [[1, -1, 0]] });
    // The floor cell east of the body is open (a step of one) and holds something a block may not be put over.
    const w: RoofWorld = { solid: base.solid, replaceable: (x, y, z) => !(x === 1 && y === -1 && z === 0) && base.replaceable(x, y, z) };
    expect(planRoof(w, { x: 0, y: 0, z: 0 }).problems.length).toBeGreaterThan(0);
    const sites = roofSites(w, { x: 0, y: 0, z: 0 }, 7);
    expect(sites.length).toBeGreaterThan(0);
    // (the step itself, one deep with walls round it, is the cheapest site of all; the flat cell a block to the west is another)
    expect(sites.some(site => site.cell.x === -1 && site.cell.y === 0 && site.cell.z === 0)).toBe(true);
    for (const site of sites) expect(planRoof(w, site.cell).problems, `${site.cell.x},${site.cell.z}`).toEqual([]);
    expect(sites.some(site => site.cell.x === 0 && site.cell.z === 0)).toBe(false);
  });

  it('fewest blocks first: a cell beside a two-high wall needs fewer than open ground, even when it is farther', () => {
    const solids: Array<[number, number, number]> = [];
    for (let z = -2; z <= 2; z++) for (const y of [0, 1]) solids.push([4, y, z]);
    const w = world({ solids });
    const sites = roofSites(w, { x: 0, y: 0, z: 0 }, 7);
    expect(sites[0].blocks).toBeLessThan(11);
    expect(sites[0].cell.x).toBe(3);
    expect(sites[0].distance).toBeGreaterThan(1);
  });

  it('no standing ground in reach: nothing is offered, and the radius is a circle', () => {
    const nothing: RoofWorld = { solid: () => false, replaceable: () => true };
    expect(roofSites(nothing, { x: 0, y: 0, z: 0 }, 5)).toEqual([]);
    const w = world();
    expect(roofSites(w, { x: 0, y: 0, z: 0 }, 3, undefined, 400).every(site => site.distance <= 3)).toBe(true);
  });
});

describe('the working lines after the roof is placed', () => {
  const from = { x: 0.5, y: 0, z: 0.5 };
  const roofRead = (blocks: Record<string, string> = {}): BlockReader => (x, y, z) => {
    const name = blocks[key(x, y, z)] ?? (y < 0 ? 'stone' : y === 2 && Math.abs(x) <= 1 && Math.abs(z) <= 1 ? 'cobblestone' : 'air');
    return { name, solid: !['air', 'fire', 'lava'].includes(name) };
  };

  it('a close enderman has its eyes hidden by the roof but its lower body is clear and within striking distance', () => {
    const target = { x: 2.5, y: 0, z: 0.5 }, view = endermanView(roofRead(), from, target);
    expect(view.eyes.clear).toBe(false);
    expect(view.eyes.between[0].name).toBe('cobblestone');
    expect(view.feet.clear).toBe(true);
    expect(view.approach.clear).toBe(true);
    expect(endermanStrikePoint(roofRead(), from, target)).not.toBeNull();
    expect(endermanStrikePoint(roofRead({ '1,1,0': 'stone' }), from, target)).toBeNull();
    expect(endermanStrikePoint(roofRead(), from, { x: 8.5, y: 0, z: 0.5 })).toBeNull();
  });

  it('a clear eye ray does not prove an approach: a two-high passage has no route for a three-high enderman', () => {
    const read: BlockReader = (x, y, z) => {
      // A narrow corridor, two high across x=3: both rays fit, the enderman does not.
      const solid = y < 0 || Math.abs(z) >= 1 || (x === 3 && y >= 2);
      return { name: solid ? 'stone' : 'air', solid };
    };
    const view = endermanView(read, from, { x: 10.5, y: 0, z: 0.5 });
    expect(view.eyes.clear).toBe(true);
    expect(view.feet.clear).toBe(true);
    expect(view.approach.clear).toBe(false);
  });

  it('a nearby warped stem and an unloaded cell block the whole ray, including the first two metres', () => {
    for (const name of ['warped_stem', 'unloaded']) {
      const base = roofRead();
      const read: BlockReader = (x, y, z) => x === 1 && y === 1 && z === 0 ? name === 'unloaded' ? null : { name, solid: true } : base(x, y, z);
      const view = endermanView(read, from, { x: 12.5, y: 0, z: 0.5 });
      expect(view.eyes.clear).toBe(false);
      expect(view.feet.clear).toBe(false);
      expect(view.eyes.between[0].name).toBe(name === 'unloaded' ? '未ロード' : name);
    }
  });

  it('the support plan leaves both rays clear even when the preferred support side faces the elevated target', () => {
    const base = world(), target = { x: 12.5, y: 1, z: 0.5 };
    const plan = planRoof(base, { x: 0, y: 0, z: 0 }, { x: -1, z: 0 }, target);
    expect(plan.problems).toEqual([]);
    check(base, plan);
    const laid = new Set(plan.placements.map(c => key(c.x, c.y, c.z)));
    const read: BlockReader = (x, y, z) => {
      const solid = laid.has(key(x, y, z)) || base.solid(x, y, z) === true;
      return { name: solid ? 'cobblestone' : 'air', solid };
    };
    expect(endermanLine(read, from, target, ENDERMAN_EYE).clear).toBe(true);
    expect(endermanLine(read, from, target, ENDERMAN_FEET).clear).toBe(true);
  });
});
