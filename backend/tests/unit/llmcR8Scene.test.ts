import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r8 (2026-10-22, run 32). The scenes of the run, built in a test world and run on the code of r7 (they fail there) and on r8 (they pass):
//   - +321 to +330 s: a bridge one block wide over a lava sea, the body at its western tip, a wither skeleton come along it from the fortress:
//     the flee has no way, the last stand laid a block under the feet by a jump, and a blow in the air threw the body into the lava;
//   - +902 s: a bed placed and slept in at once: "there's only half bed" (run 28 too): the server sends a placed bed's foot first and its
//     head a tick later, and mineflayer's sleep reads the foot's partner at the moment it is called.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    const p = block.position;
    bot.__dug.push(`${p.x},${p.y},${p.z}`);
    bot.__blocks.set(`${p.x},${p.y},${p.z}`, { name: 'air', boundingBox: 'empty' });
    return { stateId: 0, blockName: 'air' };
  }) };
});
// A fake body has no registry for the route search's movements: a stand-in.
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const reflexes: any = await import('../../src/services/minebot/utils/floorReflexes.js');
const { floorConfig } = await import('../../src/services/minebot/utils/floorConfig.js');
const { ensureReflexLedger } = await import('../../src/services/minebot/utils/reflexLedger.js');
const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');
const { place } = await import('../../src/services/minebot/utils/primitives/place.js');
const { use } = await import('../../src/services/minebot/utils/primitives/use.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const AIR: Cell = { name: 'air', boundingBox: 'empty' };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 };
const BRICKS: Cell = { name: 'nether_bricks', boundingBox: 'block', diggable: true, hardness: 2 };
const LAVA: Cell = { name: 'lava', boundingBox: 'empty' };
const NETHERRACK = { name: 'netherrack', type: 5, count: 64 };
const COBBLE = { name: 'cobblestone', type: 1, count: 16 };
const SWORD = { name: 'iron_sword', type: 20, count: 1 };

/** Run 32's bridge: nether bricks at y 54, z 0, x 225 to 256 (the western end is where the body was laying it); air round it, a lava sea at y 28 and under. */
const bridge = (x: number, y: number, z: number): Cell => (y <= 28 ? LAVA : y === 54 && z === 0 && x >= 225 && x <= 256 ? BRICKS : AIR);
/** An open floor of stone under y 64. */
const field = (_x: number, y: number, _z: number): Cell => (y < 64 ? STONE : AIR);
/** A closed cavern: a chamber (x -2 to 2, z -2 to 2, y 64 to 66) with a pit in its east half (x 1 and 2, six deep), a room for the enemy at x 4, a wall at x 3 (a tunnel when `opened`). */
const cavern = (opened: boolean) => (x: number, y: number, z: number): Cell => {
  const chamber = x >= -2 && x <= 2 && z >= -2 && z <= 2 && y >= 64 && y <= 66, pit = x >= 1 && x <= 2 && z >= -2 && z <= 2 && y >= 58 && y <= 63;
  const room = x === 4 && z === 0 && (y === 64 || y === 65), tunnel = opened && x === 3 && z === 0 && (y === 64 || y === 65);
  return chamber || pit || room || tunnel ? AIR : STONE;
};
/** A ledge: stone floor for z 0 to 3 (x 0 to 10) at y 54, air round it, a lava sea under. */
const ledge = (x: number, y: number, z: number): Cell => (y <= 28 ? LAVA : y === 54 && z >= 0 && z <= 3 && x >= 0 && x <= 10 ? STONE : AIR);

const mob = (id: number, name: string, x: number, y: number, z: number, extra: Record<string, unknown> = {}) =>
  ({ id, name, type: 'hostile', height: name === 'wither_skeleton' ? 2.4 : 1.95, width: name === 'wither_skeleton' ? 0.7 : 0.6, position: new Vec3(x, y, z), ...extra });

/** A fake body in the Nether at `at` (feet), a physics tick, a ledger, the floor installed. A jump key pressed is recorded (`__jumped`): a body in the air that a blow throws. */
function scene(shape: (x: number, y: number, z: number) => Cell, at: Vec3, options: { health?: number; items?: any[]; mobs?: Record<string, any>; now?: () => number; dimension?: string } = {}) {
  const blocks = new Map<string, Cell>();
  const calls: Array<[string, unknown]> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[], __placed: [] as string[], __jumped: false, __fakeMovements: true,
    entity: { id: 1, name: 'player', position: at.clone(), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    health: options.health ?? 20, food: 17, game: { dimension: options.dimension ?? 'the_nether' },
    entities: options.mobs ?? {},
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 }, netherrack: { id: 3 }, nether_bricks: { id: 4 } },
      entitiesByName: { wither_skeleton: { type: 'hostile' }, zombie: { type: 'hostile' }, blaze: { type: 'hostile' }, skeleton: { type: 'hostile' }, creeper: { type: 'hostile' } }, itemsByName: {}, items: {} },
    heldItem: null, inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), attack: vi.fn(), stopDigging: () => undefined,
    setControlState: vi.fn((key: string, value: boolean) => { calls.push([key, value]); if (key === 'jump' && value) bot.__jumped = true; }),
    placeBlock: vi.fn(async (reference: any, face: Vec3) => {
      const dest = reference.position.plus(face);
      bot.__placed.push(`${dest.x},${dest.y},${dest.z}`);
      blocks.set(`${dest.x},${dest.y},${dest.z}`, { name: bot.heldItem?.name ?? 'cobblestone', boundingBox: 'block' });
    }),
    blockAt: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      return { diggable: true, hardness: 1.5, ...(blocks.get(`${x},${y},${z}`) ?? shape(x, y, z)), position: new Vec3(x, y, z) };
    },
  });
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => undefined, setGoal: () => undefined,
    goto: vi.fn(async (goal: any) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }) };
  const ledger = ensureReflexLedger(bot);
  reflexes.installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now: options.now });
  return { bot, ledger, calls };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
