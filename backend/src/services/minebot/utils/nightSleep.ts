/**
 * The night slept through: at night, with a bed carried or one standing near, the body sleeps before it goes on with the work it
 * was asked for, and the night is skipped (the owner, 2026-10-20: "ベッドがあれば寝て夜を飛ばす。地上で待つことはしない").
 *
 * Asked at the start of a command of the work kind (NIGHT_SLEEP_SKILLS), once a night: sleep-in-bed sets the bed down, sleeps, and
 * takes the bed back when it wakes in the morning. Not tried when it cannot work: another player awake in the world (the night is
 * skipped only when every player sleeps), a hostile within eight blocks (the game refuses), in the water or in the air, or in the
 * Nether or the End (a bed explodes there). A sleep the morning did not end is ended here: the body gets up and takes its bed.
 */

/** Commands that do the day's work: the night is slept through before them. Never a fight, an escape or a shelter. */
export const NIGHT_SLEEP_SKILLS: ReadonlySet<string> = new Set(['mine-block', 'stair-mine', 'move-to', 'wait-time', 'explore-for-structure']);

/** Ticks of the day a bed can be slept in (the library's own test, bed.js). */
const SLEEP_FROM = 12_542;
const SLEEP_TO = 23_459;
const HOSTILE_RANGE = 8;
const BED_RANGE = 16;

interface SleepBody {
  entity?: { position: { x: number; y: number; z: number; distanceTo(other: unknown): number }; onGround?: boolean; isInWater?: boolean };
  time?: { timeOfDay?: number; day?: number; age?: number | bigint };
  game?: { dimension?: unknown };
  username?: string;
  players?: Record<string, { username?: string; gamemode?: number; entity?: unknown }>;
  entities?: Record<string, any>;
  registry?: any;
  inventory?: { items?(): Array<{ name: string }> };
  isSleeping?: boolean;
  isABed?(block: unknown): boolean;
  findBlock?(options: { matching: (block: any) => boolean; maxDistance: number }): { position: { x: number; y: number; z: number } } | null;
  wake?(): Promise<void>;
  nightSleep?: { night: number };
}

/** Which night this is: the day count (a night lies within one day of the clock). */
function nightNumber(bot: SleepBody): number {
  const day = Number(bot.time?.day);
  if (Number.isFinite(day)) return day;
  const age = Number(bot.time?.age);
  return Number.isFinite(age) ? Math.floor(age / 24000) : 0;
}

/** Why the body would not sleep now, or null when it would. */
export function sleepRefusal(bot: SleepBody): string | null {
  if (!String(bot.game?.dimension ?? 'overworld').includes('overworld')) return 'not_overworld';
  const tick = Number(bot.time?.timeOfDay);
  if (!Number.isFinite(tick) || tick < SLEEP_FROM || tick > SLEEP_TO) return 'not_night';
  if (bot.isSleeping) return 'asleep';
  if (bot.nightSleep?.night === nightNumber(bot)) return 'tried_tonight';
  const at = bot.entity?.position;
  if (!at || bot.entity?.isInWater || bot.entity?.onGround === false) return 'footing';
  // Spectators do not count for the night's skip; anyone else awake keeps the night.
  const awake = Object.values(bot.players ?? {}).some(player => player?.username && player.username !== bot.username && player.gamemode !== 3);
  if (awake) return 'others_awake';
  const hostile = Object.values(bot.entities ?? {}).some((entity: any) => entity?.position && entity !== bot.entity
    && bot.registry?.entitiesByName?.[entity.name]?.type === 'hostile' && entity.position.distanceTo(at) <= HOSTILE_RANGE);
  if (hostile) return 'hostile_near';
  const carried = (() => { try { return (bot.inventory?.items?.() ?? []).some(item => item.name.endsWith('_bed')); } catch { return false; } })();
  if (carried) return null;
  try {
    if (typeof bot.isABed === 'function' && bot.findBlock?.({ matching: block => bot.isABed!(block), maxDistance: BED_RANGE })) return null;
  } catch { /* no bed seen */ }
  return 'no_bed';
}

type RunSkill = (name: string, ...args: any[]) => Promise<{ success?: boolean; result?: unknown } | null | undefined>;

/**
 * Sleeps through the night when it can (see sleepRefusal), and says what came of it in one sentence for the command's result, or ''
 * when it did not try. `run` calls a skill by name (sleep-in-bed, dig-block-at).
 */
export async function sleepThroughNight(bot: SleepBody, run: RunSkill): Promise<string> {
  if (sleepRefusal(bot)) return '';
  bot.nightSleep = { night: nightNumber(bot) };
  let slept: { success?: boolean; result?: unknown } | null | undefined;
  try { slept = await run('sleep-in-bed', false, false); } catch { return ''; }
  const text = String(slept?.result ?? '');
  if (!slept?.success) return '';
  const morning = /朝になりました/.test(text);
  // Not woken by the morning: the night is not being skipped. Up again, and the bed back into the pack.
  if (bot.isSleeping) { try { await bot.wake?.(); } catch { /* the work below starts from the bed */ } }
  const left = /置いたベッドは\((-?\d+), (-?\d+), (-?\d+)\)/.exec(text);
  let bedNote = '';
  if (left) {
    try {
      const taken = await run('dig-block-at', Number(left[1]), Number(left[2]), Number(left[3]), true, 'target', true);
      bedNote = taken?.success ? '。ベッドは拾い直しました' : `。ベッド(${left[1]}, ${left[2]}, ${left[3]})は置いたままです`;
    } catch { bedNote = `。ベッド(${left[1]}, ${left[2]}, ${left[3]})は置いたままです`; }
  } else if (/拾い直しました/.test(text)) bedNote = '。ベッドは拾い直しました';
  return morning
    ? `（夜だったので、先にベッドで眠って朝にしました${bedNote}）`
    : `（夜だったのでベッドで眠りましたが、夜は明けませんでした${bedNote}）`;
}
