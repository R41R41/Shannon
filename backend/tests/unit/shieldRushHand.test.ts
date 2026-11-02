import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { createRequire } from 'node:module';
import { shieldRush, shieldRushProblem, type ShieldRushArgs, type ShieldRushOutcome } from '../../src/services/minebot/utils/primitives/shieldRush.js';
import { RushShooterWatch } from '../../src/services/minebot/utils/huntBlaze.js';
import { RushSpace } from '../../src/services/minebot/utils/primitives/shieldRushSpace.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';
import { installShieldBlock } from '../../src/services/minebot/utils/shieldBlock.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { takeActReport } from '../../src/services/minebot/utils/actReport.js';

vi.mock('../../src/services/minebot/utils/primitives/go.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/go.js')>();
  return { ...actual, go: vi.fn() };
});

// The client ticks move the body at shield walking pace. Only server events count hits/death/collection.
function field(x = 2.8, y = 64) {
  const controls: Record<string, boolean> = {}, slots: any[] = Array(46).fill(null);
  slots[36] = { name: 'stone_sword', type: 1, slot: 36, count: 1 };
  slots[45] = { name: 'shield', type: 2, slot: 45, count: 1, durabilityUsed: 0 };
  const mob: any = { id: 41, uuid: 'chosen', name: 'blaze', type: 'hostile', position: new Vec3(x, y, 0.5), width: 0.6, height: 1.8, metadata: [0], health: 20, isValid: true };
  const blocks = new Map<string, string | null>(), states: string[] = [], swings: Array<{ at: number; shield: boolean; id: number }> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'the_nether' }, entities: { 41: mob }, heldItem: slots[36], usingHeldItem: false,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, metadata: [0], onGround: true, height: 1.8 },
    registry: { entitiesByName: { blaze: { metadataKeys: ['flags'] } }, itemsByName: { shield: { maxDurability: 336 } } },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) },
    blockAt: (v: Vec3) => {
      const p = v.floored(), key = `${p.x},${p.y},${p.z}`, name = blocks.has(key) ? blocks.get(key) : p.y < 64 ? 'stone' : 'air';
      return name === null ? null : { name, position: p, boundingBox: name === 'stone' ? 'block' : 'empty', shapes: name === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [], type: name === 'stone' ? 1 : 0 };
    },
    setControlState: (k: string, v: boolean) => { controls[k] = v; }, getControlState: (k: string) => !!controls[k],
    clearControlStates: () => { for (const k of Object.keys(controls)) controls[k] = false; },
    look: (yaw: number) => { bot.entity.yaw = yaw; return Promise.resolve(); },
    activateItem: vi.fn((off: boolean) => { expect(off).toBe(true); bot.usingHeldItem = true; }),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }),
    deactivateItem: vi.fn(() => { bot.usingHeldItem = false; }),
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, stopDigging: () => undefined,
    attack: (e: any) => {
      swings.push({ at: Date.now(), shield: bot.usingHeldItem, id: e.id }); e.health -= 5; bot.emit('entityHurt', e);
      if (e.health <= 0) {
        bot.emit('entityDead', e);
        if (bot.keepCorpse) setTimeout(() => { delete bot.entities[e.id]; }, 600);
        else delete bot.entities[e.id];
        setTimeout(() => { bot.entities[70] = { id: 70, name: 'item', position: e.position.clone(), getDroppedItem: () => ({ name: 'blaze_rod', count: 1 }) }; }, 100);
      }
    },
  });
  const timer = setInterval(() => {
    const p = bot.entity.position, yaw = bot.entity.yaw;
    const f = Number(controls.forward) || 0, b = Number(controls.back) || 0, l = Number(controls.left) || 0, r = Number(controls.right) || 0;
    const dx = (-Math.sin(yaw) * (f - b) - Math.cos(yaw) * (l - r)) * 0.055;
    const dz = (-Math.cos(yaw) * (f - b) + Math.sin(yaw) * (l - r)) * 0.055;
    if (bot.simulateTick) bot.simulateTick();
    else if (!bot.frozen) bot.entity.position = p.offset(dx, 0, dz);
    for (const e of Object.values(bot.entities) as any[]) if (e.name === 'item' && e.position.distanceTo(bot.entity.position) < 0.85 && bot.takeDrops !== false) {
      bot.emit('playerCollect', bot.entity, e); slots[10] = { name: 'blaze_rod', type: 3, slot: 10, count: (slots[10]?.count ?? 0) + 1 }; delete bot.entities[e.id];
    }
    bot.emit('physicsTick');
  }, 50);
  const stop = new AbortController();
  const ctx = { bot, stop: stop.signal, base: { x: 0, y: 64, z: 0 }, facing: 'north' as const, deadline: Date.now() + 60_000, progress: (s: string) => states.push(s) };
  const args: ShieldRushArgs = { target: '#41', seconds: 30, retreatHp: 14, retreatTo: { x: 0.5, y: 64, z: 0.5 }, area: { center: { x: 0.5, y: 64, z: 0.5 }, radius: 10, maxDrop: 0 }, shieldReserve: 36, onCrossfire: 'retreat', pickup: 'target_drops' };
  return { bot, mob, slots, blocks, states, swings, controls, ctx, args, stop, close: () => clearInterval(timer) };
}
type Field = ReturnType<typeof field>;
async function settle<T>(promise: Promise<T>, limit = 65_000): Promise<T> {
  let done = false, value: T | undefined, error: unknown;
  promise.then(v => { value = v; done = true; }, e => { error = e; done = true; });
  for (let ms = 0; !done && ms < limit; ms += 50) await vi.advanceTimersByTimeAsync(50);
  if (error) throw error;
  expect(done, 'the hand must terminate within its deadline').toBe(true);
  return value!;
}
async function run(f: Field): Promise<ShieldRushOutcome> { return settle(shieldRush(f.ctx, f.args)); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); vi.mocked(go).mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shield_rush one chosen blaze', () => {
  it('also closes, collects and returns using the real client physics under a raised shield', async () => {
    const f = field(6.5), data = minecraftData('1.21.11'), Block = (blockLoader as any)('1.21.11');
    const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');
    const cache = new Map<string, any>();
    const getBlock = (p: Vec3) => {
      const at = p.floored(), key = `${at.x},${at.y},${at.z}`;
      if (!cache.has(key)) { const b = new Block(data.blocksByName[at.y < 64 ? 'stone' : 'air'].id, 0, 0); b.position = at; cache.set(key, b); }
      return cache.get(key);
    };
    const world = { getBlock }, physics = Physics(data, world);
    Object.assign(f.bot, { registry: data, version: '1.21.11', physics, blockAt: getBlock, controlState: f.controls,
      jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, quickBarSlot: 0, foodSaturation: 5 });
    Object.assign(f.bot.entity, { pitch: 0, effects: {}, attributes: {}, width: 0.6, isInWater: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false });
    f.bot.simulateTick = () => physics.simulatePlayer(new PlayerState(f.bot, f.controls), world).apply(f.bot);
    const flags = data.entitiesByName.blaze.metadataKeys!.indexOf('flags');
    f.mob.metadata = Array(data.entitiesByName.blaze.metadataKeys!.length).fill(0); f.mob.metadata[flags] = 1;
    setTimeout(() => { f.mob.metadata[flags] = 0; }, 3700);
    const result = await run(f);
    expect(result.shieldRush).toMatchObject({ status: 'killed', hits: 4, rodsDelta: 1, safe: true });
    expect(f.swings.every(s => s.shield)).toBe(true); f.close();
  });
  it('strikes through a raised shield, confirms hits, picks up and returns, without another sortie', async () => {
    const f = field(6.5); f.mob.metadata[0] = 1;
    setTimeout(() => { f.mob.metadata[0] = 0; }, 3700);
    const r = await run(f);
    expect(r.shieldRush).toMatchObject({ status: 'killed', code: null, targetDead: true, hits: 4, rodsDelta: 1, hpMin: 20, hpEnd: 20, shieldBefore: 336, shieldAfter: 336, safe: true });
    expect(f.states.join(' ')).toMatch(/CLOSE.*STRIKE.*PICKUP.*RETREAT/u);
    expect(f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5))).toBeLessThanOrEqual(0.65);
    expect(f.swings.every(s => s.id === 41 && s.shield)).toBe(true);
    expect(f.swings.slice(1).every((s, i) => s.at - f.swings[i].at >= 625)).toBe(true);
    expect(f.bot.deactivateItem).not.toHaveBeenCalled();
    expect(Object.values(f.controls).some(Boolean)).toBe(false);
    f.close();
  });
  it.each(['charged', 'unknown'])('closes on safe floor and strikes under the ready shield without a %s shooter window', async phase => {
    const f = field(6.5), start = f.bot.entity.position.clone(), started = Date.now();
    f.mob.metadata = phase === 'charged' ? [1] : [];
    f.args.pickup = 'none';
    const watch = new RushShooterWatch(f.bot);
    watch.update(started); expect(watch.mayClose(start, started)).toBe(false);
    let ticks = 0;
    f.bot.on('physicsTick', () => { ticks++; });
    const steps: Array<{ shield: boolean; ticks: number; elapsed: number; at: Vec3 }> = [];
    const setControl = f.bot.setControlState;
    vi.spyOn(f.bot, 'setControlState').mockImplementation((key, value) => {
      if (value && ['forward', 'back', 'left', 'right'].includes(String(key))) {
        steps.push({ shield: f.bot.usingHeldItem, ticks, elapsed: Date.now() - started, at: f.bot.entity.position.clone() });
      }
      setControl(key, value);
    });
    const r = await run(f);
    expect(r.shieldRush).toMatchObject({ status: 'killed', hits: 4, safe: true });
    expect(f.states).toContain('盾の突撃 CLOSE');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every(s => s.shield && s.ticks >= 5 && s.elapsed >= 250
      && new RushSpace(f.bot, f.args.area).stand(s.at))).toBe(true);
    expect(f.swings.every(s => s.shield && s.at - started < 15_000)).toBe(true);
    expect(f.bot.deactivateItem).not.toHaveBeenCalled(); f.close();
  });
  it('attacks in reach even during charge/unknown phase; pickup none returns without seeking items', async () => {
    const f = field(); f.mob.metadata[0] = 1; f.args.pickup = 'none';
    const r = await run(f);
    expect(r.shieldRush.status).toBe('killed'); expect(f.swings).toHaveLength(4);
    expect(f.swings[0].at - new Date('2026-11-03T00:00:00Z').getTime()).toBeLessThan(500);
    expect(r.shieldRush.rodsDelta).toBe(0); f.close();
  });
  it('equips the carried sword once and verifies it before raising the shield', async () => {
    const f = field(); f.bot.heldItem = { name: 'diamond_pickaxe', type: 7 }; f.args.pickup = 'none';
    expect((await run(f)).shieldRush.status).toBe('killed'); expect(f.bot.equip).toHaveBeenCalledTimes(1);
    expect(f.swings.every(s => s.shield)).toBe(true); f.close();
  });
  it('does not count a confirmed dead blaze still in its death animation as an active shooter', async () => {
    const f = field(); f.bot.keepCorpse = true; f.args.pickup = 'none';
    expect((await run(f)).shieldRush).toMatchObject({ status: 'killed', targetDead: true, safe: true }); f.close();
  });
  it('keeps the resident shield from taking the look, keys or lowering the hand shield, and restores it', async () => {
    const f = field(); const release = f.bot.deactivateItem; installShieldBlock(f.bot); f.args.pickup = 'none';
    const r = await run(f);
    expect(r.shieldRush.status).toBe('killed'); expect(release).not.toHaveBeenCalled();
    expect(f.bot.shieldBlock.enabled).toBe(true); expect(f.bot.shieldBlock.up).toBe(true); f.close();
  });
  it('retreats at the requested HP and measures the minimum through the return', async () => {
    const f = field(8); setTimeout(() => { f.bot.health = 14; f.bot.emit('health'); delete f.bot.entities[41]; }, 400);
    const r = await run(f);
    expect(r.shieldRush).toMatchObject({ status: 'retreated', code: null, hpMin: 14, hpEnd: 14, safe: true });
    expect(f.swings).toHaveLength(0); f.close();
  });
  it('returns SHIELD_LOW at the reserve, without swinging or substituting a new shield', async () => {
    const f = field(8); f.slots[45].durabilityUsed = 300;
    f.args.retreatTo.x = -1.5;
    setTimeout(() => { delete f.bot.entities[41]; }, 400);
    const r = await run(f); expect(r.shieldRush).toMatchObject({ code: 'SHIELD_LOW', shieldBefore: 36, safe: true }); f.close();
    const g = field(8); setTimeout(() => { g.slots[45].durabilityUsed = 300; delete g.bot.entities[41]; }, 400);
    const s = await run(g); expect(s.shieldRush).toMatchObject({ status: 'retreated', code: 'SHIELD_LOW', shieldAfter: 36, safe: true }); expect(g.swings).toHaveLength(0); g.close();
  });
  it('distinguishes a lost target from an observed death and never changes targets', async () => {
    const f = field(8); f.bot.entities[42] = { ...f.mob, id: 42, uuid: 'other', position: new Vec3(15, 64, 0.5) };
    setTimeout(() => { delete f.bot.entities[41]; }, 400);
    // The other blaze is hidden by a wall so the chosen retreat point can be safe.
    for (let yy = 64; yy <= 67; yy++) f.blocks.set(`10,${yy},0`, 'stone');
    const r = await run(f); expect(r.shieldRush).toMatchObject({ code: 'TARGET_LOST', targetDead: null, safe: true }); expect(f.swings).toHaveLength(0); f.close();
  });
  it('returns HEIGHT_UNREACHABLE for high hover, retaining the shield while waiting', async () => {
    const f = field(2, 72);
    f.args.retreatTo.x = -1.5;
    // The overhead shelter hides the hovering blaze without blocking the walk back after closing.
    setTimeout(() => { for (let y = 66; y < 72; y++) f.blocks.set(`1,${y},0`, 'stone'); }, 15_200);
    const r = await run(f); expect(r.shieldRush).toMatchObject({ code: 'HEIGHT_UNREACHABLE', safe: true }); expect(f.swings).toHaveLength(0); f.close();
  });
  it.each(['health', 'shield'])('keeps requiring a closing window at the %s margin and never forces one after waiting', async margin => {
    const f = field(8); f.mob.metadata[0] = 1;
    if (margin === 'health') f.bot.health = f.args.retreatHp + 4;
    else f.slots[45].durabilityUsed = 336 - (f.args.shieldReserve + 30);
    // A shelter wall appears when the no-window retreat begins; the target remains loaded.
    setTimeout(() => { f.blocks.set('4,65,0', 'stone'); f.blocks.set('4,64,0', 'stone'); }, 15_050);
    const r = await run(f); expect(r.shieldRush.code).toBe('NO_ATTACK_WINDOW'); expect(f.swings).toHaveLength(0); expect(f.states).not.toContain('盾の突撃 CLOSE'); f.close();
  });
  it('still closes at the health margin when an observed burst ends', async () => {
    const f = field(6.5), start = f.bot.entity.position.clone();
    f.bot.health = f.args.retreatHp + 4; f.mob.metadata[0] = 1; f.args.pickup = 'none';
    const pending = shieldRush(f.ctx, f.args);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bot.entity.position.equals(start)).toBe(true);
    expect(f.states).not.toContain('盾の突撃 CLOSE'); expect(f.swings).toHaveLength(0);
    f.mob.metadata[0] = 0;
    expect((await settle(pending)).shieldRush).toMatchObject({ status: 'killed', hits: 4, safe: true });
    expect(f.states).toContain('盾の突撃 CLOSE'); f.close();
  });
  it('does not close without actual shield use even when a shooting window opens', async () => {
    const f = field(8), start = f.bot.entity.position.clone();
    f.bot.activateItem.mockImplementation(() => undefined); f.mob.metadata[0] = 1;
    setTimeout(() => { f.mob.metadata[0] = 0; }, 100);
    const pending = shieldRush(f.ctx, f.args);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bot.entity.position.equals(start)).toBe(true);
    expect(f.states).not.toContain('盾の突撃 CLOSE'); expect(f.swings).toHaveLength(0);
    f.stop.abort('floor-flee'); await settle(pending); f.close();
  });
  it('honours onCrossfire retreat and continue', async () => {
    const f = field(); f.bot.entities[42] = { ...f.mob, id: 42, position: new Vec3(-5, 64, 0.5), metadata: [1] };
    f.args.retreatTo.x = -1.5;
    setTimeout(() => { delete f.bot.entities[41]; delete f.bot.entities[42]; }, 400);
    const r = await run(f); expect(r.shieldRush.code).toBe('CROSSFIRE'); expect(f.states).toContain('盾の突撃 RETREAT'); expect(f.swings).toHaveLength(0); f.close();
    const g = field(); g.args.onCrossfire = 'continue'; g.bot.entities[42] = { ...g.mob, id: 42, position: new Vec3(-5, 64, 0.5), metadata: [1] };
    await run(g); expect(g.swings.length).toBeGreaterThan(0); g.close();
  });
  it.each(['lava', null])('returns RETREAT_BLOCKED before any movement for an unsafe or unknown retreat floor (%s)', async floor => {
    const f = field(), start = f.bot.entity.position.clone(), keys = vi.spyOn(f.bot, 'setControlState');
    f.args.retreatTo.x = -4.5; f.blocks.set('-5,63,0', floor);
    const r = await run(f);
    expect(r.shieldRush).toMatchObject({ code: 'RETREAT_BLOCKED', safe: false, status: 'failed', at: { x: start.x, y: start.y, z: start.z } });
    expect(f.bot.entity.position.equals(start)).toBe(true); expect(keys).not.toHaveBeenCalled();
    expect(f.bot.activateItem).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled();
    expect(f.swings).toHaveLength(0); f.close();
  });
  it('reports RETREAT_BLOCKED at the current position if the deadline ends without confirmed shelter', async () => {
    const f = field(8); f.ctx.deadline = Date.now();
    expect((await run(f)).shieldRush).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', safe: false, at: { x: 0.5, y: 64, z: 0.5 } });
    expect(f.swings).toHaveLength(0); f.close();
  });
  it('PICKUP_UNSAFE for an unsafe drop and reports its id and location', async () => {
    const f = field();
    setTimeout(() => { f.blocks.set('2,63,0', 'lava'); }, 2200);
    const r = await run(f); expect(r.shieldRush.code).toBe('PICKUP_UNSAFE'); expect(r.shieldRush.targetDead).toBe(true); expect(r.shieldRush.pendingDrops[0].id).toBe(70); f.close();
  });
  it('does not claim collection on item disappearance or pick an item that predates the kill', async () => {
    const f = field(); f.bot.takeDrops = false;
    f.bot.entities[69] = { id: 69, name: 'item', position: new Vec3(2.8, 64, 0.5), getDroppedItem: () => ({ name: 'blaze_rod', count: 3 }) };
    setTimeout(() => { delete f.bot.entities[70]; }, 2700);
    const r = await run(f); expect(r.shieldRush.code).toBe('PICKUP_UNSAFE'); expect(r.shieldRush.rodsDelta).toBe(0); expect(r.shieldRush.pendingDrops.map(d => d.id)).toEqual([70]); f.close();
  });
  it('reserves time to return and reports TIME_LIMIT without attacking another mob', async () => {
    const f = field(8); f.args.seconds = 10; f.args.retreatTo.x = -3.5;
    for (let y = 64; y <= 67; y++) f.blocks.set(`-2,${y},0`, 'stone');
    const r = await run(f); expect(r.shieldRush.code).toBe('TIME_LIMIT'); expect(r.shieldRush.elapsedMs).toBeLessThanOrEqual(10000); f.close();
  });
  it.each(['lava', 'fall', 'burn', 'lease'])('REFLEX yields immediately for %s and never writes after the cut', async kind => {
    const f = field(8);
    setTimeout(() => {
      if (kind === 'lava') f.bot.entity.isInLava = true;
      if (kind === 'fall') { f.bot.entity.onGround = false; f.bot.entity.velocity.y = -1; }
      if (kind === 'burn') { f.bot.entity.metadata[0] = 1; f.bot.health = 4; }
      if (kind === 'lease') f.stop.abort('floor-flee');
    }, 400);
    const r = await run(f); expect(r.shieldRush).toMatchObject({ code: 'REFLEX', status: 'cut', safe: false }); expect(f.swings).toHaveLength(0); f.close();
  });
  it('DEAD remains distinct from target death', async () => {
    const f = field(8); setTimeout(() => { f.bot.health = 0; f.bot.emit('health'); }, 400);
    expect((await run(f)).shieldRush).toMatchObject({ code: 'DEAD', targetDead: false, hpMin: 0, hpEnd: 0 }); f.close();
  });
  it('does not clear controls or send a look after an external reflex takes them', async () => {
    const f = field(8), controls = vi.spyOn(f.bot, 'setControlState'), look = vi.spyOn(f.bot, 'look');
    let keysAtCut = 0, looksAtCut = 0;
    setTimeout(() => { f.stop.abort('floor-flee'); f.controls.forward = true; keysAtCut = controls.mock.calls.length; looksAtCut = look.mock.calls.length; }, 400);
    expect((await run(f)).shieldRush.code).toBe('REFLEX');
    await vi.advanceTimersByTimeAsync(200);
    expect(controls.mock.calls).toHaveLength(keysAtCut); expect(look.mock.calls).toHaveLength(looksAtCut); expect(f.controls.forward).toBe(true); f.close();
  });
  it('refuses pickup after a full inventory gives no collection acknowledgement', async () => {
    const f = field(); f.bot.takeDrops = false;
    const r = await run(f); expect(r.shieldRush).toMatchObject({ code: 'PICKUP_UNSAFE', rodsDelta: 0, safe: true }); f.close();
  });
  it('act exposes the structured result on its line and stops subsequent dependent hands', async () => {
    const f = field(); f.args.pickup = 'none';
    const hands = ACT_HANDS.parse([{ do: 'attack', style: 'shield_rush', ...f.args }]);
    const result = await settle(executeAction(f.bot, 'act', 60_000, () => runAct(createMotorPort(f.bot), hands), { waitForQuiescence: true }));
    const json = JSON.parse(result.result as string);
    expect(json.lines[0].shieldRush).toMatchObject({ status: 'killed', hits: 4, safe: true }); f.close();
  });
  it('retains REFLEX measurements in act after an external cut', async () => {
    const f = field(8); const started = Date.now();
    const hands = ACT_HANDS.parse([{ do: 'attack', style: 'shield_rush', ...f.args }, { do: 'wait', seconds: 1 }]);
    setTimeout(() => { f.bot.entity.isInLava = true; }, 400);
    await settle(executeAction(f.bot, 'act', 60_000, () => runAct(createMotorPort(f.bot), hands), { waitForQuiescence: true }));
    const report = takeActReport(f.bot, started)!;
    expect((report.lines[0] as any).shieldRush.code).toBe('REFLEX'); expect(report.lines[0].end).toBe('cut'); expect(report.lines[1].status).toBe('skipped'); f.close();
  });
});

