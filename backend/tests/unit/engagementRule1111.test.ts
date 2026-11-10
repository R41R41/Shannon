import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BodyQueue } from '../../src/services/minebot/integration/commonFca/bodyQueue.js';
import { beginEngagement, engagedWithAny } from '../../src/services/minebot/utils/engagement.js';
import { engageRead, installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';

// Owner decision 11/10: at most two enemies that are after the body within 4 m and at most four within 8 m are fought before they strike, at any
// health, whatever an act accepts; creepers by their own technique; neutral kinds only when they are after the body.
const SWORD = { name: 'iron_sword', type: 20, count: 1 };
const SHIELD = { name: 'shield', type: 21, count: 1 };
const mob = (id: number, name: string, x = 2.6, z = 0.5, type = 'hostile') => ({ id, name, type, health: 100, height: name === 'creeper' ? 1.7 : 1.95, width: 0.6,
  position: new Vec3(x, 64, z), metadata: [] as unknown[] });

function fixture(enemies: any[], options: { shield?: boolean; items?: any[]; health?: number; rim?: boolean } = {}) {
  const handlers: Record<string, (packet: any) => void> = {};
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    health: options.health ?? 20, food: 20, game: { dimension: 'overworld' }, entities: Object.fromEntries(enemies.map(entity => [entity.id, entity])),
    inventory: { items: () => options.items ?? [SWORD], slots: new Array(46).fill(null) },
    heldItem: SWORD, controlState: {}, usingHeldItem: false,
    registry: { entitiesByName: Object.fromEntries(enemies.map(entity => [entity.name, { type: entity.type }])) },
    _client: { on: (event: string, listener: (packet: any) => void) => { handlers[event] = listener; } },
    setControlState: vi.fn((key: string, value: boolean) => { bot.controlState[key] = value; }),
    clearControlStates: vi.fn(() => { bot.controlState = {}; }), stopDigging: vi.fn(),
    look: vi.fn((yaw: number) => { bot.entity.yaw = yaw; }), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any, destination: string) => { if (destination === 'off-hand') bot.inventory.slots[45] = item; else bot.heldItem = item; }),
    activateItem: vi.fn(() => { bot.usingHeldItem = true; }), deactivateItem: vi.fn(() => { bot.usingHeldItem = false; }),
    attack: vi.fn(),
    blockAt: (p: Vec3) => {
      const at = p.floored();
      const floor = at.y < 64 && (!options.rim || (at.x === 0 && at.z === 0));
      const name = floor ? 'stone' : 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, hardness: 1.5, position: at };
    },
  });
  if (options.shield) bot.inventory.slots[45] = SHIELD;
  installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
  return { bot, handlers };
}
const entries = (bot: any) => bot.reflexLedger.entriesSince(0) as Array<{ kind: string; detail: string; outcome: string }>;
const idle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(() => { vi.useRealTimers(); });

