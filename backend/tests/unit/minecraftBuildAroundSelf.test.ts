import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/services/minebot/execution/observedWait.js', () => ({ actionDelay: vi.fn(async () => {}) }));

const { default: BuildAroundSelf, cellsOf, feetCell, turnsForLandmark, BUILDING_BLOCKS } = await import('../../src/services/minebot/instantSkills/buildAroundSelf.js');
const { seesPoint, visiblePointOn } = await import('../../src/services/minebot/utils/sightLine.js');
const { beginEngagement, engageFor, engagedWith, engagementOf, isEngaged, timedEngagement } = await import('../../src/services/minebot/utils/engagement.js');
const { default: AcceptThreat } = await import('../../src/services/minebot/instantSkills/acceptThreat.js');
const { builtAroundStatus } = await import('../../src/services/minebot/utils/builtAround.js');
const { EMERGENCY_HOSTILE_GUIDANCE_JA } = await import('../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js');

const cage = JSON.parse(fs.readFileSync(path.resolve('saves/minecraft/structures/slit_cage.json'), 'utf8'));
const key = (pos: { x: number; y: number; z: number }) => `${pos.x},${pos.y},${pos.z}`;

/** A flat stone floor at y=63, a body standing on it at the origin, a spawner beside it, and a pack. */
function world(spawnerAt = new Vec3(1, 64, 0)) {
  const placed = new Map<string, { name: string; top?: boolean }>();
  placed.set(key(spawnerAt), { name: 'spawner' });
  const order: string[] = [];
  const dug: string[] = [];
  const pack = [{ name: 'cobblestone', count: 128 }, { name: 'cobblestone_slab', count: 8 }, { name: 'stone_sword', count: 1 }];
  let held: any = null;
  const blockAt = (pos: Vec3) => {
    const at = pos.floored();
    const put = placed.get(key(at));
    if (put) return { name: put.name, position: at, boundingBox: 'block', shapes: put.top ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ type: put.top ? 'top' : 'bottom' }) };
    if (at.y <= 63) return { name: 'stone', position: at, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) };
    return { name: 'air', position: at, boundingBox: 'empty', shapes: [], getProperties: () => ({}) };
  };
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0 }, blockAt,
    inventory: { items: () => pack.filter(item => item.count > 0) }, equip: async (item: any) => { held = item; }, look: async () => {},
    setControlState: () => {}, getControlState: () => false,
    instantSkills: { getSkill: (name: string) => (name === 'dig-block-at' ? { run: async (x: number, y: number, z: number) => { placed.delete(`${x},${y},${z}`); dug.push(`${x},${y},${z}`); } } : null) },
    placeOptions: [] as any[], placedAgainst: [] as string[],
    _placeBlockWithOptions: async (reference: any, face: Vec3, options: any) => {
      bot.placeOptions.push(options);
      bot.placedAgainst.push(`${reference.position.x},${reference.position.y},${reference.position.z}`);
      const at = reference.position.plus(face);
      const slab = String(held.name).endsWith('_slab');
      placed.set(key(at), { name: held.name, top: slab && (options?.half === 'top' || face.y === -1) });
      held.count--;
      order.push(key(at));
    } };
  return { bot, placed, order, pack, dug };
}

describe('a plan is turned about the body to where its landmark is, and laid out round the body\'s feet', () => {
  it('finds the quarter turn that puts the spawner cell on the spawner, whichever side the body stands on', () => {
    const feet = new Vec3(0, 64, 0);
    for (const [at, turns] of [[new Vec3(1, 64, 0), 0], [new Vec3(0, 64, 1), 1], [new Vec3(-1, 64, 0), 2], [new Vec3(0, 64, -1), 3]] as Array<[Vec3, number]>) {
      expect(turnsForLandmark(cage, feet, pos => (pos.equals(at) ? 'spawner' : 'air'))).toBe(turns);
      const keep = cellsOf(cage, feet, turns).filter(cell => cell.spec === '@keep');
      expect(keep.map(cell => key(cell.pos))).toEqual([key(at)]);
    }
    expect(turnsForLandmark(cage, feet, () => 'air')).toBeNull();           // no spawner beside it
    expect(turnsForLandmark(cage, feet, pos => (pos.equals(new Vec3(1, 65, 0)) ? 'spawner' : 'air'))).toBeNull();   // nor one a level up
  });

  it('the cage plan: every cell of the corridor within a blow of the eyes, the body\'s own cells left alone', () => {
    const cells = cellsOf(cage, new Vec3(0, 64, 0), 0);
    const corridor = cells.filter(cell => cell.spec === '@air' && cell.pos.y === 64);
    expect(corridor.length).toBe(12);
    const eyes = new Vec3(0.5, 65.62, 0.5);
    for (const cell of corridor) expect(cell.pos.offset(0.5, 0.9, 0.5).distanceTo(eyes)).toBeLessThan(2.6);
    expect(cells.some(cell => cell.pos.x === 0 && cell.pos.z === 0 && (cell.pos.y === 64 || cell.pos.y === 65))).toBe(false);
    expect(cells.filter(cell => cell.spec === '@slab:top' && !cell.becomes).length).toBe(8);
  });
});

