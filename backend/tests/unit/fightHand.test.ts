import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { createRequire } from 'node:module';
import { takeActReport, renderActReport } from '../../src/services/minebot/utils/actReport.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { cooldownMs } from '../../src/services/minebot/utils/primitives/attack.js';
import { installShieldBlock } from '../../src/services/minebot/utils/shieldBlock.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';
import { isEngaged } from '../../src/services/minebot/utils/engagement.js';

// The practice field of the fight hand (run 39, 2026-10-26). No server, no API.
//
// REAL here: the body is moved by the client physics (prismarine-physics, the engine mineflayer moves it with: the jump, the fall, the sprint, the
// knockback it is given) at 50 ms ticks in real time; the hand is the production `fight` run inside the production `act` (its watch, its accept/hurt
// rules, its reports), inside a real action with the real motor port (a lease that takes the body aborts it); the shield reflex (`installShieldBlock`)
// and the floor's reflexes (`installFloorReflexes`: the low-health flight, the melee hand ...) are the production ones, reading this world.
// MODELLED (an honest approximation, not the game): the creatures. A mob here is a point with a box that walks at a fixed speed toward (or away
// from) the body over a flat floor, hits once a second within 1.5 m (3 on normal, a raised shield in front stops it), has 20 health, an invulnerable
// half second after a hit and a knock back. The body's blow follows the 1.21 rules that matter to the hand: the eye to the box within 3 m, the
// look on it, the damage by the weapon scaled by the swing's charge (0.2 + 0.8 c^2), a critical hit x1.5 when the swing is full (> 0.9), the body is
// falling, not sprinting and not in water; a blow from behind a raised shield is refused. The pathfinder is a stub that walks to the followed creature
// over the flat floor (the real one needs a server's chunks). Food: eating takes 1.6 s; a golden apple gives 4 health at once (the game gives
// regeneration); other food mends the body only by the natural regeneration, which is on at food 18 (one health in 4 s).

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SWORD: Record<string, number> = { wooden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8, iron_axe: 9 };
const FOOD: Record<string, number> = { bread: 5, cooked_beef: 8, golden_apple: 4 };

interface MobSpec { name?: string; at: Vec3; speed?: number; damage?: number; health?: number; flees?: boolean; idle?: boolean; hitGapMs?: number }
interface Mob {
  id: number; name: string; type: string; position: Vec3; velocity: Vec3; height: number; width: number; health: number; metadata: unknown[]; isValid: boolean;
  onGround: boolean; speed: number; damage: number; flees: boolean; idle: boolean; hitGapMs: number; lastHit: number; hurtAt: number; deadAt?: number; kb: Vec3;
}
const itemOf = (name: string, count = 1, slot = 36) => ({ name, count, type: (mcData.itemsByName as any)[name]?.id ?? 9000, slot });

