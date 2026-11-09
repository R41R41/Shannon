import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { floorOpensWhenUsed, planBedSpot } from '../../src/services/minebot/utils/bedSpot.js';

const { default: SleepInBed, bedSpotFailedLately, isFreeCell, noteBedSpotFailed } = await import('../../src/services/minebot/instantSkills/sleepInBed.js');

// end1109o11: two nights the sleep chose the cell over the crafting table she had set beside her; the place is a right click on the floor,
// which opened the table, and the same cell came back each time (about 6.5 minutes of the first night, 1.5 of the next).

const solid = (name = 'stone') => ({ name, boundingBox: 'block', diggable: true, shapes: [[0, 0, 0, 1, 1, 1]] });
const air = { name: 'air', boundingBox: 'empty', shapes: [] };

/** A flat floor at y=60 with a crafting table at (1,60,0) beside her feet (0,61,0); everything above is air. */
function world(table = new Vec3(1, 60, 0)) {
  return (pos: Vec3) => {
    const p = pos.floored();
    if (p.equals(table)) return solid('crafting_table');
    return p.y <= 60 ? solid('stone') : air;
  };
}

describe('a bed is not set on a block that opens when used (end1109o11)', () => {
  it('names crafting tables, furnaces, chests and beds as such, and not rock', () => {
    for (const name of ['crafting_table', 'furnace', 'chest', 'barrel', 'white_bed', 'oak_door', 'note_block']) expect(floorOpensWhenUsed(solid(name))).toBe(true);
    for (const name of ['stone', 'dirt', 'cobblestone', 'deepslate']) expect(floorOpensWhenUsed(solid(name))).toBe(false);
  });

  it('the sleep never chooses the cell over the crafting table', () => {
    const blockAt = world();
    // Nearest the eyes would be (1,61,0) (over the table); she stands with the table to the east.
    const bot: any = { entity: { position: new Vec3(0.65, 61, 0.5) }, blockAt };
    const spot = new SleepInBed(bot).findPlaceForBed()!;
    expect(spot).not.toBeNull();
    expect(spot.equals(new Vec3(1, 61, 0))).toBe(false);
    expect(blockAt(spot.offset(0, -1, 0)).name).toBe('stone');
  });

  it('a made spot does not use the table as its floor', () => {
    // A rock passage one wide: only the cells east over the table and beyond are open, so the plan must dig elsewhere or give up.
    const table = new Vec3(1, 60, 0);
    const blockAt = (pos: Vec3) => {
      const p = pos.floored();
      if (p.equals(table)) return solid('crafting_table');
      if (p.y <= 60) return solid('stone');
      if ((p.y === 61 || p.y === 62) && p.z === 0 && p.x >= 0 && p.x <= 2) return air;
      return solid('stone');
    };
    const plan = planBedSpot({ blockAt }, { x: 0.5, y: 61, z: 0.5 }, { isFree: isFreeCell, hasPickaxe: true, fillers: 10, body: [new Vec3(0, 61, 0), new Vec3(0, 62, 0)] });
    expect(plan).not.toBeNull();
    for (const cell of [plan!.pos, plan!.head]) expect(blockAt(cell.offset(0, -1, 0)).name).not.toBe('crafting_table');
  });

  it('a foot cell where no bed came is not chosen again for ten minutes', () => {
    const bot: any = { entity: { position: new Vec3(0.3, 61, 0.5) }, blockAt: world(new Vec3(50, 60, 50)) };
    const first = new SleepInBed(bot).findPlaceForBed()!;
    noteBedSpotFailed(first, Date.now());
    expect(bedSpotFailedLately(first)).toBe(true);
    const second = new SleepInBed(bot).findPlaceForBed()!;
    expect(second).not.toBeNull();
    expect(second.equals(first)).toBe(false);
    expect(bedSpotFailedLately(first, Date.now() + 11 * 60_000)).toBe(false);
  });
});
