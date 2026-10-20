import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

// The block scan is stood in for, for nearbyNeeds only.
const scanned: { hits: Array<{ name: string; position: Vec3; distance: number }> } = { hits: [] };
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', async (original) => ({
  ...(await original() as object),
  scanLoadedBlocks: vi.fn((_bot: unknown, names: Iterable<string>) => {
    const wanted = new Set(names);
    return { hits: scanned.hits.filter(hit => wanted.has(hit.name)), columns: 1, reachMetres: 24, sectionsScanned: 1 };
  }),
}));

const { ironStillNeeded, nearbyNeeds } = await import('../../src/services/minebot/utils/nearbyNeeds.js');
const { BODY_EVENTS, BodyEventWatcher } = await import('../../src/services/minebot/integration/commonFca/bodyEvents.js');

const registry = minecraftData('1.21.11');
const pack = (items: Array<{ name: string; count: number }>) => ({ inventory: { items: () => items, slots: new Array(46).fill(null) } });

describe('run 19: the iron still to get, from what is still to make (about 55 dug for about 33 used)', () => {
  it('is 33 with nothing made: two pickaxes, a bucket and the whole armour', () => {
    expect(ironStillNeeded([])).toBe(33);
  });
  it('counts the ore in a furnace and what is carried, so loading a furnace brings no need back', () => {
    expect(ironStillNeeded([{ name: 'raw_iron', count: 19 }], [{ item: 'raw_iron', count: 14 }])).toBe(0);
    expect(ironStillNeeded([{ name: 'raw_iron', count: 19 }])).toBe(14);
  });
  it('counts what was made by having it: after the pickaxe, the bucket, the chestplate and the leggings, nine ingots leave three', () => {
    const made = ['iron_pickaxe', 'bucket', 'iron_chestplate', 'iron_leggings'].map(name => ({ name, count: 1 }));
    expect(ironStillNeeded([...made, { name: 'iron_ingot', count: 9 }])).toBe(3);
    expect(ironStillNeeded([...made, { name: 'diamond_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 },
      { name: 'iron_helmet', count: 1 }, { name: 'iron_boots', count: 1 }])).toBe(0);
  });
});

describe('run 19: a standing bed and fuel are needs too', () => {
  const body = (items: Array<{ name: string; count: number }>, beds: Array<{ position: { x: number; y: number; z: number }; distance: number; keep?: string }> = []) => ({
    registry, entity: { position: new Vec3(62.5, 70, 14.5) }, world: { getColumns: () => [] }, entities: {},
    blockAt: (p: Vec3) => p.x === 69 && p.y === 66 && p.z === 4 ? { name: 'red_bed', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
    placeMemory: { recall: (kind?: string) => kind === 'bed' ? beds : [] }, activeFurnaces: [], ...pack(items),
  }) as any;
  const fed = [{ name: 'cooked_salmon', count: 6 }, { name: 'oak_planks', count: 12 }, { name: 'coal', count: 8 }, { name: 'iron_ingot', count: 33 }];

  it('says the igloo bed 13 m off, first, with its block name; not her own respawn bed, nor one past 96 m', () => {
    scanned.hits = [];
    const needs = nearbyNeeds(body(fed, [{ position: { x: 69, y: 66, z: 4 }, distance: 13 }, { position: { x: 300, y: 70, z: 0 }, distance: 240 }]), 1_000);
    expect(needs).toEqual([expect.objectContaining({ id: 'bed:b:69,66,4', need: 'bed', name: 'red_bed', distance: 13, canReach: true })]);
    expect(nearbyNeeds(body(fed, [{ position: { x: 69, y: 66, z: 4 }, distance: 13, keep: 'respawn' }]), 5_000)).toEqual([]);
    // Her own bed at her base is hers already; a remembered bed whose loaded block is air now is gone.
    expect(nearbyNeeds(body(fed, [{ position: { x: 69, y: 66, z: 4 }, distance: 13, keep: 'base' }]), 6_000)).toEqual([]);
    expect(nearbyNeeds(body(fed, [{ position: { x: 70, y: 66, z: 4 }, distance: 14 }]), 7_000)).toEqual([]);
    expect(nearbyNeeds(body([...fed, { name: 'white_bed', count: 1 }], [{ position: { x: 69, y: 66, z: 4 }, distance: 13 }]), 9_000)).toEqual([]);
  });

  it('says coal ore while fewer than eight coal are carried, charcoal counting', () => {
    scanned.hits = [{ name: 'coal_ore', position: new Vec3(70, 66, 20), distance: 12 }];
    const withBed = [...fed.filter(item => item.name !== 'coal'), { name: 'white_bed', count: 1 }];
    expect(nearbyNeeds(body([...withBed, { name: 'coal', count: 3 }]), 13_000)).toEqual([expect.objectContaining({ need: 'fuel', name: 'coal_ore', distance: 12 })]);
    expect(nearbyNeeds(body([...withBed, { name: 'coal', count: 3 }, { name: 'charcoal', count: 5 }]), 17_000)).toEqual([]);
  });
});

describe('run 19: a chase is measured, and told sooner in water (a salmon chase of 201 s was never told as stalled)', () => {
  function chase(inWater: boolean) {
    let clock = Date.parse('2026-10-20T10:00:00Z');
    const bot = { entity: { position: { x: 0, y: 60, z: 0 }, isInWater: inWater }, items: [] as Array<{ name: string; count: number }>,
      inventory: { items: () => bot.items }, entities: { 9: { name: 'salmon', position: { x: 10, y: 58, z: 0 } } } };
    const watcher = new BodyEventWatcher(bot, () => clock, () => []);
    watcher.begin({ id: 'chase', skill: 'attack-continuously', arguments: { entityName: 'salmon' } });
    return { bot, watcher, advance: (ms: number) => { clock += ms; watcher.tick(); } };
  }
  const stalls = (watcher: InstanceType<typeof BodyEventWatcher>) => watcher.pending(999).filter(event => event.kind === 'action.stalled');

  it('a chase that neither kills nor closes in is stalled after 15 s on land, 8 s in water, with the water said', () => {
    const land = chase(false);
    for (let i = 0; i < 7; i++) land.advance(2_000);
    expect(stalls(land.watcher)).toHaveLength(0);
    land.advance(2_000);
    expect(stalls(land.watcher)[0]?.data).toMatchObject({ skill: 'attack-continuously', measure: 'chase', distance: 10.2 });
    const water = chase(true);
    for (let i = 0; i < 4; i++) water.advance(2_000);
    expect(stalls(water.watcher)[0]?.data).toMatchObject({ measure: 'chase', hazard: 'water' });
    expect(BODY_EVENTS.waterStallMs).toBeLessThan(BODY_EVENTS.stallMs);
  });

  it('after a kill the next one is chased from wherever it is; a group word or a stand in place is not measured', () => {
    const f = chase(false);
    f.bot.entities[9]!.position.x = 2;
    f.advance(2_000);
    f.bot.items = [{ name: 'salmon', count: 1 }];
    f.bot.entities[9]!.position.x = 12;
    f.advance(2_000);
    // 18 s of closing in on the next one from 12 m: measured from the kill, it gets somewhere; from the old best (2 m) it never would.
    for (let i = 0; i < 9; i++) { f.bot.entities[9]!.position.x -= 1.2; f.advance(2_000); }
    expect(stalls(f.watcher)).toHaveLength(0);
    let clock = Date.parse('2026-10-20T10:00:00Z');
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [] }, entities: {} };
    for (const args of [{ entityName: 'hostile' }, { entityName: 'zombie', holdPosition: true }]) {
      const watcher = new BodyEventWatcher(bot, () => clock, () => []);
      watcher.begin({ id: 'stand', skill: 'attack-continuously', arguments: args });
      for (let i = 0; i < 12; i++) { clock += 2_000; watcher.tick(); }
      expect(stalls(watcher)).toHaveLength(0);
    }
  });

  it('closing in by 2 m or a kill (its drop) counts as getting somewhere', () => {
    const f = chase(false);
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 0) f.bot.entities[9]!.position.x -= 2.5;
      if (i === 6) f.bot.items = [{ name: 'salmon', count: 1 }];
      f.advance(2_000);
    }
    expect(stalls(f.watcher)).toHaveLength(0);
  });
});
