import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { createRequire } from 'node:module';
import { takeActReport, renderActReport } from '../../src/services/minebot/utils/actReport.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { cooldownMs } from '../../src/services/minebot/utils/primitives/attack.js';
import { isEngaged } from '../../src/services/minebot/utils/engagement.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { eat } from '../../src/services/minebot/utils/primitives/body.js';
import { scanLoadedBlocks } from '../../src/services/minebot/utils/loadedBlockScan.js';
import { GATE_PATIENCE_MS, GATE_WINDOW_MS, ShooterWatch, StrikeGate, blazeCharged, hoversAboveReach, nextShotTicks, strikeHold } from '../../src/services/minebot/utils/huntBlaze.js';

// The blaze camp (S2, 2026-11-02): a blaze is not followed off the spot, a blaze that hovers beyond a sword's reach is waited for under the shield, what comes within reach is
// struck, a blow waits (for a while) for a shot that is about to land or a blaze about to shoot, and the drop is told in the line the fight ends with.
// The practice field is the fight hand's (tests/unit/fightHand.test.ts): the body moves by the client physics; the creatures are modelled (a blaze here is a point with a box
// that stays where the scene puts it; it does not shoot: the shots and the flames are set by the scene).

// The camp's retreat (below) walks with `go`, eats with `eat` and finds the spawner by the scan: each is the real one until a test says otherwise.
vi.mock('../../src/services/minebot/utils/primitives/go.js', async importOriginal => { const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/go.js')>(); return { ...actual, go: vi.fn(actual.go) }; });
vi.mock('../../src/services/minebot/utils/primitives/body.js', async importOriginal => { const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/body.js')>(); return { ...actual, eat: vi.fn(actual.eat) }; });
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', async importOriginal => { const actual = await importOriginal<typeof import('../../src/services/minebot/utils/loadedBlockScan.js')>(); return { ...actual, scanLoadedBlocks: vi.fn(actual.scanLoadedBlocks) }; });

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const BLAZE_FLAGS = mcData.entitiesByName.blaze.metadataKeys!.indexOf('flags');
const itemOf = (name: string, count = 1, slot = 36) => ({ name, count, type: (mcData.itemsByName as any)[name]?.id ?? 9000, slot });

interface BlazeSpec { at: Vec3; /** Where the blaze is at t ms after the start: the script of its hover. */ path?: (ms: number) => Vec3; charged?: (ms: number) => boolean; health?: number }
function makeCamp(options: { shield?: boolean; held?: string; blazes: BlazeSpec[]; walls?: Array<[number, number, number]> }) {
  const cache = new Map<string, any>();
  const wallCells = new Set((options.walls ?? []).map(([x, y, z]) => `${x},${y},${z}`));
  const getBlock = (position: Vec3) => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const name = y < 64 || wallCells.has(`${x},${y},${z}`) ? 'stone' : 'air';
    const key = `${name}@${x},${y},${z}`;
    if (!cache.has(key)) { const block = new Block(mcData.blocksByName[name].id, 0, 0); block.position = new Vec3(x, y, z); cache.set(key, block); }
    return cache.get(key);
  };
  const world = { getBlock, blockAt: getBlock };
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const slots: any[] = new Array(46).fill(null);
  slots[36] = itemOf(options.held ?? 'iron_sword', 1, 36);
  if (options.shield) slots[45] = itemOf('shield', 1, 45);
  const stats = { swings: 0, hits: 0, keyWrites: 0, forwardOn: 0, minX: 0.5, maxX: 0.5, minZ: 0.5, maxZ: 0.5, shotsFlown: 0 };
  const start = Date.now();
  const bot: any = Object.assign(new EventEmitter(), {
    version: VERSION, registry: mcData, game: { dimension: 'the_nether' }, health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, physics, controlState: control, entities: {} as Record<string, any>,
    entity: { id: 1, name: 'player', type: 'player', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) }, quickBarSlot: 0, usingHeldItem: false,
    executingSkill: false, interruptExecution: false, stopDigging: () => undefined,
    blockAt: world.blockAt, getControlState: (name: string) => control[name],
    setControlState: (name: string, value: boolean) => { if (control[name] !== value) { stats.keyWrites++; if (name === 'forward' && value) stats.forwardOn++; } control[name] = value; },
    clearControlStates: () => { for (const key of Object.keys(control)) control[key] = false; },
    getEquipmentDestSlot: (destination: string) => ({ 'off-hand': 45, hand: 36, head: 5, torso: 6, legs: 7, feet: 8 } as Record<string, number>)[destination],
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    lookAt: async (point: Vec3) => {
      const eye = bot.entity.position.offset(0, 1.62, 0), d = point.minus(eye);
      bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    },
    equip: async (item: any, destination: string) => {
      const from = item.slot, old = destination === 'off-hand' ? slots[45] : slots[36], to = destination === 'off-hand' ? 45 : 36;
      if (from !== to) { slots[from] = old; if (old) old.slot = from; }
      slots[to] = item; item.slot = to;
      bot.heldItem = slots[36] ?? null; bot.emit('heldItemChanged', bot.heldItem);
    },
    setQuickBarSlot: () => undefined,
    activateItem: () => { bot.usingHeldItem = true; }, deactivateItem: () => { bot.usingHeldItem = false; },
    attack: (mob: any) => {
      stats.swings++;
      if (bot.usingHeldItem && slots[45]?.name === 'shield') return;             // refused from behind a raised shield
      const eye = bot.entity.position.offset(0, 1.62, 0), half = mob.width / 2, p = mob.position;
      const dx = Math.max(Math.abs(eye.x - p.x) - half, 0), dz = Math.max(Math.abs(eye.z - p.z) - half, 0), dy = Math.max(p.y - eye.y, eye.y - (p.y + mob.height), 0);
      if (Math.hypot(dx, dy, dz) > 3.0 || mob.health <= 0) return;
      const now = Date.now(), charge = Math.min(1, (now - (bot.lastAttackAt ?? 0)) / cooldownMs(bot.heldItem?.name)); bot.lastAttackAt = now;
      if (now - mob.hurtAt < 500) return;
      mob.hurtAt = now; mob.health -= 6 * (0.2 + 0.8 * charge * charge); stats.hits++;
      setTimeout(() => {
        bot.emit('entityHurt', mob);
        if (mob.health <= 0) {
          mob.deadAt = Date.now(); bot.emit('entityDead', mob);
          // The drop: an item entity where it died, its stack told by the entity.
          const rod: any = { id: 900 + mob.id, name: 'item', position: mob.position.clone().offset(0.3, -1, 0), isValid: true, getDroppedItem: () => ({ name: 'blaze_rod', count: 1 }) };
          bot.entities[rod.id] = rod; bot.emit('entitySpawn', rod);
        }
      }, 30);
    },
    pathfinder: {
      movements: undefined as any, goal: null as any,
      setMovements(movements: any) { this.movements = movements; },
      setGoal(goal: any) { this.goal = goal; if (!goal) { control.forward = false; control.sprint = false; control.jump = false; } },
      stop() { this.setGoal(null); },
    },
  });
  bot.heldItem = slots[36];
  const mobs = options.blazes.map((spec, index) => {
    const metadata: unknown[] = new Array(mcData.entitiesByName.blaze.metadataKeys!.length).fill(0);
    const mob: any = { id: 100 + index, name: 'blaze', type: 'hostile', position: spec.at.clone(), velocity: new Vec3(0, 0, 0), height: 1.8, width: 0.6, health: spec.health ?? 20,
      metadata, isValid: true, hurtAt: 0, spec };
    bot.entities[mob.id] = mob;
    return mob;
  });
  const tick = () => {
    const e = bot.entity, goal = bot.pathfinder.goal;
    if (goal?.entity) {
      const to = goal.entity.position.minus(e.position);
      if (Math.hypot(to.x, to.z) > Math.sqrt(goal.rangeSq ?? 4)) { e.yaw = Math.atan2(-to.x, -to.z); control.forward = true; }
      else control.forward = false;
    }
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    stats.minX = Math.min(stats.minX, e.position.x); stats.maxX = Math.max(stats.maxX, e.position.x);
    stats.minZ = Math.min(stats.minZ, e.position.z); stats.maxZ = Math.max(stats.maxZ, e.position.z);
    const ms = Date.now() - start;
    for (const mob of mobs) {
      if (mob.health <= 0) { if (Date.now() - (mob.deadAt ?? Date.now()) > 600) { mob.isValid = false; delete bot.entities[mob.id]; bot.emit('entityGone', mob); } continue; }
      if (mob.spec.path) mob.position = mob.spec.path(ms);
      mob.metadata[BLAZE_FLAGS] = mob.spec.charged?.(ms) ? 1 : 0;
    }
    bot.emit('physicsTick');
  };
  const timer = setInterval(tick, 50);
  return { bot, control, mobs, stats, stop: () => clearInterval(timer) };
}
type Camp = ReturnType<typeof makeCamp>;

async function act(camp: Camp, handList: unknown, options: { accept?: string[] } = {}) {
  const since = Date.now();
  const hands = ACT_HANDS.parse(handList);
  const result = await executeAction(camp.bot, 'act', 120_000, async () => runAct(createMotorPort(camp.bot), hands, undefined, undefined, { accept: options.accept }), { waitForQuiescence: true });
  let text = result.result as string;
  if (!text.startsWith('{')) {
    const report = takeActReport(camp.bot, since);
    if (report) text = renderActReport(camp.bot, report, camp.bot.reflexLedger?.noteSince(0));
  }
  return { result, json: JSON.parse(text) };
}
const lineOf = (json: any, index = 0) => String(json.lines[index].line);

describe('what the camp reads', () => {
  const body = new Vec3(0.5, 64, 0.5);
  it('a blaze is charged by the first bit of its flags, and nothing is said when the data has no such key', () => {
    const blaze: any = { name: 'blaze', metadata: new Array(mcData.entitiesByName.blaze.metadataKeys!.length).fill(0) };
    expect(blazeCharged(mcData as any, blaze)).toBe(false);
    blaze.metadata[BLAZE_FLAGS] = 1;
    expect(blazeCharged(mcData as any, blaze)).toBe(true);
    expect(blazeCharged({} as any, blaze)).toBeNull();
  });

  it('hovering above reach means the lowest point of the creature is more than 3 above the eye', () => {
    expect(hoversAboveReach(body, { position: new Vec3(2, 68.7, 0) })).toBe(true);
    expect(hoversAboveReach(body, { position: new Vec3(2, 66.5, 0) })).toBe(false);
    expect(hoversAboveReach(body, { position: new Vec3(2, 60, 0) })).toBe(false);
  });

  it('a shot on its way to the body is a number of ticks away; one that passes wide is none', () => {
    const bot: any = { entity: { position: body.clone() }, entities: {
      1: { id: 1, name: 'small_fireball', type: 'projectile', position: new Vec3(0.5, 65, -8.5), velocity: new Vec3(0, 0, 0.8) },
      2: { id: 2, name: 'small_fireball', type: 'projectile', position: new Vec3(12, 65, -8.5), velocity: new Vec3(0, 0, 0.8) },
    } };
    const ticks = nextShotTicks(bot, 20);
    expect(ticks).not.toBeNull();
    expect(ticks!).toBeGreaterThan(3);
    expect(ticks!).toBeLessThan(14);
    bot.entities = { 2: bot.entities[2] };
    expect(nextShotTicks(bot, 20)).toBeNull();
  });
});

describe('fight on a blaze: the camp', () => {
  it('a blaze hovering out of reach is not followed: no key is pressed, the body keeps its place, and when the blaze comes down it is struck and the rod is told', async () => {
    const hoverUntil = 2500;
    const camp = makeCamp({ shield: true, blazes: [{
      at: new Vec3(4.5, 70, 0.5),
      path: ms => ms < hoverUntil ? new Vec3(4.5, 70.5, 0.5) : new Vec3(1.5, 64.2, 0.5),
    }] });
    const { json, result } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 30 }]);
    camp.stop();
    console.log('[blaze 1]', result.failureType, lineOf(json), JSON.stringify(camp.stats));
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/^fight 済 blaze #100 死んだ・落とし物 blaze_rod×1・与えた打撃 \d+/u);
    expect(camp.stats.forwardOn).toBe(0);
    expect(camp.stats.maxX - camp.stats.minX).toBeLessThan(0.5);
    expect(camp.stats.maxZ - camp.stats.minZ).toBeLessThan(0.5);
    expect(camp.mobs[0].health).toBeLessThanOrEqual(0);
    expect(isEngaged(camp.bot)).toBe(false);
  }, 60_000);

  it('a blaze at eye level a few blocks off is approached only as far as the camp\'s leash, then waited for', async () => {
    const camp = makeCamp({ shield: false, blazes: [{ at: new Vec3(9.5, 65.5, 0.5) }], held: 'iron_sword' });
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', range: 12, seconds: 6 }]);
    camp.stop();
    console.log('[blaze 2]', lineOf(json), JSON.stringify(camp.stats));
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toMatch(/limit_time/u);
    // the body moved toward it by no more than the leash (3.5 blocks) and a step
    expect(camp.stats.maxX - 0.5).toBeLessThan(4.6);
    expect(camp.stats.swings).toBe(0);
    expect(camp.bot.pathfinder.goal).toBeNull();
  }, 60_000);

  it('a blow waits for a blaze that is about to shoot (charged for more than 2.2 s and in sight), for the patience at most, and is struck; the held blow is counted', async () => {
    // The target comes within reach at 2.6 s; the other blaze, in sight, has been charged since 0.3 s: 2.3 s by then, which is long enough to be about to shoot.
    const camp = makeCamp({ shield: true, blazes: [
      { at: new Vec3(1.5, 70.5, 0.5), path: ms => ms < 2600 ? new Vec3(1.5, 70.5, 0.5) : new Vec3(1.5, 65.0, 0.5) },
      { at: new Vec3(-6.5, 66, 3.5), charged: ms => ms > 300 },
    ] });
    const started = Date.now();
    const { json } = await act(camp, [{ do: 'fight', target: '#100', seconds: 20 }]);
    camp.stop();
    console.log('[blaze 3]', lineOf(json), JSON.stringify(camp.stats), Date.now() - started, 'ms');
    expect(json.ok).toBe(true);
    // the first blow was held back for the patience (1.5 s) and then struck anyway, and the hold was told
    expect(lineOf(json)).toMatch(/見送り 1/u);
    expect(camp.mobs[0].health).toBeLessThanOrEqual(0);
    expect(Date.now() - started).toBeGreaterThan(2600 + 1300);
    // only the first stretch of waiting is the patience's: the blows after it go (a flame that never goes out must not defer every blow)
    expect(Date.now() - started).toBeLessThan(13_000);
  }, 60_000);

  it('the watch knows how long a blaze has been charged, and forgets it when the flame is out', async () => {
    const camp = makeCamp({ blazes: [{ at: new Vec3(3.5, 65, 0.5), charged: ms => ms < 100000 }] });
    await sleep(120);                                                  // the first tick sets the flame
    const watch = new ShooterWatch(camp.bot);
    const first = watch.charged(1000);
    expect(first).toHaveLength(1);
    expect(first[0].ms).toBe(0);
    expect(watch.charged(3500)[0].ms).toBe(2500);
    expect(strikeHold(camp.bot, watch, 3500)).toMatch(/溜めていて撃つ直前/u);
    expect(strikeHold(camp.bot, watch, 1500)).toBeNull();
    camp.mobs[0].spec.charged = () => false;
    await sleep(120);
    expect(watch.charged(4000)).toHaveLength(0);
    camp.stop();
  });
});

