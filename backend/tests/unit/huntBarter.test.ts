import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BARTER_APPROACH, BARTER_AT_ONCE, barterMany, barterRound, barterWithPiglin, isAdultPiglin, isAngryPiglin, reachTo, wearsGoldArmour } from '../../src/services/minebot/utils/huntBarter.js';
import { use } from '../../src/services/minebot/utils/primitives/use.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// The walk up to a piglin is the walk's (a real route search): here it is a stand-in that the tests steer.
const walk = vi.hoisted(() => ({ goWith: vi.fn() }));
vi.mock('../../src/services/minebot/utils/primitives/walk.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/minebot/utils/primitives/walk.js')>()), goWith: walk.goWith, walkMovements: () => ({}),
}));
const GAVE_UP = { reached: false, timedOut: true, stuck: false, error: null, search: null, opens: [] as string[] };
const ARRIVED = { reached: true, timedOut: false, stuck: false, error: null, search: null, opens: [] as string[] };
beforeEach(() => { walk.goWith.mockReset(); walk.goWith.mockResolvedValue(GAVE_UP); });

// Bartering gold with a piglin (S2, 2026-11-02): one exchange, whole. The piglin here follows the game's rule that matters to the hand: an adult that is not angry and not
// already looking at gold takes an ingot, holds it in its off hand while it looks, then lets go and throws what it gives back toward the player.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const KEYS = ['shared_flags', 'air', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'mob_flags', 'living_entity_flags', 'health', 'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'immune_to_zombification', 'baby', 'dancing'];
const registry = { entitiesByName: { piglin: { metadataKeys: KEYS } } };

interface PiglinSpec { baby?: boolean; angry?: boolean; busy?: boolean; refuses?: boolean; admireMs?: number; gives?: Array<{ name: string; count: number }>; at?: Vec3 }

function world(spec: PiglinSpec = {}, options: { gold?: number; wearGold?: boolean; lyingBefore?: boolean } = {}) {
  const piglin: any = { id: 30, name: 'piglin', type: 'hostile', position: (spec.at ?? new Vec3(101.5, 70, 100.5)).clone(), height: 1.95, width: 0.6, isValid: true,
    equipment: [null, spec.busy ? { name: 'gold_ingot' } : null, null, null, null, null], metadata: KEYS.map(() => false) };
  piglin.metadata[KEYS.indexOf('baby')] = !!spec.baby;
  piglin.metadata[KEYS.indexOf('mob_flags')] = spec.angry ? 4 : 0;
  const slots: any[] = new Array(46).fill(null);
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, entity: { position: new Vec3(100.5, 70, 100.5), yaw: 0, pitch: 0, onGround: true }, entities: { 30: piglin } as Record<string, any>,
    heldItem: { name: 'gold_ingot', count: options.gold ?? 3 }, _gold: options.gold ?? 3, _pack: new Map<string, number>(), nextId: 100, thrown: [] as any[],
    inventory: { slots, items: () => [...(bot._gold > 0 ? [{ name: 'gold_ingot', count: bot._gold }] : []), ...[...bot._pack].map(([name, count]) => ({ name, count }))] },
    lookAt: async () => undefined, look: async () => undefined, setControlState: () => undefined, clearControlStates: () => undefined,
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    activateEntity: async (target: any) => {
      if (target !== piglin || spec.refuses || spec.baby || spec.angry || piglin.equipment[1]) return;
      bot._gold--; piglin.equipment[1] = { name: 'gold_ingot' }; bot.emit('entityEquip', piglin);
      setTimeout(() => {
        piglin.equipment[1] = null; bot.emit('entityEquip', piglin);
        for (const give of spec.gives ?? [{ name: 'iron_nugget', count: 12 }]) {
          // Thrown toward the player: it lands at the player's feet and the game takes it into the pack.
          const item: any = { id: bot.nextId++, name: 'item', position: new Vec3(100.7, 70.2, 100.5), getDroppedItem: () => give };
          bot.entities[item.id] = item; bot.emit('entitySpawn', item);
          setTimeout(() => { delete bot.entities[item.id]; bot._pack.set(give.name, (bot._pack.get(give.name) ?? 0) + give.count); }, 60);
        }
      }, spec.admireMs ?? 120);
    },
  });
  if (options.wearGold) slots[8] = { name: 'golden_boots' };
  if (options.lyingBefore) bot.entities[7] = { id: 7, name: 'item', position: new Vec3(100.9, 70, 100.5), getDroppedItem: () => ({ name: 'cobblestone', count: 4 }) };
  return { bot, piglin };
}
const context = (bot: any): StepContext => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north', base: { x: 100, y: 70, z: 100 } });

