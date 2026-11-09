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

interface SleepingBot {
  isSleeping?: boolean;
  sleep(bed: unknown): Promise<void>;
  once?(event: string, listener: (...args: any[]) => void): unknown;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}
/** How long, past mineflayer's own 3 s, the body still waits for the server to lay it in the bed. */
export const SLEEP_LATE_MS = 8_000;
/** The server's own words for why it would not let the body lie down (1.21: an overlay system message). */
const BED_REFUSALS: Array<[RegExp, string]> = [
  [/bed\.not_safe|monsters nearby/i, '近くに敵がいます（サーバーの判定：ベッドの周り 8 マス・上下 5 マスの敵）'],
  [/bed\.too_far_away|too far/i, 'ベッドが遠すぎます'],
  [/bed\.obstructed|obstructed/i, 'ベッドの上がふさがっています'],
  [/bed\.no_sleep|only sleep at night/i, 'サーバーではまだ夜になっていません'],
  [/bed\.occupied|occupied/i, 'ベッドは使用中です'],
];
function refusalOf(message: unknown): string | null {
  let text = '';
  try { text = JSON.stringify((message as { json?: unknown })?.json ?? message) + String((message as { toString?: () => string })?.toString?.() ?? ''); } catch { return null; }
  for (const [pattern, words] of BED_REFUSALS) if (pattern.test(text)) return words;
  return null;
}
/**
 * Lying down in a bed. mineflayer gives up when the server's "sleep" has not come within 3 s ("bot is not sleeping"); on a slow server
 * (end1108g: a night of 20 real minutes, TPS under 9) the server lays the body down later than that. Here the body keeps waiting
 * SLEEP_LATE_MS more for the sleep, and when the server said why it refused (monsters, too far, obstructed), the error says that instead.
 */
export async function sleepPatiently(bot: SleepingBot, bed: unknown, lateMs = SLEEP_LATE_MS): Promise<void> {
  let refused: string | null = null;
  const onMessage = (message: unknown) => { refused ??= refusalOf(message); };
  const listens = typeof bot.on === 'function';
  if (listens) bot.on?.('message', onMessage);
  if (listens) bot.on?.('actionBar', onMessage);
  try {
    try {
      await bot.sleep(bed);
      return;
    } catch (error: any) {
      if (!String(error?.message ?? error).includes('not sleeping')) throw error;
    }
    if (!bot.isSleeping && !refused) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); clearInterval(poll); bot.removeListener?.('sleep', done); resolve(); };
        const timer = setTimeout(done, lateMs);
        const poll = setInterval(() => { if (bot.isSleeping || refused) done(); }, 250);
        bot.once?.('sleep', done);
      });
    }
    if (bot.isSleeping) return;
    // "monsters" keeps the callers' mapping to enemy_near (sleepInBed, utils/primitives/sleep).
    // Set by the message listener while bot.sleep waited; the compiler cannot see that assignment and narrows it to null.
    const why = refused as string | null;
    if (why) throw new Error(why.startsWith("近くに敵") ? `there are monsters nearby: ${why}` : `server refused: ${why}`);
    throw new Error(`bot is not sleeping（サーバーが ${Math.round((3_000 + lateMs) / 1000)} 秒以内に寝かせませんでした。サーバーが重いとみられます）`);
  } finally {
    if (listens) bot.removeListener?.('message', onMessage);
    if (listens) bot.removeListener?.('actionBar', onMessage);
  }
}
