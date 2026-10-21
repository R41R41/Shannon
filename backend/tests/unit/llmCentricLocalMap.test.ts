import { describe, expect, it } from 'vitest';
import { drawColumn, drawLocalMap, drawSlice, drawTop, facingOfYaw, heightCode, noteMapStop, recentStopLines, relativeCell, relativeWords,
  symbolFor, underOpenSky, type MapBlock } from '../../src/services/minebot/utils/localMap.js';
import { describeArea } from '../../src/services/minebot/instantSkills/getBlocksInArea.js';
import { readChunk, sectionBlock } from '../../src/services/minebot/utils/anvilWorld.js';
import zlib from 'node:zlib';

// The map's golden drawings (design mb-llm-centric 4: "地図の金型"): fixed blocks in, fixed text out. No body, no world.
const stone: MapBlock = { name: 'stone', solid: true };
const air: MapBlock = { name: 'air', solid: false };
function world(): (x: number, y: number, z: number) => MapBlock | null {
  const cells = new Map<string, MapBlock | null>([
    ['11,63,20', { name: 'deepslate', solid: true }], ['9,63,20', { name: 'dirt', solid: true }], ['10,62,20', { name: 'iron_ore', solid: true }],
    ['12,64,20', { name: 'water', solid: false, level: 0 }], ['8,64,22', { name: 'cave_air', solid: false }], ['12,64,22', null],
    ['10,64,18', { name: 'furnace', solid: true }], ['11,65,19', { name: 'gravel', solid: true }],
  ]);
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (cells.has(key)) return cells.get(key)!;
    if (y <= 63) return stone;
    if (y === 66 && x <= 9) return stone;
    return air;
  };
}

describe('the decision map (utils/localMap)', () => {
  it('draws five layers round the feet in the contract\'s format, top first, with self, trail, creatures, unloaded and water', () => {
    const text = drawLocalMap({ feet: { x: 10, y: 64, z: 20 }, read: world(), trail: new Set(['11,64,20']), creatures: new Map([['9,64,21', '!'], ['8,64,18', 'm']]) },
      { mode: 'layers', radius: 2 });
    expect(text).toBe([
      '地図 v1 足=(10,64,20) x=8..12 z=18..22 方式=layers 上=北',
      'y=66', 'z\\x 8 9 0 1 2',
      ' 18 # # . . .', ' 19 # # . . .', ' 20 # # . . .', ' 21 # # . . .', ' 22 # # . . .',
      'y=65', 'z\\x 8 9 0 1 2',
      ' 18 . . . . .', ' 19 . . . ; .', ' 20 . . . . .', ' 21 . . . . .', ' 22 . . . . .',
      'y=64', 'z\\x 8 9 0 1 2',
      ' 18 m . F . .', ' 19 . . . . .', ' 20 . . @ * ~', ' 21 . ! . . .', ' 22 . . . . ?',
      'y=63', 'z\\x 8 9 0 1 2',
      ' 18 # # # # #', ' 19 # # # # #', ' 20 # : # # #', ' 21 # # # # #', ' 22 # # # # #',
      'y=62', 'z\\x 8 9 0 1 2',
      ' 18 # # # # #', ' 19 # # # # #', ' 20 # # i # #', ' 21 # # # # #', ' 22 # # # # #',
    ].join('\n'));
  });
  it('draws the ground from above with standing heights', () => {
    const text = drawTop({ read: world(), self: { x: 10, y: 64, z: 20 }, trail: new Set(['11,64,20']), minX: 8, maxX: 12, minZ: 18, maxZ: 20, feetY: 64, top: 70, bottom: 58 });
    expect(text).toBe(['z\\x 8  9  0  1  2', ' 18 #3 #3 F1 #0 #0', ' 19 #3 #3 #0 ;2 #0', ' 20 #3 #3 @0 *0 ~1'].join('\n'));
  });

  it('chooses the surface under the open sky and the layers under a roof', () => {
    const read = world();
    expect(underOpenSky(read, { x: 10, y: 64, z: 20 })).toBe(true);
    expect(underOpenSky(read, { x: 8, y: 64, z: 20 })).toBe(false);
    expect(drawLocalMap({ feet: { x: 10, y: 64, z: 20 }, read }).split('\n')[0]).toBe('地図 v1 足=(10,64,20) x=0..20 z=10..30 方式=surface 上=北');
    expect(drawLocalMap({ feet: { x: 8, y: 64, z: 20 }, read }).split('\n')[0]).toBe('地図 v1 足=(8,64,20) x=1..15 z=13..27 方式=layers 上=北');
  });

  it('gives each family one letter (the old clashes are gone) and every air is air', () => {
    expect(symbolFor({ name: 'deepslate' })).toBe('#');
    expect(symbolFor({ name: 'dirt' })).toBe(':');
    expect(symbolFor({ name: 'gold_ore' })).toBe('g');
    expect(symbolFor({ name: 'glass', solid: true })).toBe('+');
    expect(symbolFor({ name: 'amethyst_cluster', solid: true })).toBe('$');
    expect(symbolFor({ name: 'poppy', solid: false })).toBe(',');
    expect(symbolFor({ name: 'netherrack' })).toBe('n');
    expect(symbolFor({ name: 'nether_portal' })).toBe('p');
    expect(symbolFor({ name: 'cave_air' })).toBe('.');
    expect(symbolFor(null)).toBe('?');
    expect(symbolFor({ name: 'water', level: 3 })).toBe('-');
    expect(symbolFor({ name: 'lava', level: 0 })).toBe('L');
    expect(symbolFor({ name: 'end_portal_frame', eye: true })).toBe('R');
    expect(symbolFor({ name: 'end_portal_frame' })).toBe('Q');
    expect(symbolFor({ name: 'nether_bricks' })).toBe('N');
    expect(symbolFor({ name: 'red_bed' })).toBe('B');
    expect(symbolFor({ name: 'torch', solid: false })).toBe('t');
    expect(heightCode(-3)).toBe('c');
    expect(heightCode(12)).toBe('+');
  });

  it('reads relative cells in the facing, and says where a cell is', () => {
    expect(facingOfYaw(0)).toBe('north');
    expect(facingOfYaw(-Math.PI / 2)).toBe('east');
    expect(relativeCell({ x: 0, y: 64, z: 0 }, 'east', { front: 2, right: 1, up: -1 })).toEqual({ x: 2, y: 63, z: 1 });
    expect(relativeCell({ x: 0, y: 64, z: 0 }, 'north', { front: 1, right: 1 })).toEqual({ x: 1, y: 64, z: -1 });
    expect(relativeWords({ x: 201, y: 45, z: 277 }, { x: 202, y: 52, z: 277 })).toBe('東1・上7');
  });

  it('draws a slice and a column', () => {
    const slice = drawSlice({ read: world(), self: { x: 10, y: 64, z: 20 }, center: { x: 10, y: 64, z: 20 }, radius: 2, yFrom: 63, yTo: 64, axis: 'ew' });
    expect(slice.split('\n')).toEqual(['y\\x 8 9 0 1 2', ' 64 . . @ . ~', ' 63 # : # # #']);
    const column = drawColumn({ read: world(), x: 10, z: 18, yFrom: 62, yTo: 65 });
    expect(column.split('\n')).toEqual(['y=65 . air', 'y=64 F furnace', 'y=62..63 # stone']);
  });

  it('counts the stops at one place for one reason', () => {
    const bot: any = { entity: { position: { x: 0, y: 64, z: 0 } } };
    noteMapStop(bot, { kind: 'walk', from: { x: 0, y: 64, z: 0 }, at: { x: 1, y: 64, z: 0 }, reason: '一歩ではない' }, 1000);
    noteMapStop(bot, { kind: 'walk', from: { x: 0, y: 64, z: 0 }, at: { x: 1, y: 64, z: 0 }, reason: '一歩ではない' }, 2000);
    expect(recentStopLines(bot, 3000)).toEqual(['(0,64,0)→(1,64,0) 一歩ではない ×2 1秒前']);
  });
});

