import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
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
    const state = retreat();
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    expect(bot.keys.left).toBe(true);
    const shielded = body({ slots: Object.assign(new Array(46).fill(null), { 45: { name: 'shield' } }) });
    add(shielded, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(shielded)).toBeNull();
    const away = body();
    add(away, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(2, 0, 0) });
    expect(retreatThreat(away)).toBeNull();
  });
  it('eats only when short, best food first, never with an enemy at arm\'s length unless nearly dead', () => {
    const items = [{ name: 'bread' }, { name: 'cooked_beef' }, { name: 'rotten_flesh' }, { name: 'pufferfish' }];
    expect(floorEatChoice(body({ items, food: 14, health: 20 }))).toBeNull();
    expect(floorEatChoice(body({ items, food: 6 }))?.name).toBe('cooked_beef');
    expect(floorEatChoice(body({ items, food: 17, health: 12 }))?.name).toBe('cooked_beef');
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }], food: 10, health: 10 }))).toBeNull();
    expect(floorEatChoice(body({ items: [{ name: 'rotten_flesh' }], food: 5 }))?.name).toBe('rotten_flesh');
    expect(floorEatChoice(body({ items: [{ name: 'pufferfish' }], food: 2 }))).toBeNull();
    const threatened = body({ items, food: 5, health: 15 });
    add(threatened, 2, { name: 'zombie', position: new Vec3(2, 64, 0) });
    expect(floorEatChoice(threatened)).toBeNull();
    const dying = body({ items, food: 5, health: 5 });
    add(dying, 2, { name: 'zombie', position: new Vec3(2, 64, 0) });
    expect(floorEatChoice(dying)?.name).toBe('cooked_beef');
  });
  it('wears the best armour into an empty slot and never swaps a worn piece', () => {
    const items = [{ name: 'leather_chestplate' }, { name: 'iron_chestplate' }, { name: 'diamond_helmet' }];
    expect(floorArmorChoice(body({ items }))).toEqual({ item: { name: 'diamond_helmet' }, destination: 'head' });
    const slots = new Array(46).fill(null); slots[5] = { name: 'leather_helmet' };
    expect(floorArmorChoice(body({ items, slots }))).toEqual({ item: { name: 'iron_chestplate' }, destination: 'torso' });
    const full = new Array(46).fill(null); for (const i of [5, 6, 7, 8]) full[i] = { name: 'leather_x' };
    expect(floorArmorChoice(body({ items, slots: full }))).toBeNull();
  });
});
