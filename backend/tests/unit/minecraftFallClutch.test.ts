import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';
import { CLUTCH_REACH, clutchWanted, groundUnder, runFallClutch, scoopBack, scoopWanted, type FallBody, type FallMemory } from '../../src/services/minebot/utils/fallClutch.js';
import { actionSignal, createMotorPort, executeAction, preemptLowerPriorityActions } from '../../src/services/minebot/execution/ActionExecution.js';
import { installLife } from '../../src/services/minebot/utils/life.js';

// Keep this test independent of the dragon's readers/providers; no live world or service.
vi.mock('../../src/services/minebot/utils/dragonState.js', () => ({ isEnd: (bot: FallBody) => bot.game?.dimension === 'the_end' }));

const cube = [[0, 0, 0, 1, 1, 1]];
const cellKey = (v: Vec3) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const nextVy = (vy: number) => (vy - 0.08) * 0.98;
// Exercise the installed Mineflayer's empty-slot/LRU equip policy, including its bare-bot calls after awaits.
const injectInventory = createRequire(import.meta.url)('mineflayer/lib/plugins/simple_inventory.js') as (bot: any) => void;

/**
 * Local simulate/apply has already set P(N) when physicsTick fires (physics.js:81-82).
 * emit models physicsTick -> updatePosition/write position -> move, with no promise turn
 * between them. The server ray uses ONLY the last position packet, P(N-1) during physicsTick,
 * P(N) during move. This is an ordered packet model, not a server/latency test.
 */
function rig(top: (x: number, z: number) => number = () => 65, name = 'end_stone', waterDelayTicks = 1, rejectUse = false, positionPacket = 'position') {
  const water = new Map<string, Vec3>();
  const sends: Array<{ tick: number; eye: Vec3; source: Vec3 | null; reachable: boolean; pitch: number }> = [];
  const wire: Array<{ tick: number; name: string; position: Vec3 }> = [];
  const pending: Array<{ tick: number; source: Vec3 }> = [];
  let tick = 0;
  let serverPosition = new Vec3(0.5, 100, 0.5);
  let receiveItem = (name: string) => { bot.heldItem = { ...bot.heldItem, name }; };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 100, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: false, isInWater: false },
    game: { dimension: 'the_end' }, health: 20,
    heldItem: { name: 'water_bucket', slot: 37 }, quickBarSlot: 1,
    inventory: { items: () => [bot.heldItem] },
    look: vi.fn((_yaw: number, _pitch: number) => new Promise<void>(() => {})), // a look that never settles must not stall a pour
    lookAt: vi.fn(async () => undefined),
    blockAt: (p: Vec3) => {
      const c = p.floored(), wet = water.has(cellKey(c));
      const solid = c.y < top(c.x, c.z);
      return { name: wet ? 'water' : solid ? name : 'air', metadata: 0, boundingBox: solid ? 'block' : 'empty', shapes: solid ? cube : [] };
    },
    _client: { write: (_name: string, data: { x?: number; y?: number; z?: number; rotation?: { x: number; y: number } }) => {
      if (_name === 'position' || _name === 'position_look') serverPosition = new Vec3(data.x!, data.y!, data.z!);
      wire.push({ tick, name: _name, position: serverPosition.clone() });
      if (_name !== 'use_item') return;
      if (bot.heldItem.name !== 'water_bucket') return; // scoop-back is covered by minecraftDragonFight; count pours only
      const eye = serverPosition.offset(0, 1.62, 0);
      const yaw = Math.PI - (data.rotation?.x ?? 180) * Math.PI / 180;
      const pitch = -(data.rotation?.y ?? 0) * Math.PI / 180;
      const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      let source: Vec3 | null = null;
      for (let distance = 0; distance <= 4.5; distance += 0.005) {
        const at = eye.plus(direction.scaled(distance)), block = bot.blockAt(at);
        if (block.boundingBox === 'block') { source = at.floored().offset(0, 1, 0); break; }
      }
      sends.push({ tick, eye, source, reachable: source !== null, pitch });
      if (source && !rejectUse && bot.heldItem.name === 'water_bucket') {
        receiveItem('bucket');
        if (waterDelayTicks === 0) observe(source);
        else pending.push({ tick: tick + waterDelayTicks, source });
      }
    } },
    activateItem: () => bot._client.write('use_item', { rotation: { x: 180, y: 0 } }),
    deactivateItem: () => undefined,
  });
  const memory: FallMemory = {};
  function observe(source: Vec3) {
    const old = { ...bot.blockAt(source), position: source };
    water.set(cellKey(source), source);
    bot.emit('blockUpdate', old, { ...bot.blockAt(source), position: source });
  }
  const emit = () => {
    tick++;
    bot.emit('physicsTick');
    for (const update of pending.filter(update => update.tick === tick)) observe(update.source);
    const old = serverPosition.clone();
    const p = bot.entity.position;
    bot._client.write(positionPacket, { x: p.x, y: p.y, z: p.z });
    bot.emit('move', old);
  };
  const collisionTop = (p: Vec3) => {
    let highest = -Infinity;
    for (let x = Math.floor(p.x - 0.3 + 1e-6); x <= Math.floor(p.x + 0.3 - 1e-6); x++)
      for (let z = Math.floor(p.z - 0.3 + 1e-6); z <= Math.floor(p.z + 0.3 - 1e-6); z++) highest = Math.max(highest, top(x, z));
    return highest;
  };
  return { bot, memory, sends, water, emit, collisionTop, wire,
    setItemReceipt(receive: (name: string) => void) { receiveItem = receive; }, get tick() { return tick; } };
}

