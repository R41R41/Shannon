import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim } from '../helpers/physicsBody.js';

/**
 * hunt (2026-11-11): the food animals around the body, until none is left or `count` have fallen, with their drops. attack and pickup are the parts' own and are
 * tested elsewhere: here they are stood in for (an attack kills the animal where it stands and drops what it drops; a pickup takes the named drops into the pack).
 */
const attackMock = vi.fn();
const pickupMock = vi.fn();
vi.mock('../../src/services/minebot/utils/primitives/attack.js', async importOriginal => ({ ...(await importOriginal<object>()), attack: (...args: unknown[]) => attackMock(...args) }));
vi.mock('../../src/services/minebot/utils/primitives/pickup.js', async importOriginal => ({ ...(await importOriginal<object>()), pickup: (...args: unknown[]) => pickupMock(...args) }));

const { hunt, huntKinds, isBabyAnimal } = await import('../../src/services/minebot/utils/primitives/hunt.js');
const { handProblem } = await import('../../src/services/minebot/utils/actHandRules.js');
const { handReasons } = await import('../../src/services/minebot/utils/packEvents.js');
const { stepLabel } = await import('../../src/services/minebot/utils/actLabel.js');
const { ACT_HANDS, HAND_KINDS } = await import('../../src/services/minebot/instantSkills/act.js');

let nextId = 100;
function setup(ground: (x: number, y: number, z: number) => string = (_x, y) => y < 64 ? 'stone' : 'air') {
  const sim = makeSim(ground);
  const bot = sim.bot;
  const here = bot.entity.position;
  const animal = (name: string, dx: number, options: { baby?: boolean; dz?: number } = {}) => {
    const metadata: unknown[] = [];
    metadata[16] = options.baby === true;
    const entity = { id: nextId++, name, type: 'animal', position: new Vec3(here.x + dx, here.y, here.z + (options.dz ?? 0)), height: 1.4, width: 0.9, metadata };
    bot.entities[entity.id] = entity;
    return entity;
  };
  const ctx = () => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
  const drops: Record<string, string[]> = { cow: ['beef', 'leather'], pig: ['porkchop'], sheep: ['mutton', 'white_wool'], chicken: ['chicken', 'feather'], rabbit: [] };
  const lyingItems = new Map<number, string>();
  /** The stand-in attack: the creature dies where it stands (its death is the connection's event) and drops its loot there after `dropMs`. */
  const kills = (unreachable: Set<number> = new Set(), dropMs = 0) => attackMock.mockImplementation(async (_ctx: unknown, args: { target: number }) => {
    const entity = bot.entities[args.target];
    if (unreachable.has(args.target)) return { ok: false, reason: 'cannot_reach', text: `${entity.name}（id ${entity.id}）に届かない（4.6m、5秒近づけない）` };
    delete bot.entities[args.target];
    bot.emit('entityDead', entity);
    const spawn = () => { for (const name of drops[entity.name] ?? []) { const id = nextId++; bot.entities[id] = { id, name: 'item', position: entity.position.clone(), metadata: [] }; lyingItems.set(id, name); } };
    if (dropMs > 0) setTimeout(spawn, dropMs); else spawn();
    return { ok: true, text: `${entity.name}（id ${entity.id}）を倒した（3回振って 3回当たった、2.0秒）`, progress: { unit: 'blow', done: 3, left: null } };
  });
  pickupMock.mockImplementation(async (_ctx: unknown, args: { ids: number[] }) => {
    let took = 0;
    for (const id of args.ids) {
      if (!bot.entities[id]) continue;
      sim.give(lyingItems.get(id) ?? 'dirt', 1); delete bot.entities[id]; took++;
    }
    return { ok: true, text: `拾った: ${took}` };
  });
  return { sim, bot, animal, ctx, kills, lyingItems };
}

beforeEach(() => { attackMock.mockReset(); pickupMock.mockReset(); });

