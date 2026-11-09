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
import { installGazeGuard } from '../../src/services/minebot/utils/gazeGuard.js';
import { ENDERMAN_EYE, ENDERMAN_LEGS, ENDERMAN_STARE_MS, atRoofCentre, endermanView, looksAtEyes, roofInteriorStep } from '../../src/services/minebot/utils/huntEnderman.js';
import { EndermanCamp, endermanCampObservation } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';

// The enderman hunt on a practice field (S2, 2026-11-02): the body lays a 3x3 roof over itself, stares the enderman in the eye from under it (the gaze guard is let go
// for the stare and put back), and strikes it from the hole while it stands at the roof's edge and cannot reach. The body is moved by the client physics; the world
// takes the blocks the body lays; the enderman is modelled with the rules that matter to the hand: angered by a stare of five ticks on its eyes with the line clear,
// 2.9 tall and 0.6 wide so that it stands only where three cells are free, reaches 1.43 across, teleports when it is looked in the eye within four blocks.

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');
const KEYS = mcData.entitiesByName.enderman.metadataKeys!;
const CREEPY = KEYS.indexOf('creepy'), STARED = KEYS.indexOf('stared_at');
const itemOf = (name: string, count = 1, slot = 36) => ({ name, count, type: (mcData.itemsByName as any)[name]?.id ?? 9000, slot });
const FLOOR = 64;

