import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { createRequire } from 'node:module';
import { installEdgeGuard } from '../../src/services/minebot/utils/edgeGuard.js';
import { fleeHeadingSafe, fleeKeys } from '../../src/services/minebot/utils/floorReflexes.js';

// P8 sixth review: the flee's verdicts against the client physics (prismarine-physics), the way a body really runs: sprinting, jumping, falling.
// Open-loop: the keys are held on a heading and the damage is counted. Closed-loop: the keys are those of `fleeKeys` at every tick, with the edge
// guard installed, as in the reflex. A scenario is "hot" when the body stands on magma or has its feet or head in lava or fire.

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');

type Spec = string | [string, Record<string, unknown>];
type World = { getBlock: (position: Vec3) => any; blockAt: (position: Vec3) => any };
function makeBlock(spec: Spec, x: number, y: number, z: number) {
  const [name, properties] = Array.isArray(spec) ? spec : [spec, undefined];
  const block = properties ? Block.fromProperties(name, properties, 0) : new Block(mcData.blocksByName[name].id, 0, 0);
  block.position = new Vec3(x, y, z);
  return block;
}
function worldOf(at: (x: number, y: number, z: number) => Spec): World {
  const getBlock = (position: Vec3) => { const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z); return makeBlock(at(x, y, z), x, y, z); };
  return { getBlock, blockAt: getBlock };
}

function makeBot(world: World, start: Vec3, options: { health?: number; guard?: boolean; inWater?: boolean } = {}) {
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: true, back: false, left: false, right: false, jump: false, sprint: true, sneak: false };
  const bot: any = { version: VERSION, health: options.health ?? 5, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] }, entities: {},
    entity: { position: start, velocity: new Vec3(0, 0, 0), onGround: !options.inWater, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    physics, registry: mcData, controlState: control,
    pathfinder: { movements: { exclusionAreasStep: [] as any[] }, setMovements(movements: any) { this.movements = movements; } },
    blockAt: world.blockAt, getControlState: (name: string) => control[name], setControlState: (name: string, value: boolean) => { control[name] = value; } };
  if (options.guard !== false) installEdgeGuard(bot);
  const tick = () => physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
  return { bot, control, tick };
}

/** Tracks the fall damage of a body tick by tick (one point per block beyond three, from the highest point since it last stood). */
class Falls {
  private peak = -Infinity; private wasGround = true; damage = 0; worst = 0;
  constructor(start: number) { this.peak = start; }
  step(bot: any) {
    const y = bot.entity.position.y;
    if (bot.entity.onGround) { if (!this.wasGround) { const hurt = Math.max(0, Math.ceil(this.peak - y - 3)); this.damage += hurt; this.worst = Math.max(this.worst, hurt); } this.peak = y; }
    else this.peak = Math.max(this.peak, y);
    this.wasGround = bot.entity.onGround;
  }
}
const isHot = (world: World, bot: any) => {
  const p = bot.entity.position, feet = world.getBlock(p).name, head = world.getBlock(p.offset(0, 1, 0)).name, under = world.getBlock(p.offset(0, -0.05, 0)).name;
  return bot.entity.isInLava || feet === 'lava' || head === 'lava' || feet === 'fire' || head === 'fire' || (bot.entity.onGround && under === 'magma_block');
};

// ---- open loop: the verdict of the scan against what the body does when it runs that way -------------------------------------------------
/** Terrain along -z (yaw 0): the top solid y of the column z, 64 where z >= 0. */
const columns = (surface: (zc: number) => number) => worldOf((_x, y, z) => (y <= (z >= 0 ? 64 : surface(z)) ? 'stone' : 'air'));
function openLoop(world: World, ticks = 120) {
  const start = new Vec3(0.5, 65, 0.5);
  const { bot, control, tick } = makeBot(world, start);
  const falls = new Falls(start.y);
  for (let t = 0; t < ticks; t++) { control.forward = true; control.sprint = true; tick(); falls.step(bot); }
  return { damage: falls.damage, worst: falls.worst };
}
describe('open loop: a heading the scan calls safe costs no health; one it refuses would have', () => {
  const CASES: Array<[string, (zc: number) => number, boolean]> = [
    ['one block per block (1:1)', zc => 64 + zc + 1, true],
    ['a block and a half per block (1.5:1)', zc => 64 + Math.floor(1.5 * (zc + 1)), true],
    ['a drop of three', () => 61, true],
    ['two drops of three with level ground between', zc => (zc >= -1 ? 64 : zc >= -3 ? 61 : 58), true],
    ['two blocks per block (2:1)', zc => 64 + 2 * (zc + 1), false],
    ['three blocks per block (3:1)', zc => 64 + 3 * (zc + 1), false],
    ['terraces two blocks each', zc => 64 + 2 * zc, false],
    ['terraces three blocks each', zc => 64 + 3 * zc, false],
    ['2:1 for five cells and then level', zc => (zc >= -5 ? 64 + 2 * (zc + 1) : 54), false],
  ];
  it.each(CASES)('%s', (_label, surface, safe) => {
    const world = columns(surface);
    const bot = makeBot(world, new Vec3(0.5, 65, 0.5)).bot;
    expect(fleeHeadingSafe(bot, bot.entity.position, 0)).toBe(safe);
    const { damage, worst } = openLoop(world);
    // The edge guard is on: what is left is what it cannot stop (a body that has left the ledge). Safe means a fall of two points at most, in one flight.
    if (safe) expect(worst, `damage ${damage}`).toBeLessThan(3);
    else expect(worst, `damage ${damage}`).toBeGreaterThanOrEqual(3);
  });
});

