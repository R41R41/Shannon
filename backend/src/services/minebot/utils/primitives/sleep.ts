import { createMotorPort, executeAction } from '../../execution/ActionExecution.js';
import { bedExplodesHere, isBedName } from '../bedRules.js';
import { isThreatEntity, type ThreatBody } from '../hostileMobHints.js';
import type { Cell } from '../localMap.js';
import { StepStopped, stopped, type StepContext, type StepOutcome } from './common.js';

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

interface SleepEntity { id?: number; name?: string; type?: string; metadata?: unknown[]; position: { x: number; y: number; z: number } }
export interface SleepBody extends ThreatBody {
  registry?: { entitiesByName?: Record<string, { type?: string; metadataKeys?: string[] } | undefined> } | null;
  entity?: { position: { x: number; y: number; z: number } };
  entities?: Record<string, SleepEntity>;
  time?: { timeOfDay?: number };
}

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
  if (!isNight(timeOfDay) && !storm) {
    return none('not_night', `夜ではない（今 ${timeOfDay}、寝られるのは ${NIGHT_FROM}〜${NIGHT_TO}。夜まであと約 ${Math.round(ticksToNight(timeOfDay) / 20)} 秒）`);
  }
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
  // In bed the body cannot move: a stop from outside (stopIf, a reflex, the command's end) wakes it at once.
  const getUp = () => { if (bot.isSleeping) void Promise.resolve(bot.wake?.()).catch(() => undefined); };
  ctx.stop.addEventListener('abort', getUp, { once: true });
  const host = skill.rootBot ?? skill.bot;
  let result: SkillResult;
  try {
    result = await executeAction(bot, 'sleep-in-bed', timeoutMs, async () => {
      const port = createMotorPort(bot);
      skill.bot = port;
      try { return await skill.runImpl(false, false, { leaveIfNight: true, noDig: true }) as never; }
      finally { if (skill.bot === port) skill.bot = host; }
    }) as SkillResult;
  } finally { ctx.stop.removeEventListener('abort', getUp); }
  // Never left lying in bed: a body in bed cannot act on the next hand.
  if (bot.isSleeping) await Promise.resolve(bot.wake?.()).catch(() => undefined);
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
  return { ok: true, text: `${bedName}で寝て朝にした（今 ${Number(bot.time?.timeOfDay ?? 0)}）。${bed}` };
}
