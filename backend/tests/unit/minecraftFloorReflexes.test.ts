import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { executeAction, physicalActionBusy } from '../../src/services/minebot/execution/ActionExecution.js';
import { creeperLit, floorArmorChoice, floorEatChoice, floorRetreatTick, retreatThreat, type FloorBody, type RetreatState } from '../../src/services/minebot/utils/floorReflexes.js';

function body(patch: Partial<FloorBody> & { items?: { name: string }[]; slots?: ({ name: string } | null)[] } = {}) {
  const keys: Record<string, boolean> = {}, looks: number[] = [];
  const self = { id: 1, name: 'player', position: new Vec3(0, 64, 0) };
  const bot: FloorBody & { keys: Record<string, boolean>; looks: number[] } = {
    entity: self, entities: { 1: self }, health: 20, food: 20, heldItem: null,
    inventory: { items: () => patch.items ?? [], slots: patch.slots ?? new Array(46).fill(null) },
    setControlState: (key, value) => { keys[key] = value; }, look: yaw => { looks.push(yaw); },
    on: () => undefined, keys, looks, ...patch,
  };
  return bot;
}
const retreat = (): RetreatState => ({ engaged: false, ticks: 0, cooldown: 0, engagements: 0 });
const add = (bot: FloorBody, id: number, entity: Record<string, unknown>) => { bot.entities![id] = { id, ...entity } as any; };