describe('fight on a creature that is not there', () => {
  it('says it is not seen within 32 m and the next hand to try, by kind (S4\'s c1 trial: three fights in a row ended on the bare "not seen")', async () => {
    const camp = makeCamp({ shield: true, blazes: [] });
    const blaze = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 10 }]);
    const ender = await act(camp, [{ do: 'fight', target: 'enderman', seconds: 10 }]);
    camp.stop();
    expect(lineOf(blaze.json)).toContain('probe kind=camp');
    expect(lineOf(ender.json)).toContain('probe kind=around');
    expect(blaze.json.ok).toBe(false);
    expect(lineOf(blaze.json).length).toBeLessThanOrEqual(160);
  }, 30_000);
});

describe('fight on a blaze: the shield and the choice of the blaze', () => {
  it('a shield that breaks in the fight is replaced from the pack at once; the wear counts what the broken one had left, and the line says a spare was put on', async () => {
    const camp = makeCamp({ shield: true, blazes: [{ at: new Vec3(1.5, 70.5, 0.5), path: ms => ms < 2600 ? new Vec3(1.5, 70.5, 0.5) : new Vec3(1.5, 65.0, 0.5) }] });
    (camp.bot.inventory.slots as any[])[45].durabilityUsed = 300;
    (camp.bot.inventory.slots as any[])[20] = itemOf('shield', 1, 20);
    setTimeout(() => { (camp.bot.inventory.slots as any[])[45] = null; }, 1000);
    const { json } = await act(camp, [{ do: 'fight', target: '#100', seconds: 20 }]);
    camp.stop();
    console.log('[blaze spare]', lineOf(json));
    expect(json.ok).toBe(true);
    expect(camp.bot.inventory.slots[45]?.name).toBe('shield');
    expect(lineOf(json)).toContain('予備に替えた×1');
    expect(lineOf(json)).toMatch(/盾 −36/u);
  }, 60_000);

  it('a blaze named by its kind: of two, the one the eye sees is fought, though the other is nearer (it hovers behind the wall)', async () => {
    // The nearer blaze (id 100) is two blocks off with a wall of stone between; the other (id 101) is in sight, three blocks the other way, at the body's height.
    const walls: Array<[number, number, number]> = [];
    for (const y of [64, 65, 66, 67]) for (const z of [-1, 0, 1]) walls.push([1, y, z]);
    const camp = makeCamp({ shield: true, walls, blazes: [
      { at: new Vec3(2.5, 65.5, 0.5) },
      { at: new Vec3(-2.0, 65.5, 0.5) },
    ] });
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    console.log('[blaze pick]', lineOf(json));
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toContain('#101');
    expect(camp.mobs[1].health).toBeLessThanOrEqual(0);
    expect(camp.mobs[0].health).toBe(20);
  }, 60_000);
});

