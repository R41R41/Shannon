import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';

// stair-mine from the sea (ladder probe 2026-10-20, runs 11 and 12): afloat, or on the ice of a frozen sea, every way stopped by
// the water, and no step. The body goes to land first and digs on from there, inland.
const StairMineClass = async () => (await import('../../src/services/minebot/instantSkills/stairMine.js')).default;

/** A sea west of x 20 (seabed y 45, water up to y 62, or ice at y 62 when frozen), land east of it (ground y 64); none when `land` is false. */
const shore = ({ frozen = false, land = true, roof = false } = {}) => (p: Vec3) => {
  const block = (name: string, boundingBox: 'block' | 'empty') => ({ name, boundingBox, position: p, diggable: boundingBox === 'block' });
  if (roof && p.y === 80) return block('stone', 'block');
  if (land && p.x >= 20) return p.y <= 64 ? block(p.y === 64 ? 'grass_block' : 'stone', 'block') : block('air', 'empty');
  if (p.y <= 45) return block('stone', 'block');
  if (p.y === 62 && frozen) return block('ice', 'block');
  return p.y <= 62 ? block('water', 'empty') : block('air', 'empty');
};
const body = (at: Vec3, world: (p: Vec3) => any, afloat: boolean) => ({ version: '1.21.11',
  entity: { position: at, isInWater: afloat, onGround: !afloat }, inventory: { items: () => [] },
  blockAt: (p: Vec3) => world(p.floored()) }) as any;

describe('stair-mine knows when it is at sea', () => {
  it('afloat, or on the ice of a frozen sea, whatever the stop said', async () => {
    const StairMine = await StairMineClass();
    expect((new StairMine(body(new Vec3(0.5, 62.4, 0.5), shore(), true)) as any).atSea([])).toBe(true);
    expect((new StairMine(body(new Vec3(0.5, 63, 0.5), shore({ frozen: true }), false)) as any).atSea([])).toBe(true);
  });
  it('on land, only when the water stopped it under the open sky: an aquifer under a roof of rock is not the sea', async () => {
    const StairMine = await StairMineClass();
    const water = ['足元のstone(21, 63, 0)の隣(20, 63, 0)が水です。掘ると浸水するため停止しました'];
    expect((new StairMine(body(new Vec3(21.5, 65, 0.5), shore(), false)) as any).atSea(water)).toBe(true);
    expect((new StairMine(body(new Vec3(21.5, 65, 0.5), shore(), false)) as any).atSea(['次の段への移動を確認できませんでした'])).toBe(false);
    expect((new StairMine(body(new Vec3(21.5, 65, 0.5), shore({ roof: true }), false)) as any).atSea(water)).toBe(false);
  });
});

describe('stair-mine finds land a stair can start from, and the way inland', () => {
  it('the footholds on land, three blocks or more from the water, never the ice', async () => {
    const StairMine = await StairMineClass();
    for (const frozen of [false, true]) {
      const sites = (new StairMine(body(new Vec3(0.5, 63, 0.5), shore({ frozen }), !frozen)) as any).landSites();
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((site: any) => site.x >= 23 && site.y === 65 && site.groundBlock === 'grass_block')).toBe(true);
      // Beyond sixteen blocks the scan reads every other column.
      expect(Math.floor(sites[0].x)).toBeLessThanOrEqual(24);
    }
  });
  it('no land in sight: none', async () => {
    const StairMine = await StairMineClass();
    expect((new StairMine(body(new Vec3(0.5, 63, 0.5), shore({ land: false, frozen: true }), false)) as any).landSites()).toEqual([]);
  });
  it('the stair goes inland, away from the sea it came from', async () => {
    const StairMine = await StairMineClass();
    const way = (new StairMine(body(new Vec3(23.5, 65, 0.5), shore(), false)) as any).inlandDirection(new Vec3(23, 65, 0), new Vec3(0.5, 63, 0.5));
    expect([way.x, way.z]).toEqual([1, 0]);
  });
});