/** 843f814's physicsTick + predicted-eye decision, restricted to these flat, loaded full-cube fixtures.
 * The forecast, eye and rotation formula are copied from the old targetForPour; only bucket preparation is omitted. */
function legacyPhysicsPour(f: ReturnType<typeof rig>, floor: number) {
  const listener = () => {
    const b = f.bot.entity, v = b.velocity;
    if (b.onGround || v.y > -0.75) return;
    let feet = b.position.clone(), vy = v.y;
    for (let tick = 0; tick < 8; tick++) {
      vy = nextVy(vy); feet = feet.offset(v.x, vy, v.z);
      if (feet.y > floor) continue;
      const eye = b.position.offset(v.x, nextVy(v.y) + 1.62, v.z);
      const aim = new Vec3(Math.floor(feet.x) + 0.5, floor, Math.floor(feet.z) + 0.5).minus(eye);
      if (eye.y <= floor || aim.norm() > 4.4) return;
      const yaw = Math.atan2(-aim.x, -aim.z), pitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
      f.bot._client.write('use_item', { rotation: { x: (180 / Math.PI) * (Math.PI - yaw), y: -(180 / Math.PI) * pitch } });
      f.bot.removeListener('physicsTick', listener);
      return;
    }
  };
  f.bot.on('physicsTick', listener);
}

/** Real patched inventory + simple_inventory; the server model applies item receipts through actual slots. */
function nativeRig(bucketSlot = 37, full = false) {
  const f = rig(() => 65, 'end_stone', 0), bot: any = f.bot;
  const require = createRequire(import.meta.url), registry = require('prismarine-registry')('1.21.11');
  const write = bot._client.write;
  bot._client = Object.assign(new EventEmitter(), { write });
  Object.assign(bot, { registry, version: '1.21.11', supportFeature: (name: string) => registry.supportFeature(name),
    world: { getBlock: () => null }, players: {}, settings: {}, physicsEnabled: false, setQuickBarSlot: () => {} });
  require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
  injectInventory(bot);
  bot.quickBarSlot = 0;
  const Item = require('prismarine-item')(registry);
  const put = (slot: number, name: string) => bot._setSlot(slot, new Item(registry.itemsByName[name].id, 1));
  put(36, 'iron_sword'); put(38, 'stick');
  if (full) for (let slot = 37; slot <= 44; slot++) put(slot, 'cobblestone');
  put(bucketSlot, 'water_bucket');
  f.setItemReceipt(name => put(36 + bot.quickBarSlot, name));
  const packets: Array<{ name: string; data: any }> = [];
  bot._client.write = (name: string, data: any) => {
    if (['use_item', 'window_click', 'held_item_slot'].includes(name)) packets.push({ name, data });
    return write(name, data);
  };
  return { ...f, bot, packets, slots: bot.inventory.slots as any[], equip: vi.spyOn(bot, 'equip') };
}

function expectNoWorkListeners(f: ReturnType<typeof rig>) {
  for (const event of ['physicsTick', 'move', 'blockUpdate']) expect(f.bot.listenerCount(event)).toBe(0);
  // A bounded pending note has a life-only end invalidator, not a running clutch or any motor callback.
  expect(f.bot.listenerCount('end')).toBe(f.memory.scoop ? 1 : 0);
}