/** Ticks with the clock moving 300 ms each, the hand of each round finished before the next. */
async function rounds(bot: any, clock: { at: number }, count: number) {
  for (let i = 0; i < count; i++) {
    clock.at += 300; tick(bot);
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 6000, interval: 5 });
    await settle(5);
  }
}
const meleeLines = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => entry.kind === 'melee' || entry.kind === 'melee_none');

describe('run 32\'s bridge: a wither skeleton comes along a bridge one block wide over a lava sea, and the body is at its western tip', () => {
  const tip = new Vec3(225.5, 55, 0.5);

  it('r7 laid a block by a jump at 6.6 health and a blow in the air threw it off; r8 puts a block between at the first sight (4 m) and never jumps at the rim', async () => {
    const clock = { at: 40_000_000 };
    const { bot, ledger } = scene(bridge, tip, { health: 15.5, items: [NETHERRACK, SWORD], mobs: { 12: mob(12, 'wither_skeleton', 229.1, 55, 0.5) }, now: () => clock.at });
    // The first sight within four metres (3.6 m), health 15.5: the cover of r7 is for shooters; the flee starts at 8.
    await rounds(bot, clock, 4);
    // Three blows in 2.3 s (4.5 each, the wither's effect on top): 6.6.
    bot.health = 6.6;
    await rounds(bot, clock, 6);
    // The fatal hand of run 32 was the jump of the pillar (pillarUp presses the jump key; a blow in the air threw the body off).
    expect(bot.__jumped, 'a jump was made at the rim').toBe(false);
    // r8: the first two hands are blocks toward the enemy, the cell on the bridge and the one over it.
    expect(bot.__placed).toEqual(['226,55,0', '226,56,0']);
    const lines = meleeLines(ledger);
    expect(lines.filter(entry => entry.kind === 'melee')).toHaveLength(2);
    expect(lines[0].detail).toMatch(/^近接の wither_skeleton #12 3\.6m: 間 \(226,55,0\) に netherrack を置いた。足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩） 今3\.6m 体力15\.5$/u);
    expect(lines[1].detail).toContain('間 (226,56,0) に netherrack を置いた');
    // Then the facts: nothing more to make (the cell between is walled; no cell to step back to), told once, not an act-stopping hand.
    const none = lines.filter(entry => entry.kind === 'melee_none');
    expect(none).toHaveLength(1);
    expect(none[0].detail).toMatch(/^近接の wither_skeleton #12 3\.6m: 動ける手が無い（敵との間は既に塞がっている・下がる所が無い）。足場: 幅 1 の橋/u);
    // At 6.6 the flee was refused ("no way") and the last stand had no pillar to make: told as a fact, nothing done.
    expect(ledger.entriesSince(-1).some(entry => entry.detail.includes('1段積んで上がった'))).toBe(false);
  });

  it('the last stand at the rim, with the enemy at 3.6 m, is the melee hand and not a pillar; with the enemy far it is nothing', () => {
    const near = scene(bridge, tip, { health: 6.6, items: [COBBLE], mobs: { 12: mob(12, 'wither_skeleton', 229.1, 55, 0.5) } });
    const stand = reflexes.lastStandChoice(near.bot);
    expect(stand?.kind).toBe('melee');
    expect(stand.detail).toMatch(/^低体力で逃げ道なし: 間 \(226,55,0\) に cobblestone を置いた。足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩） \(225,55,0\) 体力6\.6。届く: wither_skeleton #12 3\.6m 見える$/u);
    expect(reflexes.lastStandChoice(near.bot, 'melee')).toBeNull();
    // 6 m away (the first sight of run 32): no melee enemy within four metres; before r8 this was a pillar.
    const far = scene(bridge, tip, { health: 6.6, items: [COBBLE], mobs: { 12: mob(12, 'wither_skeleton', 231.5, 55, 0.5) } });
    expect(reflexes.lastStandChoice(far.bot)).toBeNull();
  });

  it('mid-bridge with no block carried: a step back along the bridge, away from it; the rim is the same, the distance grows', async () => {
    const clock = { at: 41_000_000 };
    const { bot, ledger } = scene(bridge, new Vec3(240.5, 55, 0.5), { health: 15.5, items: [], mobs: { 12: mob(12, 'wither_skeleton', 243.5, 55, 0.5) }, now: () => clock.at });
    await rounds(bot, clock, 1);
    expect(meleeLines(ledger)[0]).toMatchObject({ kind: 'melee', outcome: 'done' });
    expect(meleeLines(ledger)[0].detail).toMatch(/^近接の wither_skeleton #12 3\.0m: 敵から離れる向きへ西1へ動いた \(240,55,0\)→\(239,55,0\)。足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩） 今4\.0m 体力15\.5$/u);
    expect(bot.entity.position.x).toBe(239.5);
    expect(bot.__jumped).toBe(false);
  });

  it('an act running stops as a reflex, and says what the body did and the footing', async () => {
    const { bot } = scene(bridge, tip, { health: 15.5, items: [NETHERRACK], mobs: { 12: mob(12, 'wither_skeleton', 229.1, 55, 0.5) } });
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
    await settle(60);
    tick(bot);
    const json = JSON.parse((await acting).result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
    expect(json.stoppedWhy).toContain('近接の wither_skeleton #12 3.6m: 間 (226,55,0) に netherrack を置いた');
    expect(json.stoppedWhy).toContain('足場: 幅 1 の橋・左右とも空所');
  });
});

describe('the melee hand\'s conditions', () => {
  it('at the rim of a ledge with a floor behind it, one step to the cell with fewer voids round it ("空所から離れる向きへ")', async () => {
    const clock = { at: 42_000_000 };
    // On the ledge's edge row (z 0), a zombie along the edge 3 m east: the row behind (z 1) has no void round it.
    const { bot, ledger } = scene(ledge, new Vec3(5.5, 55, 0.5), { health: 15.5, mobs: { 2: mob(2, 'zombie', 8.5, 55, 0.5) }, now: () => clock.at });
    await rounds(bot, clock, 1);
    expect(meleeLines(ledger)[0].detail).toMatch(/^近接の zombie #2 3\.0m: 空所から離れる向きへ西1南1へ動いた \(5,55,0\)→\(4,55,1\)。足場: 空所なし 4m内に居ない 体力15\.5$/u);
  });

  it('on a floor with no rim nothing is done unless the body was hurt just now (and then a step away, never to a rim); not at the flee\'s health', async () => {
    const clock = { at: 43_000_000 };
    const quiet = scene(field, new Vec3(0.5, 64, 0.5), { health: 15, mobs: { 2: mob(2, 'zombie', 2.5, 64, 0.5) }, now: () => clock.at });
    await rounds(quiet.bot, clock, 3);
    expect(meleeLines(quiet.ledger)).toHaveLength(0);
    expect(quiet.bot.entity.position.x).toBe(0.5);
    // Hurt between two ticks: a step away.
    const hurt = scene(field, new Vec3(0.5, 64, 0.5), { health: 15, mobs: { 2: mob(2, 'zombie', 2.5, 64, 0.5) }, now: () => clock.at });
    clock.at += 300; tick(hurt.bot);
    hurt.bot.health = 11.5;
    await rounds(hurt.bot, clock, 1);
    expect(meleeLines(hurt.ledger)[0]).toMatchObject({ kind: 'melee', outcome: 'done' });
    expect(meleeLines(hurt.ledger)[0].detail).toMatch(/^近接の zombie #2 2\.0m: 敵から離れる向きへ西1/u);
    expect(hurt.bot.entity.position.x).toBeLessThan(0);
    // At the flee's health (8) the flee is the one that runs: no melee hand on a floor.
    const low = scene(field, new Vec3(0.5, 64, 0.5), { health: 9, mobs: { 2: mob(2, 'zombie', 2.5, 64, 0.5) }, now: () => clock.at });
    clock.at += 300; tick(low.bot); await settle(10);
    low.bot.health = 7;
    await rounds(low.bot, clock, 1);
    expect(meleeLines(low.ledger)).toHaveLength(0);
  });

  it('no melee hand for a shooter, a creeper, a walled-off enemy, or a kind the planner fights by choice above the flee\'s health', async () => {
    const clock = { at: 44_000_000 };
    const tipAt = new Vec3(225.5, 55, 0.5);
    for (const name of ['blaze', 'skeleton', 'creeper']) {
      const { bot, ledger } = scene(bridge, tipAt, { health: 15.5, items: [NETHERRACK], mobs: { 3: mob(3, name, 228.5, 55, 0.5) }, now: () => clock.at });
      await rounds(bot, clock, 2);
      expect(meleeLines(ledger), name).toHaveLength(0);
    }
    // Walled off (a cavern with a pit beside the body, the enemy in a room of its own behind a wall: no line, no way): nothing; the wall opened: a step off the rim.
    for (const [opened, expected] of [[false, 0], [true, 1]] as const) {
      const cave = scene(cavern(opened), new Vec3(0.5, 64, 0.5), { health: 15.5, mobs: { 3: mob(3, 'zombie', 4.5, 64, 0.5) }, now: () => clock.at });
      await rounds(cave.bot, clock, 1);
      expect(meleeLines(cave.ledger).filter(entry => entry.kind === 'melee'), `opened ${opened}`).toHaveLength(expected);
      if (opened) expect(cave.bot.entity.position.x).toBe(-0.5);
    }
    // A fight of the planner's choosing: left alone at 15.5, acted on at 7.
    for (const [health, expected] of [[15.5, 0], [7, 1]] as const) {
      const fight = scene(bridge, tipAt, { health, items: [NETHERRACK], mobs: { 3: mob(3, 'wither_skeleton', 229.1, 55, 0.5) }, now: () => clock.at });
      fight.bot.engagements = [{ kinds: ['wither_skeleton'] }];
      await rounds(fight.bot, clock, 1);
      expect(meleeLines(fight.ledger).filter(entry => entry.kind === 'melee'), `health ${health}`).toHaveLength(expected);
    }
  });

  it('three hands in an episode at most: then it says so, and leaves the decision to the planner (a walk back and forth is no plan)', async () => {
    const clock = { at: 45_000_000 };
    // A long bridge, no block carried, the enemy follows at 3 m each time: three steps back, then the fact.
    const enemy = mob(12, 'wither_skeleton', 243.5, 55, 0.5);
    const { bot, ledger } = scene(bridge, new Vec3(240.5, 55, 0.5), { health: 15.5, items: [], mobs: { 12: enemy }, now: () => clock.at });
    for (let i = 0; i < 4; i++) {
      await rounds(bot, clock, 1);
      enemy.position = new Vec3(bot.entity.position.x + 3, 55, 0.5);
    }
    const lines = meleeLines(ledger);
    expect(lines.filter(entry => entry.kind === 'melee')).toHaveLength(3);
    expect(lines.at(-1)).toMatchObject({ kind: 'melee_none' });
    expect(lines.at(-1)!.detail).toContain('この間に3手を打ったがまだ近い。これ以上は反射でしない');
  });
});

// ===== the bed =====

const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry), Block: require('prismarine-block')(registry) };
  } catch { return null; }
}
const L = lib();

/** The head of a bed lies this way from its foot (the bed's `facing`). */
const FACING: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

/**
 * A body in the Overworld in a stone room, with mineflayer's own bed plugin (its `sleep`, the very code that said "there's only half bed"),
 * and a server that answers a placed bed as the game's does: the foot at once, the head `headDelayMs` later (the next tick, 50 ms).
 */
function bedBody(options: { headDelayMs?: number; head?: 'comes' | 'never'; facing?: string } = {}) {
  const { registry, Chunk, World, Block } = L!;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const put = (x: number, y: number, z: number, name: string) => chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 56; y < 64; y++) put(x, y, z, 'stone');
  const world = new World(null, null);
  world.sync.setColumn(0, 0, chunk);
  const facing = options.facing ?? 'south';
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.20.4', registry, world: world.sync, entity: { id: 1, position: new Vec3(3.5, 64, 3.5), yaw: 0, onGround: true, effects: {} },
    entities: {}, game: { dimension: 'overworld', gameMode: 'survival' }, time: { timeOfDay: 14000 }, isRaining: false, thunderState: 0,
    heldItem: null, inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, currentWindow: null,
    blockAt: (p: Vec3, extra?: boolean) => world.sync.getBlock(p, extra),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }),
    canDigBlock: () => true,
  });
  bot.supportFeature = (name: string) => name === 'blockStateId';
  bot._client = new EventEmitter();
  // The server: the foot at once, the head a tick later.
  bot.placeBlock = vi.fn(async (reference: any, face: Vec3) => {
    const dest = reference.position.plus(face);
    const state = (part: string) => Block.fromProperties('black_bed', { part, facing, occupied: false }, 0).stateId;
    world.sync.setBlockStateId(dest, state('foot'));
    if (options.head === 'never') return;
    const [dx, dz] = FACING[facing];
    const headAt = dest.offset(dx, 0, dz);
    setTimeout(() => world.sync.setBlockStateId(headAt, state('head')), options.headDelayMs ?? 60);
  });
  // The bed plugin of mineflayer itself.
  require('mineflayer/lib/plugins/bed.js')(bot);
  bot.activateBlock = vi.fn(() => { setTimeout(() => { bot.emit('entitySleep', bot.entity); setTimeout(() => bot.emit('entityWake', bot.entity), 40); }, 5); });
  return { bot, world };
}
const bedCtx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 3, y: 64, z: 3 } });
const BED = { name: 'black_bed', type: 77, count: 1 };

