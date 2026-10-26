import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { readCondition } from '../../src/services/minebot/utils/actConditions.js';

// The task queue's act (`tq/contract.md` section 4): `done` ends the act ok where it holds (between hands and inside one), `repeat` runs the hands
// again from where the feet are, a pass that changes nothing stops it, and being hurt or falling stops any act. A fake body: blocks from a map.
const walked: Array<{ x: number; y: number; z: number }> = [];
let moves = true;
vi.mock('../../src/services/minebot/utils/primitives/walk.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/walk.js')>();
  return { ...actual, walk: vi.fn(async (ctx: any, spec: any) => {
    const to = spec.to ?? spec.path?.at(-1);
    if (moves && to) { ctx.bot.entity.position = new Vec3(to.x + 0.5, to.y, to.z + 0.5); walked.push(to); }
    return { ok: true, text: `(${to?.x},${to?.y},${to?.z}) に着いた（1m、0.0秒）` };
  }) };
});

function body(overrides: Record<string, unknown> = {}) {
  let items: Array<{ name: string; count: number }> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    inventory: { items: () => items, slots: new Array(46).fill(null) },
    blockAt: (p: Vec3) => ({ name: Math.floor(p.y) < 64 ? 'stone' : 'air', boundingBox: Math.floor(p.y) < 64 ? 'block' : 'empty', diggable: true, hardness: 1.5, position: p.floored() }),
    setControlState: () => undefined, clearControlStates: () => undefined,
    ...overrides,
  });
  return { bot, give: (name: string, count: number) => { items = [...items.filter(item => item.name !== name), { name, count }]; } };
}
const hands = (value: unknown) => ACT_HANDS.parse(value);
const parse = (result: { result: string }) => JSON.parse(result.result);
const cond = (value: unknown) => readCondition(value)!;

describe('done: the act ends ok where the condition holds', () => {
  it('in the middle of a hand: a long wait is cut where the pack shows what was asked, and it is ok', async () => {
    const { bot, give } = body();
    setTimeout(() => give('oak_log', 10), 80);
    const started = Date.now();
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 10 }, { do: 'jump' }]), undefined, undefined,
      { done: cond([[{ k: 'have', item: 'log', n: 10 }]]), tickMs: 20 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.success).toBe(true);
    const json = parse(result);
    expect(json).toMatchObject({ ok: true, done: 1, of: 2, doneMet: 'have:log 10/10' });
    expect(json.stoppedBy).toBeUndefined();
    expect(json.lines[0]).toMatchObject({ i: 1, do: 'wait', status: 'done' });
    expect(json.lines[1]).toMatchObject({ i: 2, status: 'skipped', line: '未実行: 済む条件を満たした' });
  });

  it('after a hand: the next hands are skipped', async () => {
    const { bot, give } = body();
    const events: any[] = [];
    bot.on('minebotActStep', (event: any) => { events.push(event); if (event.status === 'completed' && event.index === 0) give('oak_log', 4); });
    const result = await runAct(bot, hands([{ do: 'jump' }, { do: 'wait', seconds: 5 }]), undefined, undefined, { done: cond([[{ k: 'have', item: 'log', n: 4 }]]), tickMs: 20 });
    expect(result.success).toBe(true);
    expect(parse(result)).toMatchObject({ ok: true, done: 1, of: 2, doneMet: 'have:log 4/4' });
  });

  it('a condition that held before the first hand: ok with no hand done, and it is said', async () => {
    const { bot, give } = body();
    give('oak_log', 12);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 5 }]), undefined, undefined, { done: cond([[{ k: 'have', item: 'log', n: 10 }]]) });
    expect(parse(result)).toMatchObject({ ok: true, done: 0, of: 1, doneMet: 'have:log 12/10' });
  });

  it('a condition that never holds changes nothing: every hand runs and the result carries no doneMet', async () => {
    const { bot } = body();
    const result = parse(await runAct(bot, hands([{ do: 'jump' }, { do: 'sneak', on: false }]), undefined, undefined, { done: cond([[{ k: 'hp', n: 99 }]]) }));
    expect(result).toMatchObject({ ok: true, done: 2, of: 2 });
    expect(result.doneMet).toBeUndefined();
  });
});