describe('stair-mine from the sea goes to land and digs on to the target', () => {
  /** The stair itself stubbed: a step down where the ground is land, the stop the water gives at sea. */
  const run = async (world: (p: Vec3) => any, start: Vec3, afloat: boolean, targetY: number) => {
    const StairMine = await StairMineClass();
    const bot = body(start, world, afloat);
    const skill: any = new StairMine(bot);
    const moves: any[] = [];
    skill.checkPickaxeAvailable = () => null;
    skill.digStairDown = async (from: Vec3, dir: Vec3) => {
      moves.push({ name: 'step' });
      if (world(from.offset(dir.x, -1, dir.z)).boundingBox === 'block' && world(from.offset(dir.x, -2, dir.z)).boundingBox === 'block') {
        bot.entity.position = bot.entity.position.offset(dir.x, -1, dir.z);
        return true;
      }
      skill.lastStopReason = `前方の足場(${from.x + dir.x}, ${from.y - 2}, ${from.z + dir.z})がwaterで空いています（木の上・崖・洞窟の縁など）`;
      return false;
    };
    skill.callSkill = async (name: string, x: number, y: number, z: number) => {
      moves.push({ name, x, y, z });
      const ground = [...Array(30).keys()].map(up => 50 + up).find(at => world(new Vec3(Math.floor(x), at, Math.floor(z))).boundingBox === 'empty'
        && world(new Vec3(Math.floor(x), at - 1, Math.floor(z))).boundingBox === 'block') ?? 63;
      bot.entity.position = new Vec3(x, ground, z);
      bot.entity.isInWater = world(new Vec3(Math.floor(x), ground, Math.floor(z))).name === 'water';
      bot.entity.onGround = !bot.entity.isInWater;
      return { success: true, result: '到着しました' };
    };
    const result = await skill.runImpl(targetY, 'west');
    return { result, moves: moves.filter(move => move.name !== 'step'), steps: moves, bot };
  };

  it('afloat: swims to the shore first, before any step, and the stair goes on east to y 50', async () => {
    const { result, moves, steps, bot } = await run(shore(), new Vec3(0.5, 62.4, 0.5), true, 50);
    expect(moves).toHaveLength(1);
    // Nothing is tried in the water (ladder probe, frozen sea: 95 s of a call spent afloat before the swim).
    expect(steps[0].name).toBe('move-to');
    expect(steps.filter(move => move.name === 'step')).toHaveLength(15);
    expect(moves[0]).toMatchObject({ name: 'move-to' });
    expect(Math.floor(moves[0].x)).toBeGreaterThanOrEqual(23);
    expect(result.success).toBe(true);
    expect(Math.floor(bot.entity.position.y)).toBe(50);
    expect(bot.entity.position.x).toBeGreaterThan(moves[0].x);
    expect(result.result).toContain('海の上から陸(');
    expect(result.result).toContain('eastへ掘り進めました');
  });
  it('on the ice of a frozen sea: walks to the land the same way', async () => {
    const { result, bot } = await run(shore({ frozen: true }), new Vec3(0.5, 63, 0.5), false, 50);
    expect(result.success).toBe(true);
    expect(Math.floor(bot.entity.position.y)).toBe(50);
  });
  it('no land within reach: goes the way asked to look again, and says so when there is still none', async () => {
    const { result, moves } = await run(shore({ land: false }), new Vec3(0.5, 62.4, 0.5), true, 50);
    expect(result.success).toBe(false);
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(moves.every(move => move.x < 0 && move.z === 0)).toBe(true);
    expect(result.result).toContain('陸へ向かいましたが着けませんでした');
    expect(result.result).toContain('陸が見えず');
  });
});

