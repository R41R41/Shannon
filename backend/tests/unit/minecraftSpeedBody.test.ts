import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';

const { shaftStepRefusal } = await import('../../src/services/minebot/utils/shaftDown.js');
const { solidCellsBetween, minedApproachCost } = await import('../../src/services/minebot/utils/blockApproachCost.js');
const { travelProfile, TRAVEL_DIG_COST, TRAVEL_PLACE_COST } = await import('../../src/services/minebot/utils/travelProfile.js');

/** A world of stone, with the cells given by name. */
function world(cells: Record<string, string> = {}) {
  return {
    blockAt: (p: Vec3) => {
      const name = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? 'stone';
      return { name, boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block', diggable: name !== 'bedrock' };
    },
  };
}

describe('a descent straight down where the rock allows (lab: a stair 2.45 s a level, 70% of it digging three blocks)', () => {
  const feet = new Vec3(0, 40, 0);
  it('digs the block under the feet when solid rock is under that, with no liquid beside', () => {
    expect(shaftStepRefusal(world(), feet)).toBeNull();
  });
  it('never drops into a cave, onto magma, beside water or lava, or through bedrock', () => {
    expect(shaftStepRefusal(world({ '0,38,0': 'cave_air' }), feet)).toBe('no_rock_under');
    expect(shaftStepRefusal(world({ '0,38,0': 'magma_block' }), feet)).toBe('no_rock_under');
    // Gravel under the floor falls into whatever is below it once the floor is gone, the body on top.
    expect(shaftStepRefusal(world({ '0,38,0': 'gravel' }), feet)).toBe('falling_under');
    expect(shaftStepRefusal(world({ '1,39,0': 'lava' }), feet)).toBe('liquid_beside');
    expect(shaftStepRefusal(world({ '0,38,-1': 'water' }), feet)).toBe('liquid_beside');
    expect(shaftStepRefusal(world({ '0,39,0': 'bedrock' }), feet)).toBe('floor_not_diggable');
    expect(shaftStepRefusal(world({ '0,39,0': 'chest' }), feet)).toBe('floor_protected');
  });
});

describe('mine-block ranks an ore in sight before one buried a few blocks nearer', () => {
  it('counts the solid cells on the straight line from the eyes', () => {
    const open = world(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(x => [`${x},41,0`, 'cave_air'])));
    const eyes = new Vec3(0.5, 41.62, 0.5);
    expect(solidCellsBetween(open, eyes, new Vec3(8, 41, 0))).toBe(0);
    expect(solidCellsBetween(world(), eyes, new Vec3(4, 41, 0))).toBe(3);
    // In sight 8 m off beats buried 4 m off.
    expect(minedApproachCost(open, eyes, new Vec3(8, 41, 0))).toBeLessThan(minedApproachCost(world(), eyes, new Vec3(4, 41, 0)));
  });
});

describe('the walk prices digging and laying blocks near their real time', () => {
  it('digs at 3 (a stone block as 8 steps, not 28) and lays a block at 5 steps on land; in water as before', () => {
    const land = travelProfile(false);
    expect(land[6]).toBe(TRAVEL_DIG_COST);
    expect(TRAVEL_DIG_COST).toBe(3);
    expect(land[11]).toBe(true);
    expect(land[12]).toBe(TRAVEL_PLACE_COST);
    expect(travelProfile(true)[6]).toBe(8);
  });
});

const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');

describe('stair-mine past water (mb-body\'s lab: runs 9 and 18 stopped at a source beside the stair, 11 and 12 on a sea)', () => {
  function waterBot(cells: Record<string, string>, items = [{ name: 'cobblestone', count: 32 }]) {
    return {
      version: '1.21.11', interruptExecution: false,
      entity: { position: new Vec3(0.5, 40, 0.5), yaw: 0, onGround: true, isInWater: false },
      inventory: { items: () => items },
      blockAt: (p: Vec3) => {
        const name = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? 'stone';
        return { name, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block', diggable: true, position: p };
      },
    } as any;
  }

  it('puts a carried block into the water beside a block of the stair, then lets it be dug', async () => {
    const cells: Record<string, string> = { '2,40,0': 'water' };
    const skill: any = new StairMine(waterBot(cells));
    skill.sleep = async () => {};
    skill.placeBlockSafe = vi.fn(async (name: string, at: Vec3) => { cells[`${at.x},${at.y},${at.z}`] = name; return true; });
    expect(await skill.plugWaterBeside(new Vec3(1, 40, 0), 'cobblestone')).toBe(true);
    expect(skill.placeBlockSafe).toHaveBeenCalledWith('cobblestone', new Vec3(2, 40, 0));
  });

  it('never fills the cells the body stands in, and says so when there is nothing to fill with', async () => {
    const inBody: any = new StairMine(waterBot({ '0,40,0': 'water' }));
    inBody.placeBlockSafe = vi.fn(async () => true);
    expect(await inBody.plugWaterBeside(new Vec3(1, 40, 0), 'cobblestone')).toBe(false);
    expect(inBody.placeBlockSafe).not.toHaveBeenCalled();
    const empty: any = new StairMine(waterBot({ '2,40,0': 'water' }, []));
    empty.placeBlockSafe = vi.fn(async () => true);
    expect(await empty.plugWaterBeside(new Vec3(1, 40, 0), 'cobblestone')).toBe(false);
  });

  it('afloat, goes to the bank first; still in the water after, says where to go instead of four ways of "water"', async () => {
    const bot = waterBot({});
    bot.entity.isInWater = true;
    const skill: any = new StairMine(bot);
    skill.callSkill = vi.fn(async () => ({ success: false, result: '岸が見つかりません' }));
    const result = await skill.runImpl(10, 'east');
    expect(skill.callSkill).toHaveBeenCalledWith('leave-water');
    expect(result).toMatchObject({ success: false, failureType: 'stair_progress_blocked' });
    expect(result.result).toContain('水の中からは階段を掘れません');
  });
});