describe('repeat: the hands again, from where the feet are', () => {
  const step = [{ do: 'walk', to: { x: 1, y: 0, z: 0 }, rel: true }];
  it('relative hands go further on every pass, and the result keeps the last pass\'s lines', async () => {
    walked.length = 0; moves = true;
    const { bot } = body();
    const events: any[] = [];
    bot.on('minebotActStep', (event: any) => events.push(event));
    const result = await runAct(bot, hands(step), undefined, undefined, { repeat: 4 });
    expect(result.success).toBe(true);
    expect(walked.map(cell => cell.x)).toEqual([1, 2, 3, 4]);
    const json = parse(result);
    expect(json).toMatchObject({ ok: true, done: 4, of: 4, repeat: { done: 4, of: 4 }, at: { x: 4, y: 64, z: 0 } });
    expect(json.lines).toHaveLength(1);
    expect(events.filter(event => event.status === 'in_progress').map(event => [event.iteration, event.repeat])).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });

  it('ends at the pass where done holds, ok, and says which hand of which pass', async () => {
    walked.length = 0; moves = true;
    const { bot } = body();
    const result = await runAct(bot, hands(step), undefined, undefined, { repeat: 8, done: cond([[{ k: 'at', x: 4, y: 64, z: 0, r: 0.9 }]]), tickMs: 20 });
    const json = parse(result);
    expect(result.success).toBe(true);
    expect(json).toMatchObject({ ok: true, doneMet: expect.stringContaining('at:4,64,0~0.9'), repeat: { done: 3, of: 8 } });
    expect(walked.map(cell => cell.x)).toEqual([1, 2, 3]);
  });

  it('used up with the condition still unmet: ok, with no doneMet', async () => {
    walked.length = 0; moves = true;
    const { bot } = body();
    const json = parse(await runAct(bot, hands(step), undefined, undefined, { repeat: 3, done: cond([[{ k: 'at', x: 99, y: 64, z: 0, r: 1 }]]), tickMs: 20 }));
    expect(json).toMatchObject({ ok: true, done: 3, of: 3, repeat: { done: 3, of: 3 } });
    expect(json.doneMet).toBeUndefined();
  });

  it('a pass that changes nothing (feet, pack, blocks dug) stops the act: no_progress', async () => {
    moves = false;
    const { bot } = body();
    const result = await runAct(bot, hands(step), undefined, undefined, { repeat: 5 });
    moves = true;
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('no_progress');
    expect(parse(result)).toMatchObject({ ok: false, stoppedBy: 'noProgress', stoppedWhy: '進まない: 1 回目が何も変えなかった', repeat: { done: 1, of: 5 } });
  });

  it('a hand that fails stops the act on its pass (the rest of the passes are not run)', async () => {
    moves = true;
    const { bot } = body();
    const result = await runAct(bot, hands([{ do: 'dig', at: [{ x: 9, y: 63, z: 0 }] }]), undefined, undefined, { repeat: 3 });
    const json = parse(result);
    expect(result.success).toBe(false);
    expect(json).toMatchObject({ stoppedBy: 'failure', done: 0, of: 3 });
    expect(json.repeat).toMatchObject({ of: 3 });
  });

  it('does not check absolute hands against repeat (the head refuses them before sending): the first pass runs, the second changes nothing and stops it', async () => {
    moves = true;
    const { bot } = body();
    const result = await runAct(bot, hands([{ do: 'dig', at: [{ x: 0, y: 65, z: 1 }] }]), undefined, undefined, { repeat: 3 });
    const json = parse(result);
    expect(result.failureType).toBe('no_progress');
    expect(json.lines[0]).toMatchObject({ status: 'done' });
    expect(json).toMatchObject({ stoppedBy: 'noProgress', done: 1, of: 3, repeat: { done: 1, of: 3 } });
  });

  it('without repeat or done the result is what it was: no new fields', async () => {
    const { bot } = body();
    const json = parse(await runAct(bot, hands([{ do: 'jump' }])));
    expect(json).toMatchObject({ ok: true, done: 1, of: 1 });
    expect(json.repeat).toBeUndefined();
    expect(json.doneMet).toBeUndefined();
  });
});

