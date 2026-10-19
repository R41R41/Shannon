import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  describeLastDeath, DIGEST_CHARACTERS, DRAGON_PLACES, emptyPlaceMemory, MAX_PLACES, parsePlaceMemory, placesDigest, recordDeath, rememberPlace,
} from '../../src/modules/minecraftLearning/places.js';
import { installPlaceMemory } from '../../src/services/minebot/utils/placeMemory.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';

const overworld = 'overworld';
const here = { dimension: overworld, position: { x: 0, y: 64, z: 0 } };

describe('what a long journey comes back to is never given up for room (run 15: 1,500 places of ore, water and lava in half an hour)', () => {
  it('keeps portals, villages, structures, the base and the newest deaths, and gives up the far and old ore first', () => {
    const state = emptyPlaceMemory();
    const t0 = 1_000_000;
    rememberPlace(state, { kind: 'nether_portal', dimension: overworld, position: { x: 900, y: 64, z: 0 }, note: '↔nether(112,70,0)', keep: 'portal' }, t0);
    rememberPlace(state, { kind: 'village', dimension: overworld, position: { x: -800, y: 70, z: 0 } }, t0);
    rememberPlace(state, { kind: 'crafting_table', dimension: overworld, position: { x: 700, y: 64, z: 0 }, keep: 'base' }, t0);
    for (let n = 0; n < 7; n++) rememberPlace(state, { kind: 'death', dimension: overworld, position: { x: n * 50, y: 64, z: 500 } }, t0 + n);
    // Ore near the body seen just now, and ore far off seen long ago.
    rememberPlace(state, { kind: 'iron_ore', dimension: overworld, position: { x: 3, y: 40, z: 3 } }, t0 + 60 * 60_000, here);
    for (let n = 0; n < MAX_PLACES; n++) rememberPlace(state, { kind: 'coal_ore', dimension: overworld, position: { x: 2000 + n * 10, y: 30, z: 0 } }, t0 + n, here);
    expect(state.places).toHaveLength(MAX_PLACES);
    for (const kind of ['nether_portal', 'village', 'crafting_table', 'iron_ore']) expect(state.places.some(place => place.kind === kind)).toBe(true);
    // The five newest deaths stay; the two oldest could go (coal was the crowded kind, so they did not need to).
    expect(state.places.filter(place => place.kind === 'death').length).toBeGreaterThanOrEqual(5);
    // Of the coal, what lies furthest off went first; the nearest stays.
    expect(state.places.some(place => place.kind === 'coal_ore' && place.position.x === 2000)).toBe(true);
    expect(state.places.some(place => place.kind === 'coal_ore' && place.position.x === 2000 + (MAX_PLACES - 1) * 10)).toBe(false);
  });

  it('takes one portal as one place, and the frames round an end portal as one', () => {
    const state = emptyPlaceMemory();
    for (const [x, y] of [[0, 64], [1, 64], [0, 65], [1, 65], [0, 66], [1, 66]]) rememberPlace(state, { kind: 'nether_portal', dimension: overworld, position: { x, y, z: 0 } }, 1);
    for (let n = 0; n < 12; n++) rememberPlace(state, { kind: 'end_portal_frame', dimension: overworld, position: { x: 100 + (n % 5), y: 30, z: (n * 7) % 5 } }, 1);
    expect(state.places.map(place => place.kind)).toEqual(['nether_portal', 'end_portal_frame']);
  });
});

describe('the remembered places fit what a decision keeps, with what the task needs first', () => {
  it('stays within 560 characters of JSON however many kinds there are (the summary drops a part over 600 whole)', () => {
    const state = emptyPlaceMemory();
    const kinds = ['water', 'lava', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore', 'furnace', 'chest'];
    kinds.forEach((kind, n) => rememberPlace(state, { kind, dimension: overworld, position: { x: -1000 - n * 37, y: -54, z: 1000 + n * 41 } }, 1));
    const digest = placesDigest(state, here.position, overworld, 10);
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_CHARACTERS);
    expect(Object.keys(digest).length).toBeGreaterThan(5);
  });

  it('for the dragon, puts the base, the portal with its pair, the stronghold, the fortress and the village first', () => {
    const state = emptyPlaceMemory();
    for (let n = 0; n < 12; n++) rememberPlace(state, { kind: `kind_${n}`, dimension: overworld, position: { x: n, y: 64, z: n } }, 1);
    rememberPlace(state, { kind: 'bed', dimension: overworld, position: { x: 400, y: 64, z: 0 }, keep: 'respawn', note: 'リスポーン地点' }, 1);
    rememberPlace(state, { kind: 'nether_portal', dimension: overworld, position: { x: 600, y: 64, z: 0 }, keep: 'portal', note: '↔nether(-1234,64,-5678)' }, 1);
    rememberPlace(state, { kind: 'stronghold', dimension: overworld, position: { x: 1500, y: 20, z: -900 } }, 1);
    rememberPlace(state, { kind: 'village', dimension: overworld, position: { x: -300, y: 70, z: 10 } }, 1);
    const digest = placesDigest(state, here.position, overworld, 10, { ensure: DRAGON_PLACES });
    expect(digest.base).toBe('400m 東 (400,64,0) bed リスポーン地点');
    expect(digest.nether_portal).toContain('↔nether(-1234,64,-5678)');
    expect(digest.stronghold).toBeDefined(); expect(digest.village).toBeDefined();
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_CHARACTERS);
  });
});

