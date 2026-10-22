/**
 * Beds of every colour work the same: `bed` or any `<colour>_bed` names one. Outside the Overworld a bed is not slept
 * in but explodes (the Nether and the End), so no skill puts the body into one there.
 */
export const isBedName = (name: unknown): boolean => {
  const text = String(name ?? '').replace(/^minecraft:/, '');
  return text === 'bed' || text.endsWith('_bed');
};

type BedCell = { x: number; y: number; z: number };
/** The way a bed lies: from its foot to its head (the bed's `facing`). */
const BED_FACING: Record<string, readonly [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
export interface BedHalves { part: 'head' | 'foot'; facing: string; foot: BedCell; head: BedCell; /** The cell of the other half than the one asked. */ other: BedCell }

/**
 * Where the two halves of the bed at `cell` lie, from the block's own state (`part`, `facing`): null when the block does not say (a block
 * object without properties). r8 (runs 28 and 32): the server sends a placed bed's foot at once and its head in the next block update, so
 * a bed read right after it is placed can have only one half in the body's world; the cells say which half is awaited.
 */
export function bedHalves(block: unknown, cell: BedCell): BedHalves | null {
  let props: Record<string, unknown> | undefined;
  try { props = (block as { getProperties?: () => Record<string, unknown> })?.getProperties?.(); } catch { props = undefined; }
  const part = String(props?.part ?? ''), facing = String(props?.facing ?? '');
  const step = BED_FACING[facing];
  if ((part !== 'head' && part !== 'foot') || !step) return null;
  const sign = part === 'foot' ? 1 : -1;
  const other = { x: cell.x + step[0] * sign, y: cell.y, z: cell.z + step[1] * sign };
  return part === 'foot' ? { part, facing, foot: { ...cell }, head: other, other } : { part, facing, foot: other, head: { ...cell }, other };
}

export function bedExplodesHere(bot: { game?: { dimension?: unknown } }): boolean {
  return /nether|the_end/.test(String(bot.game?.dimension ?? ''));
}

export const BED_EXPLODES = 'ネザーとエンドではベッドは爆発するため使いません（リスポーン地点はオーバーワールドのベッドで決めます）';