function makeField(options: { health?: number; food?: number; items?: Array<{ name: string; count?: number }>; held?: string; shield?: boolean; mobs: MobSpec[] }) {
  const placed = new Set<string>();
  const cache = new Map<string, any>();
  const getBlock = (position: Vec3) => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const name = y < 64 ? 'stone' : placed.has(`${x},${y},${z}`) ? 'stone' : 'air';
    const key = `${name}@${x},${y},${z}`;
    if (!cache.has(key)) { const block = new Block(mcData.blocksByName[name].id, 0, 0); block.position = new Vec3(x, y, z); cache.set(key, block); }
    return cache.get(key);
  };
  const world = { getBlock, blockAt: getBlock };
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const slots: any[] = new Array(46).fill(null);
  let next = 9;
  for (const entry of options.items ?? []) slots[next] = itemOf(entry.name, entry.count ?? 1, next++);
  if (options.held) slots[36] = itemOf(options.held, 1, 36);
  if (options.shield) slots[45] = itemOf('shield', 1, 45);
  const stats = { swings: 0, hitsOnMob: 0, crits: 0, missed: 0, refusedByShield: 0, hitsOnBot: 0, blockedByShield: 0, healthLost: 0, aimedAt: new Set<number>(), eaten: [] as string[],
    keyWrites: [] as Array<{ t: number; control: string; on: boolean }>, shieldRaises: 0 };
  const start = Date.now();
  const bot: any = Object.assign(new EventEmitter(), {
    version: VERSION, registry: mcData, game: { dimension: 'overworld' }, health: options.health ?? 20, food: options.food ?? 20, foodSaturation: 5, oxygenLevel: 20,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, physics, controlState: control, entities: {} as Record<string, any>,
    entity: { id: 1, name: 'player', type: 'player', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) }, quickBarSlot: 0, usingHeldItem: false,
    executingSkill: false, interruptExecution: false, stopDigging: () => undefined,
    blockAt: world.blockAt, getControlState: (name: string) => control[name],
    setControlState: (name: string, value: boolean) => { if (control[name] !== value) stats.keyWrites.push({ t: Date.now() - start, control: name, on: value }); control[name] = value; },
    clearControlStates: () => { for (const key of Object.keys(control)) control[key] = false; },
    getEquipmentDestSlot: (destination: string) => ({ 'off-hand': 45, hand: 36, head: 5, torso: 6, legs: 7, feet: 8 } as Record<string, number>)[destination],
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    lookAt: async (point: Vec3) => {
      const eye = bot.entity.position.offset(0, 1.62, 0), d = point.minus(eye);
      bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    },
    equip: async (item: any, destination: string) => {
      // a move, not a copy: what was in the hand goes to the slot the item came from
      const from = item.slot, old = destination === 'off-hand' ? slots[45] : slots[36], to = destination === 'off-hand' ? 45 : 36;
      if (from !== to) { slots[from] = old; if (old) old.slot = from; }
      slots[to] = item; item.slot = to;
      bot.heldItem = slots[36] ?? null; bot.emit('heldItemChanged', bot.heldItem);
    },
    setQuickBarSlot: () => undefined,
    activateItem: (offhand?: boolean) => { bot.usingHeldItem = true; if (offhand && slots[45]?.name === 'shield') stats.shieldRaises++; },
    deactivateItem: () => { bot.usingHeldItem = false; },
    consume: async () => {
      const item = bot.heldItem; if (!item || !FOOD[item.name]) throw new Error('nothing to eat');
      bot.usingHeldItem = true;
      await sleep(1600);
      bot.usingHeldItem = false;
      item.count--; if (item.count <= 0) { slots[item.slot] = null; if (slots[36] === item) bot.heldItem = null; }
      stats.eaten.push(item.name);
      bot.food = Math.min(20, bot.food + (item.name === 'golden_apple' ? 4 : FOOD[item.name]));
      if (item.name === 'golden_apple') { bot.health = Math.min(20, bot.health + 4); bot.emit('health'); }
    },
    attack: (mob: Mob) => {
      stats.swings++; stats.aimedAt.add(mob.id);
      const shieldUp = bot.usingHeldItem && slots[45]?.name === 'shield';
      if (shieldUp) { stats.refusedByShield++; return; }
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const half = mob.width / 2, p = mob.position;
      const dx = Math.max(Math.abs(eye.x - p.x) - half, 0), dz = Math.max(Math.abs(eye.z - p.z) - half, 0), dy = Math.max(p.y - eye.y, eye.y - (p.y + mob.height), 0);
      const box = Math.hypot(dx, dy, dz);
      const toMob = p.offset(0, mob.height * 0.6, 0).minus(eye);
      const look = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch));
      const angle = Math.acos(Math.max(-1, Math.min(1, look.dot(toMob) / (toMob.norm() || 1))));
      if (box > 3.0 || angle > 0.5 || mob.health <= 0) { stats.missed++; return; }
      const now = Date.now(), held = bot.heldItem?.name;
      const charge = Math.min(1, (now - (bot.lastAttackAt ?? 0)) / cooldownMs(held)); bot.lastAttackAt = now;
      let damage = (SWORD[held] ?? 1) * (0.2 + 0.8 * charge * charge);
      const e = bot.entity;
      if (charge > 0.9 && !e.onGround && e.velocity.y < 0 && !control.sprint && !e.isInWater) { damage *= 1.5; stats.crits++; }
      if (now - mob.hurtAt < 500) return;                                   // invulnerable half second
      mob.hurtAt = now; mob.health -= damage; stats.hitsOnMob++;
      const away = new Vec3(p.x - e.position.x, 0, p.z - e.position.z); const len = away.norm() || 1;
      mob.kb = new Vec3(away.x / len * 0.35, 0, away.z / len * 0.35);
      setTimeout(() => { bot.emit('entityHurt', mob); if (mob.health <= 0) { mob.deadAt = Date.now(); bot.emit('entityDead', mob); } }, 30);
    },
    pathfinder: {
      movements: undefined as any, goal: null as any,
      setMovements(movements: any) { this.movements = movements; },
      setGoal(goal: any) { this.goal = goal; if (!goal) { control.forward = false; control.sprint = false; control.jump = false; } },
      stop() { this.setGoal(null); },
    },
  });
  bot.heldItem = slots[36] ?? null;
  const mobs: Mob[] = options.mobs.map((spec, index) => {
    const name = spec.name ?? 'zombie';
    const mob: Mob = { id: 100 + index, name, type: 'hostile', position: spec.at.clone(), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, health: spec.health ?? 20,
      metadata: [], isValid: true, onGround: true, speed: spec.speed ?? 0.2, damage: spec.damage ?? 3, flees: !!spec.flees, idle: !!spec.idle, hitGapMs: spec.hitGapMs ?? 1000,
      lastHit: 0, hurtAt: 0, kb: new Vec3(0, 0, 0) };
    bot.entities[mob.id] = mob;
    return mob;
  });
  let ticks = 0;
  const tick = () => {
    ticks++;
    const e = bot.entity;
    // the stub pathfinder walks to the followed creature (flat floor, nothing in the way)
    const goal = bot.pathfinder.goal;
    if (goal?.entity) {
      const to = goal.entity.position.minus(e.position);
      if (Math.hypot(to.x, to.z) > Math.sqrt(goal.rangeSq ?? 4)) { e.yaw = Math.atan2(-to.x, -to.z); control.forward = true; control.sprint = Math.hypot(to.x, to.z) > 5; }
      else { control.forward = false; control.sprint = false; }
    }
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    const feet = e.position;
    for (const mob of mobs) {
      if (!mob.isValid) continue;
      if (mob.health <= 0) { if (Date.now() - (mob.deadAt ?? Date.now()) > 600) { mob.isValid = false; delete bot.entities[mob.id]; bot.emit('entityGone', mob); } continue; }
      const to = new Vec3(feet.x - mob.position.x, 0, feet.z - mob.position.z), distance = Math.hypot(to.x, to.z);
      if (!mob.idle) {
        const direction = mob.flees ? -1 : 1;
        if (mob.flees || distance > 0.9) { mob.position.x += direction * to.x / (distance || 1) * mob.speed; mob.position.z += direction * to.z / (distance || 1) * mob.speed; }
      }
      mob.position.x += mob.kb.x; mob.position.z += mob.kb.z; mob.kb = mob.kb.scaled(0.6);
      const now = Date.now();
      if (!mob.idle && !mob.flees && distance < 1.5 && Math.abs(feet.y - mob.position.y) < 1.2 && now - mob.lastHit >= mob.hitGapMs && bot.health > 0) {
        mob.lastHit = now;
        const toMob = mob.position.minus(feet), look = new Vec3(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
        const front = look.dot(toMob) / (Math.hypot(toMob.x, toMob.z) || 1) > 0.1;
        if (bot.usingHeldItem && slots[45]?.name === 'shield' && front) { stats.blockedByShield++; }
        else {
          stats.hitsOnBot++; stats.healthLost += mob.damage; bot.health = Math.max(0, bot.health - mob.damage);
          e.velocity.x += to.x / (distance || 1) * 0.4; e.velocity.z += to.z / (distance || 1) * 0.4; e.velocity.y = Math.max(e.velocity.y, 0.3);
          bot.emit('entityHurt', e); bot.emit('health');
        }
      }
    }
    if (ticks % 80 === 0 && bot.food >= 18 && bot.health > 0 && bot.health < 20) { bot.health = Math.min(20, bot.health + 1); bot.emit('health'); }
    bot.emit('physicsTick');
  };
  const timer = setInterval(tick, 50);
  return { bot, control, mobs, stats, world, stop: () => clearInterval(timer), distance: (mob: Mob) => Math.hypot(mob.position.x - bot.entity.position.x, mob.position.z - bot.entity.position.z) };
}
type Field = ReturnType<typeof makeField>;