describe.skipIf(!L)('a bed placed and slept in at once (runs 28 and 32: "there\'s only half bed")', () => {
  it('the cause: mineflayer\'s sleep, called on the foot when the server has sent only the foot, throws "there\'s only half bed"; a tick later it does not', async () => {
    const { bot } = bedBody();
    const foot = new Vec3(5, 64, 3);
    await bot.placeBlock({ position: foot.offset(0, -1, 0) }, new Vec3(0, 1, 0));
    expect(bot.blockAt(foot).name).toBe('black_bed');
    expect(bot.blockAt(foot.offset(0, 0, 1)).name).toBe('air');
    await expect(bot.sleep(bot.blockAt(foot))).rejects.toThrow("there's only half bed");
    await settle(120);
    expect(bot.blockAt(foot.offset(0, 0, 1)).name).toBe('black_bed');
    await expect(bot.sleep(bot.blockAt(foot))).resolves.toBeUndefined();
  });

  it('place then use in one go sleeps: the hand waits for the head, and says where the foot and the head lie', async () => {
    const { bot } = bedBody();
    bot.inventory.items = () => [BED];
    const placed = await place(bedCtx(bot), { block: 'black_bed', at: [{ x: 5, y: 64, z: 3 }] });
    bot.inventory.items = () => [];
    const slept = await use(bedCtx(bot), { at: { x: 5, y: 64, z: 3 } });
    // eslint-disable-next-line no-console
    console.log(`[bed r8] place: ${placed.ok} ${placed.text} / use: ${slept.ok} ${slept.text}`);
    expect(placed.ok).toBe(true);
    // r7 said only "(5,64,3) に black_bed を置いた（下の stone に当てて。残り0）", and the use that followed was "there's only half bed".
    expect(placed.text).toContain('ベッドは足 (5,64,3)・頭 (5,64,4)（向き south');
    // The wait is told (the next run's log shows how late the head comes).
    expect(placed.text).toMatch(/頭は足より \d+ms 遅れて届いた/u);
    expect(bot.blockAt(new Vec3(5, 64, 4)).name).toBe('black_bed');
    expect(slept).toMatchObject({ ok: true });
    expect(slept.text).toContain('のベッドで寝た');
  });

  it('a use right after the foot alone (the head still on its way) waits for it, clicks the head, and needs no item in the hand (a planner wrote item:"black_bed" and was told it had none)', async () => {
    const { bot } = bedBody({ headDelayMs: 90 });
    const foot = new Vec3(5, 64, 3);
    await bot.placeBlock({ position: foot.offset(0, -1, 0) }, new Vec3(0, 1, 0));
    const slept = await use(bedCtx(bot), { at: { x: 5, y: 64, z: 3 }, item: 'black_bed' });
    expect(slept).toMatchObject({ ok: true });
    expect(slept.text).toMatch(/頭のブロックが来るまで \d+ms 待った/u);
    expect(bot.activateBlock).toHaveBeenCalledTimes(1);
    expect(bot.activateBlock.mock.calls[0][0].position).toEqual(new Vec3(5, 64, 4));
  });

  it('a bed that really has one half only: the line says which cell is missing and what it holds, on the placing and on the sleeping', async () => {
    const { bot } = bedBody({ head: 'never' });
    bot.inventory.items = () => [BED];
    const placed = await place(bedCtx(bot), { block: 'black_bed', at: [{ x: 5, y: 64, z: 3 }] });
    expect(placed).toMatchObject({ ok: false, reason: 'not_placed' });
    expect(placed.text).toContain('半分しか無い: ベッドの頭のマス (5,64,4) は air のまま（向き south');
    const slept = await use(bedCtx(bot), { at: { x: 5, y: 64, z: 3 } });
    expect(slept).toMatchObject({ ok: false, reason: 'not_slept' });
    expect(slept.text).toContain('ベッドの頭のマス (5,64,4) が air（半分しか無い。向き south）');
  }, 15_000);
});
