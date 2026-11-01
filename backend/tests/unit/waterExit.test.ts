import { describe, expect, it } from 'vitest';
import { deepWaterWords, waterExitWords } from '../../src/services/minebot/utils/primitives/waterExit.js';

// Run 58 (hold 1): the body in an aquifer under a stone ceiling, its only air the one-wide hole it fell through. A cobblestone it laid beside
// it against the ceiling is a ledge only once the two stone cells over it are dug; the climbs had said only "no base to pile on".
const world = (cells: Record<string, string>, fallback: (y: number) => string) => ({
  blockAt: (at: { x: number; y: number; z: number }) => {
    const name = cells[`${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`] ?? fallback(Math.floor(at.y));
    return { name, boundingBox: name === 'water' || name === 'air' ? 'empty' : 'block', diggable: name !== 'bedrock', position: at };
  },
});
const aquifer = (y: number) => (y <= 16 ? 'water' : 'stone');

describe('the ledge out of water', () => {
  it('names the laid block and the two cells to dig over it', () => {
    const bot = world({ '0,17,0': 'air', '0,18,0': 'air', '1,16,0': 'cobblestone' }, aquifer);
    const words = waterExitWords(bot, { x: 0, y: 16, z: 0 })!;
    expect(words).toContain('(1,16,0) は cobblestone（床になる）。上の (1,17,0) stone・(1,18,0) stone を掘れば go で (1,17,0) へ上がれる');
  });
  it('without a block yet, names where one can be laid and what it is laid against', () => {
    const bot = world({ '0,17,0': 'air' }, aquifer);
    const words = waterExitWords(bot, { x: 0, y: 16, z: 0 })!;
    expect(words).toMatch(/\(-?1,16,0\) に stone\(-?1,17,0\) に当てて置き、上の/u);
  });
  it('the live state says deep water with no floor and the way out, and nothing on a shore or in shallow water', () => {
    const at = (x: number, y: number, z: number) => ({ entity: { position: { x: x + 0.5, y, z: z + 0.5 } } });
    const deep = { ...world({ '0,17,0': 'air', '0,18,0': 'air', '1,16,0': 'cobblestone' }, aquifer), ...at(0, 16.2, 0) };
    const words = deepWaterWords(deep)!;
    expect(words).toContain('深い水の中（足の下も水で床が無い');
    expect(words).toContain('水の中の作業より先に水の外へ');
    expect(words).toContain('go で (1,17,0) へ上がれる');
    const shallow = { ...world({ '0,16,0': 'water' }, y => (y <= 15 ? 'stone' : 'air')), ...at(0, 16, 0) };
    expect(deepWaterWords(shallow)).toBeNull();
    const dry = { ...world({}, y => (y <= 15 ? 'stone' : 'air')), ...at(0, 16, 0) };
    expect(deepWaterWords(dry)).toBeNull();
  });
  it('skips a ledge under bedrock or lava, and says nothing when nothing fits', () => {
    const bot = world({ '1,17,0': 'bedrock', '-1,17,0': 'lava', '0,1,0': 'x' }, y => (y <= 16 ? 'water' : y === 17 ? 'water' : 'air'));
    expect(waterExitWords(bot, { x: 0, y: 16, z: 0 })).toBeNull();
  });
});