describe('build-around-self walls the body in from where it stands (lab: built beside a live blaze spawner in 35 seconds, no blow taken)', () => {
  it('closes the four sides and the lid first, with the fewest blocks, and then builds the rest', async () => {
    const { bot, placed, order, dug } = world();
    const result: any = await new BuildAroundSelf(bot).runImpl('slit_cage');
    expect(result.success).toBe(true);
    expect(result.result).toContain('中央のマスは (0, 64, 0)');
    // Closed in: the three free sides at the feet (the fourth is the spawner), the four at the eyes, the lid.
    const sealedAfter = Math.max(...['-1,64,0', '0,64,1', '0,64,-1', '1,65,0', '-1,65,0', '0,65,1', '0,65,-1', '0,66,0'].map(cell => order.indexOf(cell)));
    expect(sealedAfter).toBeGreaterThanOrEqual(0);
    expect(sealedAfter).toBeLessThan(16);
    // The slits are slabs in the upper half; the feet ring and the roof are whole blocks.
    for (const cell of ['1,65,0', '-1,65,0', '0,65,1', '0,65,-1', '1,65,1', '-1,65,-1']) expect(placed.get(cell)).toMatchObject({ top: true });
    expect(placed.get('-1,64,0')!.name).toBe('cobblestone');
    expect(placed.get('1,64,0')!.name).toBe('spawner');                   // never touched
    expect(placed.has('0,64,0') || placed.has('0,65,0')).toBe(false);       // nor the body's own cells
    // One corner stands whole while the rest is built against it, and is a slit at the end.
    expect(dug).toEqual(['-1,65,-1']);
    expect(placed.get('-1,65,-1')).toMatchObject({ top: true });
    // The floor was already there (stone underfoot), so only walls, slits and roof were laid.
    expect(order.length).toBe(69);
    expect(order.filter(cell => cell.split(',')[1] === '63').length).toBe(0);
  });

  it('takes the last step to the cell beside the spawner itself when it stands a block or two off it (paid run L77w: sent back from 1.4m, and died there)', async () => {
    const { bot } = world(new Vec3(3, 64, 0));
    const moves: number[][] = [];
    bot.instantSkills.getSkill = (name: string) => (name === 'move-to' ? { run: async (x: number, y: number, z: number) => { moves.push([x, y, z]); bot.entity.position = new Vec3(x, y, z); } } : null);
    const result: any = await new BuildAroundSelf(bot).runImpl('slit_cage');
    expect(moves).toEqual([[2.5, 64, 0.5]]);
    expect(result.result).not.toContain('いま隣に spawner がありません');
  });

  it('says where to stand when no spawner is beside it, and what is short when the pack will not do', async () => {
    const lost = world(new Vec3(5, 64, 5));
    expect(await new BuildAroundSelf(lost.bot).runImpl('slit_cage')).toMatchObject({ success: false, failureType: 'invalid_location' });
    const poor = world();
    poor.pack[0].count = 10; poor.pack[1].count = 2;
    const short: any = await new BuildAroundSelf(poor.bot).runImpl('slit_cage');
    expect(short).toMatchObject({ success: false, failureType: 'missing_item' });
    expect(short.result).toContain('ハーフブロック');
    expect((await new BuildAroundSelf(world().bot).runImpl('no_such_plan') as any).result).toContain('slit_cage');
  });

  it('called again, builds only what is missing (a wall dug open to fetch what fell outside)', async () => {
    const { bot, placed, order } = world();
    await new BuildAroundSelf(bot).runImpl('slit_cage');
    placed.delete('-1,64,0');
    const before = order.length;
    const again: any = await new BuildAroundSelf(bot).runImpl('slit_cage');
    expect(again.success).toBe(true);
    expect(order.slice(before)).toEqual(['-1,64,0']);
    expect(BUILDING_BLOCKS).toContain('cobbled_deepslate');
  });

  it('tells the body near what it built how much of it is missing, and how to close it (paid run L77aa: a rod fetched through the inner wall left it open, and the emergency had it chase a blaze out through the gap)', async () => {
    const { bot, placed } = world();
    expect(builtAroundStatus(bot)).toBeNull();
    await new BuildAroundSelf(bot).runImpl('slit_cage');
    expect(builtAroundStatus(bot)).toMatch(/^slit_cage（中央のマス \(0,64,0\)、いま中央のマスにいる）: \d+マスすべて建っている$/);
    placed.delete('-1,64,0');
    placed.delete('0,65,1');
    expect(builtAroundStatus(bot)).toMatch(/2マスが欠けている（build-around-self をもう一度呼べば塞がる）/);
    bot.entity.position = new Vec3(2.5, 64, 3.5);
    expect(builtAroundStatus(bot)).toMatch(/中央から3\.6m離れている.*2マスが欠けている（中央のマスへ戻ってからbuild-around-self/);
    bot.entity.position = new Vec3(20.5, 64, 0.5);
    expect(builtAroundStatus(bot)).toBeNull();     // out of the way of it: nothing said
    expect(EMERGENCY_HOSTILE_GUIDANCE_JA).toContain('builtAround');
  });
});

