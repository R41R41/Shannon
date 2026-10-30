import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { createRequire } from 'node:module';
import { pillarUp, PILLAR_FEET_OVER_FLOOR } from '../../src/services/minebot/utils/primitives/pillarUp.js';

// pillarUp against the client physics (prismarine-physics, the engine mineflayer moves the body with), run 39: pillarUp was called 9 times
// and every time said "1段目が積めなかった（足元は今 air、足は y=N.00）", with no error text. It waited for the feet to be 1.26 over the floor
// of the cell; a vanilla jump tops out at 1.2522, so it never laid a block. Here the real jump is measured and the pillar is run on a body
// moved by that physics in real time (50 ms ticks; the code's own 35 ms polling; a server that lags a tick and refuses a block that would
// overlap the body). No server, no API.

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');

function makeWorld() {
  const placed = new Set<string>();
  const blocks = new Map<string, any>();
  const getBlock = (position: Vec3) => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const name = y < 64 || placed.has(`${x},${y},${z}`) ? (placed.has(`${x},${y},${z}`) ? 'cobblestone' : 'stone') : 'air';
    const key = `${name}@${x},${y},${z}`;
    if (!blocks.has(key)) { const block = new Block(mcData.blocksByName[name].id, 0, 0); block.position = new Vec3(x, y, z); blocks.set(key, block); }
    return blocks.get(key);
  };
  return { placed, getBlock, blockAt: (position: Vec3) => getBlock(position) };
}
type World = ReturnType<typeof makeWorld>;

function makeBody(world: World, items: Array<{ name: string; count: number; type: number }> = []) {
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const bot: any = {
    version: VERSION, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [], items: () => items }, entities: {},
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    registry: mcData, heldItem: items[0] ? { name: items[0].name, type: items[0].type } : null,
    blockAt: world.blockAt, getControlState: (name: string) => control[name], setControlState: (name: string, value: boolean) => { control[name] = value; },
    look: async () => undefined,
    /** Where the server has the body: the position one tick ago. */
    serverAt: new Vec3(0.5, 64, 0.5),
    placeCalls: [] as Array<{ y: number; vy: number }>,
    refuse: null as null | (() => Error),
  };
  const tick = () => { bot.serverAt = bot.entity.position.clone(); physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot); };
  bot.placeBlock = async (reference: any, face: Vec3) => {
    bot.placeCalls.push({ y: bot.entity.position.y, vy: bot.entity.velocity.y });
    await new Promise(resolve => setTimeout(resolve, 60));   // the round trip
    if (bot.refuse) throw bot.refuse();
    const target = reference.position.plus(face);
    // The server refuses a block whose cell the body overlaps (its feet below the cell's top).
    if (bot.serverAt.y < target.y + 1 - 1e-6) throw new Error(`Event blockUpdate:(${target.x}, ${target.y}, ${target.z}) did not fire within timeout of 5000ms`);
    world.placed.add(`${target.x},${target.y},${target.z}`);
    const stack = items.find(item => item.name === 'cobblestone');
    if (stack) stack.count--;
  };
  return { bot, control, tick };
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
/** Moves the body by the physics in real time while `run` goes. */
async function live<T>(body: ReturnType<typeof makeBody>, run: () => Promise<T>): Promise<T> {
  const timer = setInterval(body.tick, 50);
  try { return await run(); } finally { clearInterval(timer); }
}
const cobble = (count: number) => [{ name: 'cobblestone', count, type: mcData.blocksByName.cobblestone.id }];

describe('the vanilla jump, measured with the client physics', () => {
  it('tops out at 1.2522 over the floor: never the 1.26 the old pillarUp waited for; the cell is free from 1.0 up, ticks 4 to 7 lay it', () => {
    const { bot, control, tick } = makeBody(makeWorld());
    control.jump = true;
    const rows: Array<{ tick: number; dy: number; vy: number; ground: boolean }> = [];
    for (let t = 1; t <= 14; t++) { tick(); rows.push({ tick: t, dy: bot.entity.position.y - 64, vy: bot.entity.velocity.y, ground: bot.entity.onGround }); }
    const top = Math.max(...rows.map(row => row.dy));
    expect(top).toBeCloseTo(1.2522, 3);
    expect(top).toBeLessThan(1.26);
    expect(rows.slice(0, 6).map(row => row.dy.toFixed(3))).toEqual(['0.420', '0.753', '1.001', '1.166', '1.249', '1.252']);
    expect(rows[11]).toMatchObject({ tick: 12, ground: true });
    // The ticks on which the code would lay (feet over the bar, rising no faster than 0.14, not yet falling fast): 4 to 7, four of them.
    const window = rows.filter(row => row.dy >= PILLAR_FEET_OVER_FLOOR && row.vy <= 0.14 && row.vy >= -0.45 && row.tick <= 12).map(row => row.tick);
    expect(window).toEqual([4, 5, 6, 7]);
    // And the old bar had no tick at all.
    expect(rows.filter(row => row.dy >= 1.26)).toHaveLength(0);
  });
});