describe('the rule: who counts and when it holds', () => {
  it('holds for 1 to 2 enemies within 4 m and at most 4 within 8 m, and says why when it does not', () => {
    const near = (n: number) => Array.from({ length: n }, (_, index) => mob(10 + index, 'zombie', 2.5, 0.5 + index * 0.4));
    const far = (n: number, from = 20) => Array.from({ length: n }, (_, index) => mob(from + index, 'zombie', 7, 0.5 + index * 0.4));
    const read = (enemies: any[]) => engageRead(fixture(enemies).bot, undefined);
    expect(read([...near(1)])).toMatchObject({ n4: 1, n8: 1, inRule: true });
    expect(read([...near(2), ...far(2)])).toMatchObject({ n4: 2, n8: 4, inRule: true });
    expect(read([...near(3)])).toMatchObject({ n4: 3, inRule: false });
    expect(read([...near(2), ...far(3)])).toMatchObject({ n4: 2, n8: 5, inRule: false });
    expect(read([...far(2)])).toMatchObject({ n4: 0, n8: 2, inRule: false });
    expect(read([...near(1), mob(40, 'warden', 7, 0.5)]).inRule).toBe(false);
  });

  it('counts neutral kinds only once they are after the body: a blow taken from them (by the server\'s cause id) or an enderman\'s anger flag', () => {
    const piglin = mob(8, 'piglin'), ender = mob(9, 'enderman', 3.1), wolf = mob(10, 'wolf', 3.0);
    const { bot, handlers } = fixture([piglin, ender, wolf]);
    bot.inventory.slots[5] = { name: 'golden_helmet', count: 1 };   // gold on: a piglin leaves the body alone until it strikes
    expect(engageRead(bot, bot.floorReflexes)).toMatchObject({ n4: 0, n8: 0 });
    handlers.damage_event({ entityId: 1, sourceCauseId: 9, sourceDirectId: 9 });   // piglin #8 struck (ids are the game's plus one)
    expect(engageRead(bot, bot.floorReflexes)).toMatchObject({ n4: 1, n8: 1, inRule: true });
    bot.registry.entitiesByName.enderman = { type: 'hostile', metadataKeys: ['a', 'b', 'creepy'] };
    ender.metadata = [0, 0, true];
    expect(engageRead(bot, bot.floorReflexes).n4).toBe(2);
  });

  it('a spider in daylight in the overworld is neutral until it strikes; a cave spider is not', () => {
    const { bot } = fixture([mob(8, 'spider'), mob(9, 'cave_spider', 3.0)]);
    bot.time = { isDay: true };
    expect(engageRead(bot, bot.floorReflexes).n4).toBe(1);
    bot.time = { isDay: false };
    expect(engageRead(bot, bot.floorReflexes).n4).toBe(2);
  });

  it('what an act accepts is not a fight the planner chose: the body\'s defence still counts it, the dig guard still honours it', () => {
    const bot: any = {};
    beginEngagement(bot, ['zombie'], { accept: true });
    expect(engagedWithAny(bot, ['zombie'])).toBe(true);
    expect(engagedWithAny(bot, ['zombie'], { exceptAccepted: true })).toBe(false);
    beginEngagement(bot, ['skeleton']);
    expect(engagedWithAny(bot, ['skeleton'], { exceptAccepted: true })).toBe(true);
  });
});