// The retreat corridor crosses partial floors; its shelter is 17 m from camp, beyond the combat area.
function outsideField(x = 6.5) {
  const f = field(x), read = f.bot.blockAt;
  f.args.seconds = 60; f.args.retreatTo = { x: -16.5, y: 64, z: 0.5 };
  f.bot.blockAt = (p: Vec3) => {
    const b = read(p), at = p.floored();
    if (at.y !== 63 || b?.name !== 'stone') return b;
    if (at.x === -6) return { ...b, name: 'nether_brick_stairs', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0.5, 1, 1, 1]] };
    if (at.x === -10) return { ...b, name: 'nether_brick_slab', shapes: [[0, 0, 0, 1, 0.5, 1]] };
    return at.x <= -16 ? { ...b, name: 'nether_bricks' } : b;
  };
  for (const y of [64, 65, 66]) f.blocks.set(`-14,${y},0`, 'stone');
  return f;
}
function arriveOutside(f: Field) {
  vi.mocked(go).mockImplementationOnce(async (ctx, a) => {
    expect(a.goals).toEqual([f.args.retreatTo]);
    await new Promise(resolve => setTimeout(resolve, 300));
    ctx.bot.entity.position = new Vec3(a.goals[0].x, a.goals[0].y, a.goals[0].z);
    return { ok: true, text: 'go 着いた' };
  });
}

