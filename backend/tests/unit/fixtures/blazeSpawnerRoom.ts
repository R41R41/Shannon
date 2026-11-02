import type { CampReader } from '../../../src/services/minebot/utils/huntCamp.js';

// The REAL ground of a staged natural world's fortress, read by the lab probe (scene map_blaze) round its blaze spawner at (-101, 56, -115): the spawner room is five by five with a
// one-block brick wall and a fence over it, floor at y 55; north of it the corridor has a three-wide shaft that goes down, with a one-block ledge at each side. Rows are z from -123
// to -107, columns x from -109 to -93; n netherrack, x blackstone, B nether bricks, # fence, S spawner, ~ lava, . air.

export const X0 = -109, Z0 = -123;
export const LAYERS: Record<number, string[]> = {
  58: ['nnxxxxxxxxxxxxxnn', 'nnnxxxxxxxxxxxxxn', 'nnnnxxxxxxxxxxxxx', 'nnnnn.......xxxxx', 'nnnnn.......xxxxx', 'nnnnn.......xxxxn', 'nnnnn.......xxxnn', 'nnnnn.......nxnnx', 'nnnnn.......nnnxx',
    'nnnnn.......nnxxx', 'nnnnn.......nxxxx', 'nnnnnn#####nxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnnnxxxx', 'nnnnnnnnnnnnnnnxx'],
  57: ['nnnxxxxxxxxxxxxxn', 'nnnnxxxxxxxxxxxxx', 'nnnnnxxxxxxxxxxxx', 'nnnnn.......xxxxx', 'nnnnn.......xxxxx', 'nnnnn.......xxxxx', 'nnnnn##...##xxxxn', 'nnnnn#.....#xxxnn', 'nnnnn#.....#nxxnx',
    'nnnnn#.....#nxxxx', 'nnnnn#.....#nxxxx', 'nnnnn#######xxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnxxxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnn~nnnnnnnxnnx'],
  56: ['nnnxxxxxxxxxxxxxx', 'nnnnxxxxxxxxxxxxx', 'nnnnnxxxxxxxxxxxx', 'nnnnn.......xxxxx', 'nnnnn.......xxxxx', 'nnnnn.B...B.xxxxx', 'nnnnnBB...BBxxxxx', 'nnnnnB.....Bxxxxn', 'nnnnnB..S..Bxxxxn',
    'nnnnnB.....Bxxxxx', 'nnnnnB.....Bxxxxx', 'nnnnnBBBBBBBxxxxx', 'nnnnnnnnnnxxxxxxx', 'nnnnnnnnnxxxxxxxx', 'nnnnnnnnnnxxxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnnnxxxxx'],
  55: ['xnxxxxx...xxxxxxn', 'nnnxxxx...xxxxxxx', 'nnnnxxx...xxxxxxx', 'nnnnn.B...B.xxxxx', 'nnnnn.B...B.xxxxx', 'nnnnn.B...B.xxxxx', 'nnnnn.BBBBB.xxxxn', 'nnnnn.BBBBB.xxxxn', 'nnnnn.BBBBB.xxxxx',
    'nnnnn.BBBBB.xxxxx', 'nnnnn.BBBBB.xxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnxxxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnnnxxxx'],
  54: ['xxxxxxx...xxxxxnn', 'xnxxxxx...xxxxxxn', 'xnnxxxx...xxxxxxx', 'nnnnx.B...B.xxxxx', 'nnnnn.B...B.xxxxx', 'nnnnn.BBBBB.xxxxn', 'nnnnn.BBBBB.xxxxn', 'nnnnn.BBBBB.xxxxx', 'nnnnn.BBBBB.xxxxx',
    'nnnnn.BBBBB.xxxxx', 'nnnnn.BBBBB.xxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnxxxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnnnxxxx', 'nnnnnnnnnnnnnxxxx'],
  53: ['xxxxxxB...Bxxxnnn', 'nxxxxxB...Bxxxxnn', 'xnxxxxB...Bxxxxxn', 'nnnxx.B...B.xxxxx', 'nnnnx.BBBBB.xxxxn', 'nnnnx.BBBBB.xxxnn', 'nnnnn.BBBBB.xxxxx', 'nnnnn.BBBBB.xxxxx', 'nnnnn.BBBBB.xxxxx',
    'nnnnn.BBBBB.xxxxx', 'nnnnn.BBBBB.xxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnnxxxxx', 'nnnnnnnnnnnnnxxxx', 'nnnnnnnnnnnnnxxxx', 'nnnnnnnnnnnnnnxxx', 'nnnnnnnnnnnnnnxxx'],
};
export const NAME: Record<string, string> = { n: 'netherrack', x: 'blackstone', B: 'nether_bricks', '#': 'nether_brick_fence', S: 'spawner', '~': 'lava', '.': 'air' };

/** The lab's ground as a reader; `change` overrides single cells (key "x,y,z"), `unloadedBelow` is the lowest layer that was read. */
export function ground(change: Record<string, string> = {}): CampReader {
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (key in change) { const name = change[key]; return { name, solid: !['air', 'fire', 'lava', 'water'].includes(name) }; }
    const layer = LAYERS[y], col = x - X0, row = z - Z0;
    if (!layer || col < 0 || col > 16 || row < 0 || row > 16) return null;
    const name = NAME[layer[row][col]] ?? 'netherrack';
    return { name, solid: !['air', 'lava'].includes(name) };
  };
}
export const SPAWNER = { x: -101, y: 56, z: -115 };