// ---- closed loop: the keys of the reflex ------------------------------------------------------------------------------------------------
interface Outcome { hot: number; damage: number; worst: number; endZ: number; endY: number; moved: boolean; refused: number; maxY: number; out: number }
function closedLoop(world: World, start: Vec3, options: { ticks?: number; threat?: Vec3 | ((position: Vec3) => Vec3); stopAtZ?: number; strategy?: 'keys' | 'nojump'; health?: number } = {}): Outcome {
  const { bot, control, tick } = makeBot(world, start, { health: options.health });
  const falls = new Falls(start.y), memory: { heading?: number } = {};
  let hot = 0, refused = 0, maxY = start.y, out = -1;
  const threatOf = (position: Vec3) => (typeof options.threat === 'function' ? options.threat(position) : options.threat ?? new Vec3(start.x, start.y, start.z + 3));
  for (let t = 0; t < (options.ticks ?? 90); t++) {
    const keys = fleeKeys(bot, [threatOf(bot.entity.position)], memory);
    if (keys === null) { refused++; control.forward = false; control.sprint = false; control.jump = false; }
    else {
      bot.entity.yaw = keys.yaw; control.forward = true; control.sprint = true;
      control.jump = options.strategy === 'nojump' ? keys.jump && bot.entity.onGround !== false : keys.jump;
    }
    tick(); falls.step(bot);
    maxY = Math.max(maxY, bot.entity.position.y);
    if (isHot(world, bot)) hot++;
    if (out < 0 && options.stopAtZ !== undefined && bot.entity.onGround && bot.entity.position.z < options.stopAtZ) out = t;
    if (bot.entity.position.y < 20) break;
  }
  const p = bot.entity.position;
  return { hot, damage: falls.damage, worst: falls.worst, endZ: p.z, endY: p.y, moved: Math.hypot(p.x - start.x, p.z - start.z) > 1.5, refused, maxY, out };
}
const START = new Vec3(0.5, 65, 0.5);
const stoneTo = (height: number, y: number) => (y <= height ? 'stone' : 'air');

describe('closed loop: a one-block step is climbed, and the block it lands on matters', () => {
  it('a step of stone is climbed and the run goes on; a single magma tile in the plateau is never stood on (it was, with 16f57b8)', () => {
    const stoneStep = closedLoop(worldOf((_x, y, z) => (z <= -1 && y === 65 ? 'stone' : stoneTo(64, y))), START);
    expect(stoneStep.endZ).toBeLessThan(-8); expect(stoneStep.endY).toBeCloseTo(66, 1); expect(stoneStep.hot).toBe(0);
    const tile = closedLoop(worldOf((_x, y, z) => (z === -1 && y === 65 ? 'magma_block' : z <= -2 && y === 65 ? 'stone' : stoneTo(64, y))), START);
    expect(tile.hot).toBe(0); expect(tile.maxY).toBeLessThan(66);
    const campfire = closedLoop(worldOf((_x, y, z) => (z === -1 && y === 65 ? ['campfire', { facing: 'north', lit: true, signal_fire: false, waterlogged: false }] : z <= -2 && y === 65 ? 'stone' : stoneTo(64, y))), START);
    expect(campfire.maxY).toBeLessThan(66);
  });
});

describe('closed loop: steep descents cost no health, slopes are run', () => {
  it.each([['2:1', (zc: number) => 64 + 2 * (zc + 1)], ['3:1', (zc: number) => 64 + 3 * (zc + 1)], ['terraces of 3', (zc: number) => 64 + 3 * zc]] as const)('%s: not run straight down (a diagonal or a run along the top is taken instead), and no health is lost', (_label, surface) => {
    const outcome = closedLoop(columns(surface), START);
    expect(outcome.worst).toBeLessThan(3); expect(outcome.damage).toBeLessThan(3); expect(outcome.hot).toBe(0);
  });
  it('1:1 and 1.5:1 are run down without damage of three or more', () => {
    for (const surface of [(zc: number) => 64 + zc + 1, (zc: number) => 64 + Math.floor(1.5 * (zc + 1))]) {
      const outcome = closedLoop(columns(surface), START, { ticks: 60, threat: position => new Vec3(position.x, position.y, position.z + 3) });
      expect(outcome.moved).toBe(true); expect(outcome.worst).toBeLessThan(3);
    }
  });
});