describe('current FCA life and patched native inventory boundaries', () => {
  it.each(['death', 'respawn', 'spawn', 'game', 'end'])('permanently closes a waiting clutch on %s and never restores a successor hand', async event => {
    vi.useFakeTimers();
    const f = nativeRig();
    const events = ['death', 'respawn', 'spawn', 'game', 'end', 'physicsTick', 'move', 'blockUpdate'];
    const residents = new Map(events.map(name => [name, f.bot.listenerCount(name)]));
    f.bot.entity.velocity.y = -1.6;
    const entity = f.bot.entity;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.equip).not.toHaveBeenCalled();
    expect(f.bot.heldItem.name).toBe('water_bucket');
    f.bot.health = 0; f.bot.emit(event); f.bot.health = 20;
    f.bot.setQuickBarSlot(2); // A new life/owner chose its own hand before the old continuation resumes.
    const packets = f.packets.length;
    entity.position.y = 67; entity.velocity.y = -2.4; f.emit();
    await vi.advanceTimersByTimeAsync(500);
    expect(await running).toMatchObject({ success: false });
    expect(f.bot.entity).toBe(entity); // Health recovery and the same Entity cannot revive the scope.
    expect(f.bot.quickBarSlot).toBe(2);
    expect(f.packets).toHaveLength(packets);
    expect(f.sends).toHaveLength(0);
    for (const name of events) expect(f.bot.listenerCount(name)).toBe(residents.get(name));
  });

  it.each(['entity', 'client', 'dimension'])('refuses silent %s replacement before the next move', async kind => {
    vi.useFakeTimers();
    const f = rig();
    f.bot.entity.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    if (kind === 'entity') f.bot.entity = { ...f.bot.entity, position: f.bot.entity.position.clone() };
    if (kind === 'client') f.bot._client = { ...f.bot._client };
    if (kind === 'dimension') f.bot.game.dimension = 'overworld';
    f.bot.entity.position.y = 67; f.emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(await running).toMatchObject({ success: false });
    expect(f.sends).toHaveLength(0);
  });

  it.each([false, true])('refuses a pack bucket with fullHotbar=%s without native equip, clicks or local slots/cursor mutation', async full => {
    vi.useFakeTimers();
    const f = nativeRig(20, full);
    f.bot.entity.velocity.y = -1.6;
    const before = f.slots.map(item => item ? { name: item.name, type: item.type, count: item.count } : null);
    const cursor = f.bot.inventory.selectedItem, hand = f.bot.heldItem;
    const click = vi.spyOn(f.bot, 'clickWindow');
    expect(clutchWanted(f.bot, f.memory, Date.now())).toBeNull();
    expect(await runFallClutch(f.bot, f.bot, f.memory)).toMatchObject({ success: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.equip).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
    expect(f.packets).toHaveLength(0);
    expect(f.slots.map(item => item ? { name: item.name, type: item.type, count: item.count } : null)).toEqual(before);
    expect(f.bot.inventory.selectedItem).toBe(cursor); expect(f.bot.heldItem).toBe(hand);
  });

  it('drops a poured note at the next life before a fresh scoop scope can use its old coordinates', async () => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 100);
    f.bot.entity.position.y = 67; f.bot.entity.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.memory.scoop).toMatchObject({ x: 0, y: 65, z: 0 });
    f.bot.health = 0; f.bot.emit('death'); f.bot.health = 20; f.bot.emit('respawn');
    await vi.advanceTimersByTimeAsync(0); await running;
    f.bot.entity.position.y = 65; f.bot.entity.onGround = true;
    f.bot.heldItem = { name: 'bucket', slot: 37 };
    f.water.set('0,65,0', new Vec3(0, 65, 0)); // Even if an identically placed source exists in the new life.
    const before = f.wire.length;
    expect(scoopWanted(f.bot, f.memory, Date.now())).toBe(false);
    expect(f.memory.scoop).toBeUndefined();
    expect(await scoopBack(f.bot, f.bot, f.memory)).toMatchObject({ success: true, scooped: false });
    expect(f.wire).toHaveLength(before);
  });

  it('keeps the poured note after owner preemption in the same life', async () => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 0);
    f.bot.entity.position.y = 67; f.bot.entity.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0); f.emit();
    preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    await vi.advanceTimersByTimeAsync(0); await running;
    f.bot.entity.position.y = 65; f.bot.entity.onGround = true;
    expect(f.memory.scoop).toMatchObject({ x: 0, y: 65, z: 0 });
    expect(scoopWanted(f.bot, f.memory, Date.now())).toBe(true);
  });

  it('uses the existing keeper to reject a note when death occurs after the old scope already ended', async () => {
    vi.useFakeTimers();
    const folder = mkdtempSync(join(tmpdir(), 'clutch-life-'));
    const f = rig(() => 65, 'end_stone', 0);
    const life = installLife(f.bot, { file: join(folder, 'life.json'), key: () => 'clutch-fixture' });
    try {
      f.bot.entity.position.y = 67; f.bot.entity.velocity.y = -2.4;
      const running = executeAction(f.bot as never, 'floor-clutch', 8000,
        (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
        { priority: 380, safetyLease: true, waitForQuiescence: false });
      await vi.advanceTimersByTimeAsync(0); f.emit();
      preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
      await vi.advanceTimersByTimeAsync(0); await running;
      expect(f.memory.scoop).toBeDefined();
      f.bot.health = 0; f.bot.emit('death'); f.bot.health = 20; f.bot.emit('respawn'); f.bot.emit('spawn');
      f.bot.entity.position.y = 65; f.bot.entity.onGround = true;
      const writes = f.wire.length;
      expect(scoopWanted(f.bot, f.memory, Date.now())).toBe(false);
      expect(f.memory.scoop).toBeUndefined();
      await scoopBack(f.bot, f.bot, f.memory);
      expect(f.wire).toHaveLength(writes);
    } finally { life.dispose(); rmSync(folder, { recursive: true, force: true }); }
  });

  async function pendingWithoutKeeper() {
    const f = rig(() => 65, 'end_stone', 0);
    f.bot.entity.position.y = 67; f.bot.entity.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0); f.emit();
    preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    await vi.advanceTimersByTimeAsync(0); await running;
    f.bot.entity.position.y = 65; f.bot.entity.onGround = true;
    expect(f.memory.scoop).toBeDefined();
    expectNoWorkListeners(f);
    return f;
  }

  it('invalidates an idle pending note without a keeper, even after the old action already ended', async () => {
    vi.useFakeTimers();
    const f = await pendingWithoutKeeper(), entity = f.bot.entity;
    const writes = f.wire.length;
    f.bot.health = 0; f.bot.emit('death'); f.bot.health = 20; f.bot.emit('respawn'); f.bot.emit('spawn');
    expect(f.bot.entity).toBe(entity);
    expect(scoopWanted(f.bot, f.memory, Date.now())).toBe(false);
    await scoopBack(f.bot, f.bot, f.memory);
    expect(f.memory.scoop).toBeUndefined();
    expect(f.wire).toHaveLength(writes);
    for (const event of ['death', 'respawn', 'spawn', 'game', 'end']) expect(f.bot.listenerCount(event)).toBe(0);
  });

  it.each(['expire', 'consume', 'end'])('releases the bounded note-only invalidator on %s', async reason => {
    vi.useFakeTimers();
    const f = await pendingWithoutKeeper();
    if (reason === 'expire') await vi.advanceTimersByTimeAsync(90_001);
    if (reason === 'end') f.bot.emit('end');
    if (reason === 'consume') {
      f.bot.activateItem = () => { f.water.delete('0,65,0'); f.bot.heldItem = { name: 'water_bucket', slot: 37 }; };
      expect(await scoopBack(f.bot, f.bot, f.memory)).toMatchObject({ scooped: true });
    }
    expect(f.memory.scoop).toBeUndefined();
    for (const event of ['death', 'respawn', 'spawn', 'game', 'end']) expect(f.bot.listenerCount(event)).toBe(0);
  });

  it('replaces the idle note watcher without letting the old deadline delete a later source', async () => {
    vi.useFakeTimers();
    const f = await pendingWithoutKeeper(), old = f.memory.scoop!;
    await vi.advanceTimersByTimeAsync(6001);
    f.water.clear(); f.bot.heldItem = { name: 'water_bucket', slot: 37 };
    f.bot.entity.position = new Vec3(3.5, 67, .5); f.bot.entity.onGround = false;
    const running = runFallClutch(f.bot, f.bot, f.memory); f.emit();
    const next = f.memory.scoop!;
    expect(next).not.toBe(old); expect(next).toMatchObject({ x: 3, y: 65, z: 0 });
    f.bot.entity.position.y = 65; f.bot.entity.onGround = true;
    await vi.advanceTimersByTimeAsync(3000); await running;
    await vi.advanceTimersByTimeAsync(Math.max(0, old.at + 90_001 - Date.now()));
    expect(f.memory.scoop).toBe(next); expectNoWorkListeners(f);
    await vi.advanceTimersByTimeAsync(Math.max(0, next.at + 90_001 - Date.now()));
    expect(f.memory.scoop).toBeUndefined(); expectNoWorkListeners(f);
  });

  it('does not remove a successor packet wrapper installed synchronously during the use', async () => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 0);
    f.bot.entity.position.y = 67; f.bot.entity.velocity.y = -2.4;
    const received: unknown[] = [], original = f.bot._client.write;
    f.bot._client.write = (name, data) => {
      if (name === 'use_item') received.push(structuredClone(data));
      return original(name, data);
    };
    let successor: typeof f.bot._client.write;
    f.bot.activateItem = () => {
      const previous = f.bot._client.write;
      successor = (name, data) => previous(name, data);
      f.bot._client.write = successor;
      f.bot._client.write('use_item', { rotation: { x: 180, y: 0 } });
    };
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.bot._client.write).toBe(successor!);
    f.bot.entity.onGround = true;
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.bot._client.write).toBe(successor!);
    const nextUse = { hand: 1, sequence: 99, rotation: { x: 17, y: -33 } };
    f.bot.activateItem = () => f.bot._client.write('use_item', nextUse);
    const next = executeAction(f.bot as never, 'next-owner-use', 1000,
      (async () => { createMotorPort(f.bot).activateItem(); return { success: true, result: 'used' }; }) as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toMatchObject({ success: true });
    expect(f.bot._client.write).toBe(successor!);
    expect(received.at(-1)).toEqual(nextUse);
  });

  it('uses the patched 4.35 native activateItem while retaining hand/sequence and overriding a stale look with the current landing ray', async () => {
    vi.useFakeTimers();
    const f = nativeRig(), bot = f.bot, packets = f.packets;
    bot.entity.position.y = 67; bot.entity.velocity.y = -2.4;
    const running = runFallClutch(bot, bot, f.memory);
    f.emit();
    const use = packets.find(packet => packet.name === 'use_item')?.data;
    expect(use).toMatchObject({ hand: 0, sequence: 1, rotation: { y: 90 } });
    expect(Number.isFinite(use.rotation.x)).toBe(true); // Straight down has no unique yaw; the server-model ray below is the direction check.
    expect(f.sends[0]).toMatchObject({ reachable: true, source: { x: 0, y: 65, z: 0 } });
    bot.entity.position.y = 65; bot.entity.onGround = true;
    await vi.advanceTimersByTimeAsync(3000); await running;
  });
});