describe('the body strikes first', () => {
  it('one zombie in reach, never yet struck, an act accepting zombies, health 20: it is hit, and the ledger says n4, n8 and the decision', async () => {
    const { bot } = fixture([mob(7, 'zombie')], { shield: true });
    bot.attack.mockImplementation((entity: any) => { delete bot.entities[entity.id]; });   // the blow kills it: the hand ends and the ledger hears of it
    beginEngagement(bot, ['zombie'], { accept: true });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalled());
    await vi.waitFor(() => expect(entries(bot).some(entry => entry.kind === 'melee')).toBe(true));
    const line = entries(bot).find(entry => entry.kind === 'melee')!;
    expect(line.detail).toContain('n4=1 n8=1 decision=fight');
    expect(line.outcome).toBe('done');
    expect(bot.floorReflexes.handTarget?.target).toBe(7);
  });

  it('at health 5 a single zombie is fought, not run from', async () => {
    const { bot } = fixture([mob(7, 'zombie')], { health: 5 });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalled());
    expect(bot.floorReflexes.engagements.flee ?? 0).toBe(0);
    expect(bot.floorReflexes.fleeEpisode).toBeUndefined();
  });

  it('three enemies within 4 m are outside the rule: no blow, and the low-health flee says its counts and decision=flee', async () => {
    const { bot } = fixture([mob(7, 'zombie', 2.5, 0.2), mob(8, 'zombie', 2.5, 0.6), mob(9, 'zombie', 2.5, 1.0)], { health: 6 });
    const begun: string[] = [];
    const begin = bot.reflexLedger.begin.bind(bot.reflexLedger);
    bot.reflexLedger.begin = (kind: string, detail: string, max?: number) => { if (kind === 'flee') begun.push(detail); return begin(kind, detail, max); };
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.floorReflexes.engagements.flee).toBe(1);
    expect(begun.join('|')).toMatch(/n4=3 n8=3 decision=flee/u);
  });

  it('three enemies above the flee\'s health: skipped, and the ledger says so with the counts', async () => {
    const { bot } = fixture([mob(7, 'zombie', 2.5, 0.2), mob(8, 'zombie', 2.5, 0.6), mob(9, 'zombie', 2.5, 1.0)], { health: 15 });
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
    expect(entries(bot).find(entry => entry.kind === 'melee_none' && entry.detail.includes('n4=3') && entry.detail.includes('decision=skip'))).toBeTruthy();
  });

  it.each([['an enderman that is calm', mob(7, 'enderman', 2.4)], ['a zombified piglin that has not struck', mob(7, 'zombified_piglin', 2.4)],
    ['a wolf', mob(7, 'wolf', 2.4)], ['an iron golem', mob(7, 'iron_golem', 2.4)]])('does not intercept %s', async (_name, enemy) => {
    const { bot } = fixture([enemy]);
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.floorReflexes.melee).toBeUndefined();
  });

  it('a piglin goes for a body wearing no gold, so it is struck before it strikes; with a golden piece on it is left alone', async () => {
    const bare = fixture([mob(7, 'piglin', 2.4)]);
    bare.bot.emit('physicsTick');
    await vi.waitFor(() => expect(bare.bot.attack).toHaveBeenCalled());
    const gold = fixture([mob(7, 'piglin', 2.4)]);
    gold.bot.inventory.slots[5] = { name: 'golden_helmet', count: 1 };
    gold.bot.emit('physicsTick');
    await idle(50);
    expect(gold.bot.attack).not.toHaveBeenCalled();
  });

  it('a zombified piglin that has attacked the body before (not in the last 5 s) is still after it', async () => {
    const { bot } = fixture([mob(7, 'zombified_piglin', 2.4)]);
    const hint = await import('../../src/services/minebot/utils/hostileMobHints.js');
    hint.noteAttackedBy('zombified_piglin');
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalled());
  });

  it('strikes a piglin once it has struck', async () => {
    const { bot, handlers } = fixture([mob(7, 'piglin', 2.4)]);
    handlers.damage_event({ entityId: 1, sourceCauseId: 8, sourceDirectId: 8 });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalled());
  });

  it('leaves the planner\'s own laying of blocks alone, and a rim of a drop to the rim hands', async () => {
    const laying = fixture([mob(7, 'zombie')]);
    laying.bot.actHandNow = 'place';
    laying.bot.emit('physicsTick');
    await idle(50);
    expect(laying.bot.attack).not.toHaveBeenCalled();
    const rim = fixture([mob(7, 'zombie')], { rim: true });
    rim.bot.emit('physicsTick');
    await idle(50);
    expect(rim.bot.attack).not.toHaveBeenCalled();
  });

  it('yields to a fight the planner has chosen above the flee\'s health (an engagement that is not an accept)', async () => {
    const { bot } = fixture([mob(7, 'zombie')]);
    beginEngagement(bot, ['zombie']);
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('yields to the lava reflex', async () => {
    const { bot } = fixture([mob(7, 'zombie')]);
    bot.lavaReflex = { engaged: true };
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('one hand carries on to a second zombie in reach (its own engagement is not the planners)', async () => {
    const { bot } = fixture([mob(7, 'zombie', 2.4, 0.5), mob(8, 'zombie', 2.5, 0.9)]);
    bot.attack.mockImplementation((entity: any) => { delete bot.entities[entity.id]; });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await vi.waitFor(() => expect(entries(bot).filter(entry => entry.kind === 'melee')).toHaveLength(1));
  });

  it('an enemy it cannot get at (in reach of nothing, a step toward it fails) is not walked toward again and again, and does not fill the ledger', async () => {
    const { bot } = fixture([mob(7, 'zombie', 4.2, 0.5)]);
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.floorReflexes.engageFutile?.has(7)).toBe(true), { timeout: 4000 });
    const walks = bot.setControlState.mock.calls.filter((call: any[]) => call[0] === 'forward' && call[1] === true).length;
    for (let tick = 0; tick < 12; tick++) { bot.emit('physicsTick'); await idle(120); }
    expect(bot.setControlState.mock.calls.filter((call: any[]) => call[0] === 'forward' && call[1] === true).length).toBe(walks);
    expect(bot.attack).not.toHaveBeenCalled();
    expect(entries(bot).filter(entry => entry.kind === 'melee')).toHaveLength(0);
  }, 10_000);

  it('strikes nothing with no weapon at all (the old logic goes on)', async () => {
    const { bot } = fixture([mob(7, 'zombie')], { items: [] });
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
  });
});