describe('stair-mine swims one way at sea with no land in sight (ladder probe: to and fro for ten minutes in a wide frozen sea)', () => {
  /** Open sea; the seabed at y 45, or rising a block every four to the north (z below 0) when `shoaling`. */
  const sea = (shoaling: boolean) => (p: Vec3) => {
    const bed = shoaling ? 45 + Math.floor(Math.max(0, -p.z) / 4) : 45;
    const block = (name: string, boundingBox: 'block' | 'empty') => ({ name, boundingBox, position: p });
    return p.y <= Math.min(bed, 60) ? block('sand', 'block') : p.y <= 62 ? block('water', 'empty') : block('air', 'empty');
  };
  const east = new Vec3(1, 0, 0), west = new Vec3(-1, 0, 0);
  it('turns towards the seabed that rises (a shore), whatever way it was asked', async () => {
    const StairMine = await StairMineClass();
    const skill: any = new StairMine(body(new Vec3(0.5, 62.4, 0.5), sea(true), true));
    const way = skill.headingAtSea(east);
    expect([way.x, way.z]).toEqual([0, -1]);
    // The next call asks another way: the heading is kept.
    const again = skill.headingAtSea(west);
    expect([again.x, again.z]).toEqual([0, -1]);
  });
  it('over a flat seabed keeps the first way, and never turns straight back when the next call asks for it', async () => {
    const StairMine = await StairMineClass();
    const skill: any = new StairMine(body(new Vec3(0.5, 62.4, 0.5), sea(false), true));
    expect(skill.headingAtSea(east).x).toBe(1);
    expect(skill.headingAtSea(west).x).toBe(1);
  });
});

describe('stair-mine turns at sea when a swim goes nowhere (ladder probe, deep sea: 1,000 s against an ocean monument)', () => {
  it('the next swim goes a quarter turn aside, not the same way again and not back', async () => {
    const StairMine = await StairMineClass();
    const world = shore({ land: false });
    const bot = body(new Vec3(0.5, 62.4, 0.5), world, true);
    const skill: any = new StairMine(bot);
    const moves: any[] = [];
    // The swim is stopped where it starts.
    skill.callSkill = async (name: string, x: number, y: number, z: number) => { moves.push({ name, x, y, z }); return { success: false, result: 'スタック' }; };
    expect(await skill.walkToLand(new Vec3(-1, 0, 0))).toBeNull();
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ x: -48, z: 0 });
    expect(moves[1].x).toBe(0);
    expect(Math.abs(moves[1].z)).toBe(48);
  });
});

describe('stair-mine shuts off the water beside a block before digging it (ladder probe: water every way at y 38 by a frozen sea)', () => {
  /** Rock to y 64, air over it; water east of x 1 at y 63 and 64 (a lake beside the stair). */
  const lake = () => {
    const changed = new Map<string, string>();
    const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
    const world = (p: Vec3) => {
      const name = changed.get(key(p)) ?? (p.x >= 2 && (p.y === 63 || p.y === 64) ? 'water' : p.y <= 64 ? 'stone' : 'air');
      return { name, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block', position: p, diggable: name !== 'air' && name !== 'water' };
    };
    return { world, changed, key };
  };
  const make = async (items: Array<{ name: string; count: number }>, afloat = false) => {
    const StairMine = await StairMineClass();
    const { world, changed, key } = lake();
    const bot: any = body(new Vec3(0.5, 65, 0.5), world, afloat);
    bot.inventory = { items: () => items };
    bot.equip = async () => {};
    bot.placeBlock = async (reference: any, face: Vec3) => { changed.set(key(reference.position.plus(face)), items[0].name); };
    const skill: any = new StairMine(bot);
    skill.digBlockSafe = async (block: any) => { changed.set(key(block.position), 'air'); return true; };
    skill.moveOneStair = async () => true;
    return { skill, world, changed };
  };
  it('fills the water cell with a carried block, and digs on', async () => {
    const { skill, world } = await make([{ name: 'cobblestone', count: 64 }]);
    expect(await skill.sealWater(new Vec3(2, 64, 0))).toBe(true);
    expect(world(new Vec3(2, 64, 0)).name).toBe('cobblestone');
    const { skill: stair, world: after } = await make([{ name: 'cobblestone', count: 64 }]);
    expect(await stair.digStairDown(new Vec3(0, 65, 0), new Vec3(1, 0, 0))).toBe(true);
    expect(after(new Vec3(2, 64, 0)).name).toBe('cobblestone');
    expect(after(new Vec3(1, 64, 0)).name).toBe('air');
  });
  it('nothing to fill it with, or afloat: the stop stays', async () => {
    const { skill } = await make([]);
    expect(await skill.digStairDown(new Vec3(0, 65, 0), new Vec3(1, 0, 0))).toBe(false);
    expect(skill.lastStopReason).toContain('が水です');
    const { skill: afloat } = await make([{ name: 'cobblestone', count: 64 }], true);
    expect(await afloat.sealWater(new Vec3(2, 64, 0))).toBe(false);
  });
});