describe('get-blocks-in-area with the map\'s letters', () => {
  it('no longer clashes, counts cave_air as air and an unloaded cell as unloaded', () => {
    const out = describeArea(world(), { x1: 8, y1: 63, z1: 20, x2: 12, y2: 64, z2: 22 }, 'layers');
    const parsed = JSON.parse(out.result);
    expect(parsed.legend[':']).toBe('dirt');
    expect(parsed.legend['#']).toContain('deepslate');
    expect(parsed.legend['?']).toBe('未ロード');
    expect(parsed.layers[1].data.split('\n')[2]).toBe('....?');
    const stats = JSON.parse(describeArea(world(), { x1: 8, y1: 64, z1: 22, x2: 12, y2: 64, z2: 22 }, 'stats').result);
    expect(stats.airCount).toBe(4);
    expect(stats.unloaded).toBe(1);
  });
});

describe('a saved world (utils/anvilWorld)', () => {
  it('unpacks a section\'s longs by its palette', () => {
    // Four bits a block: the first long holds 16 blocks; block 1 is palette 2, block 2 palette 1.
    const word = (2n << 4n) | (1n << 8n);
    const section = { palette: [air, stone, { name: 'iron_ore' }], data: [word, 0n, 0n], bits: 4 };
    expect(sectionBlock(section, 0, 0, 0).name).toBe('air');
    expect(sectionBlock(section, 1, 0, 0).name).toBe('iron_ore');
    expect(sectionBlock(section, 2, 0, 0).name).toBe('stone');
  });
  it('reads a chunk out of a region file\'s bytes', () => {
    const region = Buffer.alloc(8192 + 4096);
    region.writeUInt32BE((2 << 8) | 1, ((1 & 31) + (2 & 31) * 32) * 4);
    const body = zlib.deflateSync(Buffer.from('nbt'));
    region.writeUInt32BE(body.length + 1, 8192); region.writeUInt8(2, 8196); body.copy(region, 8197);
    const chunk = readChunk(region, 1, 2, () => ({ sections: [{ Y: 4, block_states: { palette: [{ Name: 'minecraft:obsidian' }] } }] }), entry => ({ name: String(entry.Name).replace('minecraft:', '') }));
    expect(chunk && sectionBlock(chunk.sections.get(4)!, 3, 3, 3).name).toBe('obsidian');
    expect(readChunk(region, 0, 0, () => ({}), () => air)).toBeNull();
  });
});