describe('which animals a hunt takes', () => {
  const { bot } = setup();
  it('takes the food kinds, a list of them, a plural and a namespaced one', () => {
    expect(huntKinds(bot, 'cow')).toEqual({ kinds: ['cow'] });
    expect(huntKinds(bot, 'pig,cow')).toEqual({ kinds: ['pig', 'cow'] });
    expect(huntKinds(bot, 'Cows, minecraft:sheep')).toEqual({ kinds: ['cow', 'sheep'] });
    expect(huntKinds(bot, 'goat')).toEqual({ kinds: ['goat'] });
  });
  it('refuses a hostile, a villager, a pet, a mount, a fish, an id and a made-up name, each with its reason', () => {
    expect(huntKinds(bot, 'zombie')).toMatchObject({ problem: expect.stringContaining('敵') });
    expect(huntKinds(bot, 'villager')).toMatchObject({ problem: expect.stringContaining('食料の動物ではない') });
    expect(huntKinds(bot, 'wolf')).toMatchObject({ problem: expect.stringContaining('狩らない') });
    expect(huntKinds(bot, 'horse')).toMatchObject({ problem: expect.stringContaining('狩らない') });
    expect(huntKinds(bot, 'squid')).toMatchObject({ problem: expect.stringContaining('食料の動物ではない') });
    expect(huntKinds(bot, '#12')).toMatchObject({ problem: expect.stringContaining('動物の名前ではない') });
    expect(huntKinds(bot, 'blorp')).toMatchObject({ problem: expect.stringContaining('動物の名前ではない') });
    expect(huntKinds(bot, 'cow,zombie')).toHaveProperty('problem');
  });
  it('reads a baby from the registry\'s own `baby` datum, and takes an unreadable datum for an adult', () => {
    const { bot: b, animal } = setup();
    const keys = b.registry.entitiesByName.cow.metadataKeys as string[];
    expect(keys.indexOf('baby')).toBe(16);
    expect(isBabyAnimal(b, animal('cow', 5, { baby: true }))).toBe(true);
    expect(isBabyAnimal(b, animal('cow', 6))).toBe(false);
    expect(isBabyAnimal(b, { ...animal('cow', 7), metadata: undefined })).toBe(false);
    expect(isBabyAnimal(b, { ...animal('cow', 8), metadata: [] })).toBe(false);
  });
});

