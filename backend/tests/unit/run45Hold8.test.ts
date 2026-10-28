import { describe, expect, it } from 'vitest';
import { blockInHand, mayLayAt } from '../../src/services/minebot/utils/primitives/go.js';

// Run 45, hold 8 (2026-10-28; the box 20261028T051948-act-sqiah): q34 go 2 up to the surface. The route laid the floor of its next cell (183,62,198)
// while the body was jumping straight over that cell: in the run its feet were 62.75 (0.25 in the cell); in the lab, with a wait until the feet were
// over the cell's top (63.1), the server refused it all the same. A go's route builds no tower: a block under the body is never sent.
const at = (x: number, y: number, z: number, onGround = false) => ({ entity: { position: { x, y, z }, onGround } });
const cell = { x: 183, y: 62, z: 198 };

describe('run 45, hold 8: no block is laid under the body or in it', () => {
  it('the body straight over the cell (in it, or just over its top, as in the run and the lab): not laid', () => {
    expect(mayLayAt(at(183.41, 62.75, 198.5), cell)).toBe(false);
    expect(mayLayAt(at(183.41, 63.10, 198.5), cell)).toBe(false);
    expect(mayLayAt(at(183.41, 63.25, 198.5), cell)).toBe(false);
  });
  it('the body beside the cell: laid (a bridge from the edge, the step up ahead)', () => {
    // A bridge: the body at the edge of its own column, the block one down and one across.
    expect(mayLayAt(at(182.9, 63, 198.5), cell)).toBe(true);
    // The floor of the next cell ahead, the body on its own floor.
    expect(mayLayAt(at(181.5, 63, 198.5), cell)).toBe(true);
    // A cell over the body's head in its own column is not under it (the box decides: here it is clear).
    expect(mayLayAt(at(183.5, 59.9, 198.5), cell)).toBe(true);
    // On the ground at the edge of a bridge, the middle over the gap's column: the floor is laid (the body is above the cell).
    expect(mayLayAt(at(183.05, 63, 198.5, true), cell)).toBe(true);
  });
  it('the body in the cell from beside (its box over the cell): not laid', () => {
    expect(mayLayAt(at(182.85, 62, 198.5), cell)).toBe(false);
  });
});

describe('run 45, hold 8 (the lab): the block is in the hand before a place is sent', () => {
  const bot = (held: string, items: string[]) => {
    const body: any = { heldItem: { name: held }, inventory: { items: () => items.map(name => ({ name, count: 8 })) }, equipped: [] as string[] };
    body.equip = async (item: { name: string }) => { body.equipped.push(item.name); body.heldItem = { name: item.name }; };
    return body;
  };
  it('the iron pickaxe in the hand (a dig took it): the allowed block goes in first', async () => {
    const b = bot('iron_pickaxe', ['iron_pickaxe', 'dirt', 'cobblestone']);
    expect(await blockInHand(b, ['cobblestone', 'dirt'])).toBe(true);
    expect(b.equipped).toEqual(['dirt']);
  });
  it('an allowed block already in the hand: nothing is done; none in the pack: false', async () => {
    const b = bot('cobblestone', ['cobblestone']);
    expect(await blockInHand(b, ['cobblestone'])).toBe(true);
    expect(b.equipped).toEqual([]);
    expect(await blockInHand(bot('iron_pickaxe', ['iron_pickaxe']), ['cobblestone'])).toBe(false);
  });
});