const hands = (value: unknown) => ACT_HANDS.parse(value);
/** Runs an act as the body does: inside a real action, on the motor port, so that a lease that takes the body aborts it. */
async function act(field: Field, handList: unknown, options: { stopIf?: any; accept?: string[] } = {}) {
  const since = Date.now();
  const result = await executeAction(field.bot, 'act', 120_000, async () => runAct(createMotorPort(field.bot), hands(handList), options.stopIf, undefined, { accept: options.accept }), { waitForQuiescence: true });
  // A lease that took the body ends the action with a bare 'interrupted': the act's report is told then, as the body's nativeBody does.
  let text = result.result as string;
  if (!text.startsWith('{')) {
    const report = takeActReport(field.bot, since);
    if (report) text = renderActReport(field.bot, report, field.bot.reflexLedger?.noteSince(0));
  }
  return { result, json: JSON.parse(text) };
}
const lineOf = (json: any, index = 0) => String(json.lines[index].line);

describe('fight on the practice field: one zombie', () => {
  it('kills it with a full-charge sword: critical blows on the way down, the shield reflex up between the blows and down for each, and says the counts', async () => {
    const field = makeField({ held: 'iron_sword', shield: true, items: [{ name: 'bread', count: 2 }],
      mobs: [{ at: new Vec3(8.5, 64, 0.5) }, { at: new Vec3(-9.5, 64, 0.5), idle: true }] });
    installShieldBlock(field.bot);
    const target = field.mobs[0], bystander = field.mobs[1];
    const { json } = await act(field, [{ do: 'fight', target: '#100', seconds: 40 }]);
    field.stop();
    console.log('[fight 1]', lineOf(json), JSON.stringify({ ...field.stats, aimedAt: [...field.stats.aimedAt], keyWrites: field.stats.keyWrites.length }));
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/^fight 済 zombie #100 死んだ・与えた打撃 \d+（振り \d+）・受けた体力 [\d.]+・食べた 0・体: fight（反射なし）/u);
    expect(target.health).toBeLessThanOrEqual(0);
    // only the creature named was struck; the other one (idle, 9 m off) was not turned to
    expect([...field.stats.aimedAt]).toEqual([100]);
    expect(bystander.health).toBe(20);
    // the swings: full charge (the wait of the sword), criticals on the way down
    expect(field.stats.crits).toBeGreaterThanOrEqual(1);
    expect(field.stats.hitsOnMob).toBeLessThanOrEqual(5);
    // the shield reflex raised the shield against the zombie in reach and the body's blow went out from behind a lowered one
    expect(field.stats.shieldRaises).toBeGreaterThanOrEqual(1);
    expect(field.stats.refusedByShield).toBe(0);
    // the engagement ended with the hand
    expect(isEngaged(field.bot)).toBe(false);
    // the counts told are the ones that happened
    const told = /与えた打撃 (\d+)（振り (\d+)）・受けた体力 ([\d.]+)/u.exec(lineOf(json))!;
    expect(Number(told[1])).toBe(field.stats.hitsOnMob);
    expect(Number(told[2])).toBe(field.stats.swings);
    expect(Number(told[3])).toBeCloseTo(field.stats.healthLost, 1);
    expect(field.control.sprint).toBe(false);
    expect(field.control.forward).toBe(false);
  }, 60_000);

  it('a sword that is only in the pack is taken in hand; a kind name takes the nearest of the kind once', async () => {
    const field = makeField({ held: 'bread', items: [{ name: 'iron_sword' }], mobs: [{ at: new Vec3(6.5, 64, 0.5) }, { at: new Vec3(-12.5, 64, 0.5), idle: true }] });
    const { json } = await act(field, [{ do: 'fight', target: 'zombie', seconds: 40 }]);
    field.stop();
    console.log('[fight 1b]', lineOf(json));
    expect(json.ok).toBe(true);
    expect(field.bot.heldItem?.name).toBe('iron_sword');
    expect(field.mobs[0].health).toBeLessThanOrEqual(0);
    expect(field.mobs[1].health).toBe(20);
  }, 60_000);

  it('the hurt the fight costs is not held against it by the act (no 被弾 stop), and does not stop the next hand', async () => {
    const field = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(3.5, 64, 0.5), damage: 6, hitGapMs: 700 }] });
    const { json } = await act(field, [{ do: 'fight', target: '#100', seconds: 40 }, { do: 'wait', seconds: 1 }]);
    field.stop();
    console.log('[fight 1c]', lineOf(json), json.stoppedBy, json.done, '/', json.of, 'hp', field.bot.health);
    expect(field.stats.healthLost).toBeGreaterThanOrEqual(6);
    expect(json.stoppedBy).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.done).toBe(2);
  }, 60_000);
});