interface Options { at: Vec3; angry?: boolean; walls?: Array<[number, number, number]>; wallName?: string; blocks?: number; guard?: boolean; shield?: boolean; health?: number; pumpkin?: boolean }
function makeField(options: Options) {
  const placed = new Map<string, string>();
  const fixed = new Set((options.walls ?? []).map(([x, y, z]) => `${x},${y},${z}`));
  const cache = new Map<string, any>();
  const nameAt = (x: number, y: number, z: number) => y < FLOOR ? 'stone' : fixed.has(`${x},${y},${z}`) ? options.wallName ?? 'stone' : placed.get(`${x},${y},${z}`) ?? 'air';
  const getBlock = (position: Vec3) => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const name = nameAt(x, y, z);
    const key = `${name}@${x},${y},${z}`;
    if (!cache.has(key)) { const block = new Block(mcData.blocksByName[name].id, 0, 0); block.position = new Vec3(x, y, z); cache.set(key, block); }
    return cache.get(key);
  };
  const solid = (x: number, y: number, z: number) => nameAt(x, y, z) !== 'air';
  const world = { getBlock, blockAt: getBlock };
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const slots: any[] = new Array(46).fill(null);
  slots[36] = itemOf('iron_sword', 1, 36);
  slots[9] = itemOf('cobblestone', options.blocks ?? 64, 9);
  slots[10] = itemOf('stone_pickaxe', 1, 10);
  if (options.shield !== false) slots[45] = itemOf('shield', 1, 45);
  if (options.pumpkin) slots[5] = itemOf('carved_pumpkin', 1, 5);
  const stats = { swings: 0, hits: 0, hitsOnBot: 0, blocked: 0, teleports: 0, laid: [] as string[], guardOffWhileStaring: 0, stareTicks: 0, angryAtMs: 0, reachedBodyAtMs: 0, minGap: 99, keys: [] as string[] };
  const start = Date.now();
  const bot: any = Object.assign(new EventEmitter(), {
    version: VERSION, registry: mcData, game: { dimension: 'overworld' }, health: options.health ?? 20, food: 20, foodSaturation: 5, oxygenLevel: 20,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, physics, controlState: control, entities: {} as Record<string, any>,
    entity: { id: 1, name: 'player', type: 'player', position: new Vec3(0.5, FLOOR, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) }, quickBarSlot: 0, usingHeldItem: false,
    executingSkill: false, interruptExecution: false, stopDigging: () => undefined,
    blockAt: world.blockAt, getControlState: (name: string) => control[name],
    // The new temporary-column removal uses the same server-confirmed dig as a real hand; local air alone is insufficient.
    _client: new EventEmitter(), digTime: () => 100,
    dig: async (block: any) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      if (!placed.has(key)) throw new Error('only a block placed by the fixture may be removed');
      placed.delete(key);
      bot._client.emit('block_change', { location: block.position, type: mcData.blocksByName.air.minStateId });
    },
    setControlState: (name: string, value: boolean) => { if (control[name] !== value) stats.keys.push(`${Date.now() - start}ms ${name}=${value} @${bot.entity.position.x.toFixed(1)}`); control[name] = value; },
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
    // Lays the held block against the reference's face: the world takes it (not into the body's own cells), the stack is one less.
    placeBlock: async (reference: any, face: Vec3) => {
      const at = reference.position.plus(face), held = bot.heldItem;
      if (!held || !/cobblestone|dirt|netherrack/u.test(held.name)) throw new Error('nothing to place');
      const feet = bot.entity.position;
      if (Math.floor(feet.x) === at.x && Math.floor(feet.z) === at.z && (at.y === Math.floor(feet.y) || at.y === Math.floor(feet.y) + 1)) throw new Error('in the body');
      await new Promise(resolve => setTimeout(resolve, 50));
      placed.set(`${at.x},${at.y},${at.z}`, held.name);
      held.count--; stats.laid.push(`${at.x},${at.y},${at.z}`);
      if (held.count <= 0) { slots[held.slot] = null; bot.heldItem = null; }
    },
    attack: (mob: any) => {
      stats.swings++;
      if (bot.usingHeldItem && slots[45]?.name === 'shield') return;
      const eye = bot.entity.position.offset(0, 1.62, 0), half = mob.width / 2, p = mob.position;
      const dx = Math.max(Math.abs(eye.x - p.x) - half, 0), dz = Math.max(Math.abs(eye.z - p.z) - half, 0), dy = Math.max(p.y - eye.y, eye.y - (p.y + mob.height), 0);
      if (Math.hypot(dx, dy, dz) > 3.0 || mob.health <= 0) return;
      const now = Date.now(), held = bot.heldItem?.name, charge = Math.min(1, (now - (bot.lastAttackAt ?? 0)) / cooldownMs(held)); bot.lastAttackAt = now;
      if (now - mob.hurtAt < 500) return;
      mob.hurtAt = now; mob.health -= (held === 'iron_sword' ? 6 : 1) * (0.2 + 0.8 * charge * charge); stats.hits++;
      setTimeout(() => {
        bot.emit('entityHurt', mob);
        if (mob.health <= 0) {
          mob.deadAt = Date.now(); bot.emit('entityDead', mob);
          const pearl: any = { id: 900, name: 'item', position: mob.position.clone().offset(0.2, 0, 0.1), isValid: true, getDroppedItem: () => ({ name: 'ender_pearl', count: 1 }) };
          bot.entities[pearl.id] = pearl; bot.emit('entitySpawn', pearl);
        }
      }, 30);
    },
    pathfinder: { movements: undefined as any, goal: null as any, setMovements(m: any) { this.movements = m; }, setGoal(g: any) { this.goal = g; if (!g) { control.forward = false; control.sprint = false; control.jump = false; } }, stop() { this.setGoal(null); } },
  });
  bot.heldItem = slots[36];
  const metadata: unknown[] = new Array(KEYS.length).fill(0);
  metadata[CREEPY] = !!options.angry; metadata[STARED] = !!options.angry;
  const mob: any = { id: 200, name: 'enderman', type: 'hostile', position: options.at.clone(), velocity: new Vec3(0, 0, 0), height: 2.9, width: 0.6, health: 40, metadata, isValid: true, hurtAt: 0, lastHit: 0 };
  bot.entities[mob.id] = mob;
  if (options.guard !== false) installGazeGuard(bot);
  const rayClear = (from: Vec3, to: Vec3) => {
    const steps = Math.ceil(from.distanceTo(to) / 0.1);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (solid(Math.floor(from.x + (to.x - from.x) * t), Math.floor(from.y + (to.y - from.y) * t), Math.floor(from.z + (to.z - from.z) * t))) return false;
    }
    return true;
  };
  /** The enderman's box at (x, y, z) fits: every cell it touches is free. */
  const fits = (x: number, y: number, z: number) => {
    for (let cx = Math.floor(x - 0.3); cx <= Math.floor(x + 0.3); cx++) for (let cz = Math.floor(z - 0.3); cz <= Math.floor(z + 0.3); cz++)
      for (let cy = Math.floor(y); cy <= Math.floor(y + 2.9 - 1e-6); cy++) if (solid(cx, cy, cz)) return false;
    return true;
  };
  let stare = 0, lastTeleportCheck = 0;
  const tick = () => {
    const e = bot.entity;
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    const ms = Date.now() - start;
    if (mob.health > 0) {
      const eyeFrom = e.position.offset(0, 1.62, 0), mobEyes = mob.position.offset(0, ENDERMAN_EYE, 0);
      const gaze = looksAtEyes(eyeFrom, e.yaw, e.pitch, mob.position) && rayClear(eyeFrom, mobEyes) && !options.pumpkin;
      if (!mob.metadata[CREEPY]) {
        stare = gaze ? stare + 1 : 0;
        if (gaze) stats.stareTicks++;
        if (stare >= 5) { mob.metadata[CREEPY] = true; mob.metadata[STARED] = true; stats.angryAtMs = ms; }
      } else {
        const gap = Math.hypot(mob.position.x - e.position.x, mob.position.z - e.position.z);
        stats.minGap = Math.min(stats.minGap, gap);
        // Looked in the eye within four blocks: it teleports away.
        if (gaze && gap < 4 && ms - lastTeleportCheck > 500) { lastTeleportCheck = ms; stats.teleports++; mob.position = new Vec3(e.position.x + 9, FLOOR, e.position.z - 6); }
        else {
          const to = new Vec3(e.position.x - mob.position.x, 0, e.position.z - mob.position.z), length = Math.hypot(to.x, to.z);
          if (length > 0.05) {
            const step = Math.min(0.215, length);
            const nx = mob.position.x + to.x / length * step, nz = mob.position.z + to.z / length * step;
            if (fits(nx, FLOOR, nz)) { mob.position.x = nx; mob.position.z = nz; }
            else if (fits(nx, FLOOR, mob.position.z)) mob.position.x = nx;
            else if (fits(mob.position.x, FLOOR, nz)) mob.position.z = nz;
          }
        }
        const dxm = Math.abs(e.position.x - mob.position.x), dzm = Math.abs(e.position.z - mob.position.z);
        if (dxm < 1.43 && dzm < 1.43 && mob.position.y < e.position.y + 1.8 && mob.position.y + 2.9 > e.position.y && ms - mob.lastHit >= 1000 && bot.health > 0) {
          mob.lastHit = ms; if (!stats.reachedBodyAtMs) stats.reachedBodyAtMs = ms;
          const front = new Vec3(-Math.sin(e.yaw), 0, -Math.cos(e.yaw)).dot(mob.position.minus(e.position)) > 0;
          if (bot.usingHeldItem && slots[45]?.name === 'shield' && front) stats.blocked++;
          else { stats.hitsOnBot++; bot.health = Math.max(0, bot.health - 7); bot.emit('health'); }
        }
      }
    } else if (Date.now() - (mob.deadAt ?? Date.now()) > 600 && mob.isValid) { mob.isValid = false; delete bot.entities[mob.id]; bot.emit('entityGone', mob); }
    if (bot.gazeGuard && !bot.gazeGuard.enabled && !mob.metadata[CREEPY]) stats.guardOffWhileStaring++;
    bot.emit('physicsTick');
  };
  // Start as a player already standing on the field. With vy=0, the first physics step has no downward collision and clears onGround;
  // the second applies gravity against the floor and restores it. Starting a recovery between those steps would fail its ground guard.
  // Settle only player physics, with all controls released: no mob ticks, stare, attacks or elapsed recovery budget.
  for (let i = 0; i < 2; i++) physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
  const timer = setInterval(tick, 50);
  return { bot, control, mob, stats, placed, stop: () => clearInterval(timer) };
}
type Field = ReturnType<typeof makeField>;