describe('creepers: their own technique', () => {
  it('with a shield the shield is raised and it is struck behind it', async () => {
    const { bot } = fixture([mob(7, 'creeper')], { shield: true });
    bot.attack.mockImplementation((entity: any) => { delete bot.entities[entity.id]; });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalled());
    expect(bot.activateItem).toHaveBeenCalled();
    await vi.waitFor(() => expect(entries(bot).some(entry => entry.kind === 'melee' && entry.detail.includes('盾'))).toBe(true));
  });

  it('with no shield at full health: one blow, and as soon as it swells the hand ends and no second blow follows (the floor\'s retreat takes the body)', async () => {
    const creeper = mob(7, 'creeper');
    const { bot } = fixture([creeper]);
    bot.attack.mockImplementation(() => { creeper.metadata = Array.from({ length: 19 }, (_, index) => index === 16 ? 1 : 0); });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(entries(bot).some(entry => entry.kind === 'melee' && entry.detail.includes('点火'))).toBe(true));
    for (let tick = 0; tick < 6; tick++) { bot.emit('physicsTick'); await idle(60); }
    expect(bot.attack).toHaveBeenCalledTimes(1);
    expect(bot.activateItem).not.toHaveBeenCalled();
  });

  it('the shield coming down in the middle of the hand ends it at once and gives the lit creeper back to the floor', async () => {
    const { bot } = fixture([mob(7, 'creeper')], { shield: true });
    bot.attack.mockImplementation(() => { bot.inventory.slots[45] = null; bot.usingHeldItem = false; });
    bot.emit('physicsTick');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(entries(bot).some(entry => entry.kind === 'melee' && entry.detail.includes('盾が下りた'))).toBe(true));
    expect(bot.creeperDuel).toBeFalsy();
  });

  it('a creeper out of reach is not walked up to (it swells inside its own reach): no step toward it, no lease', async () => {
    const { bot } = fixture([mob(7, 'creeper', 4.2, 0.5)]);
    bot.emit('physicsTick');
    await idle(80);
    expect(bot.setControlState.mock.calls.some((call: any[]) => call[0] === 'forward' && call[1] === true)).toBe(false);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('with no shield and low health a creeper is not struck', async () => {
    const { bot } = fixture([mob(7, 'creeper')], { health: 6 });
    bot.emit('physicsTick');
    await idle(50);
    expect(bot.attack).not.toHaveBeenCalled();
  });
});

describe('D4: a stopIf end does not drop a following fight or attack item', () => {
  const made = { life: 1, dim: 'overworld' as const, dimSince: 'd', bodyBoot: 'bb', connectionId: 'c', headBoot: 'h', obsSeq: 1 };
  const Q = 't-run:hb-1:41';
  const item = (id: string, hands: unknown[]) => ({ id: `skill:${id}`, kind: 'skill', skill: 'act', arguments: { hands },
    queue: { item: id, after: 'q12', node: null, maxMs: 10_000, startBy: new Date(Date.now() + 60_000).toISOString(), queue: Q, madeIn: made } }) as never;
  const run = (danger: string) => {
    const queue = new BodyQueue();
    queue.begin(item('q12', ['go 1,2,3']));
    queue.waiting.push(item('q13', ['attack target=zombie']), item('q14', ['go 1,2,3']));
    const judged = queue.judgeWaiting({ queue: Q, item: 'q12', unit: { goal: 'partial', end: 'cut', released: true } as never }, danger);
    return { dropped: judged.dropped.map(entry => entry.command.queue?.item), kept: judged.kept.map(entry => entry.command.queue?.item) };
  };
  it('keeps the attack behind stop_if_* and damage_taken, drops the walk', () => {
    for (const danger of ['stop_if_hostile', 'stop_if_hp', 'damage_taken']) expect(run(danger)).toEqual({ dropped: ['q14'], kept: ['q13'] });
  });
  it('keeps the attack behind a cut by the melee reflex (the engagement rule strike), and still drops everything behind any other reflex', () => {
    const queue = () => { const q = new BodyQueue(); q.begin(item('q12', ['go 1,2,3'])); q.waiting.push(item('q13', ['attack target=zombie']), item('q14', ['go 1,2,3'])); return q; };
    const judged = (reflex: string) => {
      const q = queue();
      const out = q.judgeWaiting({ queue: Q, item: 'q12', unit: { goal: 'partial', end: 'cut', released: true, code: 'interrupted_by_reflex', reflex } as never }, 'interrupted_by_reflex');
      return { dropped: out.dropped.map(entry => entry.command.queue?.item), kept: out.kept.map(entry => entry.command.queue?.item) };
    };
    expect(judged('floor-melee')).toEqual({ dropped: ['q14'], kept: ['q13'] });
    for (const reflex of ['floor-flee', 'floor-retreat', 'lava', 'breath']) expect(judged(reflex)).toEqual({ dropped: ['q13', 'q14'], kept: [] });
  });
  it('still drops everything behind a reflex, a fall and the rest', () => {
    for (const danger of ['reflex', 'interrupted_by_reflex', 'fell']) expect(run(danger)).toEqual({ dropped: ['q13', 'q14'], kept: [] });
  });
});
