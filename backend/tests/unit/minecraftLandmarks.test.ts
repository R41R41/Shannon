import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { findLoadedBlocks, scanLoadedBlocks } from '../../src/services/minebot/utils/loadedBlockScan.js';
import { compassDirection, detectVillage } from '../../src/services/minebot/utils/landmarks.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { conditionsMatch, describeSituation, seedItems } from '../../src/modules/minecraftLearning/index.js';

const STATES: Record<string, number> = { air: 0, stone: 1, bell: 10, hay_block: 11, composter: 12, white_bed: 13, red_bed: 14, barrel: 15, oak_log: 16 };
const registry = { blocksByName: Object.fromEntries(Object.entries(STATES).map(([name, state]) => [name, { minStateId: state, maxStateId: state }])) };

/** A world of 16x16x16 sections with real palettes: only the listed cells are not air. */
function world(blocks: Array<[number, number, number, string]>, loaded: Array<[number, number]>) {
  const sections = new Map<string, { palette: number[]; cells: Map<number, number>; reads: number }>();
  for (const [x, y, z, name] of blocks) {
    const key = `${x >> 4},${y >> 4},${z >> 4}`;
    const section = sections.get(key) ?? { palette: [0], cells: new Map(), reads: 0 };
    if (!section.palette.includes(STATES[name])) section.palette.push(STATES[name]);
    section.cells.set(((y & 15) << 8) | ((z & 15) << 4) | (x & 15), STATES[name]);
    sections.set(key, section);
  }
  let cellReads = 0;
  const columns = loaded.map(([chunkX, chunkZ]) => ({ chunkX: String(chunkX), chunkZ: String(chunkZ), column: { minY: 0,
    sections: Array.from({ length: 8 }, (_, index) => {
      const section = sections.get(`${chunkX},${index},${chunkZ}`);
      return section ? { data: { palette: section.palette, get: (cell: number) => { cellReads++; return section.cells.get(cell) ?? 0; } } }
        : { data: { value: 0, get: () => { cellReads++; return 0; } } };
    }) } }));
  return { getColumns: () => columns, reads: () => cellReads };
}
const square = (radius: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) out.push([x, z]);
  return out;
};

describe('reading the loaded chunks by their palettes', () => {
  it('finds rare blocks while reading only the sections that list them', () => {
    const w = world([[70, 64, 3, 'bell'], [5, 70, 5, 'oak_log'], [-40, 66, 20, 'hay_block']], square(5));
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, registry, world: w };
    const scan = scanLoadedBlocks(bot, ['bell', 'hay_block']);
    expect(scan.hits.map(hit => hit.name)).toEqual(['hay_block', 'bell']);
    expect(scan.hits[1].position).toMatchObject({ x: 70, y: 64, z: 3 });
    expect(scan.columns).toBe(121);
    expect(scan.sectionsScanned).toBe(2);
    expect(w.reads()).toBe(2 * 4096); // 121 columns x 8 sections were not walked
    expect(scan.reachMetres).toBeGreaterThan(80);
    expect(scanLoadedBlocks(bot, ['no_such_block']).hits).toEqual([]);
  });

  it('answers nearest-first within a distance and stops at the first columns for a common block', () => {
    const logs: Array<[number, number, number, string]> = [];
    for (const [cx, cz] of square(5)) logs.push([cx * 16 + 8, 64, cz * 16 + 8, 'oak_log']);
    const w = world(logs, square(5));
    const bot: any = { entity: { position: new Vec3(8.5, 64, 8.5) }, registry, world: w };
    const near = findLoadedBlocks(bot, ['oak_log'], 256, 3);
    expect(near).toHaveLength(3);
    expect(near[0]).toMatchObject({ x: 8, y: 64, z: 8 });
    expect(w.reads()).toBeLessThan(121 * 4096 / 4); // far columns are not read once three nearer hits are in hand
    expect(findLoadedBlocks(bot, ['oak_log'], 20, 50).every(position => position.distanceTo(bot.entity.position) <= 20)).toBe(true);
  });
});

describe('a village in view', () => {
  const body = (blocks: Array<[number, number, number, string]>, entities: any = {}) =>
    ({ entity: { position: new Vec3(0.5, 64, 0.5) }, registry, world: world(blocks, square(5)), entities }) as any;

  it('is recognised by a bell, by two kinds of marker together, by three beds, or by villagers beside a marker', () => {
    expect(detectVillage(body([[60, 64, -40, 'bell']]))).toMatchObject({ kind: 'village', direction: '北東', distance: 72 });
    expect(detectVillage(body([[30, 64, 0, 'hay_block'], [36, 64, 4, 'composter']]))?.evidence).toContain('hay_block×1');
    const threeBeds: Array<[number, number, number, string]> = [0, 4, 8].flatMap(dz => [[40, 64, dz, 'white_bed'], [41, 64, dz, 'white_bed']] as Array<[number, number, number, string]>);
    expect(detectVillage(body(threeBeds))?.evidence).toBe('ベッド3台');
    expect(detectVillage(body([[30, 64, 0, 'barrel']], { 7: { name: 'villager', position: new Vec3(33, 64, 2) } }))?.evidence).toContain('村人1人');
  });

  it('is not claimed for the body\'s own bed or barrel, for markers far apart, or for plain building blocks', () => {
    expect(detectVillage(body([[2, 64, 0, 'white_bed'], [3, 64, 0, 'white_bed']]))).toBeNull();
    expect(detectVillage(body([[2, 64, 0, 'barrel']]))).toBeNull();
    expect(detectVillage(body([[-70, 64, 0, 'hay_block'], [70, 64, 0, 'composter']]))).toBeNull();
    expect(detectVillage(body([[1, 63, 0, 'stone'], [4, 64, 4, 'oak_log']]))).toBeNull();
  });

  it('reaches the planner and the learned knowledge as a landmark', () => {
    const bot = body([[60, 64, -40, 'bell']]);
    bot.landmarks = [detectVillage(bot)];
    const observation = captureWorldObservation(bot);
    expect(observation.landmarks?.[0]).toMatchObject({ kind: 'village', direction: '北東' });
    const features = describeSituation({ ...observation, time: '6000', dimension: 'overworld' } as any);
    expect(features.landmarks).toEqual(['village']);
    const seed = seedItems('2026-10-01T00:00:00.000Z').find(item => item.id === 'seed-village-in-sight')!;
    expect(conditionsMatch(seed.conditions, features)).toBe(true);
    expect(conditionsMatch(seed.conditions, { ...features, landmarks: undefined })).toBe(false);
    expect(compassDirection({ x: 0, z: 0 }, { x: 0, z: 10 })).toBe('南');
    expect(compassDirection({ x: 0, z: 0 }, { x: -10, z: 0 })).toBe('西');
  });
});