describe('fight on the practice field: retreatHp', () => {
  it('under retreatHp with bread (hunger 10): out of reach, eats with a gap, still low, and leaves with `retreat` (the counts and the meals told)', async () => {
    const field = makeField({ held: 'iron_sword', health: 17, food: 10, items: [{ name: 'bread', count: 3 }], mobs: [{ at: new Vec3(4.5, 64, 0.5), damage: 2, health: 40 }] });
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', retreatHp: 15, seconds: 40 }]);
    field.stop();
    console.log('[fight 2a]', result.failureType, lineOf(json), 'eaten', field.stats.eaten, 'hp', field.bot.health, 'gap', field.distance(field.mobs[0]).toFixed(1));
    expect(json.ok).toBe(false);
    expect(result.failureType).toBe('retreat');
    expect(lineOf(json)).toMatch(/fight 止まった retreat: zombie #100/u);
    expect(lineOf(json)).toMatch(/retreatHp 15/u);
    expect(field.stats.eaten.length).toBeGreaterThanOrEqual(1);
    expect(lineOf(json)).toMatch(new RegExp(`食べた ${field.stats.eaten.length}`, 'u'));
    expect(field.bot.health).toBeGreaterThan(0);
  }, 60_000);

  it('under retreatHp with a golden apple: gets out of reach, eats it, is back above the mark and goes back in to kill the zombie', async () => {
    const field = makeField({ held: 'iron_sword', health: 18, food: 20, items: [{ name: 'golden_apple', count: 1 }], mobs: [{ at: new Vec3(4.5, 64, 0.5), damage: 3, health: 30 }] });
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', retreatHp: 14, seconds: 60 }]);
    field.stop();
    console.log('[fight 2b]', result.failureType, lineOf(json), 'eaten', field.stats.eaten, 'hp', field.bot.health, 'held', field.bot.heldItem?.name);
    expect(field.stats.eaten).toEqual(['golden_apple']);
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/死んだ・.*食べた 1/u);
    expect(field.bot.heldItem?.name).toBe('iron_sword');
    expect(field.mobs[0].health).toBeLessThanOrEqual(0);
  }, 90_000);

  it('under retreatHp with nothing to eat: runs, and says `retreat` and that there was nothing', async () => {
    const field = makeField({ held: 'iron_sword', health: 12, mobs: [{ at: new Vec3(2.5, 64, 0.5), damage: 2, health: 40 }] });
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', retreatHp: 14, seconds: 30 }]);
    field.stop();
    console.log('[fight 2c]', result.failureType, lineOf(json));
    expect(result.failureType).toBe('retreat');
    expect(lineOf(json)).toMatch(/食べる物が無い|食べても治りが早まらない/u);
    expect(field.stats.swings).toBe(0);
  }, 60_000);
});