describe('what the game\'s data says of a piglin', () => {
  it('adult or baby, angry or not, from the flags by their names', () => {
    const { piglin } = world({ baby: true, angry: true });
    expect(isAdultPiglin(registry, piglin)).toBe(false);
    expect(isAngryPiglin(registry, piglin)).toBe(true);
    expect(isAdultPiglin(registry, world().piglin)).toBe(true);
    expect(isAngryPiglin(registry, world().piglin)).toBe(false);
    expect(isAdultPiglin({}, piglin)).toBeNull();
  });
  it('gold armour is any of the four armour places holding a golden piece', () => {
    expect(wearsGoldArmour(world({}, { wearGold: true }).bot)).toBe(true);
    expect(wearsGoldArmour(world().bot)).toBe(false);
  });
});

describe('barterWithPiglin: one exchange', () => {
  it('the ingot is spent, the piglin looks it over, what it throws back is taken, and the line says what came', async () => {
    const { bot, piglin } = world({ gives: [{ name: 'iron_nugget', count: 12 }, { name: 'ender_pearl', count: 5 }] });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('金 3→2');
    expect(result.text).toContain('iron_nugget+12');
    expect(result.text).toContain('ender_pearl+5');
    expect(bot._gold).toBe(2);
    expect(bot._pack.get('ender_pearl')).toBe(5);
  });

  it('a baby takes no gold: not_adult, at once, and the ingot is not offered', async () => {
    const { bot, piglin } = world({ baby: true });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'not_adult' });
    expect(bot._gold).toBe(3);
  });

  it('an angry piglin is not offered gold, and the line says whether gold armour is worn', async () => {
    const bare = await barterWithPiglin(context(world({ angry: true }).bot), world({ angry: true }).piglin);
    expect(bare).toMatchObject({ ok: false, reason: 'piglin_hostile' });
    expect(bare.text).toContain('金の防具を着ていない');
    const w = world({ angry: true }, { wearGold: true });
    const dressed = await barterWithPiglin(context(w.bot), w.piglin);
    expect(dressed.text).toContain('金の防具は着ている');
  });

  it('too far for the hand to walk (beyond the approach): out_of_reach, with the distance, and no walk', async () => {
    const { bot, piglin } = world({ at: new Vec3(112.5, 70, 100.5) });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(result.text).toMatch(/12\.0m 先、体から 11\.\dm/u);
    expect(result.text).toContain(`${BARTER_APPROACH}m までなら手が歩いて近づく`);
    expect(walk.goWith).not.toHaveBeenCalled();
    expect(bot._gold).toBe(3);
  });

  it('a piglin out of reach but near is walked up to, then the exchange is made', async () => {
    const { bot, piglin } = world({ at: new Vec3(106.5, 70, 100.5), gives: [{ name: 'iron_nugget', count: 9 }] });
    walk.goWith.mockImplementation(async (_ctx: unknown, goal: any) => {
      expect(goal.x).toBe(Math.floor(piglin.position.x));
      bot.entity.position = new Vec3(piglin.position.x - 1.6, 70, piglin.position.z);
      return ARRIVED;
    });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('iron_nugget+9');
    expect(walk.goWith).toHaveBeenCalledTimes(1);
  });

  it('a walk that gets nowhere leaves the piglin out of reach, and the line says the hand could not get near', async () => {
    const { bot, piglin } = world({ at: new Vec3(106.5, 70, 100.5) });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(result.text).toContain('近づけなかった');
    expect(bot._gold).toBe(3);
  });

  it('a piglin that is gone when the body arrives is target_not_found, the ingot not offered', async () => {
    const { bot, piglin } = world({ at: new Vec3(106.5, 70, 100.5) });
    walk.goWith.mockImplementation(async () => { delete bot.entities[30]; return ARRIVED; });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'target_not_found' });
    expect(bot._gold).toBe(3);
  });

  it('no ingot in the pack: missing_item', async () => {
    const { bot, piglin } = world({}, { gold: 0 });
    expect(await barterWithPiglin(context(bot), piglin)).toMatchObject({ ok: false, reason: 'missing_item' });
  });

  it('an offer the piglin does not take is not_accepted (the ingot stays), and the line says why it may be', async () => {
    const { bot, piglin } = world({ refuses: true });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'not_accepted' });
    expect(result.text).toContain('金 3個のまま');
  });

  it('a piglin still looking at its last gold is waited for, then the new offer is made', async () => {
    const { bot, piglin } = world({ busy: true });
    setTimeout(() => { piglin.equipment[1] = null; bot.emit('entityEquip', piglin); }, 150);
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result.ok).toBe(true);
    expect(bot._gold).toBe(2);
  });

  it('an item that lay about before the offer is not the piglin\'s answer and is not taken for it', async () => {
    const { bot, piglin } = world({ gives: [{ name: 'obsidian', count: 1 }] }, { lyingBefore: true });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('obsidian+1');
    expect(result.text).not.toContain('cobblestone');
    expect(bot.entities[7]).toBeDefined();
  });

  it('a piglin that lets go and throws nothing we can see is barter_nothing_returned, not a success', async () => {
    const { bot, piglin } = world({ gives: [] });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'nothing_returned', code: 'barter_nothing_returned' });
  });

  it('one that lets go long before its six seconds were over (hurt, angered) keeps the gold: the line says so, and that it is angry now', async () => {
    const { bot, piglin } = world({ gives: [], admireMs: 200 });
    setTimeout(() => { piglin.metadata[8] = 4; }, 150);
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'nothing_returned' });
    expect(result.text).toMatch(/金を 0\.\d秒で手放した/u);
    expect(result.text).toContain('ピグリンは怒っている');
    expect(result.text).toContain('見終わる前に手放すと何も返さない');
  });

  it('one that looked for its time and threw something out of sight is not called angry', async () => {
    const { bot, piglin } = world({ gives: [], admireMs: 4300 });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'nothing_returned' });
    expect(result.text).toContain('投げた物が見えなかった');
    expect(result.text).not.toContain('怒っている');
  }, 20_000);
});