afterEach(() => { vi.useRealTimers(); });

describe('r224/r225 packet order and target water confirmation', () => {
  const replays = [
    { round: 224, oldTick: 2026, newTick: 2027, previousEyeHeight: 6.336308105325671, frames: [
      [2025, -5.194960240307605, 69.71630810532567, 7.975961519272122, 0.12327883979143109, -1.6208084776877505, -0.17530631025644572],
      [2026, -5.071681400516174, 68.09549962763792, 7.800655209015677, 0.12684056773525784, -1.6667923405743428, -0.18037119718291195],
      [2027, -4.944840832780916, 66.42870728706357, 7.620284011832765, 0.13008174016414017, -1.711856527080276, -0.18498024428599624],
      [2028, -4.814759092616776, 65, 7.435303767546769, 0.11837438354936757, -0.0784000015258789, -0.1683320223002566],
    ] },
    { round: 225, oldTick: 5882, newTick: 5883, previousEyeHeight: 8.598070386232152, frames: [
      [5881, 1.6041737753252698, 71.97807038623215, -1.7623803404050153, 0.04765928366461286, -2.4503554728747945, -0.2703021641418133],
      [5882, 1.6518330589898826, 69.52771491335736, -2.0326825045468286, 0.04779429835125807, -2.4797484116799993, -0.2710679071237672],
      [5883, 1.6996273573411407, 67.04796650167737, -2.303750411670596, 0.04791716171610521, -2.508553492269726, -0.2717647332373453],
      [5884, 1.7475445190572458, 65, -2.575515144907941, 0.04360461716165574, -0.0784000015258789, -0.24730590724598422],
    ] },
  ];

  it.each(replays)('r$round: legacy sends from P(N-1) out of reach; move sends from the first in-reach P(N)', async replay => {
    vi.useFakeTimers();
    for (const legacy of [true, false]) {
      const f = rig(), b = f.bot.entity;
      b.position.y = replay.frames[0][2]; b.velocity.y = replay.frames[0][5];
      let running: ReturnType<typeof runFallClutch> | undefined;
      if (legacy) legacyPhysicsPour(f, 65);
      else running = runFallClutch(f.bot, f.bot, f.memory);
      for (const [index, [, x, y, z, vx, vy, vz]] of replay.frames.entries()) {
        Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, vz), onGround: index === replay.frames.length - 1 });
        f.emit();
        await vi.advanceTimersByTimeAsync(50);
      }
      await vi.advanceTimersByTimeAsync(3000);
      const result = await running;
      expect(f.sends).toHaveLength(1);
      const send = f.sends[0], useIndex = f.wire.findIndex(p => p.name === 'use_item');
      expect(replay.frames[send.tick - 1][0]).toBe(legacy ? replay.oldTick : replay.newTick);
      expect(send.reachable).toBe(!legacy);
      if (legacy) {
        expect(send.eye.y - 65).toBeCloseTo(replay.previousEyeHeight, 10);
        expect(f.wire[useIndex - 1].tick).toBe(send.tick - 1);
        expect(f.wire[useIndex + 1]).toMatchObject({ name: 'position', tick: send.tick });
        expect(f.water.size).toBe(0);
      } else {
        expect(send.eye.distanceTo(send.source!.offset(0.5, 0, 0.5))).toBeLessThanOrEqual(CLUTCH_REACH);
        expect(f.wire[useIndex - 1]).toMatchObject({ name: 'position', tick: send.tick });
        expect(f.water.size).toBe(1);
        expect(f.memory.waterObserved).toHaveLength(1);
        expect(result?.result).toContain('waterObserved=あり');
      }
    }
  });

  it.each([0, 1, 2])('retains the target blockUpdate at %s tick(s), independently of the bucket slot update', async delay => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', delay), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.bot.heldItem.name).toBe('bucket'); // slot ACK alone is not water
    if (delay > 0) {
      expect(f.memory.waterObserved).toEqual([]);
      f.bot.emit('blockUpdate', null, null);
      f.bot.emit('blockUpdate', null, { name: 'water', position: new Vec3(1, 65, 0) });
      f.bot.emit('blockUpdate', null, { name: 'air', position: new Vec3(0, 65, 0) });
      expect(f.memory.waterObserved).toEqual([]);
    }
    for (let n = 0; n < delay; n++) f.emit();
    expect(f.memory.pour).toMatchObject({ x: 0, y: 65, z: 0, ticks: delay, status: 'water_observed' });
    expect(f.memory.waterObserved).toEqual([expect.objectContaining({ x: 0, y: 65, z: 0, ticks: delay })]);
    b.position.y = 65; b.onGround = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect((await running).result).toContain(`waterObserved=あり（${delay}tick後）`);
    expectNoWorkListeners(f);
  });

  it.each(['position', 'position_look'])('writes use after %s and never from physicsTick alone', async packet => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 1, false, packet), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.bot.emit('physicsTick');
    expect(f.sends).toHaveLength(0);
    f.emit();
    expect(f.wire.map(p => p.name)).toEqual([packet, 'use_item']);
    b.onGround = true; f.emit();
    await vi.advanceTimersByTimeAsync(3000); await running;
  });

  it('accepts a target water update after the second tick position/move, before the next physicsTick', async () => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 99), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); f.emit(); f.emit(); // pour, tick 1, tick 2; all in one JS turn
    expect(f.memory.pour?.status).toBe('sent_unconfirmed');
    const source = new Vec3(0, 65, 0);
    f.water.set(cellKey(source), source);
    f.bot.emit('blockUpdate', null, { name: 'water', position: source });
    expect(f.memory.pour).toMatchObject({ ticks: 2, status: 'water_observed' });
    b.position.y = 65; b.onGround = true;
    await vi.advanceTimersByTimeAsync(3000); await running;
  });

  it.each(['two_ticks', 'stalled', 'end', 'abort'])('reports unconfirmed water and cleans up after %s', async stop => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 1, true), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    if (stop === 'two_ticks') { f.emit(); f.emit(); f.emit(); } // next physicsTick closes the two completed tick intervals
    if (stop === 'stalled') await vi.advanceTimersByTimeAsync(151);
    if (stop === 'end') f.bot.emit('end');
    if (stop === 'abort') preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    // A late real update can exist without having been confirmed in the two-tick window.
    f.bot.emit('blockUpdate', null, { name: 'water', position: new Vec3(0, 65, 0) });
    b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(3000);
    const result = await running;
    expect(result.success).toBe(false);
    if (stop !== 'abort') expect(result.result).toContain('waterObserved=なし');
    expect(f.memory.pour?.status).toBe('sent_unconfirmed');
    expect(f.memory.waterObserved).toEqual([]);
    expectNoWorkListeners(f);
  });

  it('never pours on a grounded move even if the current eye is in reach', async () => {
    vi.useFakeTimers();
    const f = rig(); f.bot.entity.velocity.y = -3.9;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.bot.entity.position.y = 65; f.bot.entity.onGround = true; f.emit();
    expect(await running).toMatchObject({ success: false });
    expect(f.sends).toHaveLength(0); expect(f.memory.pour).toBeUndefined();
  });

  it('sends nothing when a stronger owner takes the body between physicsTick and its position/move', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0);
    f.bot.once('physicsTick', () => preemptLowerPriorityActions(f.bot, 500, 'wall-escape'));
    f.emit();
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(f.sends).toHaveLength(0);
    expect(f.memory.pour).toBeUndefined();
    expectNoWorkListeners(f);
  });
});