describe('fight on the practice field: stance flee', () => {
  it('runs from a zombie until range metres away, strikes nothing, and says how far', async () => {
    const field = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(3.5, 64, 0.5) }] });
    const { json } = await act(field, [{ do: 'fight', target: '#100', stance: 'flee', range: 12, seconds: 30 }]);
    field.stop();
    console.log('[fight 3]', lineOf(json), 'gap', field.distance(field.mobs[0]).toFixed(1), 'hits taken', field.stats.hitsOnBot);
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/^fight 済 zombie #100 離れた・与えた打撃 0（振り 0）・受けた体力 [\d.]+・食べた 0（1[2-9](\.\d)?m ≥ 12m）・体: fight（反射なし）/u);
    expect(field.stats.swings).toBe(0);
    expect(field.distance(field.mobs[0])).toBeGreaterThanOrEqual(12);
    expect(isEngaged(field.bot)).toBe(false);
    expect(field.control.forward).toBe(false);
  }, 60_000);

  it('a creature that keeps up is `limit_time`, with the gap it left', async () => {
    const field = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(3.5, 64, 0.5), speed: 0.3, damage: 0 }] });
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', stance: 'flee', range: 12, seconds: 6 }]);
    field.stop();
    console.log('[fight 3b]', result.failureType, lineOf(json));
    expect(result.failureType).toBe('limit_time');
    expect(lineOf(json)).toMatch(/fight 止まった limit_time: zombie #100/u);
  }, 60_000);
});

