import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { barterWithPiglin, isAdultPiglin, isAngryPiglin, wearsGoldArmour } from '../../src/services/minebot/utils/huntBarter.js';
import { use } from '../../src/services/minebot/utils/primitives/use.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

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

  it('too far to reach: out_of_reach, with the distance', async () => {
    const { bot, piglin } = world({ at: new Vec3(106.5, 70, 100.5) });
    const result = await barterWithPiglin(context(bot), piglin);
    expect(result).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(result.text).toMatch(/目から \d\.\dm/u);
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
