import { describe, expect, it } from 'vitest';
import { waterExitWords } from '../../src/services/minebot/utils/primitives/waterExit.js';

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
  it('skips a ledge under bedrock or lava, and says nothing when nothing fits', () => {
    const bot = world({ '1,17,0': 'bedrock', '-1,17,0': 'lava', '0,1,0': 'x' }, y => (y <= 16 ? 'water' : y === 17 ? 'water' : 'air'));
    expect(waterExitWords(bot, { x: 0, y: 16, z: 0 })).toBeNull();
  });
});