async function act(field: Field, handList: unknown) {
  const since = Date.now();
  const hands = ACT_HANDS.parse(handList);
  const result = await executeAction(field.bot, 'act', 120_000, async () => runAct(createMotorPort(field.bot), hands, undefined, undefined, {}), { waitForQuiescence: true });
  let text = result.result as string;
  if (!text.startsWith('{')) {
    const report = takeActReport(field.bot, since);
    if (report) text = renderActReport(field.bot, report, field.bot.reflexLedger?.noteSince(0));
  }
  return { result, json: JSON.parse(text) };
}
const lineOf = (json: any, index = 0) => String(json.lines[index].line);

describe('fight an enderman from a roofed hole', () => {
  it('lays the roof first (11 blocks), stares it in the eye from under it, gets no blow from it at the roof\'s edge, and kills it: the pearl is told, the gaze guard is put back', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5) });
    const { json, result } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 40 }]);
    field.stop();
    console.log('[ender 1]', result.failureType, lineOf(json), JSON.stringify({ ...field.stats, laid: field.stats.laid.length }), 'mob', field.mob.position.toString(), 'body', field.bot.entity.position.toString(), 'laid', field.stats.laid.join(' '), 'keys', field.stats.keys.slice(0, 12).join(' | '));
    expect(json.ok).toBe(true);
    expect(lineOf(json)).toMatch(/^fight 済 enderman #200 死んだ・落とし物 ender_pearl×1・与えた打撃 \d+/u);
    expect(lineOf(json)).toContain('屋根 11/11・怒らせた');
    expect(field.stats.laid).toHaveLength(11);
    // the roof is where the plan says: nine caps at the body's feet + 2
    const caps = field.stats.laid.filter(key => Number(key.split(',')[1]) === FLOOR + 2);
    expect(caps).toHaveLength(9);
    expect([...field.placed.keys()].filter(key => Number(key.split(',')[1]) < FLOOR + 2)).toEqual([]);
    expect(endermanCampObservation(field.bot)?.supportsRemoved).toBe(2);
    expect(endermanCampObservation(field.bot)?.verifiedCaps).toBe(9);
    // it was angered by the stare (the guard was let go for it), it never reached the body, and it was never looked in the eye within four blocks
    expect(field.stats.angryAtMs).toBeGreaterThan(0);
    expect(field.stats.stareTicks).toBeGreaterThanOrEqual(5);
    expect(field.stats.hitsOnBot).toBe(0);
    expect(field.stats.reachedBodyAtMs).toBe(0);
    expect(field.stats.teleports).toBe(0);
    expect(field.stats.minGap).toBeGreaterThan(1.5);
    expect(field.mob.health).toBeLessThanOrEqual(0);
    expect(field.bot.gazeGuard.enabled).toBe(true);
    expect(field.bot.heldItem?.name).toBe('iron_sword');
  }, 90_000);

  it('without building blocks it says so at once, and nothing is laid or provoked', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), blocks: 5 });
    const { json, result } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 20 }]);
    field.stop();
    console.log('[ender 2]', result.failureType, lineOf(json));
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toContain('屋根に建築用ブロックが 11 個要る');
    expect(field.stats.laid).toHaveLength(0);
    expect(field.stats.stareTicks).toBe(0);
  }, 60_000);

  it('a wall of stone between: the eyes cannot be seen, and it says what stands on the line (after the roof)', async () => {
    const walls: Array<[number, number, number]> = [];
    for (let y = FLOOR; y <= FLOOR + 6; y++) for (let z = -3; z <= 3; z++) walls.push([6, y, z]);
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), walls });
    const { json } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 40 }]);
    field.stop();
    console.log('[ender 3]', lineOf(json));
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toMatch(/enderman_not_visible|not_visible/u);
    // end1109p08b (body 0f988d0a): a roof site in view leads the line (its cell first), and the 160-character clip may cut what stands on the line after it.
    expect(lineOf(json)).toMatch(/stone|屋根の場所 \(-?\d+,-?\d+,-?\d+\) へ go/u);
    expect(field.stats.stareTicks).toBe(0);
  }, 60_000);

  it('a pumpkin on the head: it will not be angered, and the hand says so before it builds', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), pumpkin: true });
    const { json } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 20 }]);
    field.stop();
    expect(json.ok).toBe(false);
    expect(lineOf(json)).toContain('かぼちゃ');
    expect(field.stats.laid).toHaveLength(0);
  }, 60_000);

  it('stops support_unsafe when an already angry target approaches before the temporary supports are removed', async () => {
    const field = makeField({ at: new Vec3(9.5, FLOOR, 0.5), angry: true });
    const { json } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 40 }]);
    field.stop();
    console.log('[ender 5]', lineOf(json), JSON.stringify({ ...field.stats, laid: field.stats.laid.length }), 'hp', field.bot.health);
    expect(field.bot.health).toBeGreaterThan(0);
    expect(field.stats.hits).toBe(0);
    expect(json.ok).toBe(false); expect(lineOf(json)).toContain('support_unsafe');
  }, 90_000);

  it('a roof that already stands (a second enderman at the same hole) is not laid again', async () => {
    const walls: Array<[number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) walls.push([x, FLOOR + 2, z]);
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), walls });
    const { json } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 40 }]);
    field.stop();
    console.log('[ender 6]', lineOf(json), JSON.stringify({ ...field.stats, laid: field.stats.laid.length }));
    expect(json.ok).toBe(true);
    expect(field.stats.laid).toHaveLength(0);
    expect(lineOf(json)).toContain('屋根は既にある');
    expect(field.stats.hitsOnBot).toBe(0);
    const camp = endermanCampObservation(field.bot)!;
    expect(camp.afterBuild?.eyes.clear).toBe(true);
    expect(camp.afterBuild?.feet.clear).toBe(true);
    expect(camp.afterBuild?.approach.clear).toBe(true);
    // The approaching enderman's head disappears above the roof edge; the lower-body gate keeps allowing blows.
    expect(camp.latest?.eyes.clear).toBe(false);
    expect(camp.latest?.feet.clear).toBe(true);
    expect(field.stats.hits).toBeGreaterThan(0);
  }, 90_000);

  it('records a two-high passage with no approach, provokes through the clear eye ray, and kills #200 after it teleports beside the roof', async () => {
    const walls: Array<[number, number, number]> = [];
    for (let x = -3; x <= 16; x++) for (const z of [-1, 1]) for (let y = FLOOR; y <= FLOOR + 4; y++) walls.push([x, y, z]);
    walls.push([4, FLOOR + 2, 0]);
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), walls });
    // This fixture normally models walking only. Supply the angry target's teleport past the passage.
    let teleported = false;
    const teleport = () => {
      if (!teleported && field.stats.angryAtMs > 0) { teleported = true; field.mob.position = new Vec3(2.5, FLOOR, 0.5); }
    };
    field.bot.on('physicsTick', teleport);
    try {
      const { json } = await act(field, [{ do: 'fight', target: '#200', seconds: 30 }]);
      expect(json.ok).toBe(true);
      expect(lineOf(json)).toContain('enderman #200 死んだ');
      const camp = endermanCampObservation(field.bot)!;
      expect(camp.afterBuild?.eyes.clear).toBe(true);
      expect(camp.afterBuild?.feet.clear).toBe(true);
      expect(camp.afterBuild?.approach.clear).toBe(false);
      expect(field.stats.stareTicks).toBeGreaterThanOrEqual(5);
      expect(field.stats.angryAtMs).toBeGreaterThan(0);
      expect(teleported).toBe(true);
      expect(field.stats.hits).toBeGreaterThan(0);
      expect(camp.targetId).toBe(200);
      expect(field.bot.gazeGuard.enabled).toBe(true);
    } finally { field.bot.removeListener('physicsTick', teleport); field.stop(); }
  }, 60_000);

  it('walks one protected cell around its own support with real player physics, then provokes and kills the same #200', async () => {
    const walls: Array<[number, number, number]> = [[1, FLOOR + 1, 0]];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 2; z++) walls.push([x, FLOOR + 2, z]);
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), walls, wallName: 'cobblestone' });
    const positions: Vec3[] = [];
    const sample = () => { positions.push(field.bot.entity.position.clone()); };
    field.bot.on('physicsTick', sample);
    try {
      const read = bodyReader(field.bot), from = { x: 0, y: FLOOR, z: 0 }, to = { x: 0, y: FLOOR, z: 1 };
      expect(field.bot.entity.onGround).toBe(true);
      expect(roofInteriorStep(read, from, from, to)).toBe(true);
      const before = endermanView(read, field.bot.entity.position, field.mob.position);
      expect(before.eyes.between[0]).toEqual({ at: { x: 1, y: FLOOR + 1, z: 0 }, name: 'cobblestone' });
      const after = endermanView(read, { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, field.mob.position);
      expect([after.eyes.clear, after.feet.clear, after.approach.clear]).toEqual([true, true, true]);
      const { json } = await act(field, [{ do: 'fight', target: '#200', seconds: 40 }]);
      const camp = endermanCampObservation(field.bot)!;
      expect(json.ok, JSON.stringify({ lines: json.lines, camp, stats: field.stats, body: field.bot.entity.position, target: field.mob.position })).toBe(true);
      expect(camp.afterBuild?.eyes.clear).toBe(false);
      expect(camp.recovery).toHaveLength(1);
      expect(camp.recovery[0]).toMatchObject({ to: { x: 0, y: FLOOR, z: 1 }, result: 'arrived' });
      expect(camp.targetId).toBe(200);
      expect(field.stats.laid).toHaveLength(0);
      expect(field.stats.hits).toBeGreaterThan(0);
      expect(field.stats.hitsOnBot).toBe(0);
      expect(field.stats.teleports).toBe(0);
      expect(positions.length).toBeGreaterThan(0);
      for (const p of positions) {
        expect(Math.abs(p.x - 0.5)).toBeLessThan(0.2);
        expect(p.z).toBeGreaterThanOrEqual(0.3);
        expect(p.z).toBeLessThanOrEqual(1.7);
        expect(Math.abs(p.y - FLOOR)).toBeLessThan(0.1);
      }
      expect(field.control.forward).toBe(false);
      expect(field.control.sneak).toBe(false);
    } finally { field.bot.removeListener('physicsTick', sample); field.stop(); }
  }, 90_000);

  it('uses the existing five-second wall stop after anger, without switching from #200 to another enderman', async () => {
    const walls: Array<[number, number, number]> = [[1, FLOOR + 1, 0]];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) walls.push([x, FLOOR + 2, z]);
    const field = makeField({ at: new Vec3(2.5, FLOOR, 0.5), angry: true, walls });
    field.bot.entities[201] = { ...field.mob, id: 201, position: new Vec3(-2.5, FLOOR, 0.5) };
    try {
      const { json } = await act(field, [{ do: 'fight', target: '#200', seconds: 20 }]);
      expect(json.ok).toBe(false);
      expect(lineOf(json)).toContain('unreachable');
      expect(lineOf(json)).toContain('間に壁がある（5秒見えない）');
      expect(lineOf(json)).toContain('#200');
      expect(field.stats.swings).toBe(0);
      expect(endermanCampObservation(field.bot)?.targetId).toBe(200);
      expect(endermanCampObservation(field.bot)?.recovery).toHaveLength(0);
      expect(endermanCampObservation(field.bot)?.latest?.feet.clear).toBe(false);
      expect(field.stats.hitsOnBot).toBe(0);
    } finally { field.stop(); }
  }, 60_000);
});