describe('the hunt', () => {
  it('takes the nearest adults first, leaves the baby and the other kinds, picks up what fell by the drops\' ids, and says what came of it', async () => {
    const { bot, animal, ctx, kills } = setup();
    kills();
    const far = animal('cow', 14), near = animal('cow', 4), baby = animal('cow', 2, { baby: true }), pig = animal('pig', 3);
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(outcome.ok).toBe(true);
    expect(attackMock.mock.calls.map(call => call[1].target)).toEqual([near.id, far.id]);
    expect(attackMock.mock.calls[0][1]).toMatchObject({ until: 'dead', maxSeconds: 12 });
    expect(bot.entities[baby.id]).toBeDefined();
    expect(bot.entities[pig.id]).toBeDefined();
    // each kill's drops were taken by id (beef and leather, one at a time, the nearer first), not by a radius
    expect(pickupMock.mock.calls.map(call => call[1].ids.length)).toEqual([1, 1, 1, 1]);
    expect(pickupMock.mock.calls.every(call => call[1].radius === undefined)).toBe(true);
    expect(outcome.text).toContain('cow 2 体倒した');
    expect(outcome.text).toContain('beef+2');
    expect(outcome.text).toContain('leather+2');
    expect(outcome.text).toContain('子 1 体は倒さない');
    expect(outcome.progress).toEqual({ unit: 'item', done: 2, left: null });
  });

  it('stops at count and says how many are left in range', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('pig', 3); animal('pig', 5); animal('cow', 7); animal('pig', 9);
    const outcome = await hunt(ctx(), { kinds: 'pig,cow', count: 2 });
    expect(outcome.ok).toBe(true);
    expect(attackMock).toHaveBeenCalledTimes(2);
    expect(outcome.text).toContain('count に達した');
    expect(outcome.text).toContain('範囲内に残り 2 体');
    expect(outcome.progress).toEqual({ unit: 'item', done: 2, left: 0 });
  });

  it('ends ok when the animals run out before count, and says so', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('sheep', 3); animal('sheep', 6);
    const outcome = await hunt(ctx(), { kinds: 'sheep', count: 5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('にもういない');
    expect(outcome.text).toContain('mutton+2');
    expect(outcome.progress).toEqual({ unit: 'item', done: 2, left: 3 });
  });

  it('keeps to the range measured from where it began', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    const inside = animal('cow', 10), outside = animal('cow', 40);
    const outcome = await hunt(ctx(), { kinds: 'cow', range: 16 });
    expect(attackMock.mock.calls.map(call => call[1].target)).toEqual([inside.id]);
    expect(outcome.text).not.toContain('範囲内に残り');
    expect(outcome.ok).toBe(true);
    expect(outside.id).toBeGreaterThan(0);
  });

  it('passes by an animal it cannot reach and goes on to the next, naming it at the end', async () => {
    const { animal, ctx, kills } = setup();
    const behindWall = animal('cow', 3), other = animal('cow', 9);
    kills(new Set([behindWall.id]));
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(attackMock.mock.calls.map(call => call[1].target)).toEqual([behindWall.id, other.id]);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain(`届かず飛ばした 1 体（#${behindWall.id}）`);
  });

  it('ends on unreachable when three in a row cannot be reached, with the kills so far kept as progress', async () => {
    const { animal, ctx, kills } = setup();
    const first = animal('cow', 3);
    const stuck = [animal('cow', 5), animal('cow', 7), animal('cow', 9)];
    kills(new Set(stuck.map(entity => entity.id)));
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(first.id).toBeGreaterThan(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unreachable');
    expect(outcome.progress?.done).toBe(1);
    expect(outcome.text).toContain('3 体続けて届かない');
  });

  it('stops with no_target and names the animals in sight when none of the asked kind is there', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('sheep', 21); animal('chicken', 30); animal('cow', 3, { baby: true });
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(attackMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no_target');
    expect(outcome.text).toContain('sheep 21m');
    expect(outcome.text).toContain('chicken 30m');
    expect(outcome.text).toContain('子 1 体は倒さない');
  });

  it('refuses a hostile kind before moving', async () => {
    const { ctx } = setup();
    const outcome = await hunt(ctx(), { kinds: 'zombie' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('invalid_input');
    expect(attackMock).not.toHaveBeenCalled();
  });

  it('waits a moment for a drop that has not shown yet, but not for a rabbit', async () => {
    const { animal, ctx, kills, bot } = setup();
    kills(new Set(), 300);
    animal('cow', 4);
    const startedAt = Date.now();
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(pickupMock).toHaveBeenCalledTimes(2);
    expect(pickupMock.mock.calls.map(call => call[1].ids.length)).toEqual([1, 1]);
    expect(outcome.text).toContain('beef+1');
    expect(Object.values(bot.entities).some((entity: any) => entity.name === 'item')).toBe(false);

    pickupMock.mockClear(); attackMock.mockReset();
    const second = setup();
    second.kills();
    second.animal('rabbit', 4);
    const t0 = Date.now();
    await hunt(second.ctx(), { kinds: 'rabbit' });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(pickupMock).not.toHaveBeenCalled();
  });

  it('does not take up drops that lay before the hunt began', async () => {
    const { animal, ctx, kills, bot } = setup();
    kills();
    const old = { id: nextId++, name: 'item', position: bot.entity.position.offset(3, 0, 0), metadata: [] };
    bot.entities[old.id] = old;
    animal('pig', 3);
    await hunt(ctx(), { kinds: 'pig' });
    expect(pickupMock.mock.calls.every(call => !call[1].ids.includes(old.id))).toBe(true);
  });

  it('stops full when the pick-up says the pack is full', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('cow', 3); animal('cow', 6);
    pickupMock.mockResolvedValue({ ok: false, reason: 'inventory_full', text: '拾えなかった: beef（持ち物が満杯）' });
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(outcome.reason).toBe('full');
    expect(attackMock).toHaveBeenCalledTimes(1);
    expect(outcome.progress?.done).toBe(1);
  });

  it('stops on the hunt\'s own seconds, reporting what was killed', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('cow', 3); animal('cow', 6);
    const context = ctx();
    context.deadline = Date.now() + 1000;   // under the 1.5 s a kill needs to start
    const outcome = await hunt(context, { kinds: 'cow', seconds: 5 });
    expect(outcome.reason).toBe('limit_time');
    expect(attackMock).not.toHaveBeenCalled();
  });

  it('stops on what attack stops on that is not a reach problem (the reason and text are attack\'s)', async () => {
    const { animal, ctx } = setup();
    animal('cow', 3);
    attackMock.mockResolvedValue({ ok: false, reason: 'invalid_input', text: 'attack には target が要る' });
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(outcome.reason).toBe('invalid_input');
    expect(outcome.text).toContain('attack には target が要る');
  });
});