describe('a death kept as one record (run 15 died four times and never went back)', () => {
  it('says how long ago, where, of what, what was dropped and how long it may still lie there', () => {
    const state = emptyPlaceMemory();
    const at = 10_000_000;
    recordDeath(state, { at, dimension: overworld, position: { x: 100, y: 64, z: -20 }, cause: 'Shannon was slain by Zombie',
      lost: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bread', count: 5 }, { name: 'coal', count: 9 }, { name: 'torch', count: 12 }, { name: 'cobblestone', count: 64 }], nearMs: 60_000 });
    const line = describeLastDeath(state, at + 3 * 60_000, here)!;
    expect(line).toMatch(/^3分前 overworld \(100,64,-20\) 102m 東「/);
    expect(line).toContain('「Shannon was slain by Zombie」');
    expect(line).toContain('iron_pickaxe×1, bread×5, coal×9, torch×12 ほか1種');
    expect(line).toContain('最長約4分');
    expect(line).toContain('拾いに戻れる');
    expect(line.length).toBeLessThanOrEqual(200);
    state.deaths![0].nearMs = 5 * 60_000;
    expect(describeLastDeath(state, at + 6 * 60_000, here)).toContain('消えた見込み');
    expect(describeLastDeath(state, at + 31 * 60_000, here)).toBeUndefined();
    // Far off the whole time, the items did not age: still worth going back for after half an hour.
    state.deaths![0].nearMs = 0;
    expect(describeLastDeath(state, at + 40 * 60_000, here)).toContain('拾いに戻れる');
    // Read back from disk as written.
    expect(parsePlaceMemory(JSON.parse(JSON.stringify(state))).deaths).toEqual(state.deaths);
  });
});

/** A body enough for the place memory: events, a pack, blocks by position. */
function body() {
  const blocks = new Map<string, { name: string }>();
  const slots: any[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'Shannon', health: 20, game: { dimension: overworld }, entity: { position: new Vec3(10.5, 64, 10.5) },
    registry: { blocksByName: {} }, inventory: { slots }, entities: {},
    blockAt: (position: Vec3) => { const block = blocks.get(position.floored().toString()); return block ? { ...block, position } : { name: 'air', position }; },
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { blocks.set(reference.position.plus(face).toString(), { name: bot.nextPlaced }); }),
  });
  installPlaceMemory(bot);
  const ticks = (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick'); };
  return { bot, blocks, slots, ticks };
}

describe('the body notes its deaths, its base, its portals and its chests as they happen', () => {
  it('records what was carried, the death message in either order, and drops nothing when the pack comes back (keepInventory)', async () => {
    vi.useFakeTimers();
    try {
      const { bot, slots, ticks } = body();
      slots[9] = { name: 'cobblestone', count: 64 }; slots[36] = { name: 'iron_pickaxe', count: 1 }; slots[5] = { name: 'iron_helmet', count: 1 };
      ticks(20);
      bot.emit('message', { translate: 'death.attack.lava', with: [{ toString: () => 'Shannon' }], toString: () => 'Shannon tried to swim in lava' });
      bot.health = 0; slots.length = 0; bot.emit('death');
      const death = bot.placeMemory.state.deaths.at(-1);
      expect(death).toMatchObject({ dimension: overworld, position: { x: 10, y: 64, z: 10 }, cause: 'Shannon tried to swim in lava' });
      expect(death.lost.map((item: any) => item.name)).toEqual(['iron_helmet', 'iron_pickaxe', 'cobblestone']);
      expect(bot.placeMemory.lastDeath()).toContain('拾いに戻れる');
      // Somebody else's death is not ours.
      bot.emit('message', { translate: 'death.attack.mob', with: [{ toString: () => 'Steve' }], toString: () => 'Steve was slain' });
      // Respawned with the pack: nothing lies there.
      bot.health = 20; slots[9] = { name: 'cobblestone', count: 64 }; slots[36] = { name: 'iron_pickaxe', count: 1 };
      bot.emit('spawn'); vi.advanceTimersByTime(2100);
      expect(bot.placeMemory.state.deaths.at(-1).lost).toEqual([]);
      expect(bot.placeMemory.lastDeath()).toContain('何も落としていない');
    } finally { vi.useRealTimers(); }
  });

  it('counts the five minutes only while near, and calls the items gone once back and none are there', () => {
    const { bot, ticks } = body();
    const now = Date.now();
    recordDeath(bot.placeMemory.state, { at: now - 10_000, dimension: overworld, position: { x: 500, y: 64, z: 0 }, lost: [{ name: 'bread', count: 3 }], nearMs: 0 });
    ticks(40);
    expect(bot.placeMemory.state.deaths.at(-1).nearMs).toBe(0); // 490 blocks off
    bot.entity.position = new Vec3(501, 64, 0); bot.entities = { 7: { name: 'item', position: new Vec3(500, 64, 0) } };
    ticks(20);
    expect(bot.placeMemory.state.deaths.at(-1).cleared).toBeUndefined();
    bot.entities = {};
    ticks(20);
    expect(bot.placeMemory.state.deaths.at(-1).cleared).toBe(true);
  });

  it('keeps the first crafting table, bed and furnace it sets down as its base, and the bed of the respawn point', async () => {
    const { bot, blocks } = body();
    bot.nextPlaced = 'crafting_table';
    await bot.placeBlock({ position: new Vec3(12, 63, 10) }, new Vec3(0, 1, 0));
    bot.nextPlaced = 'crafting_table';
    await bot.placeBlock({ position: new Vec3(30, 63, 10) }, new Vec3(0, 1, 0));
    const tables = bot.placeMemory.state.places.filter((place: any) => place.kind === 'crafting_table');
    expect(tables.map((place: any) => place.keep ?? null)).toEqual(['base', null]);
    blocks.set(new Vec3(11, 64, 10).toString(), { name: 'red_bed' });
    bot.emit('message', { translate: 'block.minecraft.set_spawn', toString: () => 'Respawn point set' });
    expect(bot.placeMemory.state.places.find((place: any) => place.kind === 'bed')).toMatchObject({ keep: 'respawn', note: 'リスポーン地点' });
  });

  it('pairs the two ends of a portal gone through', () => {
    const { bot, blocks, ticks } = body();
    blocks.set(new Vec3(10, 64, 10).toString(), { name: 'nether_portal' });
    ticks(5);
    bot.game.dimension = 'the_nether'; bot.entity.position = new Vec3(1.5, 70, 1.5);
    bot.emit('spawn');
    const portals = bot.placeMemory.state.places.filter((place: any) => place.kind === 'nether_portal');
    expect(portals).toEqual([
      expect.objectContaining({ dimension: overworld, position: { x: 10, y: 64, z: 10 }, keep: 'portal', note: '↔nether(1,70,1)' }),
      expect.objectContaining({ dimension: 'the_nether', position: { x: 1, y: 70, z: 1 }, keep: 'portal', note: '↔overworld(10,64,10)' }),
    ]);
  });

  it('notes what a chest holds when it is opened and closed', () => {
    vi.useFakeTimers();
    try {
      const { bot } = body();
      bot.blockAtCursor = () => ({ name: 'chest', position: new Vec3(14, 64, 10) });
      const window: any = { containerItems: () => [{ name: 'iron_ingot', count: 12 }, { name: 'bread', count: 5 }, { name: 'iron_ingot', count: 3 }] };
      bot.currentWindow = window; bot.emit('windowOpen', window);
      vi.advanceTimersByTime(600);
      expect(bot.placeMemory.state.places.find((place: any) => place.kind === 'chest').note).toBe('中身: iron_ingot×15 bread×5');
      window.containerItems = () => [];
      bot.emit('windowClose', window);
      expect(bot.placeMemory.state.places.find((place: any) => place.kind === 'chest').note).toBe('中身: 空');
    } finally { vi.useRealTimers(); }
  });

  it('puts the last death in the observation as one line', () => {
    const { bot } = body();
    recordDeath(bot.placeMemory.state, { at: Date.now() - 60_000, dimension: overworld, position: { x: 20, y: 64, z: 10 }, lost: [{ name: 'bread', count: 2 }], nearMs: 60_000 });
    const world = captureWorldObservation(bot);
    expect(world.lastDeath).toMatch(/^1分前 overworld \(20,64,10\) 10m 東 落とした物: bread×2/);
  });
});