// S2 (2026-11-02, S4's c1 trials: a fight at the spawner ran the health down to 2 in one act): below the planner's retreatHp, or the camp's own 12 when none was given, the body leaves the
// blazes' sight for a footing none of the spawner's blazes can see (utils/huntCamp, the one `probe kind=camp` names), eats and rests there until the health is back, and the hand ends.
describe('fight on a blaze: below the retreat health, to a hideout', () => {
  /** The spawner at (-3, 64, 2) with a wall of stone at x 3 from z -6 to 6, five high: what lies behind it is out of the sight of every blaze of the spawner. */
  const wall: Array<[number, number, number]> = [];
  for (let y = 64; y <= 68; y++) for (let z = -6; z <= 6; z++) wall.push([3, y, z]);
  const scanSpawner = () => vi.mocked(scanLoadedBlocks).mockImplementation(((_bot: unknown, names: Iterable<string>) => ({ hits: [...names].includes('spawner') ? [{ name: 'spawner', position: new Vec3(-3, 64, 2), distance: 4 }] : [], columns: 9, reachMetres: 48, sectionsScanned: 1 })) as never);
  const setUp = (health: number, options: { blazes?: BlazeSpec[]; meals?: boolean } = {}) => {
    const camp = makeCamp({ shield: true, walls: wall, blazes: options.blazes ?? [{ at: new Vec3(-2.5, 65.5, 0.5) }] });
    camp.bot.health = health; camp.bot.food = 14;
    if (options.meals !== false) (camp.bot.inventory.slots as any[])[20] = itemOf('cooked_beef', 10, 20);
    return camp;
  };
  const walkTo = () => vi.mocked(go).mockImplementationOnce((async (ctx: any, args: any) => { const at = args.goals[0]; ctx.bot.entity.position = new Vec3(at.x + 0.5, at.y, at.z + 0.5); return { ok: true, text: '着いた' }; }) as never);
  const healBy = (camp: Camp, points: number) => vi.mocked(eat).mockImplementation((async () => { camp.bot.health = Math.min(20, camp.bot.health + points); camp.bot.emit('health'); return { ok: true, text: '食べた' }; }) as never);

  it('with no retreatHp given the camp\'s own 12 applies: it goes to a footing behind the wall, eats, rests until the health is back (18), and the hand ends with where it was and how it went', async () => {
    scanSpawner(); walkTo();
    const camp = setUp(7);
    healBy(camp, 6);
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    const line = lineOf(json);
    console.log('[blaze retreat]', line);
    expect(json.ok).toBe(false);
    expect(line).toContain('retreat');
    expect(line).toMatch(/体力 7→19 退いた先 \(\d+,64,-?\d+\) は湧き場から見えない/u);
    expect(line).toContain('戻った');
    const goal = vi.mocked(go).mock.calls.at(-1)![1].goals[0];
    expect(goal.x).toBeGreaterThanOrEqual(4);
    expect(camp.bot.health).toBeGreaterThanOrEqual(18);
    expect(vi.mocked(eat)).toHaveBeenCalledTimes(2);
    expect(camp.mobs[0].health).toBe(20);
  }, 60_000);

  it('a footing the way to which is shut (go says why) gives way to the next one, and the first one\'s reason is not lost', async () => {
    scanSpawner();
    vi.mocked(go).mockClear();
    vi.mocked(go).mockImplementationOnce((async () => ({ ok: false, text: 'go 止まった unsafe: 行き先は火の隣' })) as never);
    walkTo();
    const camp = setUp(7);
    healBy(camp, 6);
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    expect(vi.mocked(go)).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(go).mock.calls.map(call => call[1].goals[0]);
    expect(`${second.x},${second.y},${second.z}`).not.toBe(`${first.x},${first.y},${first.z}`);
    expect(lineOf(json)).toContain('退いた先');
    expect(camp.bot.health).toBeGreaterThanOrEqual(18);
  }, 60_000);

  it('a retreatHp the planner gave is its own limit: 1 keeps the body in the fight at 7 hearts (the camp\'s default is overridden, not added)', async () => {
    scanSpawner();
    vi.mocked(go).mockClear();
    const camp = setUp(7, { blazes: [{ at: new Vec3(4.5, 70, 0.5), path: ms => ms < 1500 ? new Vec3(4.5, 70.5, 0.5) : new Vec3(1.5, 64.2, 0.5) }] });
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', retreatHp: 1, seconds: 30 }]);
    camp.stop();
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/^fight 済 blaze #100 死んだ/u);
    expect(vi.mocked(go)).not.toHaveBeenCalled();
  }, 60_000);

  it('shot at the hideout too (health lost there): it does not rest on, and says so', async () => {
    scanSpawner(); walkTo();
    const camp = setUp(9);
    vi.mocked(eat).mockImplementation((async () => { camp.bot.health -= 5; camp.bot.emit('health'); return { ok: true, text: '食べた' }; }) as never);
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toContain('でも撃たれた');
  }, 60_000);

  it('with no hideout known (nothing loaded says a spawner) it is the old flight: go is not asked for', async () => {
    vi.mocked(scanLoadedBlocks).mockImplementation((() => ({ hits: [], columns: 9, reachMetres: 48, sectionsScanned: 1 })) as never);
    vi.mocked(go).mockClear();
    const camp = setUp(7, { meals: false });
    camp.bot.food = 20;
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    console.log('[blaze flight]', lineOf(json));
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toContain('retreat');
    expect(vi.mocked(go)).not.toHaveBeenCalled();
  }, 60_000);
});