describe('retreat outside the combat area via go', () => {
  it('rejects an outside retreat farther than four area radii before any movement or go', async () => {
    const f = outsideField(), start = f.bot.entity.position.clone(), keys = vi.spyOn(f.bot, 'setControlState');
    f.args.retreatTo.x = start.x - f.args.area.radius * 4 - 0.01;
    expect((await run(f)).shieldRush).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', hits: 0, safe: false,
      at: { x: start.x, y: start.y, z: start.z } });
    expect(f.bot.entity.position.equals(start)).toBe(true); expect(keys).not.toHaveBeenCalled();
    expect(f.bot.activateItem).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled(); f.close();
  });
  it('allows the outside distance estimate at exactly four area radii', async () => {
    const f = outsideField(8); f.bot.health = f.args.retreatHp;
    f.args.retreatTo.x = f.bot.entity.position.x - f.args.area.radius * 4;
    arriveOutside(f);
    expect((await run(f)).shieldRush).toMatchObject({ status: 'retreated', code: null, hits: 0, safe: true });
    expect(go).toHaveBeenCalledTimes(1); f.close();
  });
  it('retreats after fifteen seconds without distance gain even while trying to close under the shield', async () => {
    const f = outsideField(8), started = Date.now(); f.bot.frozen = true; f.mob.metadata[0] = 1;
    arriveOutside(f);
    const r = await run(f);
    expect(r.shieldRush).toMatchObject({ code: 'NO_ATTACK_WINDOW', hits: 0, safe: true });
    expect(f.states).toContain('盾の突撃 CLOSE');
    expect(f.states).toContain('盾の突撃 RETREAT');
    expect(f.swings).toHaveLength(0); expect(go).toHaveBeenCalledTimes(1);
    expect(r.shieldRush.elapsedMs).toBeGreaterThanOrEqual(15_000);
    expect(Date.now() - started).toBeLessThan(16_000); f.close();
  });
  it('honours crossfire retreat when an opposing shooter appears during guarded closing', async () => {
    const f = outsideField(8); f.mob.metadata[0] = 1;
    setTimeout(() => { f.bot.entities[42] = { ...f.mob, id: 42, uuid: 'opposing', position: new Vec3(-5, 64, 0.5) }; }, 800);
    arriveOutside(f);
    expect((await run(f)).shieldRush).toMatchObject({ code: 'CROSSFIRE', hits: 0, safe: true });
    expect(f.states).toContain('盾の突撃 CLOSE'); expect(go).toHaveBeenCalledTimes(1); f.close();
  });
  it('closes and kills before returning over stairs/slabs, keeping the shield and resident ownership throughout go', async () => {
    const f = outsideField(), s = new RushSpace(f.bot, f.args.area), lowered = f.bot.deactivateItem;
    expect(s.stand(new Vec3(-5.5, 64, 0.5))).toBe(false);
    expect(s.stand(new Vec3(-9.5, 64, 0.5))).toBe(false);
    expect(s.inside(f.args.retreatTo)).toBe(false);
    installShieldBlock(f.bot);
    const release = f.bot.deactivateItem, look = vi.spyOn(f.bot, 'look'), keys = vi.spyOn(f.bot, 'setControlState');
    f.mob.metadata[0] = 1; setTimeout(() => { f.mob.metadata[0] = 0; }, 400);
    vi.mocked(go).mockImplementationOnce(async (ctx, a) => {
      expect(ctx).toBe(f.ctx);
      expect(a.seconds).toBeCloseTo((f.ctx.deadline - Date.now()) / 1000);
      expect(f.states.at(-1)).toBe('盾の突撃 RETREAT');
      expect(f.bot.shieldBlock).toMatchObject({ enabled: false, up: false });
      expect(f.bot.usingHeldItem).toBe(true);
      ctx.bot.deactivateItem(); // go's route changes call letGo; that must not lower the rush shield.
      expect(f.bot.usingHeldItem).toBe(true);
      const looks = look.mock.calls.length, writes = keys.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(look.mock.calls).toHaveLength(looks); expect(keys.mock.calls).toHaveLength(writes);
      expect(f.bot.shieldBlock.enabled).toBe(false); expect(f.bot.usingHeldItem).toBe(true);
      f.bot.health = 19; f.bot.emit('health');
      ctx.bot.entity.position = new Vec3(a.goals[0].x, a.goals[0].y, a.goals[0].z);
      return { ok: true, text: 'go 着いた' };
    });
    const r = await run(f);
    expect(r.shieldRush).toMatchObject({ status: 'killed', targetDead: true, code: null, hits: 4, rodsDelta: 1, safe: true, hpMin: 19 });
    expect(f.states.join(' ')).toMatch(/CLOSE.*STRIKE.*PICKUP.*RETREAT/u);
    expect(go).toHaveBeenCalledTimes(1);
    expect(vi.mocked(go).mock.calls[0][1]).toMatchObject({ goals: [f.args.retreatTo], range: 0.8, canPlace: ['cobblestone', 'netherrack'], maxPlace: 6, maxDrop: 0 });
    expect(lowered).not.toHaveBeenCalled(); expect(f.bot.deactivateItem).toBe(release);
    expect(f.bot.shieldBlock).toMatchObject({ enabled: true, up: true }); f.close();
  });
  it('returns safely at retreatHp with the live target hidden by the shelter', async () => {
    const f = outsideField(8); f.args.area.maxDrop = 2;
    setTimeout(() => { f.bot.health = 14; f.bot.emit('health'); }, 400);
    arriveOutside(f);
    expect((await run(f)).shieldRush).toMatchObject({ status: 'retreated', targetDead: false, code: null, hits: 0, hpMin: 14, safe: true });
    expect(go).toHaveBeenCalledTimes(1); expect(vi.mocked(go).mock.calls[0][1].maxDrop).toBe(2); f.close();
  });
  it('reports RETREAT_BLOCKED when go stops, restoring the shield writer and resident', async () => {
    const f = outsideField(8); f.bot.health = 14; installShieldBlock(f.bot);
    const release = f.bot.deactivateItem;
    vi.mocked(go).mockResolvedValueOnce({ ok: false, reason: 'stuck', text: 'go 止まった stuck' });
    expect((await run(f)).shieldRush).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', safe: false });
    expect(go).toHaveBeenCalledTimes(1); expect(f.bot.deactivateItem).toBe(release);
    expect(f.bot.shieldBlock).toMatchObject({ enabled: true, up: true }); f.close();
  });
  it('reserves straight distance × 1.8 s + 2 s using the act deadline and retreats with TIME_LIMIT', async () => {
    const f = outsideField(); f.ctx.deadline = Date.now() + 32_650;
    arriveOutside(f);
    expect((await run(f)).shieldRush).toMatchObject({ status: 'retreated', code: 'TIME_LIMIT', hits: 0, safe: true });
    expect(vi.mocked(go).mock.calls[0][1].seconds).toBeCloseTo(32.6); f.close();
  });
  it('also reserves the next closing step before moving farther from an outside retreat', async () => {
    const f = outsideField(8); f.ctx.deadline = Date.now() + 35_100;
    f.mob.metadata[0] = 1; setTimeout(() => { f.mob.metadata[0] = 0; }, 100);
    arriveOutside(f);
    expect((await run(f)).shieldRush).toMatchObject({ code: 'TIME_LIMIT', hits: 0, safe: true });
    expect(f.states).not.toContain('盾の突撃 CLOSE'); expect(go).toHaveBeenCalledTimes(1); f.close();
  });
  it('still refuses a partial floor for CLOSE and uses go only for the resulting retreat', async () => {
    const f = outsideField(8), read = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => {
      const b = read(p);
      return Math.floor(p.x) === 1 && Math.floor(p.y) === 63 ? { ...b, name: 'stone_slab', shapes: [[0, 0, 0, 1, 0.5, 1]] } : b;
    };
    f.mob.metadata[0] = 1; setTimeout(() => { f.mob.metadata[0] = 0; }, 100);
    arriveOutside(f);
    expect((await run(f)).shieldRush).toMatchObject({ code: 'NO_ATTACK_WINDOW', hits: 0, safe: true });
    expect(f.states).not.toContain('盾の突撃 CLOSE'); expect(go).toHaveBeenCalledTimes(1); f.close();
  });
  it.each(['shooter', 'projectile', 'burning', 'floor', 'head'])('rechecks %s after go reports arrival', async hazard => {
    const f = outsideField(8); f.bot.health = 14;
    vi.mocked(go).mockImplementationOnce(async (ctx, a) => {
      const p = ctx.bot.entity.position = new Vec3(a.goals[0].x, a.goals[0].y, a.goals[0].z);
      delete ctx.bot.entities[41];
      if (hazard === 'shooter') ctx.bot.entities[42] = { ...f.mob, id: 42, position: p.offset(-3, 0, 0) };
      if (hazard === 'projectile') ctx.bot.entities[90] = { id: 90, name: 'small_fireball', type: 'projectile', position: p.offset(2, 0.9, 0), velocity: new Vec3(-0.4, 0, 0) };
      if (hazard === 'burning') ctx.bot.entity.metadata[0] = 1;
      if (hazard === 'floor') f.blocks.set('-17,63,0', 'air');
      if (hazard === 'head') f.blocks.set('-17,65,0', 'stone');
      return { ok: true, text: 'go 着いた' };
    });
    expect((await run(f)).shieldRush).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', safe: false }); f.close();
  });
  it('permits a reflex release during go and restores the writer after a thrown stop', async () => {
    const f = outsideField(8); f.bot.health = 14;
    const release = f.bot.deactivateItem;
    vi.mocked(go).mockImplementationOnce(async ctx => {
      f.stop.abort('floor-flee'); ctx.bot.deactivateItem(); throw new StepStopped('floor-flee');
    });
    expect((await run(f)).shieldRush).toMatchObject({ status: 'cut', code: 'REFLEX', safe: false });
    expect(release).toHaveBeenCalledTimes(1); expect(f.bot.deactivateItem).toBe(release); f.close();
  });
  it('keeps the in-area BFS rejection of a stair corridor, without calling go', async () => {
    const f = outsideField(), start = f.bot.entity.position.clone(), keys = vi.spyOn(f.bot, 'setControlState');
    f.args.retreatTo.x = -7.5;
    expect((await run(f)).shieldRush).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', hits: 0, safe: false,
      at: { x: start.x, y: start.y, z: start.z } });
    expect(f.bot.entity.position.equals(start)).toBe(true); expect(keys).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled(); f.close();
  });
  it('keeps the shield through go when act supplies an owned motor port', async () => {
    const f = outsideField(); f.mob.health = 5; f.args.pickup = 'none'; installShieldBlock(f.bot);
    vi.mocked(go).mockImplementationOnce(async (ctx, a) => {
      expect(ctx.bot).not.toBe(f.bot);
      expect(f.bot.shieldBlock.enabled).toBe(false);
      ctx.bot.deactivateItem(); expect(f.bot.usingHeldItem).toBe(true);
      ctx.bot.entity.position = new Vec3(a.goals[0].x, a.goals[0].y, a.goals[0].z);
      return { ok: true, text: 'go 着いた' };
    });
    f.mob.metadata[0] = 1; setTimeout(() => { f.mob.metadata[0] = 0; }, 100);
    const hands = ACT_HANDS.parse([{ do: 'attack', style: 'shield_rush', ...f.args }]);
    const result = await settle(executeAction(f.bot, 'act', 60_000, () => runAct(createMotorPort(f.bot), hands), { waitForQuiescence: true }));
    expect(JSON.parse(result.result as string).lines[0].shieldRush).toMatchObject({ status: 'killed', hits: 1, safe: true });
    expect(go).toHaveBeenCalledTimes(1); f.close();
  });
});

