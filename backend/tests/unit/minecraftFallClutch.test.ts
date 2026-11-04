import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';
import { clutchWanted, groundUnder, runFallClutch, type FallBody, type FallMemory } from '../../src/services/minebot/utils/fallClutch.js';
import { actionSignal, createMotorPort, executeAction, preemptLowerPriorityActions } from '../../src/services/minebot/execution/ActionExecution.js';

// Keep this test independent of the dragon's readers/providers; no live world or service.
vi.mock('../../src/services/minebot/utils/dragonState.js', () => ({ isEnd: (bot: FallBody) => bot.game?.dimension === 'the_end' }));

const cube = [[0, 0, 0, 1, 1, 1]];
const cellKey = (v: Vec3) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const nextVy = (vy: number) => (vy - 0.08) * 0.98;

/**
 * Tick model: velocity is blocks/tick, position += velocity, then gravity/drag.
 * A use is resolved with one movement's lead, as requested for the lab's packet ordering.
 * This is an explicit assumption, not a Minecraft server/latency test. The ray and 4.5m
 * reach are checked independently; an out-of-reach/misdirected use never creates water.
 */
function rig(top: (x: number, z: number) => number = () => 65, name = 'end_stone', movementLead = 1) {
  const water = new Map<string, Vec3>();
  const sends: Array<{ tick: number; eye: Vec3; source: Vec3 | null; reachable: boolean; pitch: number }> = [];
  let tick = 0;
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
    _client: { write: (_name: string, data: { rotation?: { x: number; y: number } }) => {
      if (bot.heldItem.name !== 'water_bucket') return; // scoop-back is covered by minecraftDragonFight; count pours only
      const b = bot.entity, v = b.velocity;
      const eye = b.position.offset(v.x * movementLead, nextVy(v.y) * movementLead + 1.62, v.z * movementLead);
      const yaw = Math.PI - (data.rotation?.x ?? 180) * Math.PI / 180;
      const pitch = -(data.rotation?.y ?? 0) * Math.PI / 180;
      const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      let source: Vec3 | null = null;
      for (let distance = 0; distance <= 4.5; distance += 0.005) {
        const at = eye.plus(direction.scaled(distance)), block = bot.blockAt(at);
        if (block.boundingBox === 'block') { source = at.floored().offset(0, 1, 0); break; }
      }
      sends.push({ tick, eye, source, reachable: source !== null, pitch });
      if (source && bot.heldItem.name === 'water_bucket') {
        water.set(cellKey(source), source);
        bot.heldItem = { name: 'bucket', slot: 37 };
      }
    } },
    activateItem: () => bot._client.write('use_item', { rotation: { x: 180, y: 0 } }),
    deactivateItem: () => undefined,
  });
  const memory: FallMemory = {};
  const emit = () => { tick++; bot.emit('physicsTick'); };
  const collisionTop = (p: Vec3) => {
    let highest = -Infinity;
    for (let x = Math.floor(p.x - 0.3 + 1e-6); x <= Math.floor(p.x + 0.3 - 1e-6); x++)
      for (let z = Math.floor(p.z - 0.3 + 1e-6); z <= Math.floor(p.z + 0.3 - 1e-6); z++) highest = Math.max(highest, top(x, z));
    return highest;
  };
  return { bot, memory, sends, water, emit, collisionTop, get tick() { return tick; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('fall clutch at physics ticks (one movement lead model)', () => {
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
    expect(f.sends[0]).toMatchObject({ tick: 1, reachable: true, source: { y: 65 } });
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
  });

  const heights = [10, 15, 20, 30, 40, 50, 65, 80, 100, 110, 120, 150, 175, 200];
  for (const floor of [{ name: 'end_stone', top: 65 }, { name: 'bedrock', top: 68 }, { name: 'bedrock', top: -17 }]) {
    it.each(heights)(`${floor.name} top ${floor.top}: %dm fall, upward 0/3/6m/s, three sub-block phases`, async height => {
      vi.useFakeTimers();
      for (const up of [0, 0.15, 0.3]) for (const fraction of [0, 0.25, 0.75]) {
        const f = rig(() => floor.top, floor.name), b = f.bot.entity;
        b.position.y = floor.top + height + fraction; b.velocity.y = up;
        let running: Promise<unknown> | undefined, landingTick = -1, firstOpportunity = -1;
        for (let n = 0; n < 220 && !b.onGround; n++) {
          b.position = b.position.plus(b.velocity);
          b.velocity.y = nextVy(b.velocity.y);
          if (b.position.y <= floor.top) { b.position.y = floor.top; b.onGround = true; landingTick = f.tick + 1; }
          b.isInWater = f.water.has(cellKey(b.position));
          if (!running && clutchWanted(f.bot, f.memory, Date.now())) running = runFallClutch(f.bot, f.bot, f.memory);
          const predictedEyeToFloor = b.position.y + nextVy(b.velocity.y) + 1.62 - floor.top;
          if (running && firstOpportunity < 0 && !b.onGround && b.velocity.y <= -0.75 && predictedEyeToFloor <= 4.4) firstOpportunity = f.tick + 1;
          f.emit();
          await vi.advanceTimersByTimeAsync(50);
        }
        await vi.advanceTimersByTimeAsync(3000);
        await running;
        expect(running, `height=${height}+${fraction}, up=${up}`).toBeDefined();
        expect(f.sends.length, `height=${height}+${fraction}, up=${up}`).toBe(1);
        expect(f.sends[0].reachable).toBe(true);
        expect(f.sends[0].tick).toBe(firstOpportunity);
        expect(f.sends[0].tick).toBeLessThan(landingTick);
        expect(f.water.has(`${0},${floor.top},${0}`)).toBe(true);
        expect(f.bot.listenerCount('physicsTick')).toBe(0);
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
    expect(f.sends[0]).toMatchObject({ tick: 1, reachable: true, source: { x: -9, y: 65, z: 6 } });
    expect(f.sends[0].pitch).toBeGreaterThan(-Math.PI / 2); // diagonal aim across the cell edge
    expect(f.memory.scoop).toMatchObject({ x: -9, y: 65, z: 6 });
  });

  it('aims at r212 raised bedrock top 68 and pours before the old tick 14136', async () => {
    vi.useFakeTimers();
    const f = rig((x, z) => x === 0 && z === 0 ? 68 : 64, 'bedrock'), b = f.bot.entity;
    b.position = new Vec3(0.3445072988199184, 71.43550085849769, 0.9518799097836754);
    b.velocity = new Vec3(0.15232646703780214, -2.8293435153903577, -0.20614693381013469);
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); // 14135: eye distance 5.0555; predicted 2.2043, vy <= -2
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ reachable: true, source: { x: 0, y: 68, z: 0 } });
    b.position = new Vec3(0.49683376585772054, 68.60615734310733, 0.7457329759735407);
    f.emit();
    b.onGround = true; b.position.y = 68;
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.sends).toHaveLength(1);
  });

  it('acts inside a catch-up physics event, without waiting for promises or wall time; no duplicate use', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 80; b.velocity.y = -2.2;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.sends).toHaveLength(0);
    for (const y of [77, 74, 71, 69, 67]) { b.position.y = y; f.emit(); }
    expect(f.sends).toHaveLength(1); // still the same JS turn: an await-per-tick loop would have missed it
    expect(f.sends[0].tick).toBe(4);
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
    b.position.y = 69; b.velocity.y = -2.4;
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

  it('does not claim a water landing when the server uses the current position instead of the assumed next one', async () => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 0), b = f.bot.entity;
    b.position.y = 69; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].reachable).toBe(false); // current eye 5.62m, next eye 3.1896m
    b.onGround = true; b.position.y = 65;
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
    b.position.y = 69; b.velocity.y = -2.4;
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
    if (reason === 'changed_hand') { f.bot.heldItem = { name: 'diamond_sword', slot: 36 }; b.position.y = 69; f.emit(); }
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