describe('fight is the planners fight for the floor (combatOwner)', () => {
  const scene = () => makeField({ held: 'iron_sword', health: 7, mobs: [{ at: new Vec3(2.5, 64, 0.5), damage: 0.5, health: 12 }] });
  it('above the floors own limit (health 6 to 8) the floor does not run for it: the hand marks itself, kills the zombie and lets the mark go', async () => {
    const field = scene();
    ensureReflexLedger(field.bot);
    installFloorReflexes(field.bot, floorConfig({}));
    const { json } = await act(field, [{ do: 'fight', target: '#100', seconds: 30 }]);
    field.stop();
    const marks = (field.bot as any).headCombat as Array<{ skill: string; endedAt?: number }>;
    console.log('[fight owner]', json.stoppedBy, lineOf(json), JSON.stringify(marks));
    expect(marks.map(mark => mark.skill)).toEqual(['fight']);
    expect(marks[0]!.endedAt).toBeDefined();
    expect(json.stoppedBy).not.toBe('reflex');
  }, 60_000);
  it('with the switch off the floor runs as before and takes the body (the contrast)', async () => {
    process.env.MINEBOT_HEAD_COMBAT_OWNER = 'off';
    try {
      const field = scene();
      ensureReflexLedger(field.bot);
      installFloorReflexes(field.bot, floorConfig({}));
      const { json } = await act(field, [{ do: 'fight', target: '#100', seconds: 30 }]);
      field.stop();
      expect((field.bot as any).headCombat).toBeUndefined();
      expect(json.stoppedBy).toBe('reflex');
    } finally { delete process.env.MINEBOT_HEAD_COMBAT_OWNER; }
  }, 60_000);
});