describe('airborne reach window skipped by fast falls', () => {
  it('quantifies uniform last-step phases for vy -2.0 .. -3.9 at 0.1 intervals (10000 phases each)', () => {
    const samples = 10000, window = CLUTCH_REACH - 1.62;
    const rows: Array<{ vy: number; misses: number; percent: number }> = [];
    for (let tenth = 20; tenth <= 39; tenth++) {
      const speed = tenth / 10;
      let misses = 0;
      for (let index = 0; index < samples; index++) {
        // Constant speed over the final step, vertical aim at the cell centre, uniformly spaced midpoint phases.
        const lastAirborneHeight = speed * (index + 0.5) / samples;
        const inReach = [lastAirborneHeight + speed, lastAirborneHeight, 0].some(height => height > 0 && height + 1.62 <= CLUTCH_REACH);
        if (!inReach) misses++;
      }
      const expected = Math.max(0, 1 - window / speed);
      expect(Math.abs(misses / samples - expected)).toBeLessThanOrEqual(1 / samples);
      rows.push({ vy: -speed, misses, percent: misses / samples * 100 });
    }
    console.info('fallClutch skipped-window simulation:', JSON.stringify(rows));
  });

  it.each([-2.0, -2.8, -3.0, -3.5, -3.9])('actual move hook at vy=%s sends only if an airborne in-reach sample exists', async vy => {
    vi.useFakeTimers();
    for (const clearance of [0.5, 2.5, 2.79, 3.2]) {
      if (clearance >= -vy) continue;
      const f = rig(), b = f.bot.entity;
      b.position.y = 65 + clearance - vy; b.velocity.y = vy;
      const running = runFallClutch(f.bot, f.bot, f.memory);
      f.emit();
      b.position.y = 65 + clearance; f.emit();
      const canPour = clearance + 1.62 <= CLUTCH_REACH;
      expect(f.sends).toHaveLength(canPour ? 1 : 0);
      b.position.y = 65; b.onGround = true; f.emit();
      await vi.advanceTimersByTimeAsync(3000); await running;
      expect(f.water.size).toBe(canPour ? 1 : 0);
    }
  });
});