describe('closing phase and terrain readings', () => {
  it('retains charge over lost sight and unloading, and requires an observed end of burst', () => {
    const f = field(8), w = new RushShooterWatch(f.bot), p = f.bot.entity.position;
    w.update(Date.now()); expect(w.mayClose(p, Date.now())).toBe(false);
    f.mob.metadata[0] = 1; w.update(Date.now());
    delete f.bot.entities[41]; w.update(Date.now());
    f.bot.entities[41] = f.mob; w.update(Date.now()); expect(w.mayClose(p, Date.now())).toBe(false);
    f.mob.metadata[0] = 0; w.update(Date.now()); expect(w.mayClose(p, Date.now())).toBe(true);
    expect(w.mayClose(p, Date.now() + 5000)).toBe(false); f.close();
  });
  it('does not close into a shot still flying after the charge flag fell', () => {
    const f = field(8), w = new RushShooterWatch(f.bot), p = f.bot.entity.position;
    f.mob.metadata[0] = 1; w.update(Date.now()); f.mob.metadata[0] = 0;
    f.bot.entities[90] = { id: 90, name: 'small_fireball', type: 'projectile', position: new Vec3(6, 65, 0.5), velocity: new Vec3(-0.4, 0, 0) };
    w.update(Date.now()); expect(w.mayClose(p, Date.now())).toBe(false);
    delete f.bot.entities[90]; w.update(Date.now()); expect(w.incoming().length).toBeGreaterThan(0); f.close();
  });
  it('does not mistake an unseen new shooter for a safe phase', () => {
    const f = field(8), w = new RushShooterWatch(f.bot);
    w.update(Date.now()); f.mob.metadata[0] = 1; w.update(Date.now()); f.mob.metadata[0] = 0; w.update(Date.now());
    f.bot.entities[42] = { ...f.mob, id: 42, metadata: [0], position: new Vec3(4, 64, 4) }; w.update(Date.now());
    expect(w.mayClose(f.bot.entity.position, Date.now())).toBe(false); f.close();
  });
  it('requires the independent bursts of all visible shooters to finish', () => {
    const f = field(8), w = new RushShooterWatch(f.bot), p = f.bot.entity.position;
    f.mob.metadata[0] = 1;
    f.bot.entities[42] = { ...f.mob, id: 42, metadata: [1], position: new Vec3(5, 64, 4) };
    w.update(Date.now()); f.mob.metadata[0] = 0; w.update(Date.now());
    expect(w.mayClose(p, Date.now())).toBe(false);
    f.bot.entities[42].metadata[0] = 0; w.update(Date.now()); expect(w.mayClose(p, Date.now())).toBe(true); f.close();
  });
  it('refuses unknown floor, holes, unsafe knockback directions and points outside area', () => {
    const f = field(), s = new RushSpace(f.bot, f.args.area), p = f.bot.entity.position;
    expect(s.stand(p)).toBe(true); f.blocks.set('0,63,0', null); expect(s.stand(p)).toBe(false);
    f.blocks.delete('0,63,0'); f.blocks.set('-1,63,0', 'air'); expect(s.braced(p, [f.mob])).toBe(false);
    expect(s.stand(new Vec3(30, 64, 0.5))).toBe(false); f.close();
  });
  it('validates every required permission and rejects legacy controls and non-id targets', () => {
    const f = field(); expect(shieldRushProblem(f.args)).toBeNull();
    for (const key of Object.keys(f.args)) { const a = { ...f.args } as any; delete a[key]; expect(shieldRushProblem(a)).not.toBeNull(); }
    for (const extra of [{ hold: true }, { untilDead: true }, { rel: true }, { range: 3 }, { target: 'blaze' }, { seconds: Infinity }, { seconds: 0 }]) expect(shieldRushProblem({ ...f.args, ...extra })).not.toBeNull();
    f.close();
  });
});
