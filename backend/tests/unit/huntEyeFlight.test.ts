import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { bearingOf, compassOf, flightVector, watchEyeFlight, EYE_BREAK_EVENT } from '../../src/services/minebot/utils/huntEyeFlight.js';
import { use } from '../../src/services/minebot/utils/primitives/use.js';
import { StepStopped, type StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// The thrown eye (S2, 2026-11-02): the flight is read from entitySpawn / entityMoved / entityGone, and how it ended from what the connection says next.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function eyeBot(origin = new Vec3(100.4, 70, -20.6)) {
  const client = new EventEmitter();
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', entity: { position: origin.clone(), yaw: 0, pitch: 0, onGround: true }, entities: {} as Record<string, any>, _client: client,
    heldItem: { name: 'ender_eye', count: 3 }, registry: {}, _eyes: 3,
    inventory: { items: () => (bot._eyes > 0 ? [{ name: 'ender_eye', count: bot._eyes }] : []), slots: [] },
    activateItem: () => undefined, deactivateItem: () => undefined,
  });
  return { bot, client };
}

/** What the server does with a thrown eye: it appears at the thrower's x and z, flies a line, is gone; then its item falls or a level event is sent. */
async function fly(bot: any, client: EventEmitter, options: { from?: Vec3; unit: { x: number; z: number }; flat: number; rise?: number; ending: 'drop' | 'shatter' | 'nothing'; id?: number; stepMs?: number }) {
  const id = options.id ?? 77, from = options.from ?? bot.entity.position;
  const eye: any = { id, name: 'eye_of_ender', position: new Vec3(from.x, from.y + 0.9, from.z) };
  bot.entities[id] = eye;
  bot._eyes--;
  bot.emit('entitySpawn', eye);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await sleep(options.stepMs ?? 8);
    eye.position = new Vec3(from.x + options.unit.x * options.flat * i / steps, from.y + 0.9 + (options.rise ?? 7.5) * i / steps, from.z + options.unit.z * options.flat * i / steps);
    bot.emit('entityMoved', eye);
  }
  delete bot.entities[id];
  bot.emit('entityGone', eye);
  if (options.ending === 'drop') {
    const item: any = { id: id + 1, name: 'item', position: new Vec3(eye.position.x + 0.3, eye.position.y - 6, eye.position.z), getDroppedItem: () => null };
    bot.entities[item.id] = item;
    bot.emit('entitySpawn', item);
    await sleep(15);
    item.getDroppedItem = () => ({ name: 'ender_eye', count: 1 });
    bot.emit('entityUpdate', item);
  } else if (options.ending === 'shatter') {
    client.emit('world_event', { effectId: EYE_BREAK_EVENT, location: { x: Math.floor(eye.position.x), y: Math.floor(eye.position.y), z: Math.floor(eye.position.z) }, data: 0, global: false });
  }
}

describe('the eye flight, as numbers', () => {
  it('the bearing is 0 for north (-z), 90 for east (+x), 180 for south, 270 for west', () => {
    expect(bearingOf(0, -1)).toBeCloseTo(0, 6);
    expect(bearingOf(1, 0)).toBeCloseTo(90, 6);
    expect(bearingOf(0, 1)).toBeCloseTo(180, 6);
    expect(bearingOf(-1, 0)).toBeCloseTo(270, 6);
    expect(compassOf(45)).toBe('北東');
    expect(compassOf(350)).toBe('北');
  });

  it('a flight has a unit vector and a bearing; one under a block sideways has none', () => {
    const north = flightVector({ x: 0, y: 70, z: 0 }, { x: 0, y: 78, z: -12 });
    expect(north.unit).toEqual({ x: 0, z: -1 });
    expect(north.bearingDeg).toBe(0);
    expect(north.flat).toBeCloseTo(12, 6);
    expect(north.rise).toBeCloseTo(8, 6);
    const diagonal = flightVector({ x: 10, y: 70, z: 10 }, { x: 10 + 8.485281, y: 75, z: 10 - 8.485281 });
    expect(diagonal.unit!.x).toBeCloseTo(0.70711, 4);
    expect(diagonal.unit!.z).toBeCloseTo(-0.70711, 4);
    expect(diagonal.bearingDeg).toBeCloseTo(45, 2);
    expect(flightVector({ x: 0, y: 70, z: 0 }, { x: 0.4, y: 62, z: 0.3 }).unit).toBeNull();
  });
});

