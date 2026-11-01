import { feetCell, type Cell } from '../localMap.js';
import { blockAt, cellText, isAirLike } from './common.js';

/**
 * Run 58 (hold 1, an aquifer under y=17): the body fell into water whose only air was the one-wide hole it fell through, under a stone
 * ceiling. A block laid in the water beside it against the ceiling took, but every jump to it failed: its top is the feet's height, and the
 * two cells over it were stone, so there was nowhere to stand. For 2 minutes the climbs said only "no base to pile on". This names the
 * ledge out: a whole block (or a water/air cell a block can be laid in against a solid face) at the feet's height beside the body, and
 * which of the two cells over it must be dug before a go can step up onto it. Null when the body is not over water/air or nothing fits.
 */
export function waterExitWords(bot: any, feet: Cell): string | null {
  const solid = (block: any) => block && block.boundingBox === 'block' && block.name !== 'water' && block.name !== 'lava';
  const open = (block: any) => block && (isAirLike(block) || block.name === 'water');
  const unbreakable = (block: any) => !block || block.name === 'bedrock' || block.name === 'lava' || block.diggable === false;
  const options: { digs: number; words: string }[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ledge = { x: feet.x + dx, y: feet.y, z: feet.z + dz };
    const block = blockAt(bot, ledge);
    const above = [1, 2].map(up => ({ x: ledge.x, y: ledge.y + up, z: ledge.z }));
    if (above.some(cell => unbreakable(blockAt(bot, cell)))) continue;
    const toDig = above.filter(cell => solid(blockAt(bot, cell)));
    const digText = toDig.length ? `上の ${toDig.map(cell => `${cellText(cell)} ${blockAt(bot, cell).name}`).join('・')} を掘れば` : '上は空いていて';
    if (solid(block)) {
      options.push({ digs: toDig.length, words: `${cellText(ledge)} は ${block.name}（床になる）。${digText} go で ${cellText(above[0])} へ上がれる` });
      continue;
    }
    if (!open(block)) continue;
    const face = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
      .map(([fx, fy, fz]) => ({ x: ledge.x + fx, y: ledge.y + fy, z: ledge.z + fz }))
      .find(cell => !(cell.x === feet.x && cell.y === feet.y && cell.z === feet.z) && solid(blockAt(bot, cell)));
    if (!face) continue;
    options.push({ digs: toDig.length + 1, words: `${cellText(ledge)} に ${blockAt(bot, face).name}${cellText(face)} に当てて置き、${digText} go で ${cellText(above[0])} へ上がれる` });
  }
  if (!options.length) return null;
  options.sort((a, b) => a.digs - b.digs);
  return `水の外へ出る足場: ${options.slice(0, 2).map(option => option.words).join('／')}（掘る名前を canDig に、maxDig は掘る数以上）`;
}

/**
 * Run 58 (hold 1 resumed): in that aquifer the decisions saw breath 20/20 and the way out only as one neutral line of `around` beside
 * "dig the iron ore", kept digging iron from the water for two more minutes, sank to y=8 and drowned. The live state (`state.inside`, every
 * decision) says she is in deep water with no floor, that work there sinks her and spends breath, and the ledge out. Null out of deep water.
 */
export function deepWaterWords(bot: any): string | null {
  const feet = feetCell(bot);
  if (!feet) return null;
  if (blockAt(bot, feet)?.name !== 'water' || blockAt(bot, { x: feet.x, y: feet.y - 1, z: feet.z })?.name !== 'water') return null;
  const exit = waterExitWords(bot, feet);
  return `深い水の中（足の下も水で床が無い。掘る・置くの間も沈み、息が減る。水の中の作業より先に水の外へ）${exit ? `。${exit}` : ''}`;
}