describe('a kill with seconds left watches on (end1109p02)', () => {
  it('kills a second enderman about in the same hand and says both kills with their drops', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5) });
    const metadata: unknown[] = [...field.mob.metadata]; metadata[CREEPY] = true; metadata[STARED] = true;
    field.bot.entities[201] = { ...field.mob, id: 201, metadata, health: 40, hurtAt: 0, position: new Vec3(2.2, FLOOR, 0.5) };
    // The field's tick removes only its own mob after death; the second goes the same way.
    field.bot.on('entityDead', (e: any) => { if (e.id === 201) setTimeout(() => { e.isValid = false; delete field.bot.entities[201]; field.bot.emit('entityGone', e); }, 600); });
    try {
      const { json } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 50 }]);
      console.log('[ender chain]', lineOf(json).slice(0, 400));
      expect(json.ok).toBe(true);
      expect(lineOf(json)).toMatch(/2 体倒した/u);
      expect(lineOf(json)).toContain('#200');
      expect(lineOf(json)).toContain('#201');
    } finally { field.stop(); }
  }, 90_000);
  it('gives the seconds back after a kill with no other enderman about', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5) });
    const since = Date.now();
    try {
      const { json } = await act(field, [{ do: 'fight', target: 'enderman', seconds: 50 }]);
      expect(json.ok).toBe(true);
      expect(lineOf(json)).not.toContain('見張');
      expect(Date.now() - since).toBeLessThan(30_000);
    } finally { field.stop(); }
  }, 90_000);
});