describe('fall clutch after position packets (last received position model)', () => {
  const matrix = { cases: 0, placed: 0, skippedWindow: 0, legacyUses: 0, legacyRejected: 0 };
  afterAll(() => console.info('fallClutch height/velocity matrix:', JSON.stringify(matrix)));
  it('replays r214 fatal final ticks: centre top 64, collision top 65; the old 4.2 check has no airborne sample', async () => {
    vi.useFakeTimers();
    const f = rig((_x, z) => z >= 2 ? 65 : 64, 'bedrock');
    const frames = [
      [-1.4725474993075245, 69.2468094052377, 2.0584381423203593, -2.364348011203669],
      [-1.257598274267116, 66.88246139403402, 1.8906578407404178, -2.3954610976018342],
      [-1.0419088755679375, 65, 1.722299790812388, -0.0784000015258789],
    ];
    Object.assign(f.bot.entity, { position: new Vec3(...frames[0].slice(0, 3) as [number, number, number]), velocity: new Vec3(0.214949225, frames[0][3], -0.167780302) });
    const running = runFallClutch(f.bot, f.bot, f.memory);
    const oldReach: number[] = [];
    for (const [i, [x, y, z, vy]] of frames.entries()) {
      Object.assign(f.bot.entity, { position: new Vec3(x, y, z), velocity: new Vec3(0.214949225, vy, -0.167780302), onGround: i === 2 });
      const ground = groundUnder(bodyReader(f.bot as never), f.bot.entity.position);
      if (i < 2) oldReach.push(y + 1.62 - ground.top);
      if (i === 1) { expect(ground.top).toBe(64); expect(f.collisionTop(f.bot.entity.position)).toBe(65); }
      f.emit();
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(oldReach).toEqual([5.866809405237703, 4.502461394034029]);
    expect(oldReach.every(distance => distance > 4.2)).toBe(true);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tick: 2, reachable: true, source: { y: 65 } });
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
  });

  const heights = [10, 15, 20, 30, 40, 50, 65, 80, 100, 110, 120, 150, 175, 200];
  for (const floor of [{ name: 'end_stone', top: 65 }, { name: 'bedrock', top: 68 }, { name: 'bedrock', top: -17 }]) {
    it.each(heights)(`${floor.name} top ${floor.top}: %dm fall, six initial velocities and three sub-block phases`, async height => {
      vi.useFakeTimers();
      for (const up of [0, 0.15, 0.3, -1, -2, -3.9]) for (const fraction of [0, 0.25, 0.75]) {
        const f = rig(() => floor.top, floor.name), b = f.bot.entity;
        const old = rig(() => floor.top, floor.name);
        legacyPhysicsPour(old, floor.top);
        b.position.y = floor.top + height + fraction; b.velocity.y = up;
        f.memory.from = b.position.y;
        // Both servers start knowing the configured P(0), including 10m falls with a fast initial descent.
        for (const initial of [f, old]) initial.bot._client.write('position', { x: b.position.x, y: b.position.y, z: b.position.z });
        let running: Promise<unknown> | undefined, landingTick = -1, firstOpportunity = -1;
        for (let n = 0; n < 220 && !b.onGround; n++) {
          b.position = b.position.plus(b.velocity);
          b.velocity.y = nextVy(b.velocity.y);
          if (b.position.y <= floor.top) { b.position.y = floor.top; b.onGround = true; landingTick = f.tick + 1; }
          b.isInWater = f.water.has(cellKey(b.position));
          if (!running && clutchWanted(f.bot, f.memory, Date.now())) running = runFallClutch(f.bot, f.bot, f.memory);
          const currentEyeToFloor = b.position.y + 1.62 - floor.top;
          if (running && firstOpportunity < 0 && !b.onGround && b.velocity.y <= -0.75 && currentEyeToFloor <= CLUTCH_REACH) firstOpportunity = f.tick + 1;
          Object.assign(old.bot.entity, { position: b.position.clone(), velocity: b.velocity.clone(), onGround: b.onGround });
          old.emit();
          f.emit();
          await vi.advanceTimersByTimeAsync(50);
        }
        await vi.advanceTimersByTimeAsync(3000);
        await running;
        expect(running, `height=${height}+${fraction}, up=${up}`).toBeDefined();
        expect(f.sends.length, `height=${height}+${fraction}, up=${up}`).toBe(firstOpportunity < 0 ? 0 : 1);
        if (firstOpportunity >= 0) {
          expect(f.sends[0].reachable).toBe(true);
          expect(f.sends[0].tick).toBe(firstOpportunity);
          expect(f.sends[0].tick).toBeLessThan(landingTick);
          const packet = f.wire.findIndex(p => p.name === 'use_item');
          expect(f.wire[packet - 1]).toMatchObject({ name: 'position', tick: firstOpportunity });
          expect(f.memory.pour?.status).toBe('water_observed');
        }
        expect(f.water.has(`${0},${floor.top},${0}`)).toBe(firstOpportunity >= 0);
        expect(old.sends.every(send => !send.reachable)).toBe(true);
        expect(old.water.size).toBe(0);
        matrix.cases++;
        if (firstOpportunity < 0) matrix.skippedWindow++; else matrix.placed++;
        matrix.legacyUses += old.sends.length;
        matrix.legacyRejected += old.sends.filter(send => !send.reachable).length;
        expect(f.bot.listenerCount('physicsTick')).toBe(0);
        expect(f.bot.listenerCount('move')).toBe(0);
        expect(f.bot.listenerCount('blockUpdate')).toBe(0);
      }
    });
  }

  it('aims into r214 short fall landing cell (-9,65,6), not the departing cell (-10,65,6)', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const frames = [
      [-9.221670258672425, 68.6866159854884, 6.287110262967512, -0.9370638919468484, 0.068545352989073],
      [-9.153124905683352, 67.74955209354155, 6.274112598121848, -0.9967226335068657, 0.087410182687525],
      [-9.065714722995827, 66.75282946003469, 6.257537758119902, -1.055188201373583, 0.104577177713116],
      [-8.96113754528271, 65.69764125866111, 6.237707688725741, -1.112484458998108, 0.120199143186402],
      [-8.840938402096308, 65, 6.214915360584664, 0, 0],
    ];
    b.position = new Vec3(frames[0][0], frames[0][1], frames[0][2]);
    const running = runFallClutch(f.bot, f.bot, f.memory);
    for (const [i, [x, y, z, vy, vx]] of frames.entries()) {
      Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, -0.013), onGround: i === frames.length - 1 });
      f.emit(); await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tick: 3, reachable: true, source: { x: -9, y: 65, z: 6 } });
    expect(f.sends[0].pitch).toBeGreaterThan(-Math.PI / 2); // diagonal aim across the cell edge
    expect(f.memory.scoop).toMatchObject({ x: -9, y: 65, z: 6 });
  });

  it('aims at r212 raised bedrock top 68 and waits until tick 14136 is sent', async () => {
    vi.useFakeTimers();
    const f = rig((x, z) => x === 0 && z === 0 ? 68 : 64, 'bedrock'), b = f.bot.entity;
    b.position = new Vec3(0.3445072988199184, 71.43550085849769, 0.9518799097836754);
    b.velocity = new Vec3(0.15232646703780214, -2.8293435153903577, -0.20614693381013469);
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); // 14135: current eye distance 5.0555, out of reach despite the prediction
    expect(f.sends).toHaveLength(0);
    b.position = new Vec3(0.49683376585772054, 68.60615734310733, 0.7457329759735407);
    f.emit();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tick: 2, reachable: true, source: { x: 0, y: 68, z: 0 } });
    b.onGround = true; b.position.y = 68;
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.sends).toHaveLength(1);
  });

  it('acts inside a catch-up move event, without waiting for promises or wall time; no duplicate use', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 80; b.velocity.y = -2.2;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.sends).toHaveLength(0);
    for (const y of [77, 74, 71, 69, 67]) { b.position.y = y; f.emit(); }
    expect(f.sends).toHaveLength(1); // still the same JS turn: an await-per-tick loop would have missed it
    expect(f.sends[0].tick).toBe(5);
    b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it('removes subscriptions on abort, and never pours through an expired motor port even at the urgent tick', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 90; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(1);
    preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    await vi.advanceTimersByTimeAsync(0);
    b.position.y = 69; f.emit();
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(f.sends).toHaveLength(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
    expect(f.memory.scoop).toBeUndefined();
  });

  it('uses the existing priority 380 lease to pre-empt a flee at 250, including an urgent pour', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const fleeing = executeAction(f.bot as never, 'floor-flee', 3000,
      (() => new Promise<void>(resolve => actionSignal(f.bot)?.addEventListener('abort', () => resolve(), { once: true }))) as never,
      { priority: 250, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(preemptLowerPriorityActions(f.bot, 380, 'floor-clutch')).toBe(true);
    expect(await fleeing).toMatchObject({ success: false, failureType: 'interrupted' });
    b.position.y = 67; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].reachable).toBe(true);
    b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(3000); await running;
  });

  it('does not send from an out-of-reach current position even when the prediction is in reach', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 69; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.sends).toHaveLength(0); // current eye 5.62m, next eye 3.1896m
    b.onGround = true; b.position.y = 65;
    f.emit();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await running).toMatchObject({ success: false });
    expect(f.water.size).toBe(0);
    expect(f.memory.scoop).toBeUndefined();
  });

  it('removes event handlers, its temporary packet wrapper and the scoop note when the use throws', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const original = f.bot._client.write;
    f.bot.activateItem = () => { throw new Error('fixture packet failure'); };
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    const rejected = expect(running).rejects.toThrow('fixture packet failure');
    f.emit(); await rejected;
    expect(f.bot._client.write).toBe(original);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
    expect(f.memory.scoop).toBeUndefined();
  });

  it.each(['end', 'timeout', 'dead', 'changed_hand'])('cleans up and does not pour on %s', async reason => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 90; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    if (reason === 'end') f.bot.emit('end');
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(8100);
    if (reason === 'dead') { f.bot.health = 0; f.emit(); }
    if (reason === 'changed_hand') { f.bot.heldItem = { name: 'diamond_sword', slot: 36 }; b.position.y = 67; f.emit(); }
    expect(await running).toMatchObject({ success: false });
    b.position.y = 69; f.emit();
    expect(f.sends).toHaveLength(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it.each(['lava', 'unknown', 'partial_cube'])('keeps the existing refusal for %s ground', async ground => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const original = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => {
      if (p.y < 65) {
        if (ground === 'unknown') return null as never;
        if (ground === 'lava') return { ...original(p), name: 'lava', boundingBox: 'empty', shapes: [] };
        return { ...original(p), shapes: [[0, 0, 0, 1, 0.5, 1]] };
      }
      return original(p);
    };
    b.position.y = 69; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); b.onGround = true; f.emit();
    expect(await running).toMatchObject({ success: false });
    expect(f.sends).toHaveLength(0);
  });
});
