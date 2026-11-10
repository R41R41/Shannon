import { createMotorPort, currentAction, executeAction, nativeActionHost } from '../../execution/ActionExecution.js';
import { bedExplodesHere, isBedName, leaveBed } from '../bedRules.js';
import { isThreatEntity, type ThreatBody } from '../hostileMobHints.js';
import { lifeOf } from '../life.js';
import type { Cell } from '../localMap.js';
import { StepStopped, stopped, waitUntil, type StepContext, type StepOutcome } from './common.js';

/**
 * The act's `sleep` hand (2026-11-05, the owner's rule of 10/21: when and where she sleeps is the head's; the body keeps only the parts):
 * set the bed down, sleep, and take it back up on waking, as one part the head calls. Runs 60 and 61 carried a bed through a night of work and
 * died to that night's zombies without once lying down; the floor does not sleep by itself, the head asks for this hand.
 *
 * Where the bed goes (three blocks round, then a spot ten steps' walk off in eight), the wait for morning, getting up when the night goes
 * on and the pick-up are the skill sleep-in-bed's, run as a skill calls another. No spot is dug (`noDig`): where there is none, or an enemy
 * is in the game's box, the hand stops with the facts and the head decides (move, wall in, fight, or work on).
 */

/** The game's own test (bed.js and the server): sleep only between these ticks of the day, and no monster within 8 blocks across and 5 up or down. */
export const NIGHT_FROM = 12542;
export const NIGHT_TO = 23459;
const BOX_ACROSS = 8;
const BOX_UP = 5;
/** Placing, sleeping (the night passes about five seconds after the body lies down; the skill waits ten) and digging the bed back. */
export const SLEEP_SECONDS = 45;
export const SLEEP_SECONDS_MAX = 60;
/** A bed standing this near is used as it is (the skill's own search). */
const BED_NEAR = 16;

/** The head's booking: sleep as soon as it is dark. One at a time; the body keeps it (cleared on a sleep, a morning, a death, another dimension or a new life). */
export interface SleepDue { item?: string; seconds?: number; since: number; misses: number; sawNight: boolean; dimension: string; life?: number; deathEpoch?: string; deathSeq?: number }
export interface SleepDueHost { sleepDue?: SleepDue | null }

interface SleepEntity { id?: number; name?: string; type?: string; metadata?: unknown[]; position: { x: number; y: number; z: number } }
export interface SleepBody extends ThreatBody {
  registry?: { entitiesByName?: Record<string, { type?: string; metadataKeys?: string[] } | undefined> } | null;
  entity?: { position: { x: number; y: number; z: number } };
  entities?: Record<string, SleepEntity>;
  time?: { timeOfDay?: number };
}

/** Past this many seconds to the night, the not_night line says the day is the plan's (o09 waited 250 s twice). */
export const DAY_WAIT_SECONDS = 60;
/** Dusk this near (seconds): the sleep hand waits for it inside, exactly, and lies down. */
export const SOON_SECONDS = 10;
/** A booking is given up after this many failed tries (an enemy near, no spot), and after this long. */
const DUE_MISSES = 3;
const DUE_MAX_MS = 25 * 60_000;

export const isNight = (timeOfDay: number) => timeOfDay >= NIGHT_FROM && timeOfDay <= NIGHT_TO;

/** Every enemy in the box the game forbids sleep for (the threat test the floor uses everywhere else), nearest first. */
export function enemiesInSleepBox(bot: SleepBody, now = Date.now()): Array<{ name: string; distance: number; at: Cell }> {
  const at = bot.entity?.position;
  if (!at) return [];
  const found: Array<{ name: string; distance: number; at: Cell }> = [];
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || (entity as unknown) === bot.entity) continue;
    const dx = entity.position.x - at.x, dy = entity.position.y - at.y, dz = entity.position.z - at.z;
    if (Math.abs(dx) > BOX_ACROSS || Math.abs(dz) > BOX_ACROSS || Math.abs(dy) > BOX_UP) continue;
    const name = String(entity.name ?? '').toLowerCase();
    let threat = false;
    try { threat = !!name && isThreatEntity({ name, type: entity.type, metadata: entity.metadata }, bot.registry?.entitiesByName?.[name]?.type, now, bot); } catch { threat = false; }
    if (threat) found.push({ name, distance: Math.hypot(dx, dy, dz), at: { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) } });
  }
  return found.sort((a, b) => a.distance - b.distance);
}