describe('watchEyeFlight: the connection\'s own words', () => {
  it('follows the eye from its spawn to its going, and reads the item that fell as dropped', async () => {
    const { bot, client } = eyeBot();
    const watcher = watchEyeFlight(bot, { fateMs: 400 });
    const unit = { x: 0.6, z: -0.8 };
    void fly(bot, client, { unit, flat: 12, ending: 'drop' });
    expect(await watcher.spawned).toBe(true);
    const flight = (await watcher.flight)!;
    expect(flight.gone).toBe(true);
    expect(flight.fate).toBe('dropped');
    expect(flight.drop?.id).toBe(78);
    expect(flight.samples).toBe(12);
    expect(flight.origin).toEqual({ x: 100.4, y: 70, z: -20.6 });
    expect(flight.start.y).toBeCloseTo(70.9, 3);
    expect(flight.flat).toBeCloseTo(12, 2);
    expect(flight.unit!.x).toBeCloseTo(0.6, 4);
    expect(flight.unit!.z).toBeCloseTo(-0.8, 4);
    expect(flight.bearingDeg).toBeCloseTo(36.87, 1);
    expect(flight.overhead).toBe(false);
  });

  it('reads the level event 2003 near the eye as shattered', async () => {
    const { bot, client } = eyeBot();
    const watcher = watchEyeFlight(bot, { fateMs: 400 });
    void fly(bot, client, { unit: { x: 1, z: 0 }, flat: 12, ending: 'shatter' });
    const flight = (await watcher.flight)!;
    expect(flight.fate).toBe('shattered');
    expect(flight.drop).toBeUndefined();
    expect(flight.bearingDeg).toBeCloseTo(90, 2);
  });

  it('neither an item nor the event: the fate is unknown, not guessed (the pack\'s count fell either way)', async () => {
    const { bot, client } = eyeBot();
    const watcher = watchEyeFlight(bot, { fateMs: 80 });
    void fly(bot, client, { unit: { x: 0, z: 1 }, flat: 12, ending: 'nothing' });
    const flight = (await watcher.flight)!;
    expect(flight.gone).toBe(true);
    expect(flight.fate).toBe('unknown');
  });

  it('a level event far from the eye, an item of another kind and an item that lay about before are not this eye\'s end', async () => {
    const { bot, client } = eyeBot();
    const before: any = { id: 9, name: 'item', position: new Vec3(105, 60, -30), getDroppedItem: () => ({ name: 'ender_eye', count: 1 }) };
    bot.entities[9] = before;
    const watcher = watchEyeFlight(bot, { fateMs: 120 });
    void (async () => {
      await fly(bot, client, { unit: { x: 0, z: -1 }, flat: 12, ending: 'nothing' });
      client.emit('world_event', { effectId: EYE_BREAK_EVENT, location: { x: 400, y: 60, z: 400 }, data: 0, global: false });
      client.emit('world_event', { effectId: 2001, location: { x: 100, y: 78, z: -32 }, data: 0, global: false });
      const pearl: any = { id: 50, name: 'item', position: new Vec3(100.4, 70, -32), getDroppedItem: () => ({ name: 'ender_pearl', count: 1 }) };
      bot.entities[50] = pearl;
      bot.emit('entitySpawn', pearl);
    })();
    const flight = (await watcher.flight)!;
    expect(flight.fate).toBe('unknown');
  });

  it('an eye that appears farther than three blocks from the thrower is somebody else\'s, and no eye at all says so', async () => {
    const { bot } = eyeBot();
    const watcher = watchEyeFlight(bot, { spawnWaitMs: 120 });
    bot.emit('entitySpawn', { id: 5, name: 'eye_of_ender', position: new Vec3(110, 71, -20) });
    bot.emit('entitySpawn', { id: 6, name: 'ender_pearl', position: new Vec3(100.4, 70.9, -20.6) });
    expect(await watcher.spawned).toBe(false);
    expect(await watcher.flight).toBeNull();
  });

  it('a stronghold right below: the eye falls, no sideways flight, no unit vector, and it says overhead', async () => {
    const { bot, client } = eyeBot();
    const watcher = watchEyeFlight(bot, { fateMs: 200 });
    void fly(bot, client, { unit: { x: 0, z: 0 }, flat: 0, rise: -6, ending: 'drop' });
    const flight = (await watcher.flight)!;
    expect(flight.unit).toBeNull();
    expect(flight.bearingDeg).toBeNull();
    expect(flight.overhead).toBe(true);
  });

  it('cancel settles the watch and leaves no listener behind', async () => {
    const { bot, client } = eyeBot();
    const watcher = watchEyeFlight(bot, {});
    expect(bot.listenerCount('entityMoved')).toBe(1);
    watcher.cancel();
    expect(await watcher.flight).toBeNull();
    for (const event of ['entitySpawn', 'entityMoved', 'entityGone', 'entityUpdate', 'end']) expect(bot.listenerCount(event)).toBe(0);
    expect(client.listenerCount('world_event')).toBe(0);
  });
});