describe('floor reflexes (ADR-0010 D8, defence only)', () => {
  it('reads a lit creeper from its fuse state or its ignited flag', () => {
    const meta = (index: number, value: unknown) => { const m: unknown[] = []; m[index] = value; return m; };
    expect(creeperLit({ position: new Vec3(0, 0, 0), metadata: meta(16, 1) })).toBe(true);
    expect(creeperLit({ position: new Vec3(0, 0, 0), metadata: meta(18, true) })).toBe(true);
    expect(creeperLit({ position: new Vec3(0, 0, 0), metadata: meta(16, -1) })).toBe(false);
    expect(creeperLit({ position: new Vec3(0, 0, 0) })).toBe(false);
  });
  it('steps straight away from a lit creeper for at most a second, then lets go and waits before engaging again', () => {
    const bot = body(), state = retreat(), lit: unknown[] = []; lit[16] = 1;
    add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    expect(bot.keys.forward && bot.keys.sprint).toBe(true);
    // Facing away from the creeper on +x: mineflayer yaw for -x is +PI/2.
    expect(Math.abs(Math.sin(bot.looks[0]) - 1)).toBeLessThan(1e-9);
    let outcome = null;
    for (let tick = 0; tick < 25 && outcome !== 'released'; tick++) outcome = floorRetreatTick(bot, state);
    expect(outcome).toBe('released');
    expect(bot.keys.forward || bot.keys.sprint).toBe(false);
    expect(floorRetreatTick(bot, state)).toBeNull();
    expect(state.engagements).toBe(1);
  });
  it('ends the retreat after three blocks', () => {
    const bot = body(), state = retreat(), lit: unknown[] = []; lit[18] = true;
    add(bot, 2, { name: 'creeper', position: new Vec3(2, 64, 0), metadata: lit });
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    bot.entity!.position = new Vec3(-3.1, 64, 0);
    expect(floorRetreatTick(bot, state)).toBe('released');
  });
  it('ignores an unlit creeper and anything further than its reach', () => {
    const bot = body();
    add(bot, 2, { name: 'creeper', position: new Vec3(2, 64, 0), metadata: [] });
    const far: unknown[] = []; far[16] = 1;
    add(bot, 3, { name: 'creeper', position: new Vec3(8, 64, 0), metadata: far });
    expect(retreatThreat(bot)).toBeNull();
  });
  it('sidesteps an arrow flying at the chest, unless a shield is held (the shield reflex takes it)', () => {
    const bot = body();
    add(bot, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(bot)?.kind).toBe('arrow');
    // The tick follows each arrow: it engages once the arrow is seen moving (one physics tick, 50 ms, after it appears).
    const state = retreat();
    expect(floorRetreatTick(bot, state)).toBeNull();
    bot.entities![2].position = new Vec3(6, 65, 0);
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    expect(bot.keys.left).toBe(true);
    const shielded = body({ slots: Object.assign(new Array(46).fill(null), { 45: { name: 'shield' } }) });
    add(shielded, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(shielded)).toBeNull();
    const away = body();
    add(away, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(2, 0, 0) });
    expect(retreatThreat(away)).toBeNull();
  });
  it('`floor` mode (wide = false) is exactly the production meal: food <= 6, or health <= 12 and food < 18, never with an enemy at arm\'s length', () => {
    const items = [{ name: 'bread' }, { name: 'cooked_beef' }, { name: 'rotten_flesh' }, { name: 'pufferfish' }];
    expect(floorEatChoice(body({ items, food: 14, health: 20 }), false)).toBeNull();
    expect(floorEatChoice(body({ items, food: 17, health: 20 }), false)).toBeNull();
    expect(floorEatChoice(body({ items, food: 6 }), false)?.name).toBe('cooked_beef');
    expect(floorEatChoice(body({ items, food: 17, health: 12 }), false)?.name).toBe('cooked_beef');
    expect(floorEatChoice(body({ items, food: 17, health: 13 }), false)).toBeNull();
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }], food: 10, health: 10 }), false)).toBeNull();
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }], food: 5 }), false)?.name).toBe('rotten_flesh');
    expect(floorEatChoice(body({ items: [{ name: 'pufferfish' }], food: 2 }), false)).toBeNull();
    const threatened = body({ items, food: 5, health: 15 });
    add(threatened, 2, { name: 'zombie', position: new Vec3(2, 64, 0) });
    expect(floorEatChoice(threatened, false)).toBeNull();
    // Standing to eat next to an enemy killed the body (L18): not even when nearly dead.
    const dying = body({ items, food: 5, health: 5 });
    add(dying, 2, { name: 'zombie', position: new Vec3(2, 64, 0) });
    expect(floorEatChoice(dying, false)).toBeNull();
    expect(floorEatChoice(body({ items: [{ name: 'enchanted_golden_apple' }], food: 2 }), false)).toBeNull();
    // `floor` ignores the pathfinder and the running command altogether.
    expect(floorEatChoice(body({ items, food: 6, pathfinder: { isMoving: () => true } }), false)?.name).toBe('cooked_beef');
  });
  it('the default meal: food 14 or less, or health 10 or less and food below 18 (run 16 ate at 16 and 17, and at health 15, raw)', () => {
    const items = [{ name: 'bread' }, { name: 'cooked_beef' }, { name: 'rotten_flesh' }, { name: 'pufferfish' }];
    expect(floorEatChoice(body({ items, food: 18, health: 20 }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 17, health: 20 }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 15, health: 20 }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 14, health: 20 }))?.name).toBe('cooked_beef');
    expect(floorEatChoice(body({ items, food: 17, health: 10 }))?.name).toBe('cooked_beef');
    expect(floorEatChoice(body({ items, food: 17, health: 11 }))).toBeNull();   // a scratch is not a reason to eat
    expect(floorEatChoice(body({ items, food: 19, health: 15 }))).toBeNull();   // run 16's meal at 15 health
    expect(floorEatChoice(body({ items, food: 18, health: 10 }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 20, health: 10 }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 6 }))?.name).toBe('cooked_beef');
    // Poisonous food is avoided as before (the legacy skill ate anything); rotten flesh only when starving.
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }], food: 10, health: 10 }))).toBeNull();
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }], food: 5 }))?.name).toBe('rotten_flesh');
    expect(floorEatChoice(body({ items: [{ name: 'pufferfish' }], food: 2 }))).toBeNull();
    expect(floorEatChoice(body({ items: [{ name: 'enchanted_golden_apple' }], food: 2 }))).toBeNull();
  });
  it('the default meal is cooked first; raw meat only when nothing else is carried and the meal cannot wait (run 16 ate raw six times)', () => {
    const mixed = [{ name: 'mutton' }, { name: 'chicken' }, { name: 'cooked_mutton' }, { name: 'apple' }];
    expect(floorEatChoice(body({ items: mixed, food: 14 }))?.name).toBe('cooked_mutton');
    // Anything not raw comes before raw meat, whatever the points.
    expect(floorEatChoice(body({ items: [{ name: 'beef' }, { name: 'apple' }], food: 14 }))?.name).toBe('apple');
    const raw = [{ name: 'mutton' }, { name: 'chicken' }];
    expect(floorEatChoice(body({ items: raw, food: 14, health: 20 }))).toBeNull();   // left to be cooked
    expect(floorEatChoice(body({ items: raw, food: 10, health: 10 }))).toBeNull();
    expect(floorEatChoice(body({ items: raw, food: 6 }))?.name).toBe('mutton');       // starving: whatever there is
    expect(floorEatChoice(body({ items: raw, food: 12, health: 8 }))?.name).toBe('mutton'); // health in danger
    // Rotten flesh (hunger) after raw meat, though it fills more.
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }, { name: 'beef' }], food: 5 }))?.name).toBe('beef');
    // `floor` mode (the production floor of 10/16) is unchanged.
    expect(floorEatChoice(body({ items: raw, food: 6, health: 20 }), false)?.name).toBe('mutton');
  });
  it('the default meal keeps the safety gates: no meal with an enemy within 5 m, critical or not (the safer of the legacy skill and the floor)', () => {
    const items = [{ name: 'bread' }];
    const near = (patch: Partial<FloorBody>, x = 4) => { const b = body({ items, ...patch }); add(b, 2, { name: 'zombie', position: new Vec3(x, 64, 0) }); return b; };
    expect(floorEatChoice(near({ food: 10 }, 4))).toBeNull();
    expect(floorEatChoice(near({ food: 10 }, 6))?.name).toBe('bread');
    expect(floorEatChoice(near({ food: 5, health: 5 }, 4))).toBeNull();
    expect(floorEatChoice(near({ food: 3, health: 20 }, 2))).toBeNull();
    expect(floorEatChoice({ ...body({ items, food: 3 }), entity: { id: 1, name: 'player', position: new Vec3(0, 64, 0), isInLava: true } })).toBeNull();
  });
  it('the default meal while walking: only at health 8 or less, or food 6 or less (the legacy rule)', () => {
    const items = [{ name: 'bread' }], moving = { isMoving: () => true }, still = { isMoving: () => false };
    expect(floorEatChoice(body({ items, food: 14, pathfinder: moving }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 14, pathfinder: still }))?.name).toBe('bread');
    expect(floorEatChoice(body({ items, food: 7, pathfinder: moving }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 6, pathfinder: moving }))?.name).toBe('bread');
    expect(floorEatChoice(body({ items, food: 17, health: 9, pathfinder: moving }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 17, health: 8, pathfinder: moving }))?.name).toBe('bread');
  });
  it('the default top-up waits for an idle body: not while a command runs or waits, but a critical meal does not', async () => {
    const items = [{ name: 'bread' }];
    const bot = body({ items, food: 14 });
    expect(floorEatChoice(bot)?.name).toBe('bread');
    let finish!: () => void;
    const work = executeAction(bot as any, 'mine-block', 0, async () => { await new Promise<void>(resolve => { finish = resolve; }); return { success: true, result: 'done' }; }, {});
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(physicalActionBusy(bot)).toBe(true);
    expect(floorEatChoice(bot)).toBeNull();                    // food 14, a command runs: no top-up
    expect(floorEatChoice(bot, false)).toBeNull();             // (floor: food 14 is no meal at all)
    bot.food = 7; expect(floorEatChoice(bot)).toBeNull();      // still a top-up
    bot.food = 6; expect(floorEatChoice(bot)?.name).toBe('bread');   // critical: not held back here (the tick decides whether to cut)
    bot.food = 20; bot.health = 6; expect(floorEatChoice(bot)).toBeNull();  // full food, nothing to eat for
    // Health 6 at food 18 or 19 gains next to nothing from a meal: a top-up, held back while a command runs (fifth review, M1).
    bot.food = 19; expect(floorEatChoice(bot)).toBeNull();
    bot.food = 17; expect(floorEatChoice(bot)?.name).toBe('bread');
    finish(); await work;
    bot.food = 14; bot.health = 20; expect(floorEatChoice(bot)?.name).toBe('bread');
  });
  it('leaves the keys to the lava and breathing reflexes while either holds them', () => {
    const bot = body(), state = retreat(), lit: unknown[] = []; lit[16] = 1;
    add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
    bot.breathingReflex = { engaged: true };
    expect(floorRetreatTick(bot, state)).toBeNull();
    expect(bot.keys.forward).toBeUndefined();
    bot.breathingReflex = { engaged: false }; bot.lavaReflex = { engaged: true };
    expect(floorRetreatTick(bot, state)).toBeNull();
    bot.lavaReflex = { engaged: false };
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    bot.lavaReflex = { engaged: true };
    expect(floorRetreatTick(bot, state)).toBe('released');
  });
  it('ignores an arrow that has stopped moving, whatever velocity it last reported', () => {
    const bot = body(), arrows = new Map();
    add(bot, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(bot, arrows)).toBeNull();
    expect(retreatThreat(bot, arrows)).toBeNull();
    bot.entities![2].position = new Vec3(6, 65, 0);
    expect(retreatThreat(bot, arrows)?.kind).toBe('arrow');
  });
  it('wears the best armour into an empty slot and never swaps a worn piece', () => {
    const items = [{ name: 'leather_chestplate' }, { name: 'iron_chestplate' }, { name: 'diamond_helmet' }];
    expect(floorArmorChoice(body({ items }))).toEqual({ item: { name: 'diamond_helmet' }, destination: 'head' });
    const slots = new Array(46).fill(null); slots[5] = { name: 'leather_helmet' };
    expect(floorArmorChoice(body({ items, slots }))).toEqual({ item: { name: 'iron_chestplate' }, destination: 'torso' });
    const full = new Array(46).fill(null); for (const i of [5, 6, 7, 8]) full[i] = { name: 'leather_x' };
    expect(floorArmorChoice(body({ items, slots: full }))).toBeNull();
    // A shield goes into an empty off-hand (the shield reflex blocks with an off-hand shield only); a held one stays.
    expect(floorArmorChoice(body({ items: [{ name: 'shield' }], slots: full }))).toEqual({ item: { name: 'shield' }, destination: 'off-hand' });
    const holding = [...full]; holding[45] = { name: 'torch' };
    expect(floorArmorChoice(body({ items: [{ name: 'shield' }], slots: holding }))).toBeNull();
    const shield = { name: 'shield' };
    expect(floorArmorChoice(body({ items: [shield], slots: full, heldItem: shield as any }))).toBeNull();
  });
});
