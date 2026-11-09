import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim } from '../helpers/physicsBody.js';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';
import { closedWord } from '../../src/services/minebot/utils/actReport.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

it('tells the next decision that a swing without a hurt event was not a landed blow', async () => {
  const sim = makeSim((_x, y, _z) => y < 64 ? 'stone' : 'air');
  const fish = { id: 7, name: 'salmon', type: 'mob', position: new Vec3(0.5, 64, 0.5), height: 0.3, width: 0.5 };
  sim.bot.entities[7] = fish;
  sim.bot.pathfinder.setGoal = vi.fn();
  sim.bot.pathfinder.setMovements = vi.fn();
  sim.bot.attack = vi.fn(() => { fish.position = new Vec3(40, 64, 0.5); });
  const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 8000,
    facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 7, maxSeconds: 7 });
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  for (let ms = 0; ms < 8000 && !finished; ms += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  const result = await promise;
  expect(sim.bot.attack).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(false);
  expect(result.progress?.done).toBe(0);
  expect(result.text).toContain('1回振って 0回当たった');
});

it('keeps fighting a target each blow knocks just past the reach (S1 lab 11/8: a wither skeleton at 3.1m, 13 of 25 blows landed, told 届かない)', async () => {
  const sim = makeSim((_x, y, _z) => y < 64 ? 'stone' : 'air');
  const eye = sim.bot.entity.position.offset(0, 1.6, 0);
  const near = new Vec3(eye.x + 2.0, eye.y - 1.2, eye.z), far = new Vec3(eye.x + 4.5, eye.y - 1.2, eye.z); // 1.1m and 3.5m from the eye, less the half height
  const skeleton = { id: 9, name: 'wither_skeleton', type: 'mob', position: near.clone(), height: 2.4, width: 0.7 };
  sim.bot.entities[9] = skeleton;
  sim.bot.pathfinder.setGoal = vi.fn();
  sim.bot.pathfinder.setMovements = vi.fn();
  let backAt = Infinity;
  sim.bot.attack = vi.fn(() => { sim.bot.emit('entityHurt', skeleton); skeleton.position = far.clone(); backAt = Date.now() + 900; });
  const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 14000,
    facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 9, maxSeconds: 12 });
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  for (let ms = 0; ms < 14000 && !finished; ms += 50) {
    if (Date.now() >= backAt) { skeleton.position = near.clone(); backAt = Infinity; }
    sim.tick(); await vi.advanceTimersByTimeAsync(50);
  }
  const result = await promise;
  expect(result.reason).not.toBe('cannot_reach');
  expect((sim.bot.attack as any).mock.calls.length).toBeGreaterThan(8);
});

it('still stops a chase that neither closes in nor lands a blow for 5 s', async () => {
  const sim = makeSim((_x, y, _z) => y < 64 ? 'stone' : 'air');
  const eye = sim.bot.entity.position.offset(0, 1.6, 0);
  const skeleton = { id: 9, name: 'wither_skeleton', type: 'mob', position: new Vec3(eye.x + 6, eye.y - 1.2, eye.z), height: 2.4, width: 0.7 };
  sim.bot.entities[9] = skeleton;
  sim.bot.pathfinder.setGoal = vi.fn();
  sim.bot.pathfinder.setMovements = vi.fn();
  sim.bot.attack = vi.fn();
  const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 14000,
    facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 9, maxSeconds: 12 });
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  for (let ms = 0; ms < 14000 && !finished; ms += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  const result = await promise;
  expect(result.reason).toBe('cannot_reach');
  expect(result.text).toContain('0回振って 0回当たった');
});