describe('a cell to shut itself in anywhere, with nothing asked of the place (lab: two seconds; three wither skeletons killed from inside it twice, no blow taken)', () => {
  const shelter = JSON.parse(fs.readFileSync(path.resolve('saves/minecraft/structures/slit_shelter.json'), 'utf8'));

  it('is fourteen blocks on open ground: feet, two corner posts, slits against them, one roof block and the lid', async () => {
    const { bot, placed, order, pack } = world(new Vec3(40, 64, 40));          // no spawner anywhere near
    const began = Date.now();
    const result: any = await new BuildAroundSelf(bot).runImpl('slit_shelter');
    expect(result.success).toBe(true);
    expect(order.length).toBe(14);
    expect(order.slice(0, 4).sort()).toEqual(['-1,64,0', '0,64,-1', '0,64,1', '1,64,0']);      // the feet first
    for (const cell of ['1,65,0', '-1,65,0', '0,65,1', '0,65,-1']) expect(placed.get(cell)).toMatchObject({ top: true });
    expect(placed.get('0,66,0')!.name).toBe('cobblestone');
    expect(pack[1].count).toBe(4);
    expect(Date.now() - began).toBeLessThan(2000);                              // the waits are the test's own (none)
    // The look is turned at once for each block (a turn over several ticks was most of the time a block took).
    expect(bot.placeOptions.every((options: any) => options.forceLook === true)).toBe(true);
  });

  it('takes soul sand standing where a wall or the floor goes for one, and digs out a fence (paid run L77v dug the soul sand out cell by cell, 34 seconds for nine)', async () => {
    const { bot, placed, order, dug } = world(new Vec3(40, 64, 40));
    const at = (key: string, name: string, shape: number[]) => placed.set(key, { name, shape } as any);
    at('-1,64,0', 'soul_sand', [0, 0, 0, 1, 0.875, 1]);
    at('1,64,0', 'nether_brick_fence', [0.375, 0, 0.375, 0.625, 1.5, 0.625]);
    const blockAt = bot.blockAt;
    bot.blockAt = (pos: Vec3) => {
      const put: any = placed.get(`${pos.x},${pos.y},${pos.z}`);
      return put?.shape ? { name: put.name, position: pos.floored(), boundingBox: 'block', shapes: [put.shape], getProperties: () => ({}) } : blockAt(pos);
    };
    expect((await new BuildAroundSelf(bot).runImpl('slit_shelter') as any).success).toBe(true);
    expect(dug).toEqual(['1,64,0']);
    expect(order).not.toContain('-1,64,0');
    expect(order.length).toBe(13);
  });

  it('does not put a block against a crafting table: a click on one opens it (paid run L77v: the last side of a shelter by its own table)', async () => {
    const { bot, placed, order } = world(new Vec3(40, 64, 40));
    placed.set('0,63,1', { name: 'crafting_table' });
    expect((await new BuildAroundSelf(bot).runImpl('slit_shelter') as any).success).toBe(true);
    expect(order).toContain('0,64,1');
    expect(bot.placeOptions.length).toBe(order.length);
    expect(bot.placedAgainst.some((key: string) => key === '0,63,1')).toBe(false);
  });

  it('counts the feet of a body on soul sand in the cell above it (a lid laid one cell low went where the head was)', () => {
    expect(feetCell(new Vec3(152.5, 51.875, 254.5))).toEqual(new Vec3(152, 52, 254));
    expect(feetCell(new Vec3(0.5, 64, 0.5))).toEqual(new Vec3(0, 64, 0));
    expect(feetCell(new Vec3(0.5, 64.5, 0.5))).toEqual(new Vec3(0, 64, 0));       // on a slab: still the slab's cell
  });

  it('builds round the cell that holds the body up when it stands at a drop with its middle over the open side (paid run L77z: 26 seconds, three cells)', async () => {
    const { bot, placed } = world(new Vec3(40, 64, 40));
    const blockAt = bot.blockAt;
    bot.blockAt = (pos: Vec3) => {
      const at = pos.floored();
      return at.x >= 1 && at.y <= 63 && !placed.has(`${at.x},${at.y},${at.z}`) ? { name: 'air', position: at, boundingBox: 'empty', shapes: [], getProperties: () => ({}) } : blockAt(pos);
    };
    bot.entity.position = new Vec3(1.1, 64, 0.5);              // over the drop at x >= 1, held by the edge block at x = 0
    let yaw = 0;
    bot.look = async (to: number) => { yaw = to; };
    bot.setControlState = (key: string, on: boolean) => {         // a step of 0.1 along the look for each press of forward
      if (key === 'forward' && on) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * 0.1, 0, -Math.cos(yaw) * 0.1);
    };
    const result: any = await new BuildAroundSelf(bot).runImpl('slit_shelter');
    expect(result.result).toContain('中央のマスは (0, 64, 0)');
  });

  it('is offered by name when a plan that needs something beside the body is asked for where there is none', async () => {
    const lost = world(new Vec3(5, 64, 5));
    const refused: any = await new BuildAroundSelf(lost.bot).runImpl('slit_cage');
    expect(refused.result).toContain('slit_shelter');
    expect(turnsForLandmark(shelter, new Vec3(0, 64, 0), () => 'air')).toBe(0);
  });
});

