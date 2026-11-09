import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelActiveActions, createBedBurstMotor, createMotorPort, executeAction, motorOpsOf, recentMotorOps } from '../../src/services/minebot/execution/ActionExecution.js';
import { bedBurstOnOwnedMove, bedBurstWorld } from '../../src/services/minebot/utils/bedBurstRuntime.js';
import { NativeGoalEvidence } from '../../src/services/minebot/integration/commonFca/goalEvidence.js';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer');
const codec = createSerializer({ version: '1.21.11', state: 'play', isServer: false });
const parser = createDeserializer({ version: '1.21.11', state: 'play', isServer: true });
const foot = { x: 3, y: 65, z: 3 }, head = { x: 3, y: 65, z: 2 };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ok = { success: true, result: 'ok' };
function rig() {
  const writes: any[] = [];
  let inMove = false;
  const client: any = new EventEmitter();
  client.write = vi.fn((name, params) => { const bytes = codec.createPacketBuffer({ name, params });
    expect(parser.parsePacketBuffer(bytes).data.name).toBe(name); writes.push({ name, params, inMove }); });
  const target = { id: 17, name: 'ender_dragon', uuid: 'one', position: new Vec3(3, 65, 3), yaw: 0, metadata: { 16: 3 } };
  const bot: any = Object.assign(new EventEmitter(), { _client: client, entities: { 17: target }, health: 20, food: 20,
    game: { dimension: 'minecraft:the_end' }, entity: { id: 1, position: new Vec3(3.5, 62, 6.5), yaw: 2, pitch: 0, onGround: true },
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
    setControlState: vi.fn(), look: vi.fn(async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; }),
    attack: vi.fn(), activateBlock: vi.fn(), blockAt: () => ({ name: 'air' }), inventory: { items: () => [] },
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() } });
  const emit = bot.emit;
  bot.emit = function(event: string, ...args: any[]) { const before = inMove; if (event === 'move') inMove = true;
    try { return emit.call(this, event, ...args); } finally { inMove = before; } };
  const write = client.write, world = bedBurstWorld(bot);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await flush(); } };
  return { bot, target, client, write, writes, world, tick };
}
afterEach(() => { vi.useRealTimers(); });