describe('reachTo: the game measures the reach to the creature\'s box', () => {
  const box = (x: number, y: number, z: number) => ({ position: { x, y, z }, width: 0.6, height: 1.95 });
  it('from the side it is the distance less the half width; level with the box it has no height part', () => {
    expect(reachTo({ x: 100.5, y: 71.62, z: 100.5 }, box(103.5, 70, 100.5))).toBeCloseTo(2.7, 5);
  });
  it('above the box it is the height over the top; inside it, zero', () => {
    expect(reachTo({ x: 100.5, y: 74, z: 100.5 }, box(100.5, 70, 100.5))).toBeCloseTo(74 - 71.95, 5);
    expect(reachTo({ x: 100.5, y: 70.5, z: 100.6 }, box(100.5, 70, 100.5))).toBe(0);
  });
  it('a corner is the diagonal of the three parts', () => {
    expect(reachTo({ x: 0, y: 0, z: 0 }, { position: { x: 4.3, y: 3, z: 5.3 }, width: 0.6, height: 2 })).toBeCloseTo(Math.hypot(4, 3, 5), 5);
  });
});

describe('use item=gold_ingot on a piglin (the hand)', () => {
  it('is the whole exchange, not a right click and a guess', async () => {
    const { bot } = world({ gives: [{ name: 'gravel', count: 22 }] });
    const result = await use(context(bot), { item: 'gold_ingot', entity: 'piglin' });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('gravel+22');
  });

  it('any other item on a creature is still the plain right click', async () => {
    const { bot } = world();
    bot.heldItem = { name: 'wheat', count: 1 };
    bot.inventory.items = () => [{ name: 'wheat', count: 1 }];
    let used = 0;
    bot.useOn = () => { used++; };
    const result = await use(context(bot), { item: 'wheat', entity: 'piglin' });
    expect(result.ok).toBe(true);
    expect(used).toBe(1);
  });
});