/** 「8m 内に zombie 2体・skeleton 1体（最も近い zombie 5.1m）」 */
export function enemyWords(enemies: Array<{ name: string; distance: number }>): string {
  const counts = new Map<string, number>();
  for (const enemy of enemies) counts.set(enemy.name, (counts.get(enemy.name) ?? 0) + 1);
  const kinds = [...counts].map(([name, n]) => `${name} ${n}体`).join('・');
  return `${BOX_ACROSS}m 内（上下${BOX_UP}）に ${kinds}（最も近い ${enemies[0].name} ${enemies[0].distance.toFixed(1)}m）`;
}

/** Ticks until the night window opens again (from day or from the morning past it). */
const ticksToNight = (timeOfDay: number) => ((NIGHT_FROM - timeOfDay) % 24000 + 24000) % 24000;

type SkillResult = { success?: boolean; result?: string; nightPassed?: boolean; bedLeft?: boolean; failureType?: string };
type SleepSkill = { bot: unknown; rootBot?: unknown; maxDurationMs?: number; runImpl(...args: unknown[]): Promise<SkillResult> };

export interface SleepArgs { item?: string; seconds?: number }

export async function sleep(ctx: StepContext, args: SleepArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  // The line is the contract's own, like mine's and make's: `sleep 止まった <code>: ...` (utils/handCodes has the closed words).
  const none = (code: string, text: string, at?: Cell) => stopped(bot, code, `sleep 止まった ${code}: ${text}`, at);
  if (args.item !== undefined && !isBedName(args.item)) return none('invalid_input', `sleep の item はベッド（*_bed）: ${args.item}`);
  if (args.seconds !== undefined && (args.seconds < 10 || args.seconds > SLEEP_SECONDS_MAX)) return none('invalid_input', `sleep の seconds は 10〜${SLEEP_SECONDS_MAX}`);
  if (bedExplodesHere(bot)) return none('bed_explodes', `ここ（${String(bot.game?.dimension ?? '')}）ではベッドが爆発するので寝ない（寝られるのはオーバーワールドだけ）`);
  const timeOfDay = Number(bot.time?.timeOfDay ?? -1);
  const storm = !!bot.isRaining && Number(bot.thunderState ?? 0) > 0;
  const beds0 = ((bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>).filter(item => isBedName(item.name));
  if (!isNight(timeOfDay) && !storm) {
    const seconds = Math.round(ticksToNight(timeOfDay) / 20);
    // Run 6 (2026-11-11): told "not night" 3 s and 0 s before dusk, she waited 60 s "to be safe" and asked twice more (q29-q31, two wasted turns). The head never has to
    // time the dusk: within SOON_SECONDS the body waits for it here (exact); farther off the hand is a booking, kept by the body, which lies down at the first break between
    // hands once it is dark (`fireSleepDue`, before each hand of an act). So `sleep` is "sleep when it can be done", at any hour.
    let near: { position: Cell } | null = null;
    try { near = bot.findBlock?.({ matching: bot.isABed, maxDistance: BED_NEAR }) ?? null; } catch { near = null; }
    if (!beds0.length && !near) return none('no_bed', `ベッドを持っていない（近く ${BED_NEAR}m にもベッドは無い）。夜まであと約 ${seconds} 秒`);
    if (seconds <= SOON_SECONDS) {
      const dark = await waitUntil(ctx, () => { const t = Number(bot.time?.timeOfDay ?? -1); return isNight(t) || (!!bot.isRaining && Number(bot.thunderState ?? 0) > 0); }, (seconds + 2) * 1000, 100);
      if (!dark) return none('not_night', `夜まで約 ${seconds} 秒を待ったが、まだ夜にならない（今 ${Number(bot.time?.timeOfDay ?? -1)}）`);
    } else {
      const keeper = lifeOf(nativeActionHost(bot)), view = keeper?.view();
      (bot as SleepDueHost).sleepDue = { item: args.item, seconds: args.seconds, since: Date.now(), misses: 0, sawNight: false,
        dimension: String(bot.game?.dimension ?? ''), life: view?.life, deathEpoch: view?.deathEpoch, deathSeq: view?.deathSeq };
      return { ok: true, text: `夜まであと約 ${seconds} 秒。寝る予約をした（夜になり次第、体が次の手の前で寝る。wait で夜を待たず、作業の手を続ける）` };
    }
  }
  (bot as SleepDueHost).sleepDue = null;
  const beds = ((bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>).filter(item => isBedName(item.name));
  let standing: { position: Cell } | null = null;
  try { standing = bot.findBlock?.({ matching: bot.isABed, maxDistance: BED_NEAR }) ?? null; } catch { standing = null; }
  if (args.item && !beds.some(item => item.name === args.item) && !standing) return none('no_bed', `${args.item} を持っていない（近く ${BED_NEAR}m にもベッドは無い）`);
  if (!beds.length && !standing) return none('no_bed', `ベッドを持っていない（近く ${BED_NEAR}m にもベッドは無い）`);
  const enemies = enemiesInSleepBox(bot);
  if (enemies.length) {
    return none('enemy_near', `${enemyWords(enemies)}。なのでこの場所では寝られない`, enemies[0].at);
  }
  const skill = bot.instantSkills?.getSkill?.('sleep-in-bed') as SleepSkill | undefined;
  if (!skill) return none('not_slept', 'sleep-in-bed が無い');
  const bedName = args.item ?? beds[0]?.name ?? 'ベッド';
  const timeoutMs = Math.max(1000, Math.min((args.seconds ?? SLEEP_SECONDS) * 1000, ctx.deadline - Date.now()));
  const native = nativeActionHost(bot), keeper = lifeOf(native), startLife = keeper?.view();
  const entity = native.entity, client = native._client, dimension = native.game?.dimension;
  let changed = false, closed = false, entered = false;
  let owner: ReturnType<typeof currentAction>;
  let port: typeof bot | undefined;
  const lifeChanged = () => { changed = true; void port?._client; owner?.controller.abort('sleep_life_changed'); };
  const lifeEvents = ['death', 'respawn', 'spawn', 'game', 'end'];
  for (const event of lifeEvents) bot.on(event, lifeChanged);
  const close = () => { closed = true; for (const event of lifeEvents) bot.removeListener(event, lifeChanged); };
  const sameLife = () => {
    const now = keeper?.view();
    return !closed && !changed && native.entity === entity && native._client === client && native.game?.dimension === dimension
      && native.health > 0 && lifeOf(native) === keeper && (!startLife || !!now && now.alive && now.life === startLife.life
        && now.deathEpoch === startLife.deathEpoch && now.dimensionSince === startLife.dimensionSince);
  };
  const host = skill.rootBot ?? skill.bot;
  let result: SkillResult;
  try {
    result = await executeAction(bot, 'sleep-in-bed', timeoutMs, async () => {
      owner = currentAction(bot);
      if (!sameLife() || ctx.stop.aborted) throw new StepStopped('sleep_life_changed');
      entered = true;
      port = createMotorPort(bot, operation => sameLife() && (operation !== 'sleep' || !ctx.stop.aborted));
      // Release only this owner's bed, including a timeout/cancel while its lease is still held. The guarded
      // native port also fences the skill's delayed sleep/wake/raw leave_bed and preserves child-action identity.
      const getUp = () => { void leaveBed(port as never).catch(() => undefined).finally(close); };
      ctx.stop.addEventListener('abort', getUp, { once: true });
      owner?.controller.signal.addEventListener('abort', getUp, { once: true });
      skill.bot = port;
      try { return await skill.runImpl(false, false, { leaveIfNight: true, noDig: true }) as never; }
      finally {
        ctx.stop.removeEventListener('abort', getUp);
        owner?.controller.signal.removeEventListener('abort', getUp);
        await leaveBed(port as never).catch(() => undefined);
        close();
        if (skill.bot === port) skill.bot = host;
      }
    }) as SkillResult;
  } finally { if (!entered) close(); }
  if (ctx.stop.aborted) throw new StepStopped(String(ctx.stop.reason ?? 'stopped'));
  const text = String(result?.result ?? '').replace(/\s+/gu, ' ');
  if (!result?.success) {
    const code = result?.failureType === 'hostile_near' || /敵/u.test(text) ? 'enemy_near'
      : result?.failureType === 'no_bed_spot' ? 'no_bed_spot'
        : result?.failureType === 'not_night' ? 'not_night'
          : result?.failureType === 'bed_explodes' ? 'bed_explodes' : 'not_slept';
    // The skill's own enemy check is a sphere of 8 with its own list: the box is read again for the facts.
    const again = code === 'enemy_near' ? enemiesInSleepBox(bot) : [];
    return none(code, again.length ? `${enemyWords(again)}。なのでこの場所では寝られない` : `${bedName}で寝られなかった: ${text}`, again[0]?.at);
  }
  // A bed already standing near is used as it is: nothing was set down (the skill says nothing of a bed it took back).
  const bed = result.bedLeft === undefined ? '近くのベッドを使った' : result.bedLeft ? `ベッドは置いたまま（${text.match(/\(-?\d+, -?\d+, -?\d+\)/u)?.[0] ?? ''}）` : 'ベッドは拾い直した';
  if (!result.nightPassed) return none('night_went_on', `${bedName}で寝たが夜は明けなかった（起きているプレイヤーがいる）。起き上がった。${bed}`);
  // The server's time update comes a moment after the wake: the tick in the line is the morning's, not the night's last.
  await waitUntil(ctx, () => !isNight(Number(bot.time?.timeOfDay ?? 0)), 1500).catch(() => false);
  return { ok: true, text: `${bedName}で寝て朝にした（今 ${Number(bot.time?.timeOfDay ?? 0)}）。${bed}` };
}

/**
 * The booking kept (run 6, 2026-11-11): a `sleep` hand sent by day is kept here, and the first break between two hands of an act once it is dark lies down (the same sleep hand,
 * run inline, so the bed, the enemy box and the wake-up are the hand's). Not fired for a `sleep` hand itself; kept (not dropped) while there is no bed to hand or too little
 * of the act's time left; given up after DUE_MISSES failed tries (an enemy near, no spot), after the night has passed, after DUE_MAX_MS, on a death, a new life or another dimension.
 * Returns the line the hand's result carries, or null (nothing to say).
 */
export async function fireSleepDue(ctx: StepContext, hand: string, index: number): Promise<string | null> {
  const bot = ctx.bot as SleepBody & SleepDueHost & { findBlock?: (options: unknown) => unknown; isABed?: unknown; isRaining?: boolean; thunderState?: number; game?: { dimension?: unknown };
    inventory?: { items?: () => Array<{ name: string }> } };
  const due = bot.sleepDue;
  if (!due) return null;
  const view = lifeOf(nativeActionHost(bot as never))?.view();
  if (String(bot.game?.dimension ?? '') !== due.dimension || (view && (view.life !== due.life || view.deathEpoch !== due.deathEpoch || view.deathSeq !== due.deathSeq)) || Date.now() - due.since > DUE_MAX_MS) {
    bot.sleepDue = null;
    return null;
  }
  const t = Number(bot.time?.timeOfDay ?? -1);
  const dark = isNight(t) || (!!bot.isRaining && Number(bot.thunderState ?? 0) > 0);
  if (!dark) {
    // The night went by without a chance (the booking is stale: the morning is not the evening's).
    if (due.sawNight) bot.sleepDue = null;
    return null;
  }
  due.sawNight = true;
  if (hand === 'sleep' || ctx.deadline - Date.now() < 12_000) return null;
  const carried = (bot.inventory?.items?.() ?? []).some(item => isBedName(item.name));
  let beside: unknown = null;
  try { beside = bot.findBlock?.({ matching: bot.isABed, maxDistance: 5 }) ?? null; } catch { beside = null; }
  if (!carried && !beside) return null;
  const began = Date.now();
  const out = await sleep(ctx, { item: due.item, seconds: due.seconds });
  if (out.ok) return `寝る予約: 夜になったので手 ${index + 1} の前で寝た（${Math.max(1, Math.round((Date.now() - began) / 1000))} 秒）。${out.text}`;
  due.misses++;
  if (due.misses >= DUE_MISSES) return `寝る予約は取り下げた（${DUE_MISSES} 回寝られなかった: ${out.text.replace(/^sleep 止まった /u, '')}）`;
  bot.sleepDue = due;
  return `寝る予約: 夜になったが寝られなかった（${out.text.replace(/^sleep 止まった /u, '')}）。次の手の前でもう一度試す`;
}