describe('fight on the practice field: who holds the body', () => {
  it('a floor reflex takes the body in the fight (health 8 or less, a zombie in reach): the hand ends as `reflex` with its counts, names the reflex, and is not started again', async () => {
    const field = makeField({ held: 'iron_sword', health: 10, mobs: [{ at: new Vec3(2.5, 64, 0.5), damage: 3, health: 60 }] });
    ensureReflexLedger(field.bot);
    installFloorReflexes(field.bot, floorConfig({}));
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', seconds: 30 }, { do: 'wait', seconds: 1 }]);
    const after = { swings: field.stats.swings, health: field.mobs[0].health };
    const writesAtEnd = field.stats.keyWrites.length;
    // the flee goes on for a while after the act's receipt; the fight must not touch the keys or the zombie meanwhile
    await sleep(1500);
    const gapAfter = field.distance(field.mobs[0]);
    field.stop();
    console.log('[fight 4]', result.failureType, json.stoppedBy, '|', lineOf(json), '|', json.stoppedWhy, 'swings', field.stats.swings, 'hp', field.bot.health, 'gap', gapAfter.toFixed(1));
    expect(json.ok).toBe(false);
    expect(json.stoppedBy).toBe('reflex');
    expect(lineOf(json)).toMatch(/fight 止まった reflex: zombie #100.*与えた打撃 \d+（振り \d+）.*体: 反射 /u);
    expect(json.lines[1].status).toBe('skipped');
    expect(field.stats.swings).toBe(after.swings);
    expect(field.mobs[0].health).toBe(after.health);
    expect(field.stats.keyWrites.length).toBeGreaterThanOrEqual(writesAtEnd);
    expect(isEngaged(field.bot)).toBe(false);
    expect(field.bot.floorReflexes.fleeEpisode !== undefined || field.stats.keyWrites.some(write => write.control === 'sprint' && write.on)).toBe(true);
  }, 60_000);

  it('does not begin while a reflex holds the body: says `reflex` at once, writes no key, strikes nothing', async () => {
    const field = makeField({ held: 'iron_sword', health: 20, mobs: [{ at: new Vec3(3.5, 64, 0.5) }] });
    ensureReflexLedger(field.bot);
    installFloorReflexes(field.bot, floorConfig({}));
    field.bot.floorReflexes.fleeEpisode = { startedAt: Date.now(), origin: field.bot.entity.position.clone(), segments: 1, stalls: 0, outcome: 'done' };
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', seconds: 10 }]);
    field.stop();
    console.log('[fight 4b]', result.failureType, lineOf(json));
    expect(result.failureType).toBe('reflex');
    expect(lineOf(json)).toMatch(/fight 止まった reflex: .*反射 floor-flee が体を握っている。終わるまで始めない/u);
    expect(field.stats.swings).toBe(0);
    expect(field.stats.keyWrites).toHaveLength(0);
  }, 20_000);
});

describe('fight: the hand\'s fields and its other stops', () => {
  it('refuses a field the hand does not take, and ranges out of the head\'s rules', async () => {
    const field = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(3.5, 64, 0.5), idle: true }] });
    // `axis` is another hand's field (the schema of act would take it once the portal hand is in; here it is not a field at all), `count` is not fight's
    const refused = async (hand: any) => (await act(field, [hand])).json.lines[0].line as string;
    expect(await refused({ do: 'fight', target: '#100', count: 2 })).toContain('count は fight では使えない');
    expect(await refused({ do: 'fight', target: '#100', seconds: 3 })).toContain('fight の seconds は 5〜60');
    expect(await refused({ do: 'fight', target: '#100', seconds: 90 })).toContain('fight の seconds は 5〜60');
    expect(await refused({ do: 'fight', target: '#100', range: 20 })).toContain('fight の range は 0〜16');
    expect(await refused({ do: 'fight', target: '#100', retreatHp: 25 })).toContain('fight の retreatHp は 1〜19');
    expect(await refused({ do: 'fight', target: '#100', retreatHp: 7.5 })).toContain('fight の retreatHp は 1〜19');
    expect(() => hands([{ do: 'fight', target: '#100', stance: 'dance' }])).toThrow();
    expect(() => hands([{ do: 'fight', target: '#100', stance: 'flee', retreatHp: 10, range: 4, seconds: 5, item: 'iron_sword' }])).not.toThrow();
    expect(field.stats.swings).toBe(0);
    field.stop();
  }, 30_000);

  it('no weapon, a creature it cannot see, a player: the code and no key written', async () => {
    const none = makeField({ mobs: [{ at: new Vec3(3.5, 64, 0.5), idle: true }] });
    expect((await act(none, [{ do: 'fight', target: '#100' }])).result.failureType).toBe('no_weapon');
    expect((await act(none, [{ do: 'fight', target: '#100', item: 'diamond_sword' }])).json.lines[0].line).toContain('diamond_sword を持っていない');
    expect((await act(none, [{ do: 'fight', target: '#999' }])).result.failureType).toBe('lost');
    expect((await act(none, [{ do: 'fight', target: 'skeleton' }])).result.failureType).toBe('lost');
    none.bot.entities[500] = { id: 500, type: 'player', username: 'Alex', name: undefined, position: new Vec3(2.5, 64, 0.5), height: 1.8, width: 0.6, isValid: true };
    const player = await act(none, [{ do: 'fight', target: '#500', item: 'stick' }]);
    expect(player.result.failureType).toBe('invalid_input');
    none.stop();
    expect(none.stats.keyWrites).toHaveLength(0);
  }, 30_000);

  it('a creature that runs off beyond range after the fight began is `逃げた` (ok, not chased); one never within range is `unreachable`', async () => {
    const runner = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(2.5, 64, 0.5), flees: true, speed: 0.4 }] });
    const ran = await act(runner, [{ do: 'fight', target: '#100', range: 6, seconds: 20 }]);
    runner.stop();
    console.log('[fight 5a]', lineOf(ran.json));
    expect(ran.json.ok).toBe(true);
    expect(lineOf(ran.json)).toMatch(/^fight 済 zombie #100 逃げた/u);
    const far = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(30.5, 64, 0.5), speed: 0.3, flees: true }] });
    const never = await act(far, [{ do: 'fight', target: '#100', range: 4, seconds: 20 }]);
    far.stop();
    console.log('[fight 5b]', never.result.failureType, lineOf(never.json));
    expect(never.result.failureType).toBe('unreachable');
  }, 60_000);

  it('the time limit is `limit_time` (a zombie that cannot be hurt in the time given), with the counts', async () => {
    const field = makeField({ held: 'wooden_sword', mobs: [{ at: new Vec3(3.5, 64, 0.5), damage: 0, health: 400 }] });
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', seconds: 5 }]);
    field.stop();
    console.log('[fight 5c]', result.failureType, lineOf(json));
    expect(result.failureType).toBe('limit_time');
    expect(lineOf(json)).toMatch(/fight 止まった limit_time: zombie #100 は 5 秒で倒れなかった。与えた打撃 [1-9]/u);
  }, 30_000);
});

