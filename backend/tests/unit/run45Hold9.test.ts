import { describe, expect, it } from 'vitest';
import { hasFace } from '../../src/services/minebot/utils/primitives/go.js';

// Run 45, hold 9 (2026-10-28; the box 20261028T065719-act-jgr1d): go 12 up to the gravel. The route was drawn again while the body was in the middle of
// a jump (feet 8.2 over its floor at 7); the search started as if the body stood in the cell its feet were in, on the air under it, and the first move
// laid (177,7,199) against that air (the box: against "air"). The server laid nothing there, and the go stopped "the server refused the place".
describe('run 45, hold 9: no block is laid against a block that is not there', () => {
  it('air, a liquid or a block with no box is no face; a block with a box is', () => {
    expect(hasFace({ name: 'air', boundingBox: 'empty' })).toBe(false);
    expect(hasFace({ name: 'cave_air', boundingBox: 'empty' })).toBe(false);
    expect(hasFace({ name: 'water', boundingBox: 'empty' })).toBe(false);
    expect(hasFace({ name: 'short_grass', boundingBox: 'empty' })).toBe(false);
    expect(hasFace(null)).toBe(false);
    expect(hasFace({ name: 'cobblestone', boundingBox: 'block' })).toBe(true);
    expect(hasFace({ name: 'granite', boundingBox: 'block' })).toBe(true);
  });
});