describe('owned production bed burst raw motor', () => {
  it('refuses unowned, query and safety owners, and counts only completed writes', async () => {
    const r = rig();
    expect(() => createBedBurstMotor(r.bot, foot, head, () => null)).toThrow('owned act');
    await executeAction(r.bot, 'state', 0, async () => { expect(() => createBedBurstMotor(r.bot, foot, head, () => null)).toThrow(); return ok; });
    await executeAction(r.bot, 'act', 0, async () => {
      const motor = createBedBurstMotor(r.bot, foot, head, () => null);
      r.write.mockImplementationOnce(() => { throw Error('broken'); });
      expect(() => motor.position()).toThrow('broken'); expect(motorOpsOf(r.bot)).toBe(0);
      motor.position(); motor.burst(1, Math.PI / 2, -.25, r.world.tick, () => {});
      expect(motorOpsOf(r.bot)).toBe(5); motor.close(); return ok;
    });
    expect(recentMotorOps(r.bot).map(p => p.op)).toEqual(['bed_burst.position', 'bed_burst.unsneak', 'bed_burst.look', 'bed_burst.place', 'bed_burst.use']);
    expect(r.writes[2].params.yaw).toBe(90); r.world.stop();
  });
  it.each(['cancel', 'completed', 'death', 'respawn', 'spawn', 'game', 'dimension', 'entity', 'client'])(
    'never lends captured raw ownership across %s', async cause => {
      const r = rig(); let motor: ReturnType<typeof createBedBurstMotor>;
      await executeAction(r.bot, 'act', 0, async () => {
        motor = createBedBurstMotor(r.bot, foot, head, () => null);
        if (cause === 'cancel') cancelActiveActions(r.bot);
        else if (['death', 'respawn', 'spawn', 'game'].includes(cause)) r.bot.emit(cause);
        else if (cause === 'dimension') r.bot.game.dimension = 'overworld';
        else if (cause === 'entity') r.bot.entity = { ...r.bot.entity };
        else if (cause === 'client') r.bot._client = { write: vi.fn() };
        if (cause !== 'completed') expect(() => motor.position()).toThrow();
        return ok;
      });
      expect(() => motor!.position()).toThrow(); expect(r.writes).toEqual([]); motor!.close(); r.world.stop();
    });
  it('rechecks a reentrant abort between raw look and place', async () => {
    const r = rig(), original = r.client.write;
    r.client.write = function(name: string, data: any) { const result = original.call(this, name, data); if (name === 'look') cancelActiveActions(r.bot); return result; };
    await executeAction(r.bot, 'act', 0, async () => {
      const motor = createBedBurstMotor(r.bot, foot, head, () => null);
      expect(() => motor.burst(1, 0, 0, r.world.tick, () => {})).toThrow('owner expired'); motor.close(); return ok;
    });
    expect(r.writes.map(w => w.name)).toEqual(['player_input', 'look']); r.world.stop();
  });
  it('sends an indivisible explicit-rotation burst after a real position, then confirms its explosion', async () => {
    const r = rig(); let evidence: any;
    const run = executeAction(r.bot, 'act', 0, async () => {
      evidence = await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world, { foot, head, previousDetonationTick: null,
        until: Date.now() + 2000, signal: new AbortController().signal, fence: () => null, check: () => null, ready: () => true }); return ok;
    });
    await flush(); await r.tick();
    expect(r.writes.map(w => w.name)).toEqual(['position', 'player_input', 'look', 'block_place', 'block_place']);
    expect(r.writes.filter(w => w.name !== 'position').every(w => w.inMove)).toBe(true);
    r.client.emit('explosion', { center: { x: head.x + .5, y: head.y + .5, z: head.z + .5 } }); await r.tick(4); await run;
    expect(evidence).toMatchObject({ useTick: 1, detonationTick: 1, classification: { used: 'explosion_confirmed' } });
    expect(evidence.sent.every((p: any) => p.written && p.tick === 1)).toBe(true); r.world.stop();
  });
  it('waits eleven receipt ticks and fences an incoming teleport until a later settled tick', async () => {
    const r = rig(); const run = executeAction(r.bot, 'act', 0, async () => {
      const e = await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world, { foot, head, previousDetonationTick: 0,
        until: Date.now() + 2000, signal: new AbortController().signal, fence: () => null, check: () => null, ready: () => true });
      expect(e.useTick).toBe(13); return ok;
    });
    await flush(); await r.tick(10); expect(r.writes).toEqual([]);
    r.client.emit('position', { teleportId: 7 }); await r.tick(2); expect(r.writes).toEqual([]);
    r.client.write('teleport_confirm', { teleportId: 7 });
    r.client.write('position', { x: 3.5, y: 62, z: 6.5, flags: { onGround: true, hasHorizontalCollision: false } });
    r.bot.emit('move'); expect(r.writes.filter(w => w.name === 'block_place')).toHaveLength(0);
    await r.tick(); r.client.emit('explosion', { center: { x: 3.5, y: 65.5, z: 2.5 } }); await r.tick(4); await run; r.world.stop();
  });
  it('does not promote a use receipt to explosion or let cancellation callbacks write later', async () => {
    const r = rig(); const control = new AbortController(); let e: any;
    const run = executeAction(r.bot, 'act', 0, async () => { e = await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world,
      { foot, head, previousDetonationTick: null, until: Date.now() + 2000, signal: control.signal, fence: () => null, check: () => null, ready: () => true }); return ok; });
    await flush(); await r.tick(); control.abort('reflex'); await run; const n = r.writes.length; await r.tick(5);
    expect(r.writes).toHaveLength(n); expect(e).toMatchObject({ useTick: 1, detonationTick: null, observationInterrupted: 'reflex' }); r.world.stop();
  });
  it('settles its listeners immediately when the captured owner is cancelled, even with a separate hand signal', async () => {
    const r = rig(); let observed: any;
    const run = executeAction(r.bot, 'act', 0, async () => { observed = await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world,
      { foot, head, previousDetonationTick: null, until: Date.now() + 2000, signal: new AbortController().signal,
        fence: () => null, check: () => null, ready: () => false }); return ok; });
    await flush(); cancelActiveActions(r.bot, 'floor-dragon'); await run; await flush();
    expect(observed).toMatchObject({ useTick: null, observationInterrupted: 'floor-dragon' }); expect(r.writes).toEqual([]);
    expect(r.bot.listenerCount('move')).toBe(0); expect(r.client.listenerCount('explosion')).toBe(0); r.world.stop();
  });
  it('records a wrong-facing bed without converting its explosion to a valid burst orientation', async () => {
    const r = rig(); let e: any;
    const run = executeAction(r.bot, 'act', 0, async () => { e = await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world,
      { foot, head, previousDetonationTick: null, until: Date.now() + 2000, signal: new AbortController().signal,
        fence: () => null, check: () => null, ready: () => true }); return ok; });
    await flush(); await r.tick();
    r.bot.emit('blockUpdate', null, { name: 'blue_bed', position: foot, getProperties: () => ({ part: 'foot', facing: 'east' }) });
    r.client.emit('explosion', { center: { x: 4.5, y: 65.5, z: 3.5 } }); await r.tick(4); await run;
    expect(e).toMatchObject({ detonationTick: 1, orientationMismatch: true, classification: { orientation: 'mismatch' } }); r.world.stop();
  });
  it('keeps real packet timestamps and byte/degree yaw units; physics and velocity never forge a fresh pose', async () => {
    const r = rig(), d = r.world.dragon(17)!; await r.tick(3);
    r.client.emit('sync_entity_position', { entityId: 17, yaw: 180, dx: 0, dy: 0, dz: .2 });
    expect(d.history.at(-1)).toMatchObject({ tick: 3, yaw: 0 }); await r.tick(2); expect(d.history).toHaveLength(1);
    r.client.emit('entity_velocity', { entityId: 17, velocityX: 0, velocityY: 800, velocityZ: 1600 });
    expect(d.history.at(-1)).toMatchObject({ tick: 3, velocityTick: 5, velocity: { x: 0, y: .1, z: .2 } });
    r.client.emit('entity_look', { entityId: 17, yaw: 64 }); await r.tick(); r.client.emit('rel_entity_move', { entityId: 17 });
    expect(d.history.at(-1)?.yaw).toBeCloseTo(Math.PI / 2); expect(d.history.at(-1)?.tick).toBe(6); r.world.stop();
  });
  it('dispatches a natural move once and ignores the queued stationary trigger and repeated moves in that receipt tick', async () => {
    const r = rig(); const run = executeAction(r.bot, 'act', 0, async () => {
      await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world, { foot, head, previousDetonationTick: null, until: Date.now() + 2000,
        signal: new AbortController().signal, fence: () => null, check: () => null, ready: () => true }); return ok;
    });
    await flush(); r.bot.emit('physicsTick');
    r.client.write('position', { x: 3.5, y: 62, z: 6.5, flags: { onGround: true, hasHorizontalCollision: false } });
    r.bot.emit('move'); r.bot.emit('move'); await flush();
    expect(r.writes.filter(w => w.name === 'block_place')).toHaveLength(2);
    expect(r.writes.filter(w => w.name !== 'position').every(w => w.inMove)).toBe(true);
    r.client.emit('explosion', { center: { x: 3.5, y: 65.5, z: 2.5 } }); await r.tick(4); await run; r.world.stop();
  });
  it('does not recurse or duplicate clicks when the stationary position write reenters move', async () => {
    const r = rig(), original = r.write.getMockImplementation()!;
    r.write.mockImplementation((name: string, data: any) => { original(name, data); if (name === 'position') r.bot.emit('move'); });
    const run = executeAction(r.bot, 'act', 0, async () => {
      await bedBurstOnOwnedMove(createMotorPort(r.bot), r.world, { foot, head, previousDetonationTick: null, until: Date.now() + 2000,
        signal: new AbortController().signal, fence: () => null, check: () => null, ready: () => true }); return ok;
    });
    await flush(); await r.tick(); expect(r.writes.map(w => w.name)).toEqual(['position', 'player_input', 'look', 'block_place', 'block_place']);
    expect(r.writes.filter(w => w.name !== 'position').every(w => w.inMove)).toBe(true);
    r.client.emit('explosion', { center: { x: 3.5, y: 65.5, z: 2.5 } }); await r.tick(4); await run; r.world.stop();
  });
});