describe('StrikeGate: the patience is a budget, not a delay on every blow', () => {
  it('holds a blow while a reason stands, up to the patience in all within a window, and then lets the blows go until the window is over', () => {
    const gate = new StrikeGate();
    expect(gate.may(0, null)).toBe(true);
    expect(gate.may(100, 'a shot')).toBe(false);
    expect(gate.may(600, 'a shot')).toBe(false);
    expect(gate.count).toBe(1);
    expect(gate.may(100 + GATE_PATIENCE_MS + 10, 'a shot')).toBe(true);         // the window's patience is used
    expect(gate.may(2000, 'a shot')).toBe(true);
    expect(gate.may(5000, 'a shot')).toBe(true);
    expect(gate.may(GATE_WINDOW_MS + 100, 'a shot')).toBe(false);               // a new window: the reason holds again
    expect(gate.count).toBe(2);
    expect(gate.may(GATE_WINDOW_MS + 200, null)).toBe(true);
  });
});

describe('attack hold on a blaze', () => {
  it('equips a shield that is only in the pack, waits longer for a blaze in sight that hovers out of reach, and tells the drop and the wear', async () => {
    const camp = makeCamp({ shield: false, blazes: [{ at: new Vec3(3.5, 70.2, 0.5), path: ms => ms < 10000 ? new Vec3(3.5, 70.2, 0.5) : new Vec3(1.2, 64.2, 0.5) }] });
    // a shield only in the pack
    (camp.bot.inventory.slots as any[])[20] = itemOf('shield', 1, 20);
    const { json } = await act(camp, [{ do: 'attack', target: 'blaze', hold: true, seconds: 30 }], { accept: ['blaze'] });
    camp.stop();
    console.log('[blaze hold]', lineOf(json), JSON.stringify(camp.stats));
    expect(camp.bot.inventory.slots[45]?.name).toBe('shield');
    // the default 8 s of nothing in reach would have ended it before the blaze came down at 10 s: it was waited for, struck and killed, and the rod is told
    // (the hold then ends after 8 s with nothing more in sight: the existing stop, which tells the same counts)
    expect(lineOf(json)).toMatch(/倒した 1（blaze）/u);
    expect(lineOf(json)).toContain('blaze_rod×1');
  }, 60_000);

  it('a blaze that never comes within reach and is not in sight ends the hold as before, after the default patience', async () => {
    const camp = makeCamp({ shield: true, blazes: [] });
    const started = Date.now();
    const { json } = await act(camp, [{ do: 'attack', target: 'blaze', hold: true, seconds: 30 }], { accept: ['blaze'] });
    camp.stop();
    expect(json.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(lineOf(json)).toMatch(/打てる所/u);
  }, 60_000);
});