describe('roof centre and short eye contact', () => {
  const roofWalls = (): Array<[number, number, number]> => {
    const walls: Array<[number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) walls.push([x, FLOOR + 2, z]);
    return walls;
  };
  const contextFor = (bot: any): StepContext => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 20_000,
    facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });

  it('corrects an off-centre position within the same cell before staring (real player physics)', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), walls: roofWalls() });
    field.bot.entity.position.x = 0.86;
    const ctx = contextFor(field.bot), camp = new EndermanCamp(ctx, field.mob);
    try {
      for (let i = 0; i < 25 && !endermanCampObservation(field.bot)?.stareAt; i++) {
        const step = await camp.advance(field.mob, Date.now(), 12, false);
        expect(step.kind).not.toBe('stop');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(endermanCampObservation(field.bot)?.stareAt).not.toBeNull();
      expect(atRoofCentre(field.bot.entity.position, { x: 0, y: FLOOR, z: 0 })).toBe(true);
      expect(field.bot.getControlState('forward')).toBe(false);
    } finally { camp.release(); field.stop(); }
  });

  it('immediately aims at legs on anger even at 48m; a reset flag does not restart the stare', async () => {
    const field = makeField({ at: new Vec3(48.5, FLOOR, 0.5), walls: roofWalls() }); field.stop();
    const camp = new EndermanCamp(contextFor(field.bot), field.mob), look = vi.spyOn(field.bot, 'lookAt');
    try {
      const now = Date.now();
      expect((await camp.advance(field.mob, now, 48, false)).kind).toBe('wait');
      expect(look.mock.calls.at(-1)?.[0]).toEqual(field.mob.position.offset(0, ENDERMAN_EYE, 0));
      expect((await camp.advance(field.mob, now + 250, 48, true)).kind).toBe('fight');
      expect(look.mock.calls.at(-1)?.[0]).toEqual(field.mob.position.offset(0, ENDERMAN_LEGS, 0));
      expect(field.bot.gazeGuard.enabled).toBe(true);
      expect(looksAtEyes(field.bot.entity.position.offset(0, 1.62, 0), field.bot.entity.yaw, field.bot.entity.pitch, field.mob.position)).toBe(false);
      await camp.advance(field.mob, now + 300, 48, false);
      expect(look.mock.calls.at(-1)?.[0]).toEqual(field.mob.position.offset(0, ENDERMAN_LEGS, 0));
    } finally { camp.release(); }
  });

  it('ends eye contact at 0.5s and waits for metadata looking at legs, without another stare', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR, 0.5), walls: roofWalls() }); field.stop();
    const camp = new EndermanCamp(contextFor(field.bot), field.mob), look = vi.spyOn(field.bot, 'lookAt');
    try {
      const now = Date.now(); await camp.advance(field.mob, now, 12, false);
      expect((await camp.advance(field.mob, now + ENDERMAN_STARE_MS, 12, false)).kind).toBe('wait');
      expect(look.mock.calls.at(-1)?.[0]).toEqual(field.mob.position.offset(0, ENDERMAN_LEGS, 0));
      const step = await camp.advance(field.mob, now + ENDERMAN_STARE_MS + 501, 12, false);
      expect(step.kind).toBe('stop');
      if (step.kind === 'stop') expect(step.outcome.code).toBe('enderman_not_angry');
    } finally { camp.release(); }
  });

  it('refuses combat after a push outside ±0.2m, even while still in the centre block', async () => {
    const field = makeField({ at: new Vec3(2.5, FLOOR, 0.5), walls: roofWalls(), angry: true }); field.stop();
    const camp = new EndermanCamp(contextFor(field.bot), field.mob);
    try {
      await camp.advance(field.mob, Date.now(), 2, true);
      field.bot.entity.position.x = 0.75;
      const step = await camp.advance(field.mob, Date.now() + 50, 2, true);
      expect(step.kind).toBe('stop');
      expect(field.control.forward).toBe(false);
    } finally { camp.release(); }
  });

  const exitField = () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR + 4, 0.5), walls: roofWalls() }); field.stop();
    const ctx = contextFor(field.bot), camp = new EndermanCamp(ctx, field.mob), began = Date.now();
    const step = (ms: number, angry = false) => camp.advance(field.mob, began + ms, 12, angry);
    const observation = () => endermanCampObservation(field.bot)!;
    return { ...field, ctx, camp, step, observation, outside: () => { field.bot.entity.position = new Vec3(2.5, FLOOR, 0.5); },
      centre: () => { field.bot.entity.position = new Vec3(0.68, FLOOR, 0.5); } };
  };

  it('steps out, stares for only 0.5s and returns to the original centre before waiting for anger', async () => {
    const f = exitField(), look = vi.spyOn(f.bot, 'lookAt'), path = vi.spyOn(f.bot.pathfinder, 'setGoal');
    try {
      expect((await f.step(0)).kind).toBe('wait');
      expect(f.observation().exits[0]).toMatchObject({ to: { x: 2, y: FLOOR, z: 0 }, result: 'moving' });
      expect(f.control).toMatchObject({ forward: true, sneak: true, jump: false, sprint: false });
      expect(f.observation().recovery).toEqual([]);
      f.outside(); await f.step(100);
      expect(f.observation().exits[0].result).toBe('staring');
      expect(f.control.forward).toBe(false);
      expect(f.bot.gazeGuard.enabled).toBe(false);
      expect(look.mock.calls.at(-1)?.[0]).toEqual(f.mob.position.offset(0, ENDERMAN_EYE, 0));
      await f.step(599);
      expect(f.observation().stareEndedAt).toBeNull();
      await f.step(600);
      expect(f.observation().stareEndedAt! - f.observation().stareAt!).toBe(ENDERMAN_STARE_MS);
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'stared' });
      expect(look.mock.calls.at(-1)?.[0]).toEqual(new Vec3(0.5, FLOOR + 1.62, 0.5));
      expect(f.bot.gazeGuard.enabled).toBe(true);
      f.centre(); expect((await f.step(700)).kind).toBe('wait');
      expect(atRoofCentre(f.bot.entity.position, f.observation().roofCell)).toBe(true);
      expect(f.observation().exits[0].result).toBe('returned');
      expect(f.control.forward).toBe(false);
      const result = await f.step(1_101);
      expect(result.kind).toBe('stop');
      if (result.kind === 'stop') expect(result.outcome.code).toBe('enderman_not_angry');
      expect(f.observation().exits).toHaveLength(1);
      expect(path).not.toHaveBeenCalled();
    } finally { f.camp.release(); }
  });

  it.each(['out', 'stare'])('turns back immediately on anger during %s and withholds combat until atRoofCentre', async stage => {
    const f = exitField(), look = vi.spyOn(f.bot, 'lookAt');
    try {
      await f.step(0);
      if (stage === 'stare') { f.outside(); await f.step(100); }
      else f.bot.entity.position.x = 1.1;
      expect((await f.step(200, true)).kind).toBe('wait');
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'angry' });
      expect(look.mock.calls.at(-1)?.[0]).toEqual(new Vec3(0.5, FLOOR + 1.62, 0.5));
      expect(f.bot.gazeGuard.enabled).toBe(true);
      f.centre(); expect((await f.step(300, true)).kind).toBe('fight');
      expect(f.observation().exits[0].result).toBe('returned');
      expect(f.control.forward).toBe(false);
      expect((await f.step(400, false)).kind).toBe('fight');
      expect(f.observation().exits).toHaveLength(1);
    } finally { f.camp.release(); }
  });

  // Codex's pre-deploy review 5 (11/5): out from under the roof only with room to come back, back at once when it comes near, and a blocked way back walked round once.
  it('does not step out for a target nearer than 10 m to the exit cell', async () => {
    const field = makeField({ at: new Vec3(8.5, FLOOR + 4, 0.5), walls: roofWalls() }); field.stop();
    const camp = new EndermanCamp(contextFor(field.bot), field.mob);
    try {
      await camp.advance(field.mob, Date.now(), 8, false);
      expect(endermanCampObservation(field.bot)!.exits).toEqual([]);
      expect(field.control.forward).toBe(false);
    } finally { camp.release(); }
  });

  it('turns back at once when the target comes within 7 m while the body is out, angry or not', async () => {
    const f = exitField();
    try {
      await f.step(0);
      f.outside(); await f.step(100);
      expect(f.observation().exits[0].result).toBe('staring');
      f.mob.position = new Vec3(7.5, FLOOR, 0.5);
      await f.step(200);
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'near' });
    } finally { f.camp.release(); }
  });

  it('walks round to the roof centre when the straight way back is pushed off, and goes on from there', async () => {
    const f = exitField(), path = vi.fn(async (_goal: any) => { f.bot.entity.position = new Vec3(0.5, FLOOR, 0.5); });
    (f.bot.pathfinder as any).goto = path;
    try {
      await f.step(0);
      f.outside(); await f.step(100); await f.step(600);
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'stared' });
      f.bot.entity.position = new Vec3(1.6, FLOOR, 0.95);       // pushed off the straight corridor
      const step = await f.step(700);
      if (step.kind === 'stop') throw new Error(step.outcome.text);
      expect(path.mock.calls.some(([goal]) => goal && goal.x === 0 && goal.z === 0)).toBe(true);
      expect(f.observation().exits[0]).toMatchObject({ result: 'returned', homeWalk: 'arrived' });
    } finally { f.camp.release(); }
  });

  it('stops roof_failed only after the walk round could not reach the centre either', async () => {
    const f = exitField();
    try {
      await f.step(0);
      f.outside(); await f.step(100); await f.step(600);
      f.bot.entity.position = new Vec3(1.6, FLOOR, 0.95);
      const step = await f.step(700);
      expect(step.kind).toBe('stop');
      if (step.kind === 'stop') expect(step.outcome.text).toContain('歩いても戻れなかった');
      expect(f.observation().exits[0].homeWalk).toBe('failed');
    } finally { f.camp.release(); }
  }, 15_000);

  it('never leaves the centre for an already angry target with hidden eyes, including after its flag resets', async () => {
    const f = exitField();
    try {
      expect((await f.step(0, true)).kind).toBe('fight');
      expect((await f.step(100, false)).kind).toBe('fight');
      expect(f.observation().exits).toEqual([]);
      expect(f.control.forward).toBe(false);
    } finally { f.camp.release(); }
  });

  it('rechecks anger after turning and never presses forward if metadata changes during the turn', async () => {
    const f = exitField(), original = f.bot.lookAt;
    f.bot.lookAt = async (point: Vec3) => { await original(point); f.mob.metadata[CREEPY] = true; };
    try {
      await f.step(0);
      expect(f.control.forward).toBe(false);
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'angry' });
      expect((await f.step(100)).kind).toBe('fight');
      expect(f.observation().exits[0].result).toBe('returned');
    } finally { f.camp.release(); }
  });

  it.each(['lava', 'water', 'air', 'unloaded', 'occupied'])('skips the nearer edge when its floor is %s or its cell occupied', async hazard => {
    const f = exitField(), original = f.bot.blockAt;
    if (hazard === 'occupied') f.bot.entities[201] = { id: 201, name: 'pig', position: new Vec3(1.5, FLOOR, 0.5), height: 0.9, width: 0.9 };
    else f.bot.blockAt = (p: Vec3) => p.x === 2 && p.y === FLOOR - 1 && p.z === 0
      ? hazard === 'unloaded' ? null : { name: hazard, boundingBox: 'empty' } : original(p);
    try {
      await f.step(0);
      expect(f.observation().exits).toHaveLength(1);
      expect(f.observation().exits[0].to).not.toEqual({ x: 2, y: FLOOR, z: 0 });
    } finally { f.camp.release(); }
  });

  it('keeps the existing not_visible stop when every exterior corridor is unsafe', async () => {
    const f = exitField(), original = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => p.y === FLOOR - 1 && (Math.abs(p.x) === 2 || Math.abs(p.z) === 2) ? null : original(p);
    try {
      await f.step(0);
      const result = await f.step(8_001);
      expect(result.kind).toBe('stop');
      if (result.kind === 'stop') expect(result.outcome).toMatchObject({ code: 'enderman_not_visible', reason: 'not_visible' });
      expect(f.observation().exits).toEqual([]);
      expect(f.control.forward).toBe(false);
    } finally { f.camp.release(); }
  });

  it('returns when the outside stare loses sight, retries it only once, then stops not_visible with at most two exits', async () => {
    const f = exitField(), blocker = `3,${FLOOR + 1},0`;
    try {
      await f.step(0); f.outside(); await f.step(100);
      f.placed.set(blocker, 'stone'); await f.step(200);
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'not_visible' });
      f.placed.delete(blocker); f.centre(); await f.step(300);
      expect(f.observation().exits).toHaveLength(2);
      f.outside(); await f.step(400);
      f.placed.set(blocker, 'stone'); await f.step(500);
      f.placed.delete(blocker); f.centre(); await f.step(600);
      await f.step(700);
      expect(f.observation().exits).toHaveLength(2);
      expect(f.observation().exits.every(e => e.result === 'returned')).toBe(true);
      const result = await f.step(8_001);
      expect(result.kind).toBe('stop');
      if (result.kind === 'stop') {
        expect(result.outcome.code).toBe('enderman_not_visible');
        expect(result.outcome.text).toContain('屋根外の注視 2/2');
      }
    } finally { f.camp.release(); }
  });

  it('permits no second exit for the same stare if the target moves before any outside eye contact', async () => {
    const f = exitField();
    try {
      await f.step(0); f.outside(); f.mob.position.x = -12.5; await f.step(100);
      expect(f.observation().exits[0].reason).toBe('not_visible');
      f.centre(); await f.step(200); await f.step(300);
      expect(f.observation().exits).toHaveLength(1);
      expect(f.observation().stareAt).toBeNull();
    } finally { f.camp.release(); }
  });

  it.each(['floor', 'pushed', 'timeout', 'turn_failed'])('fails roof_failed/moved if the return cannot finish: %s', async cause => {
    const f = exitField(), original = f.bot.blockAt;
    try {
      await f.step(0); f.outside(); await f.step(100); await f.step(600);
      if (cause === 'floor') f.bot.blockAt = (p: Vec3) => p.x === 1 && p.y === FLOOR - 1 && p.z === 0 ? null : original(p);
      if (cause === 'pushed') f.bot.entity.position.z += 0.3;
      if (cause === 'turn_failed') f.bot.lookAt = async () => { throw new Error('turn failed'); };
      const result = await f.step(cause === 'timeout' ? 4_201 : 700);
      expect(result.kind).toBe('stop');
      if (result.kind === 'stop') expect(result.outcome).toMatchObject({ code: 'roof_failed', reason: 'moved' });
      expect(f.observation().exits[0].result).toBe('stopped');
      expect(f.control).toMatchObject({ forward: false, sneak: false });
      expect(f.bot.gazeGuard.enabled).toBe(true);
    } finally { f.camp.release(); }
  });

  it('turns back from a stalled outbound step instead of waiting outside or trying another exit for the same stare', async () => {
    const f = exitField(), look = vi.spyOn(f.bot, 'lookAt');
    try {
      await f.step(0); f.bot.entity.position.x = 1.1;
      expect((await f.step(3_601)).kind).toBe('wait');
      expect(f.observation().exits[0]).toMatchObject({ result: 'returning', reason: 'not_visible' });
      expect(look.mock.calls.at(-1)?.[0]).toEqual(new Vec3(0.5, FLOOR + 1.62, 0.5));
      f.centre(); await f.step(3_701);
      expect(f.observation().exits).toHaveLength(1);
      expect(f.observation().exits[0].result).toBe('returned');
      expect(f.control.forward).toBe(false);
    } finally { f.camp.release(); }
  });

  it.each(['cancelled', 'target_lost', 'released'])('releases exterior movement and restores the gaze guard when %s', async cause => {
    const f = exitField();
    try {
      await f.step(0); f.outside(); await f.step(100);
      expect(f.bot.gazeGuard.enabled).toBe(false);
      if (cause === 'released') f.camp.release();
      else if (cause === 'target_lost') {
        const result = await f.camp.advance({ ...f.mob, id: 201 }, Date.now(), 12, false);
        expect(result.kind).toBe('stop');
        if (result.kind === 'stop') expect(result.outcome.code).toBe('target_lost');
      } else {
        const stop = new AbortController(); f.ctx.stop = stop.signal; stop.abort();
        expect((await f.step(200)).kind).toBe('stop');
      }
      expect(f.observation().exits[0].result).toBe('stopped');
      expect(f.control).toMatchObject({ forward: false, sneak: false });
      expect(f.bot.gazeGuard.enabled).toBe(true);
    } finally { f.camp.release(); }
  });

  it('walks out and back with real player physics and provokes the same elevated target', async () => {
    const field = makeField({ at: new Vec3(12.5, FLOOR + 4, 0.5), walls: roofWalls() });
    const camp = new EndermanCamp(contextFor(field.bot), field.mob), path = vi.spyOn(field.bot.pathfinder, 'setGoal');
    let result: Awaited<ReturnType<EndermanCamp['advance']>> = { kind: 'wait' };
    try {
      const until = Date.now() + 7_000;
      while (Date.now() < until && result.kind === 'wait') {
        result = await camp.advance(field.mob, Date.now(), 12, field.mob.metadata[CREEPY] === true);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(result.kind, JSON.stringify({ result, position: field.bot.entity.position, exits: endermanCampObservation(field.bot)?.exits, keys: field.stats.keys })).toBe('fight');
      expect(field.stats.stareTicks).toBeGreaterThan(0);
      expect(atRoofCentre(field.bot.entity.position, { x: 0, y: FLOOR, z: 0 })).toBe(true);
      expect(endermanCampObservation(field.bot)?.exits[0]).toMatchObject({ result: 'returned', reason: 'angry' });
      expect(path).not.toHaveBeenCalled();
    } finally { camp.release(); field.stop(); }
  });
});