describe('the hunt: review fixes', () => {
  it('takes the herd in the open before an animal behind a wall that is nearer in a straight line', async () => {
    const { animal, ctx, kills } = setup((x, y) => y < 64 ? 'stone' : (x === 3 && y <= 65 ? 'stone' : 'air'));
    kills();
    const behind = animal('cow', 5), open = animal('cow', -8);
    await hunt(ctx(), { kinds: 'cow' });
    expect(attackMock.mock.calls.map(call => call[1].target)).toEqual([open.id, behind.id]);
  });

  it('says that the reachable ones are done when only an unreachable animal is left, not that none is in the radius', async () => {
    const { animal, ctx, kills } = setup();
    const stuck = animal('cow', 3);
    animal('cow', 9);
    kills(new Set([stuck.id]));
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('届く成体は倒した（残り 1 体は届かない・見失った）');
    expect(outcome.text).not.toContain('にもういない');
  });

  it('says only babies are left when they are', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('cow', 4); animal('cow', 3, { baby: true });
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(outcome.text).toContain('成体はもういない（子だけ残る）');
  });

  it('tells an animal that went out of sight from one that cannot be reached', async () => {
    const { animal, ctx } = setup();
    animal('cow', 4);
    attackMock.mockResolvedValue({ ok: false, reason: 'target_lost', text: 'cow を見失った' });
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(outcome.reason).toBe('target_lost');
    expect(outcome.text).toContain('見失った 1 体');
    expect(outcome.text).not.toContain('全部届かない');
    expect(attackMock).toHaveBeenCalledTimes(1);
  });

  it('tries a drop it could not take once, and leaves it out of the last pick-up', async () => {
    const { animal, ctx, kills } = setup();
    kills();
    animal('cow', 4);
    pickupMock.mockResolvedValue({ ok: false, reason: 'not_picked', text: '拾えなかった: beef（そこまで着けない）' });
    const outcome = await hunt(ctx(), { kinds: 'cow' });
    expect(pickupMock).toHaveBeenCalledTimes(2);   // beef and leather, once each: the sweep does not walk to them again
    expect(outcome.text).toContain('拾えず落ちたまま 2 個');
  });

  it('picks up one drop at a time', async () => {
    const { animal, ctx, kills, bot } = setup();
    kills();
    animal('cow', 4);
    const order: number[] = [];
    pickupMock.mockImplementation(async (_ctx: unknown, args: { ids: number[] }) => { order.push(...args.ids); delete bot.entities[args.ids[0]]; return { ok: true, text: '拾った' }; });
    const context = ctx();
    await hunt(context, { kinds: 'cow' });
    expect(order).toHaveLength(2);
    expect(pickupMock.mock.calls.every(call => call[1].ids.length === 1)).toBe(true);
  });
});

describe('the hand in the act', () => {
  it('is a kind of hand with its own fields and ranges', () => {
    expect(HAND_KINDS).toContain('hunt');
    expect(ACT_HANDS.safeParse([{ do: 'hunt', target: 'cow,pig', count: 6, range: 32, seconds: 60 }]).success).toBe(true);
    expect(handProblem({ do: 'hunt', target: 'cow' })).toBeNull();
    expect(handProblem({ do: 'hunt', target: 'cow', count: 6, range: 24, seconds: 40 })).toBeNull();
    expect(handProblem({ do: 'hunt' })).toContain('target');
    expect(handProblem({ do: 'hunt', target: '#12' })).toContain('id は attack');
    expect(handProblem({ do: 'hunt', target: 12 })).toContain('id は attack');
    expect(handProblem({ do: 'hunt', target: 'cow', seconds: 200 })).toContain('seconds');
    expect(handProblem({ do: 'hunt', target: 'cow', count: 0 })).toContain('count');
    expect(handProblem({ do: 'hunt', target: 'cow', range: 2 })).toContain('range');
    expect(handProblem({ do: 'hunt', target: 'cow', range: 60 })).toContain('range');
    expect(handProblem({ do: 'hunt', target: 'cow', block: 'stone' })).toContain('使えない');
  });
  it('is told as picked up in the pack events and labelled with its kinds', () => {
    expect(handReasons({ do: 'hunt' })).toEqual({ gain: 'picked' });
    expect(stepLabel({ do: 'hunt', target: 'cow,pig', count: 6 })).toBe('hunt cow,pig×6');
    expect(stepLabel({ do: 'hunt', target: 'cow' })).toBe('hunt cow');
  });
});
