import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { createRequire } from 'node:module';
import { makeSim, type Sim } from '../helpers/physicsBody.js';
import { takeActReport, renderActReport } from '../../src/services/minebot/utils/actReport.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { cooldownMs } from '../../src/services/minebot/utils/primitives/attack.js';
import { isEngaged } from '../../src/services/minebot/utils/engagement.js';
import { isHeadCombatActive } from '../../src/services/minebot/utils/combatOwner.js';
import { installShieldBlock } from '../../src/services/minebot/utils/shieldBlock.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { fight } from '../../src/services/minebot/utils/primitives/fight.js';
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
    } else if (goal && typeof goal.x === 'number') {                    // a GoalNear: to the middle of its cell
      const to = new Vec3(goal.x + 0.5 - e.position.x, 0, goal.z + 0.5 - e.position.z);
      if (Math.hypot(to.x, to.z) > Math.min(0.5, Math.sqrt(goal.rangeSq ?? 1))) { e.yaw = Math.atan2(-to.x, -to.z); control.forward = true; }
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

  it('a blaze at eye level beyond a sortie\'s reach (9 blocks from the camp) is not gone out to: the body waits at the camp', async () => {
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

  // The sortie (S2, 2026-11-04): a blaze within SORTIE_M of the camp is walked to while none that sees the body is charged, struck, and the body comes back when one is.
  it('a sortie: a blaze at eye level 6.5 blocks off, its flame out, is walked to (more than 2 blocks out) and killed; the line tells the sortie and where it ended', async () => {
    const camp = makeCamp({ shield: true, blazes: [{ at: new Vec3(7.0, 64.5, 0.5) }] });
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', range: 12, seconds: 20 }]);
    camp.stop();
    console.log('[sortie A]', lineOf(json), JSON.stringify(camp.stats));
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/死んだ.*出撃 1（野営マスから [\d.]+m の所で終えた）/u);
    expect(camp.stats.maxX - 0.5).toBeGreaterThan(2.5);
    expect(camp.mobs[0].health).toBeLessThanOrEqual(0);
  }, 60_000);

  it('a sortie waits for the window: the same blaze with its flame on from the start is not walked to', async () => {
    const camp = makeCamp({ shield: true, blazes: [{ at: new Vec3(7.0, 64.5, 0.5), charged: () => true }] });
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', range: 12, seconds: 5 }]);
    camp.stop();
    console.log('[sortie B]', lineOf(json), JSON.stringify(camp.stats));
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toMatch(/limit_time/u);
    expect(camp.stats.maxX - 0.5).toBeLessThan(1);
    expect(camp.stats.swings).toBe(0);
  }, 60_000);

  it('a sortie turns back: a blaze that lights its flame while the body is out (and stays lit a second) sends it home to the camp', async () => {
    const camp = makeCamp({ shield: true, blazes: [{ at: new Vec3(7.0, 64.5, 0.5), health: 400, charged: ms => ms > 2500 }] });
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', range: 12, seconds: 8 }]);
    camp.stop();
    console.log('[sortie C]', lineOf(json), JSON.stringify(camp.stats), camp.bot.entity.position);
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toMatch(/limit_time.*出撃 1/u);
    expect(lineOf(json)).not.toMatch(/の所で終えた/u);
    expect(camp.stats.maxX - 0.5).toBeGreaterThan(2.5);
    expect(Math.abs(camp.bot.entity.position.x - 0.5)).toBeLessThan(1.6);
    expect(camp.mobs[0].health).toBeGreaterThan(0);
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
// blazes' sight for a footing none of the spawner's blazes can see (utils/huntCamp, the one `probe kind=camp` names), and the hand ends there with the facts; eating and waiting are the head's (2026-11-05).
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

  it('with no retreatHp given the camp\'s own 12 applies: it goes to a footing behind the wall and the hand ends there with the facts (health, hunger, food), neither eating nor waiting', async () => {
    scanSpawner(); walkTo();
    vi.mocked(eat).mockClear();
    const camp = setUp(7);
    (camp.bot.inventory.slots as any[])[21] = itemOf('blaze_rod', 5, 21); (camp.bot.inventory.slots as any[])[22] = itemOf('blaze_powder', 3, 22);
    healBy(camp, 6);
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    const line = lineOf(json);
    console.log('[blaze retreat]', line);
    expect(json.ok).toBe(false);
    expect(line).toContain('retreat');
    expect(line).toMatch(/体力 7→7・満腹度 14（18 未満では体力が戻らない） 退いた先 \(\d+,64,-?\d+\) は湧き場から見えない（\d+歩）に着いた・食べ物 cooked_beef 10/u);
    expect(line).toContain('ロッド換算 6.5。');
    expect(line).toContain('頭が選ぶ');
    const goal = vi.mocked(go).mock.calls.at(-1)![1].goals[0];
    expect(goal.x).toBeGreaterThanOrEqual(4);
    // S2 (2026-11-05, the coordinator): eating and waiting at the hideout are the head's, not the hand's (raid3 sat at 6.1 with hunger 17 and went out again).
    expect(vi.mocked(eat)).not.toHaveBeenCalled();
    expect(camp.bot.health).toBe(7);
    expect(camp.mobs[0].health).toBe(20);
  }, 60_000);

  it('a footing the way to which is shut (go says why) gives way to the next one, and the first one\'s reason is not lost', async () => {
    scanSpawner();
    vi.mocked(go).mockClear();
    vi.mocked(go).mockImplementationOnce((async () => ({ ok: false, text: 'go 止まった unsafe: 行き先は火の隣' })) as never);
    walkTo();
    const camp = setUp(7);
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    expect(vi.mocked(go)).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(go).mock.calls.map(call => call[1].goals[0]);
    expect(`${second.x},${second.y},${second.z}`).not.toBe(`${first.x},${first.y},${first.z}`);
    expect(lineOf(json)).toContain('退いた先');
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

  it('at the full hunger the line says the health mends there (the head may wait without eating)', async () => {
    scanSpawner(); walkTo();
    vi.mocked(eat).mockClear();
    const camp = setUp(9);
    camp.bot.food = 20;
    const { json } = await act(camp, [{ do: 'fight', target: 'blaze', seconds: 20 }]);
    camp.stop();
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toContain('満腹度 20（体力が戻る）');
    expect(vi.mocked(eat)).not.toHaveBeenCalled();
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

  describe('the retreat interrupts the fighting wait', () => {
    let camp: Camp;
    beforeEach(() => { vi.useFakeTimers(); scanSpawner(); vi.mocked(go).mockClear(); });
    afterEach(async () => {
      camp?.stop(); vi.useRealTimers();
      const actual = await vi.importActual<typeof import('../../src/services/minebot/utils/loadedBlockScan.js')>('../../src/services/minebot/utils/loadedBlockScan.js');
      vi.mocked(scanLoadedBlocks).mockImplementation(actual.scanLoadedBlocks);
    });

    it.each(['sortie', 'meetingShot', 'home', 'replaceBroken', 'equipWeapon'] as const)('%s: below 12, go takes the legs within two ticks, even while burning', async where => {
      camp = setUp(20, { blazes: [{ at: new Vec3(-6.5, 64.5, 0.5), health: 400 }] });
      const shield = camp.bot.shieldBlock = { raised: 0, up: false };
      let equipped: (() => void) | undefined, waitingForEquip = false;
      const equip = camp.bot.equip;
      if (where === 'equipWeapon') {
        camp.bot.heldItem = null;
        camp.bot.equip = () => { waitingForEquip = true; return new Promise<void>(resolve => { equipped = resolve; }); };
      }
      let walkedAt = Infinity, injuredAt = Infinity, oldGoal: any;
      vi.mocked(go).mockImplementationOnce((async (ctx: any, args: any) => {
        walkedAt = Date.now(); oldGoal = camp.bot.pathfinder.goal;
        expect(ctx.stop.aborted).toBe(false);
        expect(isHeadCombatActive(camp.bot)).toBe(true);
        expect(args).not.toHaveProperty('canDig');
        const p = args.goals[0]; ctx.bot.entity.position = new Vec3(p.x + 0.5, p.y, p.z + 0.5);
        return { ok: true, text: '着いた' };
      }) as never);
      const running = act(camp, [{ do: 'fight', target: 'blaze', seconds: 30 }]);
      await vi.advanceTimersByTimeAsync(100);
      if (where !== 'equipWeapon') {
        expect(camp.bot.pathfinder.goal?.entity).toBe(camp.mobs[0]);
        // Already away from the camp; neither a retreat nor the way home may keep this follow goal alive.
        camp.bot.entity.position = new Vec3(-2.5, 64, 0.5);
      }
      if (where === 'meetingShot') { shield.up = true; shield.raised++; }
      if (where === 'home') camp.bot.entities[701] = { id: 701, name: 'small_fireball', type: 'projectile', position: new Vec3(-2.5, 65, -3), velocity: new Vec3(0, 0, 0.8) };
      if (where === 'replaceBroken') {
        camp.bot.inventory.slots[45] = null;
        camp.bot.inventory.slots[21] = itemOf('shield', 1, 21);
        camp.bot.equip = () => { waitingForEquip = true; return new Promise<void>(resolve => { equipped = resolve; }); };
      }
      await vi.advanceTimersByTimeAsync(100);
      if (where === 'meetingShot') expect(camp.bot.pathfinder.goal?.entity).toBe(camp.mobs[0]);
      if (where === 'home') expect(camp.bot.pathfinder.goal?.entity).toBeUndefined();
      if (where === 'replaceBroken' || where === 'equipWeapon') expect(waitingForEquip).toBe(true);
      const blows = camp.stats.swings;
      injuredAt = Date.now(); camp.bot.entity.onFire = true; camp.bot.health = 11;
      // No health event: physicsTick must still wake a native equip that has not returned.
      if (where === 'sortie') camp.bot.emit('health');
      await vi.advanceTimersByTimeAsync(100);
      expect(walkedAt - injuredAt).toBeLessThanOrEqual(100);
      expect(oldGoal).toBeNull();
      expect(camp.stats.swings).toBe(blows);
      expect(vi.mocked(go)).toHaveBeenCalledTimes(1);
      const { json } = await running;
      expect(lineOf(json)).toContain('退いた先');
      expect(lineOf(json)).not.toContain('fight-retreat');
      expect(camp.bot.listenerCount('health')).toBe(0);
      // A native equip that finishes late must not retry a hotbar write over the completed retreat.
      camp.bot.setQuickBarSlot = vi.fn();
      equipped?.(); await vi.advanceTimersByTimeAsync(2500);
      expect(camp.bot.setQuickBarSlot).not.toHaveBeenCalled();
      camp.bot.equip = equip;
    });

    it('a floor owner already holding the body wins; the health interrupt starts no competing go', async () => {
      camp = setUp(20, { blazes: [{ at: new Vec3(-6.5, 64.5, 0.5), health: 400 }] });
      const running = act(camp, [{ do: 'fight', target: 'blaze', seconds: 30 }]);
      await vi.advanceTimersByTimeAsync(100);
      camp.bot.floorReflexes = { busy: 'cover', retreat: { engaged: false } };
      camp.bot.health = 4.7; camp.bot.emit('health');
      await vi.advanceTimersByTimeAsync(100);
      const { json } = await running;
      expect(lineOf(json)).toContain('reflex');
      expect(vi.mocked(go)).not.toHaveBeenCalled();
    });

    it('counts confirmed shield blocks and direct small_fireball health loss in the fight line, from its own start', async () => {
      camp = setUp(20, { blazes: [{ at: new Vec3(-6.5, 70.5, 0.5), health: 400 }] });
      camp.bot._client = new EventEmitter(); installShieldBlock(camp.bot);
      const status = (entityId = 1, entityStatus = 29) => camp.bot._client.emit('entity_status', { entityId, entityStatus });
      status(); status(); // before the fight: the hand must subtract these
      walkTo();
      const running = act(camp, [{ do: 'fight', target: 'blaze', seconds: 30 }]);
      await vi.advanceTimersByTimeAsync(100);
      status(); status(99); status(1, 2);
      camp.bot.inventory.slots[45].durabilityUsed = 6;
      camp.bot.entities[700] = { id: 700, name: 'small_fireball', type: 'projectile', position: new Vec3(0.5, 65, 0.5) };
      camp.bot._client.emit('damage_event', { entityId: 1, sourceDirectId: 701, sourceCauseId: 101 });
      camp.bot.health = 17; camp.bot.emit('health');
      expect(camp.bot.shieldBlock.shieldCaught).toBe(3);
      expect(camp.bot.shieldBlock.shieldMissed).toBe(1);
      camp.bot.emit('entityDead', camp.mobs[0]);
      await vi.advanceTimersByTimeAsync(100);
      const { json } = await running;
      expect(lineOf(json)).toContain('盾 −6（残り330）・盾で受けた 1（種別不明）・受け損ね 1');
    });
  });
});

describe('confirmed shield notices, without inferring a fireball from the shield or its flight', () => {
  it('does not count raises, wear, burns, melee, another body, absorption, mixed batches or stale/unknown sources', () => {
    const bot: any = Object.assign(new EventEmitter(), { _client: new EventEmitter(), health: 20, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {
      7: { id: 7, name: 'small_fireball' }, 8: { id: 8, name: 'blaze' },
    } });
    installShieldBlock(bot);
    const hurt = (direct: number, body = 1) => bot._client.emit('damage_event', { entityId: body, sourceDirectId: direct + 1, sourceCauseId: 9 });
    const health = (hp: number) => { bot.health = hp; bot.emit('health'); };
    bot.shieldBlock.up = true; bot.shieldBlock.raised++; bot.emit('entityHurt', bot.entity); health(19);
    hurt(8); health(18); hurt(7, 2); health(17); hurt(77); health(16);
    hurt(7); health(16); // absorption, no health loss
    hurt(7); hurt(8); health(14); // more than one damage notice: attribution is unknown
    hurt(7); bot.emit('physicsTick'); health(13); // late health fall may be a burn
    expect(bot.shieldBlock.shieldCaught).toBe(0);
    expect(bot.shieldBlock.shieldMissed).toBe(0);
    hurt(7); health(10); // the shield being up does not turn actual fireball damage into a catch
    expect(bot.shieldBlock.shieldMissed).toBe(1);
  });
});

describe('a burning retreat keeps go\'s fire and lava rules', () => {
  afterEach(async () => {
    vi.useRealTimers();
    const actual = await vi.importActual<typeof import('../../src/services/minebot/utils/loadedBlockScan.js')>('../../src/services/minebot/utils/loadedBlockScan.js');
    vi.mocked(scanLoadedBlocks).mockImplementation(actual.scanLoadedBlocks);
  });
  it.each(['onFire', 'fire', 'lava'])('%s: the real go never enters another fire/lava cell', async burning => {
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import('../../src/services/minebot/utils/primitives/go.js')>('../../src/services/minebot/utils/primitives/go.js');
    vi.mocked(go).mockImplementation(actual.go); vi.mocked(go).mockClear();
    vi.mocked(scanLoadedBlocks).mockImplementation((() => ({ hits: [{ name: 'spawner', position: new Vec3(-3, 64, 2), distance: 4 }], columns: 9, reachMetres: 48, sectionsScanned: 1 })) as never);
    const sim: Sim = makeSim((x, y, z) => Math.abs(x) > 20 || Math.abs(z) > 20 ? null
      : y < 64 || (x === 3 && y <= 68 && Math.abs(z) <= 6) ? 'stone'
        : y === 64 && x === 1 && z === -2 ? 'fire' : y === 64 && x === 1 && z === 2 ? 'lava' : 'air', { items: [{ name: 'iron_sword', count: 1 }] });
    sim.bot.entity.id = 1; sim.bot.heldItem = sim.items[0];
    sim.bot.entities[100] = { id: 100, name: 'blaze', type: 'hostile', position: new Vec3(-2.5, 70.5, 0.5), height: 1.8, width: 0.6, isValid: true };
    const unsafe: string[] = [];
    sim.bot.on('physicsTick', () => {
      const p = sim.bot.entity.position, x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (x === 0 && z === 0) return; // the cell already burning under the body is the origin, never a new destination
      for (const dy of [-1, 0, 1]) if (['fire', 'lava'].includes(sim.world.nameAt(x, y + dy, z) ?? '')) unsafe.push(`${x},${y + dy},${z}`);
    });
    const running = fight({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, base: { x: 0, y: 64, z: 0 }, facing: 'north' }, { target: 'blaze', seconds: 30 });
    let done = false;
    running.then(() => { done = true; }, () => { done = true; });
    await vi.advanceTimersByTimeAsync(100);
    if (burning === 'onFire') sim.bot.entity.onFire = true;
    else sim.world.set(0, 64, 0, burning);
    sim.bot.health = 11; sim.bot.emit('health');
    for (let elapsed = 0; !done && elapsed < 60_000; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(done).toBe(true);
    const outcome = await running;
    expect(vi.mocked(go)).toHaveBeenCalled();
    expect(unsafe).toEqual([]);
    if (burning === 'onFire') expect(outcome.text).toContain('退いた先');
    for (const [, args] of vi.mocked(go).mock.calls) expect(args).not.toHaveProperty('canDig');
  });
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

  it('a long charge spends the charge wait only: a fireball that lands after it is still waited for (review 2026-11-05: one shared patience left no wait for the shot)', async () => {
    // The target is within reach and does not die; the other blaze, in sight, charges for 2 s (never long enough to be "about to shoot") and its fireball comes in at 3 s.
    const camp = makeCamp({ shield: true, blazes: [
      { at: new Vec3(1.5, 65.0, 0.5), health: 1000 },
      { at: new Vec3(-6.5, 66, 3.5), charged: ms => ms < 2000 },
    ] });
    const swings: number[] = [];
    const attack = camp.bot.attack;
    camp.bot.attack = (mob: any) => { swings.push(Date.now()); attack(mob); };
    const started = Date.now();
    let shotAt = 0;
    const fly = setTimeout(() => {
      shotAt = Date.now();
      const ball: any = { id: 500, name: 'small_fireball', type: 'projectile', position: new Vec3(0.5, 65.5, -8.5), velocity: new Vec3(0, 0, 0.8), isValid: true };
      camp.bot.entities[ball.id] = ball;
      const move = () => { ball.position = ball.position.plus(ball.velocity); if (ball.position.z > 0.5) { delete camp.bot.entities[ball.id]; camp.bot.off('physicsTick', move); } };
      camp.bot.on('physicsTick', move);
    }, 3000);
    const { json } = await act(camp, [{ do: 'attack', target: 'blaze', hold: true, seconds: 6 }], { accept: ['blaze'] });
    clearTimeout(fly);
    camp.stop();
    console.log('[blaze charge+shot]', lineOf(json), swings.map(at => at - started).join(','), 'shot', shotAt - started);
    // two holds: the charge's, and the shot's after it
    expect(lineOf(json)).toMatch(/見送り 2/u);
    // no blow while the shot is on its last few ticks to the body
    expect(swings.filter(at => at > shotAt + 100 && at < shotAt + 450)).toEqual([]);
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
