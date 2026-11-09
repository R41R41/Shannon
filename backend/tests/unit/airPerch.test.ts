import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';

const { airPerchHint } = await import('../../src/services/minebot/utils/shaftDown.js');
const { airUnder, AIR_LAY_DROP } = await import('../../src/services/minebot/utils/primitives/go.js');

const SOLID_BELOW = 60;
/** Open air above y=60, stone at and under it, with the cells given by name. */
function world(cells: Record<string, string> = {}) {
  const nameAt = (x: number, y: number, z: number) => cells[`${x},${y},${z}`] ?? (y <= SOLID_BELOW ? 'stone' : 'air');
  return {
    nameAt,
    blockAt: (p: Vec3) => {
      const name = nameAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return { name, boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block', diggable: name !== 'bedrock' };
    },
  };
}
/** A one-wide column of dirt from y=61 up to the given top. */
function pillar(top: number, x = 0, z = 0) {
  const cells: Record<string, string> = {};
  for (let y = SOLID_BELOW + 1; y <= top; y++) cells[`${x},${y},${z}`] = 'dirt';
  return cells;
}

describe('a perch left in the air by a placed stair (h32b: lifted to y106, 16 levels over open air, stairs down refused)', () => {
  it('names a straight shaft down to the ground when the column under the feet is solid', () => {
    const w = world(pillar(69));
    expect(airPerchHint(w as never, new Vec3(0, 70, 0))).toBe('宙の足場（落差 9）: ここから vertical down shape=shaft toY=61 で真下へ下りられる');
  });
  it('says to walk back along the placed blocks when nothing solid is under the floor', () => {
    const w = world({ '0,69,0': 'cobblestone' });
    expect(airPerchHint(w as never, new Vec3(0, 70, 0))).toBe('宙の足場（落差 9）で真下の列は固くない: 置いてきた足場を go で戻り地面へ');
  });
  it('sends the body to the top of the column beside a one-block ledge', () => {
    const w = world({ ...pillar(69, 1, 0), '0,70,0': 'cobblestone' });
    expect(airPerchHint(w as never, new Vec3(0, 71, 0))).toBe('宙の足場（落差 10）: 隣の (1,70,0) へ移り vertical down shape=shaft toY=61 で下りる');
  });
  it('names the step off into deep water first: water takes a fall from any height (end1109s10: 370 s on a perch 24 over the sea)', () => {
    const cells: Record<string, string> = { ...pillar(69) };
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (x || z) for (let y = 58; y <= 60; y++) cells[`${x},${y},${z}`] = 'water';
    expect(airPerchHint(world(cells) as never, new Vec3(0, 70, 0))).toBe('宙の足場（落差 9）: 隣の下 (1,60,0) は深さ 2 以上の水。水に落ちれば傷を受けない: go 1,60,0 waterOk range=1 で飛び降りる');
    const shallow: Record<string, string> = { ...pillar(69) };
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (x || z) shallow[`${x},60,${z}`] = 'water';
    expect(airPerchHint(world(shallow) as never, new Vec3(0, 70, 0))).toBe('宙の足場（落差 9）: ここから vertical down shape=shaft toY=61 で真下へ下りられる');
  });
  it('stays quiet on the ground, on a low step, and with nothing under the feet', () => {
    expect(airPerchHint(world() as never, new Vec3(0, 61, 0))).toBeNull();
    expect(airPerchHint(world(pillar(62)) as never, new Vec3(0, 63, 0))).toBeNull();   // two over the ground: just step off
    expect(airPerchHint(world() as never, new Vec3(0, 70, 0))).toBeNull();             // falling, no floor
  });
  it('stays quiet on a cliff edge where only one or two sides drop away', () => {
    const cells: Record<string, string> = {};
    for (let x = -3; x <= 0; x++) for (let y = 61; y <= 69; y++) for (let z = -3; z <= 3; z++) cells[`${x},${y},${z}`] = 'stone';
    expect(airPerchHint(world(cells) as never, new Vec3(0, 70, 0))).toBeNull();
  });
});

describe('the price of laying a block over open air while walking far', () => {
  it('counts the air under a cell up to the drop that makes it a perch', () => {
    const w = world(pillar(64));
    expect(airUnder(w.nameAt, { x: 0, y: 66, z: 0 })).toBe(1);
    expect(airUnder(w.nameAt, { x: 1, y: 66, z: 0 })).toBe(AIR_LAY_DROP);
    expect(airUnder(w.nameAt, { x: 1, y: 62, z: 0 })).toBe(1);
  });
  it('treats water and unloaded cells as not open', () => {
    const w = world({ '0,63,0': 'water' });
    expect(airUnder(w.nameAt, { x: 0, y: 66, z: 0 })).toBe(2);
    expect(airUnder(() => null, { x: 0, y: 66, z: 0 })).toBe(0);
  });
});