describe('fight: the critical hit timing (a long fight with a creature that does no harm, to count the blows)', () => {
  it('after the first blow (struck at once), most blows are criticals on the way down, one per sword wait or a little more; a sprint is never held in a blow', async () => {
    const field = makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(2.5, 64, 0.5), damage: 0, health: 1000 }] });
    const sprintOnAtBlow: boolean[] = [];
    const strike = field.bot.attack;
    field.bot.attack = (mob: Mob) => { sprintOnAtBlow.push(field.control.sprint); strike(mob); };
    const { json, result } = await act(field, [{ do: 'fight', target: '#100', seconds: 12 }]);
    field.stop();
    const after = field.stats.swings - 1;
    console.log('[fight crit]', result.failureType, lineOf(json), JSON.stringify({ swings: field.stats.swings, hits: field.stats.hitsOnMob, crits: field.stats.crits, missed: field.stats.missed }));
    expect(result.failureType).toBe('limit_time');
    expect(field.stats.swings).toBeGreaterThanOrEqual(10);
    expect(field.stats.swings).toBeLessThanOrEqual(21);
    expect(field.stats.crits).toBeGreaterThanOrEqual(Math.floor(after * 0.7));
    expect(field.stats.missed).toBe(0);
    expect(sprintOnAtBlow.every(on => on === false)).toBe(true);
  }, 30_000);
});

describe('fight against the old attack hand, on the same zombie', () => {
  it('attack (no accept) is stopped by the act\'s hurt rule after a 4-health loss; fight, which the act counts as accepting its target, is not', async () => {
    const same = () => makeField({ held: 'iron_sword', mobs: [{ at: new Vec3(3.5, 64, 0.5), damage: 6, hitGapMs: 700, health: 20 }] });
    const old = same();
    const attackResult = await act(old, [{ do: 'attack', target: '#100', untilDead: true, seconds: 30 }]);
    old.stop();
    const fresh = same();
    const fightResult = await act(fresh, [{ do: 'fight', target: '#100', seconds: 30 }]);
    fresh.stop();
    console.log('[attack vs fight]', attackResult.json.stoppedBy, lineOf(attackResult.json), '|', fightResult.json.stoppedBy, lineOf(fightResult.json));
    expect(attackResult.json.stoppedBy).toBe('damage');
    expect(fightResult.json.ok).toBe(true);
  }, 60_000);
});
