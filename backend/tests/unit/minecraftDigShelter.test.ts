import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import DigShelter from '../../src/services/minebot/instantSkills/digShelter.js';

function botAt(blocks: (pos: Vec3) => { name: string; boundingBox: string; diggable?: boolean }, inWater = false) {
  return { entity: { position: new Vec3(0.5, 64, 0.5), isInWater: inWater },
    blockAt: (pos: Vec3) => ({ position: pos, diggable: true, ...blocks(pos) }),
    inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
    instantSkills: { getSkill: () => ({ run: async () => ({ success: true }) }) } } as any;
}

describe('dig-shelter picks a workable site itself (paid run L17 retried six times beside water)', () => {
  it('moves a block away from water beside the shaft, then digs in and seals', async () => {
    const dug = new Set<string>(); const placed = new Set<string>();
    const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
    const world = (pos: Vec3) => {
      if (placed.has(key(pos))) return { name: 'cobblestone', boundingBox: 'block' };
      if (dug.has(key(pos)) || pos.y >= 64) return { name: 'air', boundingBox: 'empty' };
      if (pos.x === 1 && pos.y === 62 && pos.z === 0) return { name: 'water', boundingBox: 'empty' };
      return { name: 'stone', boundingBox: 'block' };
    };
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false },
      blockAt: (pos: Vec3) => ({ position: pos, diggable: true, ...world(pos) }),
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
      equip: async () => {}, lookAt: async () => {},
      placeBlock: async (reference: any, face: Vec3) => { placed.add(key(reference.position.plus(face))); } };
    const moves: Vec3[] = [];
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to'
      ? { run: async (x: number, y: number, z: number) => { moves.push(new Vec3(x, y, z)); bot.entity.position = new Vec3(x, y, z); return { success: true }; } }
      : { run: async (x: number, y: number, z: number) => { dug.add(`${x},${y},${z}`); bot.entity.position = new Vec3(bot.entity.position.x, y, bot.entity.position.z); return { success: true }; } } };
    const result: any = await new DigShelter(bot).runImpl();
    expect(result.success).toBe(true);
    expect(moves).toHaveLength(1);
    const site = moves[0].floored();
    expect(Math.abs(site.x) + Math.abs(site.z)).toBe(1);
    expect(site.x).not.toBe(1); // not onto the column next to the water... the water column itself is unusable
    expect(result.result).toContain('足元は使えなかったため');
    expect(placed.has(`${site.x},63,${site.z}`)).toBe(true); // roof sealed at ground level
  });
});

describe('dig-shelter safety checks', () => {
  it('refuses water, liquid beside the shaft and a hollow floor before digging', async () => {
    const solid = () => ({ name: 'stone', boundingBox: 'block' });
    expect(await new DigShelter(botAt(solid, true)).runImpl()).toMatchObject({ success: false, failureType: 'invalid_location' });
    const lavaBeside = (pos: Vec3) => pos.x === 1 && pos.y === 62 ? { name: 'lava', boundingBox: 'empty' } : solid();
    expect((await new DigShelter(botAt(lavaBeside)).runImpl()).result).toContain('液体');
    const cave = (pos: Vec3) => pos.y === 60 && pos.x === 0 && pos.z === 0 ? { name: 'air', boundingBox: 'empty' } : solid();
    expect((await new DigShelter(botAt(cave)).runImpl()).result).toContain('穴の底');
  });
});