describe('use item=ender_eye (the hand)', () => {
  const context = (bot: any, stop = new AbortController()): StepContext => ({ bot, stop: stop.signal, deadline: Date.now() + 60_000, facing: 'north', base: { x: 100, y: 70, z: -21 } });

  it('throws the eye and returns the exact line: the position, the unit vector, the bearing, how it ended', async () => {
    const { bot, client } = eyeBot();
    bot.activateItem = () => { void fly(bot, client, { unit: { x: -0.28, z: -0.96 }, flat: 12, ending: 'drop' }); };
    const result = await use(context(bot), { item: 'ender_eye' });
    expect(result.ok).toBe(true);
    const eye = result.data!.eye!;
    expect(eye.origin).toEqual({ x: 100.4, y: 70, z: -20.6 });
    expect(eye.unit.x).toBeCloseTo(-0.28, 3);
    expect(eye.unit.z).toBeCloseTo(-0.96, 3);
    expect(eye.bearingDeg).toBeCloseTo(343.74, 1);
    expect(eye.flew).toBeCloseTo(12, 1);
    expect(eye.fate).toBe('dropped');
    expect(eye.broke).toBe(false);
    expect(eye.drop!.id).toBe(78);
    expect(eye.arrived).toBe(false);
    expect(eye.from).toEqual({ x: 100, y: 70, z: -21 });
    expect(result.text.length).toBeLessThanOrEqual(160);
    expect(result.text).toContain('343.74°');
    expect(result.text).toContain('落ちて残る#78');
    expect(result.text).toContain('残り2');
  });

  it('a shattered eye is broke:true, and a flight shorter than the far flight says it arrived at the stronghold itself', async () => {
    const { bot, client } = eyeBot();
    bot.activateItem = () => { void fly(bot, client, { unit: { x: 0, z: 1 }, flat: 7.5, ending: 'shatter' }); };
    const result = await use(context(bot), { item: 'ender_eye' });
    const eye = result.data!.eye!;
    expect(eye.fate).toBe('shattered');
    expect(eye.broke).toBe(true);
    expect(eye.arrived).toBe(true);
    expect(eye.bearingDeg).toBeCloseTo(180, 2);
    expect(result.text).toContain('割れた');
  });

  it('no eye leaves the hand: eye_not_thrown, and the hand is released', async () => {
    const { bot } = eyeBot();
    let released = 0;
    bot.deactivateItem = () => { released++; };
    const result = await use(context(bot), { item: 'ender_eye' });
    expect(result).toMatchObject({ ok: false, reason: 'eye_not_thrown' });
    expect(released).toBe(1);
  });

  it('a flight right above the stronghold has no bearing: ok, no eye in the data, and the text says overhead', async () => {
    const { bot, client } = eyeBot();
    bot.activateItem = () => { void fly(bot, client, { unit: { x: 0, z: 0 }, flat: 0, rise: -6, ending: 'drop' }); };
    const result = await use(context(bot), { item: 'ender_eye' });
    expect(result.ok).toBe(true);
    expect(result.data?.eye).toBeUndefined();
    expect(result.text).toContain('真下');
  });

  it('the act\'s stop ends the watch (StepStopped) and the listeners are removed', async () => {
    const { bot, client } = eyeBot();
    const stop = new AbortController();
    bot.activateItem = () => { void fly(bot, client, { unit: { x: 1, z: 0 }, flat: 12, ending: 'drop', stepMs: 40 }); setTimeout(() => stop.abort('test stop'), 60); };
    await expect(use(context(bot, stop), { item: 'ender_eye' })).rejects.toBeInstanceOf(StepStopped);
    expect(bot.listenerCount('entityMoved')).toBe(0);
  });
});