// S6 (11/5): count=N is up to N ingots in the one hand. The seed's barter sequence is fixed (c1: 24 ingots, 9 pearls), and one ingot per act put a head's turn between each two.
describe('use item=gold_ingot target=piglin count=N (barterMany)', () => {
  it('delivers count through the public act hand and actually exchanges that many ingots', async () => {
    const { bot } = world({ gives: [{ name: 'ender_pearl', count: 2 }] }, { gold: 4 });
    const hands = ACT_HANDS.parse([{ do: 'use', item: 'gold_ingot', target: '#30', count: 3 }]);
    const result = await runAct(bot, hands, undefined, undefined, { maxMs: 20_000, tickMs: 25 });
    expect(result.success).toBe(true);
    expect(bot._gold).toBe(1);
    expect(bot._pack.get('ender_pearl')).toBe(6);
    const report = JSON.parse(result.result);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({ do: 'use', status: 'done', progress: { unit: 'item', done: 3, left: 0 } });
  }, 20_000);

  it('gives the ingots one round after another to the piglin in reach and takes every answer', async () => {
    const { bot } = world({ gives: [{ name: 'ender_pearl', count: 2 }] }, { gold: 5 });
    const result = await use(context(bot), { item: 'gold_ingot', entity: 'piglin', count: 3 });
    expect(result.ok).toBe(true);
    expect(bot._gold).toBe(2);
    expect(bot._pack.get('ender_pearl')).toBe(6);
    expect(result.text).toContain('3/3');
    expect(result.text).toContain('パール +6');
  }, 20_000);

  it('stops when the gold is out, saying so, with what was given', async () => {
    const { bot, piglin } = world({}, { gold: 2 });
    const result = await barterMany(context(bot), piglin, 5);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('2/5');
    expect(result.text).toContain('金が尽きた');
  }, 20_000);

  it('an angry piglin is given nothing: not_accepted or out_of_reach, the gold kept', async () => {
    const { bot, piglin } = world({ angry: true }, { gold: 4 });
    const result = await barterMany(context(bot), piglin, 4);
    expect(result.ok).toBe(false);
    expect(bot._gold).toBe(4);
  }, 20_000);

  it('a round takes the calm adults in reach, nearest first, at most three, none already looking at gold', () => {
    const { bot } = world();
    const mk = (id: number, x: number, extra: Record<string, unknown> = {}) => {
      const p: any = { ...bot.entities[30], id, position: new Vec3(x, 70, 100.5), equipment: [null, null, null, null, null, null], metadata: [...bot.entities[30].metadata], ...extra };
      bot.entities[id] = p; return p;
    };
    mk(31, 102.0); mk(32, 99.0); mk(33, 102.4); mk(34, 101.0, { equipment: [null, { name: 'gold_ingot' }, null, null, null, null] }); mk(35, 110.5);
    const round = barterRound(bot);
    expect(round.length).toBe(BARTER_AT_ONCE);
    expect(round.map((p: any) => p.id)).not.toContain(34);
    expect(round.map((p: any) => p.id)).not.toContain(35);
  });
});