describe('dig-shelter says why a hole could not be closed (paid run L70 was told to "carry cobblestone" with a stack of it in the pack)', () => {
  const shaftWorld = (dug: Set<string>, placed: Set<string>) => (pos: Vec3) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (placed.has(key)) return { name: 'cobblestone', boundingBox: 'block' };
    if (dug.has(key) || pos.y >= 64) return { name: 'air', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };
  const digger = (placeBlock: (reference: any, face: Vec3, placed: Set<string>) => Promise<void>, items: Array<{ name: string; count: number }>) => {
    const dug = new Set<string>(), placed = new Set<string>();
    const world = shaftWorld(dug, placed);
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false },
      blockAt: (pos: Vec3) => ({ position: pos, diggable: true, ...world(pos) }),
      inventory: { items: () => items }, equip: async () => {}, lookAt: async () => {},
      placeBlock: (reference: any, face: Vec3) => placeBlock(reference, face, placed) };
    bot.instantSkills = { getSkill: () => ({ run: async (x: number, y: number, z: number) => {
      dug.add(`${x},${y},${z}`); bot.entity.position = new Vec3(bot.entity.position.x, y, bot.entity.position.z); return { success: true }; } }) };
    return bot;
  };

  it('a placement that does not take is not "nothing to place": it is tried again, and named for what it is', async () => {
    let attempts = 0;
    const refused = digger(async () => { attempts++; throw new Error('No block has been placed'); }, [{ name: 'cobblestone', count: 64 }]);
    const result: any = await new DigShelter(refused).runImpl();
    expect(result).toMatchObject({ success: false, failureType: 'placement_failed' });
    expect(result.result).toContain('cobblestoneを64個持っていますが');
    expect(result.result).toContain('縦穴');
    expect(attempts).toBeGreaterThanOrEqual(8); // four faces, twice
    // A placement that fails once and then takes closes the hole.
    let calls = 0;
    const flaky = digger(async (reference, face, placed) => { if (++calls === 1) throw new Error('No block has been placed'); placed.add(`${reference.position.x + face.x},${reference.position.y + face.y},${reference.position.z + face.z}`); },
      [{ name: 'cobblestone', count: 64 }]);
    expect((await new DigShelter(flaky).runImpl() as any).success).toBe(true);
  }, 30_000);

  it('with nothing to place it says so', async () => {
    const empty = digger(async () => {}, [{ name: 'iron_pickaxe', count: 1 }]);
    const result: any = await new DigShelter(empty).runImpl();
    expect(result).toMatchObject({ success: false, failureType: 'missing_item' });
    expect(result.result).toContain('持っていません');
  });
});

describe('asked again from inside a closed shelter, dig-shelter leaves it closed (paid run L70 walked out through the wall and died)', () => {
  it('reports the shelter it is in and digs nothing, moves nowhere', async () => {
    // A 1x1 shaft two deep at (0, 62..63, 0), roofed at y=64, in stone; the body stands on its floor.
    const world = (pos: Vec3) => pos.x === 0 && pos.z === 0 && (pos.y === 62 || pos.y === 63)
      ? { name: 'air', boundingBox: 'empty' } : pos.y > 64 ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' };
    const calls: string[] = [];
    const bot: any = { entity: { position: new Vec3(0.5, 62, 0.5), isInWater: false },
      blockAt: (pos: Vec3) => ({ position: pos, diggable: true, ...world(pos) }),
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
      instantSkills: { getSkill: (name: string) => ({ run: async () => { calls.push(name); return { success: true }; } }) } };
    const result: any = await new DigShelter(bot).runImpl();
    expect(result.success).toBe(true);
    expect(result.result).toContain('既に塞いだ縦穴(0, 62, 0)の中にいます');
    expect(calls).toEqual([]);
    // With the roof open it is not a shelter yet: the skill goes to work.
    const open = { ...bot, blockAt: (pos: Vec3) => ({ position: pos, diggable: true, ...(pos.x === 0 && pos.z === 0 && pos.y === 64 ? { name: 'air', boundingBox: 'empty' } : world(pos)) }) };
    const again: any = await new DigShelter(open).runImpl();
    expect(String(again.result)).not.toContain('既に塞いだ縦穴');
  });
});


describe('a cell with nothing solid beside it is closed by way of one block put against the nearest solid first (lab continuation L77r: a shaft in hollow ground that could not be closed)', () => {
  const hollow = () => {
    const placed: string[] = [];
    const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
    // One block of ground under the body, and air all round it.
    const world = (pos: Vec3) => placed.includes(key(pos)) || key(pos) === '0,62,0' ? { name: 'netherrack', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    const bot: any = { entity: { position: new Vec3(0.5, 63, 0.5), isInWater: false },
      blockAt: (pos: Vec3) => ({ position: pos, diggable: true, ...world(pos) }),
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] }, equip: async () => {}, lookAt: async () => {},
      placeBlock: async (reference: any, face: Vec3) => { placed.push(key(reference.position.plus(face))); } };
    return { bot, placed };
  };

  it('puts the support under the cell wanted, against the ground the body stands on, and then the cell itself', async () => {
    const { bot, placed } = hollow();
    const skill: any = new DigShelter(bot);
    expect(await skill.placeAt(new Vec3(0, 63, 1))).toBe(true);
    expect(placed).toEqual(['0,62,1', '0,63,1']);
  });

  it('does not use the cells the body fills, and says so when nothing solid is within one step', async () => {
    const { bot, placed } = hollow();
    const skill: any = new DigShelter(bot);
    expect(await skill.placeAt(new Vec3(0, 65, 3))).toBe(false);
    expect(skill.sealFailure).toContain('隣に支えになるブロックがありません');
    expect(placed).toEqual([]);
    expect(skill.inBody(new Vec3(0, 64, 0))).toBe(true);
    expect(skill.inBody(new Vec3(0, 63, 1))).toBe(false);
  });
});