it('names the wall between when a chase cannot close in (S1 lab 11/8: a reflex-built cobblestone wall, told the creature air cell six times)', async () => {
  const probe = makeSim(() => 'air');
  const eye0 = probe.bot.entity.position.offset(0, 1.6, 0);
  const wallX = Math.floor(eye0.x + 3);
  const sim = makeSim((x, y, _z) => y < 64 ? 'stone' : x === wallX && y < 67 ? 'cobblestone' : 'air');
  const eye = sim.bot.entity.position.offset(0, 1.6, 0);
  const skeleton = { id: 9, name: 'wither_skeleton', type: 'mob', position: new Vec3(eye.x + 6, eye.y - 1.2, eye.z), height: 2.4, width: 0.7 };
  sim.bot.entities[9] = skeleton;
  sim.bot.pathfinder.setGoal = vi.fn();
  sim.bot.pathfinder.setMovements = vi.fn();
  sim.bot.attack = vi.fn();
  const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 14000,
    facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 9, maxSeconds: 12 });
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  for (let ms = 0; ms < 14000 && !finished; ms += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  const result = await promise;
  expect(result.reason).toBe('cannot_reach');
  expect(result.text).toContain(`間に cobblestone (${wallX},`);
  expect(result.text).toContain('掘るか回り込めば近づける');
});

it("words an eat whose food did not go down as 時間切れ, not 無い (S1 lab 11/8: 7 cooked_beef left, told 無い)", () => {
  expect(closedWord('not_eaten')).toBe('時間切れ');
  expect(closedWord('missing_item')).toBe('無い');
});

it('stops chasing a blaze 10 m from where the chase began, and keeps after a wither skeleton (end1108h16: a chase and shots took her 15 to 36 m off the spawner)', async () => {
  const run = async (name: string) => {
    const sim = makeSim((_x, y, _z) => y < 64 ? 'stone' : 'air');
    const eye = sim.bot.entity.position.offset(0, 1.6, 0);
    const creature = { id: 9, name, type: 'mob', position: new Vec3(eye.x + 6, eye.y, eye.z), height: 1.8, width: 0.6 };
    sim.bot.entities[9] = creature;
    sim.bot.pathfinder.setGoal = vi.fn();
    sim.bot.pathfinder.setMovements = vi.fn();
    sim.bot.attack = vi.fn();
    const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 14000,
      facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 9, maxSeconds: 12 });
    let finished = false;
    promise.finally(() => { finished = true; }).catch(() => {});
    for (let ms = 0; ms < 14000 && !finished; ms += 50) {
      sim.bot.entity.position = sim.bot.entity.position.offset(0.2, 0, 0);
      creature.position = creature.position.offset(0.2, 0, 0);
      await vi.advanceTimersByTimeAsync(50);
    }
    return promise;
  };
  const blaze = await run('blaze');
  expect(blaze.reason).toBe('leash');
  expect(blaze.text).toContain('を追うのをやめた: 追い始めた所から');
  expect(closedWord('leash')).toBe('届かない');
  expect((await run('wither_skeleton')).reason).toBe('cannot_reach');
});

it('strikes a blaze a step away, or one inside the radius, though the body already stands past it (end1108h17: let go of a blaze 3.1 m off)', async () => {
  const run = async (dx: number) => {
    const sim = makeSim((_x, y, _z) => y < 64 ? 'stone' : 'air');
    const eye = sim.bot.entity.position.offset(0, 1.6, 0);
    const creature = { id: 9, name: 'blaze', type: 'mob', position: new Vec3(eye.x + dx, eye.y, eye.z), height: 1.8, width: 0.6 };
    sim.bot.entities[9] = creature;
    sim.bot.pathfinder.setGoal = vi.fn();
    sim.bot.pathfinder.setMovements = vi.fn();
    sim.bot.attack = vi.fn();
    const start = sim.bot.entity.position.clone();
    const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 8000,
      facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 9, maxSeconds: 6 });
    let finished = false;
    promise.finally(() => { finished = true; }).catch(() => {});
    // the body is stepped 11 m off where the chase began (past the 10 m radius), the blaze kept dx ahead of her
    for (let ms = 0; ms < 8000 && !finished; ms += 50) {
      if (sim.bot.entity.position.distanceTo(start) < 11) {
        sim.bot.entity.position = sim.bot.entity.position.offset(1, 0, 0);
        creature.position = creature.position.offset(1, 0, 0);
      }
      await vi.advanceTimersByTimeAsync(50);
    }
    return promise;
  };
  expect((await run(4.5)).reason).not.toBe('leash'); // 3.6 m off (past the 3 m reach)
  expect((await run(-14)).reason).not.toBe('leash'); // 3 m from where the chase began: chasing leads back in
  expect((await run(8)).reason).toBe('leash');
});