describe('closed loop: the shore (L1)', () => {
  /** A lake for z > -3 (water to y 64, bottom y 58) and a bank of stone up to `bank` for z <= -3, a swimmer in the middle. */
  const lake = (bank: number) => worldOf((_x, y, z) => (z <= -3 ? stoneTo(bank, y) : y <= 58 ? 'stone' : y <= 64 ? 'water' : 'air'));
  const swim = new Vec3(0.5, 64.3, 0.5);
  const follow = (position: Vec3) => new Vec3(0.5, position.y, Math.max(position.z + 3, 1));
  it('a bank flush with the water is climbed out onto with the jump key; without the key (as the old run held it) the body stays at the shore', () => {
    const withKey = closedLoop(lake(64), swim, { ticks: 120, threat: follow, stopAtZ: -2.5 });
    expect(withKey.out, 'it got out').toBeGreaterThanOrEqual(0); expect(withKey.endZ).toBeLessThan(-10); expect(withKey.endY).toBeGreaterThanOrEqual(65);
    const without = closedLoop(lake(64), swim, { ticks: 120, threat: follow, stopAtZ: -2.5, strategy: 'nojump' });
    expect(without.out, 'without the key it is stuck').toBe(-1); expect(without.endZ).toBeGreaterThan(-2.5);
  });
  it('a bank above the water is not gone at (no run, no sticking at the shore wall)', () => {
    const high = closedLoop(lake(65), swim, { ticks: 60, threat: follow, stopAtZ: -2.5 });
    expect(high.out).toBe(-1); expect(high.refused).toBeGreaterThan(30);
  });
});

// ---- seeded fuzz ---------------------------------------------------------------------------------------------------------------------
function lcg(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

describe('closed-loop fuzz (seeded): terrain with lava, magma and fire in it', () => {
  it('one-dimensional terrain of steps, drops and hazard tiles: no hot tick and no fall of three or more in 200 runs (on this kind of terrain df24395 was hot in 3 of 600)', () => {
    const rnd = lcg(7), pick = <T,>(items: T[]) => items[Math.floor(rnd() * items.length)];
    let hot = 0, bad = 0;
    for (let run = 0; run < 200; run++) {
      const columnsOf = new Map<number, { h: number; top: string; above?: string }>();
      let h = 64;
      for (let z = 1; z >= -30; z--) {
        if (z < 0 && rnd() < 0.35) h += pick([-3, -2, -1, -1, 0, 0, 0, 0, 1, 1, 2]);
        const r = rnd(), top = r < 0.04 ? 'lava' : r < 0.07 ? 'magma_block' : r < 0.09 ? 'soul_sand' : r < 0.11 ? 'water' : 'stone';
        columnsOf.set(z, { h, top: z >= 0 ? 'stone' : top, above: z < 0 && rnd() < 0.03 ? 'fire' : undefined });
      }
      const world = worldOf((_x, y, z) => { const c = columnsOf.get(z) ?? { h: 64, top: 'stone' }; return y < c.h ? 'stone' : y === c.h ? c.top : y === c.h + 1 && c.above ? c.above : 'air'; });
      const outcome = closedLoop(world, new Vec3(0.5, columnsOf.get(0)!.h + 1, 0.5), { ticks: 70, threat: new Vec3(0.5, columnsOf.get(0)!.h + 1, 3.5) });
      if (outcome.hot) hot++;
      if (outcome.worst >= 3) bad++;
    }
    expect(hot).toBe(0); expect(bad).toBe(0);
  });
  it('two-dimensional rough terrain with lava and magma patches, run from every side: no fall of three or more in 400 runs, and hardly a hot one (on this kind of terrain df24395 was hot in 41 of 1500, 16f57b8 in 64)', () => {
    const rnd = lcg(11);
    const hash = (a: number, b: number, s: number) => { let h = (a * 374761393 + b * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; h = h ^ (h >>> 16); return ((h >>> 0) % 1000) / 1000; };
    let hot = 0, fall = 0, ran = 0;
    for (let run = 0; run < 400; run++) {
      const pa = rnd() * 6, pb = rnd() * 6, amp = 2.5, rate = 0.03, yawDir = rnd() * Math.PI * 2;
      const height = (x: number, z: number) => 64 + Math.round(amp * Math.sin(x * 0.55 + pa) * Math.cos(z * 0.5 + pb) + (hash(x, z, run) - 0.5) * amp * 0.9);
      const patch = (x: number, z: number) => { const v = hash(x + 100, z + 100, run + 5); return v < rate ? 'lava' : v < rate * 2 ? 'magma_block' : null; };
      const world = worldOf((x, y, z) => { const near = Math.hypot(x, z) <= 1, hh = near ? 64 : height(x, z); return y < hh ? 'stone' : y === hh ? (near ? 'stone' : patch(x, z) ?? 'stone') : 'air'; });
      const outcome = closedLoop(world, START, { ticks: 60, threat: new Vec3(0.5 + Math.sin(yawDir) * 3, 65, 0.5 + Math.cos(yawDir) * 3) });
      if (outcome.hot) hot++;
      if (outcome.worst >= 3) fall++;
      if (outcome.moved) ran++;
    }
    expect(fall).toBe(0); expect(hot).toBeLessThanOrEqual(2); expect(ran).toBeGreaterThan(150);
  });
});