describe('a blow from a held position is struck only at what the eyes can see', () => {
  it('takes a ray that ends on a block before the point as no sight of it, and one that reaches as sight', () => {
    const eyes = new Vec3(0.5, 65.62, 0.5);
    const wall = (hitAt: number | null) => ({ entity: { position: new Vec3(0.5, 64, 0.5) },
      world: { raycast: (from: Vec3, direction: Vec3) => (hitAt === null ? null : { intersect: from.plus(direction.scaled(hitAt)) }) } });
    expect(seesPoint(wall(null) as any, new Vec3(2.5, 64.9, 0.5), eyes)).toBe(true);
    expect(seesPoint(wall(1.0) as any, new Vec3(2.5, 64.9, 0.5), eyes)).toBe(false);
    const blaze = { position: new Vec3(2.5, 64, 0.5), height: 1.8, width: 0.6 };
    expect(visiblePointOn(wall(null) as any, blaze, 3)).not.toBeNull();
    expect(visiblePointOn(wall(1.0) as any, blaze, 3)).toBeNull();
    expect(visiblePointOn(wall(null) as any, { position: new Vec3(6.5, 64, 0.5), height: 1.8 }, 3)).toBeNull();   // seen, but out of a blow's reach
  });
});

describe('the planner can take a kind of mob on for a time (the walk up to a spawner through the blazes it came for)', () => {
  it('holds for the kinds named until the time is out, and one such word takes the place of the last', () => {
    const bot: any = {};
    engageFor(bot, ['blaze'], 60_000, 1_000);
    expect(timedEngagement(bot, 31_000)).toEqual({ kinds: ['blaze'], secondsLeft: 30 });
    engageFor(bot, ['blaze', 'wither_skeleton'], 10_000, 31_000);
    expect(bot.engagements.length).toBe(1);
    expect(timedEngagement(bot, 31_000)!.kinds).toEqual(['blaze', 'wither_skeleton']);
    expect(timedEngagement(bot, 50_000)).toBeNull();                        // run out, and gone
    expect(bot.engagements.length).toBe(0);
    // A fight skill's own word stands beside it and ends with the skill.
    const end = beginEngagement(bot, ['zombie']);
    expect(engagedWith(bot, 'zombie')).toBe(true);
    end();
    expect(isEngaged(bot)).toBe(false);
  });

  it('walling itself in is a stay it has chosen, against whatever is there; the word for a time is a skill the planner calls', async () => {
    expect(engagementOf('build-around-self', ['slit_cage'])).toEqual(['*']);
    const bot: any = { entity: { position: new Vec3(0, 64, 0) } };
    const skill: any = new AcceptThreat(bot);
    const said = await skill.runImpl('Blaze, wither_skeleton', 90);
    expect(said.success).toBe(true);
    expect(engagedWith(bot, 'blaze')).toBe(true);
    expect(engagedWith(bot, 'wither_skeleton')).toBe(true);
    expect(engagedWith(bot, 'ghast')).toBe(false);
    expect((await skill.runImpl('', 30)).success).toBe(false);
    await skill.runImpl('blaze', 100_000);
    expect(timedEngagement(bot)!.secondsLeft).toBeLessThanOrEqual(300);     // never for longer than five minutes
  });
});