describe('pillarUp on a body moved by that physics', () => {
  it('climbs one level: the block laid on the way up near the top of the jump, the feet a block higher', async () => {
    const world = makeWorld();
    const body = makeBody(world, cobble(8));
    const outcome = await live(body, () => pillarUp(ctx(body.bot), { n: 1, block: 'cobblestone' }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('1段登った');
    expect(world.getBlock(new Vec3(0, 64, 0)).name).toBe('cobblestone');
    expect(body.bot.entity.position.y).toBeCloseTo(65, 2);
    expect(body.bot.placeCalls).toHaveLength(1);
    expect(body.bot.placeCalls[0].y - 64).toBeGreaterThanOrEqual(PILLAR_FEET_OVER_FLOOR);
    expect(body.bot.placeCalls[0].vy).toBeLessThanOrEqual(0.14);
  }, 20_000);

  it('climbs three levels in a row, one block each', async () => {
    const world = makeWorld();
    const items = cobble(8);
    const body = makeBody(world, items);
    const outcome = await live(body, () => pillarUp(ctx(body.bot), { n: 3, block: 'cobblestone' }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('3段登った');
    for (const y of [64, 65, 66]) expect(world.getBlock(new Vec3(0, y, 0)).name).toBe('cobblestone');
    expect(world.getBlock(new Vec3(0, 67, 0)).name).toBe('air');
    expect(body.bot.entity.position.y).toBeCloseTo(67, 2);
    expect(body.bot.placeCalls).toHaveLength(3);
    expect(items[0].count).toBe(5);
  }, 30_000);

  it('with the old bar of 1.26 the laying is never called and the level does not take (the regression of run 39)', async () => {
    const world = makeWorld();
    const body = makeBody(world, cobble(8));
    const outcome = await live(body, () => pillarUp(ctx(body.bot), { n: 1, block: 'cobblestone', feetOver: 1.26 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('not_placed');
    expect(body.bot.placeCalls).toHaveLength(0);
    expect(world.getBlock(new Vec3(0, 64, 0)).name).toBe('air');
    // What run 39 said: the cell air, the feet at 64.00, 0 levels. Now it also says why: the jump's top, and that nothing was tried.
    expect(outcome.text).toContain('0段登った');
    expect(outcome.text).toContain('跳びの最高 y=65.25');
    expect(outcome.text).toContain('置こうとした 0 回');
    expect(outcome.text).toContain('届かず');
  }, 20_000);

  it('says what was refused when the server turns the block down each time, even with no error text', async () => {
    const world = makeWorld();
    const body = makeBody(world, cobble(8));
    body.bot.refuse = () => new Error('');
    const outcome = await live(body, () => pillarUp(ctx(body.bot), { n: 1, block: 'cobblestone' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('not_placed');
    expect(body.bot.placeCalls.length).toBeGreaterThanOrEqual(1);
    expect(outcome.text).toMatch(/置こうとして \d+ 回とも断られた（Error（文なし））/u);
  }, 20_000);

  it('stops at a ceiling, at a missing block, and over no floor, as before', async () => {
    const world = makeWorld();
    world.placed.add('0,66,0');
    const ceiling = makeBody(world, cobble(8));
    expect((await pillarUp(ctx(ceiling.bot), { n: 2, block: 'cobblestone' })).reason).toBe('ceiling');
    expect((await pillarUp(ctx(makeBody(makeWorld(), []).bot), { n: 2, block: 'cobblestone' })).reason).toBe('missing_item');
    const open = makeWorld();
    const hole = makeBody({ ...open, getBlock: (p: Vec3) => (Math.floor(p.y) === 63 ? open.getBlock(new Vec3(p.x, 70, p.z)) : open.getBlock(p)), blockAt: (p: Vec3) => (Math.floor(p.y) === 63 ? open.getBlock(new Vec3(p.x, 70, p.z)) : open.getBlock(p)) } as World, cobble(8));
    expect((await pillarUp(ctx(hole.bot), { n: 1, block: 'cobblestone' })).reason).toBe('no_floor');
  });
});

describe('a place the server never answers (run 48, hold 5)', () => {
  it('is jumped for once more, and the level is climbed; two silences in a row stop it, saying so', async () => {
    const world = makeWorld();
    const body = makeBody(world, cobble(8));
    const real = body.bot.placeBlock;
    let silent = 1;
    body.bot.placeBlock = async (...rest: unknown[]) => { if (silent-- > 0) { await new Promise(resolve => setTimeout(resolve, 2500)); return undefined; } return real(...rest); };
    const outcome = await live(body, () => pillarUp({ ...ctx(body.bot), deadline: Date.now() + 60_000 }, { n: 1, block: 'cobblestone' }));
    expect(outcome.ok).toBe(true);
    expect(world.getBlock(new Vec3(0, 64, 0)).name).toBe('cobblestone');
    const deaf = makeBody(makeWorld(), cobble(8));
    deaf.bot.placeBlock = async () => { await new Promise(resolve => setTimeout(resolve, 2500)); return undefined; };
    const stopped = await live(deaf, () => pillarUp({ ...ctx(deaf.bot), deadline: Date.now() + 60_000 }, { n: 1, block: 'cobblestone' }));
    expect(stopped.ok).toBe(false);
    expect(stopped.text).toContain('積めなかった');
  }, 40_000);
});