describe('hurt and fall stop any act', () => {
  it('health lost by 4 from the most it was in this act stops it: damage', async () => {
    const { bot } = body();
    setTimeout(() => { bot.health = 15; }, 60);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
    expect(result.failureType).toBe('damage_taken');
    const json = parse(result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'damage', stoppedWhy: '被弾: 体力 20 → 15' });
    expect(json.lines[0].line.startsWith('被弾:')).toBe(true);
  });

  it('a loss under 4 does not stop it, and health that comes back and goes again counts from the new high', async () => {
    const { bot } = body({ health: 12 });
    setTimeout(() => { bot.health = 9; }, 40);
    setTimeout(() => { bot.health = 14; }, 120);
    setTimeout(() => { bot.health = 11; }, 200);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 0.6 }]), undefined, undefined, { tickMs: 20 });
    expect(result.success).toBe(true);
  });

  it('the loss while a kind she accepted is within 6 m is not counted', async () => {
    const { bot } = body();
    bot.entities = { 5: { id: 5, name: 'zombie', type: 'hostile', position: new Vec3(3.5, 64, 0.5), height: 1.9 } };
    setTimeout(() => { bot.health = 10; }, 60);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 0.5 }]), undefined, undefined, { tickMs: 20, accept: ['zombie'] });
    expect(result.success).toBe(true);
    // The same loss with no accept stops it.
    const other = body();
    other.bot.entities = bot.entities;
    setTimeout(() => { other.bot.health = 10; }, 60);
    const stopped = await runAct(other.bot, hands([{ do: 'wait', seconds: 0.5 }]), undefined, undefined, { tickMs: 20 });
    expect(stopped.failureType).toBe('damage_taken');
  });

  it('a drop of 4 blocks or more in one airborne spell stops it: fall; a short drop, or one in water, does not', async () => {
    const { bot } = body();
    bot.entity.position = new Vec3(0.5, 70, 0.5);
    setTimeout(() => { bot.entity.onGround = false; }, 40);
    setTimeout(() => { bot.entity.position = new Vec3(0.5, 68, 0.5); }, 70);
    setTimeout(() => { bot.entity.position = new Vec3(0.5, 65, 0.5); }, 100);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 5 }]), undefined, undefined, { tickMs: 20 });
    expect(result.failureType).toBe('fell');
    expect(parse(result)).toMatchObject({ stoppedBy: 'fall', stoppedWhy: '落下: 5 段' });
    const short = body();
    short.bot.entity.position = new Vec3(0.5, 70, 0.5);
    setTimeout(() => { short.bot.entity.onGround = false; short.bot.entity.position = new Vec3(0.5, 67, 0.5); }, 30);
    setTimeout(() => { short.bot.entity.onGround = true; }, 120);
    expect((await runAct(short.bot, hands([{ do: 'wait', seconds: 0.4 }]), undefined, undefined, { tickMs: 20 })).success).toBe(true);
    const swim = body();
    swim.bot.entity.position = new Vec3(0.5, 70, 0.5);
    setTimeout(() => { swim.bot.entity.onGround = false; swim.bot.entity.isInWater = true; swim.bot.entity.position = new Vec3(0.5, 60, 0.5); }, 30);
    expect((await runAct(swim.bot, hands([{ do: 'wait', seconds: 0.4 }]), undefined, undefined, { tickMs: 20 })).success).toBe(true);
  });
});