describe('raw bed use is native, task-bound goal evidence', () => {
  const context = { scopeKey: 'owner', taskId: 'dragon-task', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 's1', generation: 1, goal: 'kill dragon', completionCondition: 'native proof' };
  const command = (patch = {}): any => ({ id: 'burst', context, connectionId: 'c1', deadlineAt: new Date(Date.now() + 5000).toISOString(), ...patch });
  it.each([false, true])('only a successful raw use under the captured task can support the later native death (task changed=%s)', async changed => {
    const r = rig(), evidence = new NativeGoalEvidence(r.bot); evidence.begin(command());
    await executeAction(r.bot, 'act', 0, async () => {
      const motor = createBedBurstMotor(r.bot, foot, head, () => null);
      if (changed) evidence.begin(command({ context: { ...context, taskId: 'other' } }));
      motor.burst(1, 0, 0, r.world.tick, () => {}); motor.close(); return ok;
    });
    expect(evidence.snapshot().boss.verified).toBe(false);
    r.client.emit('explosion', { center: { x: 3.5, y: 65.5, z: 2.5 } }); r.bot.emit('entityHurt', r.target); r.bot.emit('entityDead', r.target);
    expect(evidence.snapshot().boss.verified).toBe(!changed); if (!changed) expect(evidence.snapshot().boss.witness?.via).toContain('explosion');
    evidence.dispose(); r.world.stop();
  });
});
