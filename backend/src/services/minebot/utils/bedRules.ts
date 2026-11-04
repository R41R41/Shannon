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

type WakingBot = {
  isSleeping?: boolean; wake?: () => unknown; entity?: { id?: number };
  registry?: unknown; _client?: { write?: (name: string, params: Record<string, unknown>) => void };
};
/** Whether this version's protocol names the player commands (1.21.6 and later: leaving the bed is 0, `leave_bed`). */
function namesLeaveBed(bot: WakingBot): boolean {
  try {
    const types = (bot.registry as { protocol?: { play?: { toServer?: { types?: Record<string, unknown> } } } } | undefined)?.protocol?.play?.toServer?.types;
    return JSON.stringify(types?.packet_entity_action ?? '').includes('"leave_bed"');
  } catch { return false; }
}
/**
 * Getting out of bed. mineflayer 4.35's `wake()` sends player command 2, which from 1.21.6 the server reads as `stop_sprinting` (leaving
 * the bed became 0): on 1.21.11 the body stayed lying in the bed (the lab's night_sleep B, 2026-11-05). Where the version names the
 * command it is sent by name; elsewhere the library's own. The server's wake (the animation) clears `isSleeping` as before.
 */
export async function leaveBed(bot: WakingBot): Promise<void> {
  if (!bot.isSleeping) return;
  if (namesLeaveBed(bot) && bot._client?.write && bot.entity?.id !== undefined) {
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 'leave_bed', jumpBoost: 0 });
    return;
  }
  await bot.wake?.();
}

export const BED_EXPLODES ='ネザーとエンドではベッドは爆発するため使いません（リスポーン地点はオーバーワールドのベッドで決めます）';
