import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { buildMovements } from '../setMovements.js';
import { beginEngagement, engageFor } from '../engagement.js';
import { HEAD_COMBAT_YIELD_HEALTH, markHeadCombat } from '../combatOwner.js';
import { createLogger } from '../../../../utils/logger.js';
import { combatFootingRisk } from '../combatFooting.js';
import { footingAt, footingWords as voidWords, VOID_DROP } from '../voidFooting.js';
import { actionSignal, nativeActionHost } from '../../execution/ActionExecution.js';
import { bodyReader, feetCell, type Cell } from '../localMap.js';
import { eyeOf, probeSight } from '../probeTools.js';
import { equipToHandVerified } from '../equipVerified.js';
import { itemFoodPoints } from '../foodPoints.js';
import { creeperLit } from '../creeperFuse.js';
import { bestBlade, fleeKeys, isThreat, reflexHeld } from '../floorReflexes.js';
import { alreadyDead, cooldownMs, creatureIdOf } from './attack.js';
import { deathLedgerOf } from '../deathLedger.js';
import type { Progress } from '../../integration/commonFca/continueContract.js';
import { eat } from './body.js';
import { findEntity, isDying } from './use.js';
import { findItem, guard, letGo, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { swimControls, swimPulse } from './swim.js';
import { HOVERING_SHOOTERS, SHOT_HOLD_TICKS, ShooterWatch, StrikeGate, hoversAboveReach, nextShotTicks, strikeHold } from '../huntBlaze.js';
import { itemIds, itemsSince } from '../huntBarter.js';
import { itemFacts } from './pickup.js';
import { EndermanCamp, endermanRoofSites, hiddenFromRoof, hiddenFromRoofWords, moveToRoofSite, roofHereSight } from '../huntEndermanCamp.js';
import { huntCandidates } from '../huntEndermanProbe.js';
import { ENDERMAN_EYE, endermanAngry, endermanLine } from '../huntEnderman.js';
import { hideoutsFrom } from '../huntCamp.js';
import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { go } from './go.js';
import { EndermanDenFight } from '../huntEndermanDenFight.js';
import { endermanDenProblem, type EndermanDenSpec } from '../huntEndermanDen.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Fight');

/**
 * fight (run 39, 2026-10-26; the hands contract, docs/minecraft-hands-2026-10.md): a fight the planner chose, and the small work of it left to the body.
 *
 * The planner decides who (`target`, a creature it saw: `#id` or a kind, the nearest of the kind is taken once and then that one only), whether to
 * fight or run (`stance`), with what (`item`), how low the health may go before the fight is left (`retreatHp`), how far the body may follow
 * (`range`) and for how long (`seconds`). The body does what is finer than a second: it closes in and keeps the creature at the far edge of a blow
 * (back a step when it is on the body), turns to it, strikes with a full swing, jumps so that the blow lands on the way down (a critical hit needs a
 * fall, no sprint and a swing at full strength; the jump is timed from the weapon's own wait), keeps the shield on the arm, and, below `retreatHp`,
 * gets out of reach, eats what can help and goes back in, or leaves.
 *
 * A blaze (a creature that hovers and shoots, utils/huntBlaze) is fought from where the fight began (the camp beside the spawner, put there by the planner):
 * the body holds no key there and strikes what comes within reach and in sight; one that hovers more than a blow's reach above the eye is waited for under the
 * shield (its height is drawn again every five seconds). A blaze that sees its target does not come to it (S2, 2026-11-04, the 1.21.11 AI), so one at the body's
 * height but out of reach is gone out to (a sortie): only while no blaze that sees the body has its flame on and no shot is on its way, and no further than SORTIE_M
 * (level) from the camp. The body goes back to the camp when a blaze that sees it has been charged SORTIE_CHARGE_MS (its shots come at three seconds), when a shot
 * comes, when the target rises out of reach or past SORTIE_M, when it cannot get nearer, or after SORTIE_MS out. A blow is held back while a shot is about to land or a
 * blaze that sees the body has been charged long enough to shoot (utils/huntBlaze StrikeGate: 1.5 s in all within each 8 s). Its drop is told in the line it dies in.
 *
 * An enderman with `den` uses the planner's two-high, two-deep wall den (huntEndermanDenFight): only its four cells may be excavated, BEFORE angering the specified
 * #id. The body provokes outside, returns to the rear cell, strikes only visible legs within 3m, and briefly collects drops when no other creature is near.
 * Without `den`, the roof camp (utils/huntEnderman, huntEndermanCamp) lays nine cobblestone caps at feet+2, removes its temporary supports,
 * centres within ±0.2m, stares briefly from under it, then aims at the legs and stands under the shield
 * and strikes what comes within reach: it is not followed, and it is not looked in the eye once it is angry (it would teleport away). The roof is the hand's own
 * work and needs no canPlace: the blocks are named in the line when they are short. A bow is no tool for it (it dodges arrows).
 *
 * It never looks for a target of its own: another creature that comes is not turned to (the floor's reflexes answer it, and their word is above this
 * hand's). Other targets grant no excavation or placement. Whatever it does is told in the line: the blows swung and landed, the health lost, the meals, and who
 * held the body.
 *
 * Who holds the body (the owner's rule, run 39): the floor's reflexes (lava, air, a fall, the low-health flight at 8, a lit creeper, a shot) are above
 * every hand. This one
 *  - does not begin while one holds the body (`reflex`), and ends at once when one takes it (its lease aborts the action; the hand answers
 *    `reflex` with its counts, as `HandCut`), and is never started over by itself after the reflex: the planner decides from what the line says;
 *  - writes the keys and the look only when no reflex holds the body, and never touches the shield: the shield reflex (utils/shieldBlock) raises it
 *    against what is in reach while a fight is on (`beginEngagement`, which this hand does for a fight and not for a flight), and the body's own
 *    blow goes out from behind it (a blow lands with the shield raised: lab, 2026-11-03). While that reflex meets a shot in the air, the hand holds its
 *    keys and its look (it takes both for the turn to the shot) and only waits;
 *  - leaves the creature's kind to the act's `accept` rules: the act counts the target's kind as accepted for the length of this hand (hurt, stopIf).
 */
export interface FightArgs { target: string | number; den?: EndermanDenSpec; stance?: 'fight' | 'flee'; item?: string; retreatHp?: number; range?: number; seconds?: number }

/** A blow reaches 3 blocks from the eye to the creature's box; the body works to keep it there. */
const REACH = 3.0;
/** Inside this the body stands and strikes; beyond it, it closes in (a wider bar to leave than to enter, so that a creature at the edge does not flip it). */
const ZONE_IN = 3.0, ZONE_OUT = 3.6;
/** The creature is on the body (too near to swing from): a step back. Far edge of a blow: a step forward. */
const TOO_NEAR = 1.0, TOO_FAR = 2.6;
const TICK_MS = 50;
const DEFAULT_SECONDS = 20, DEFAULT_RANGE = 8;
/** A creature beyond the range for this long is gone (or never came in). */
const OUT_OF_RANGE_MS = 2500;
/** No nearer by this much for this long, while out of reach: it cannot be reached. */
const NO_GAIN_MS = 5000, NO_GAIN_M = 0.3;
/** Within reach but never in sight (a wall or a pane between) for this long: it cannot be struck. */
const BLIND_MS = 5000;
/** The jump for a critical hit is begun when the swing is this near to full strength (a vanilla jump lasts 12 ticks; the blow is struck on the way down). */
const JUMP_LEAD_MS = 500;
/** A jump pressed that left no ground by this time is not going to (a low ceiling, a web): blows are struck on the ground for a while. */
const JUMP_FAILS_MS = 250, NO_JUMP_MS = 1500;
/** A blow counts as landed when the creature is hurt within this long of the swing at it. */
const LANDED_WITHIN_MS = 700;
/** A creeper is struck and left (the blow throws it back; the blast is what is feared): back this long after each blow. */
const CREEPER_BACK_MS = 700;
/** A broken shield is replaced from the pack; a failed try is made again no sooner than this. */
const SPARE_RETRY_MS = 1_500;
/** The shield reflex meeting a shot holds the body this long after it raised the shield. */
const SHOT_HOLD_MS = 600;
/** A meal takes 1.6 s and a creature of the body's own pace closes about 6 m in that: the run for a meal goes to 8 m (or its time), and it is eaten from 6.5 m. */
const MEAL_GAP = 8, MEAL_MIN_GAP = 6.5, MAX_MEALS = 4;
/**
 * A hovering shooter's camp (S2, 2026-11-02, S4's c1 trials: a fight at the spawner ran the health down to 2 in one act, and the floor's own flight only begins at 8): the health below which the body leaves
 * its sight when the planner gave none, and the health a fight that fled without a hideout goes back in at (this much above).
 */
const CAMP_RETREAT_HP = 12, REST_ABOVE = 6, REST_MIN_BACK = 18;
/** The health a camp's fight goes back in at: above the line it left at, and not under 18. */
const backAt = (retreatHp: number) => Math.min(19, Math.max(REST_MIN_BACK, retreatHp + REST_ABOVE));
const NEVER_EAT = new Set(['pufferfish', 'chorus_fruit', 'suspicious_stew', 'spider_eye', 'poisonous_potato', 'enchanted_golden_apple', 'rotten_flesh']);
const CUT = /Action interrupted|Motor owner expired/u;
/** A hovering shooter is fought from where the fight began: this many blocks from it (level) and the body is out on a sortie (back within HOME_M, below, it is home). */
const OUT_M = 2.0;
/**
 * A sortie (S2, 2026-11-04): the farthest a blaze may be from the camp (level) to be gone out to, the longest out, how long a blaze that sees the body may have been
 * charged before the body turns back (the first shot is at about three seconds), and the longest walk back before the hand says it cannot.
 */
const SORTIE_M = 8, SORTIE_MS = 8_000, SORTIE_CHARGE_MS = 1_000, HOME_MS = 8_000;
/** Back at the camp within this (level); the next sortie no sooner than SORTIE_GAP_MS after a turn back, SORTIE_REST_MS after one that ran out of time or gained nothing. */
const HOME_M = 1.6, SORTIE_GAP_MS = 1_500, SORTIE_REST_MS = 5_000;
const r1 = (value: number) => Math.round(value * 10) / 10;

/** Thrown when something above the hand ended it (a reflex's lease, the act's stop): the act reports a stop in the hand, and this tells the counts. */
export class HandCut extends StepStopped {
  constructor(why: string, readonly summary: string) { super(why); }
}

/** An angry enderman that gains no metre on the roof for this long is not coming (the roof hunts: angry to in reach took 4.8 s on average). */
const ANGRY_STUCK_MS = 15_000;
/**
 * An angry enderman that did not come (enderman_did_not_arrive) is left out of the pick while it stays within STUCK_NEAR_M of where it stuck, for
 * STUCK_FORGET_MS: end1108h29 (11/8) called fight on #1376, angry and held 38-46 m off at one cell, eight times in a row (about four minutes, no
 * blow), because "an angry one comes first" picked it over the others every time.
 */
const STUCK_NEAR_M = 6, STUCK_FORGET_MS = 300_000;
/** Farther than this and angry without coming: stuck (not the planner's range: its default 8 m let #637 stand at 6 m for ten fights, end1108h30). Nearer is the camp's own matter (its edge step). */
const STUCK_FAR_M = REACH + 1.5;
/** After a fight act ends with its enderman still angry within ENDER_KEEP_M, it stays engaged ENDER_KEEP_MS for the next act. */
const ENDER_KEEP_M = 16, ENDER_KEEP_MS = 20_000;
const stuckAngry = new WeakMap<object, Map<number, { at: Cell; until: number }>>();
export function noteStuckAngry(bot: any, id: number, at: Cell, now = Date.now()): void {
  let seen = stuckAngry.get(bot);
  if (!seen) { seen = new Map(); stuckAngry.set(bot, seen); }
  seen.set(id, { at, until: now + STUCK_FORGET_MS });
}
function stuckWhere(bot: any, entity: any, now = Date.now()): Cell | null {
  const stuck = stuckAngry.get(bot)?.get(entity.id);
  if (!stuck || now > stuck.until) return null;
  const p = entity.position;
  if (Math.hypot(p.x - stuck.at.x - 0.5, p.y - stuck.at.y, p.z - stuck.at.z - 0.5) <= STUCK_NEAR_M) return stuck.at;
  // end1109p05: #619, angry 6-7 below the roof, followed underneath from roof to roof (more than STUCK_NEAR_M from where it stuck) and was picked
  // first as "angry" six times, 15 s each, 0 blows. Still STUCK_BELOW blocks or more below the feet, it is still the one that cannot come up.
  const feet = Number(bot.entity?.position?.y);
  if (Number.isFinite(feet) && feet - p.y >= STUCK_BELOW) return cellOfEntity(entity);
  // end1109p07b: #574, angry on the ledges about the pocket, wandered more than STUCK_NEAR_M from where it stuck (not below the feet) and was
  // picked first as "angry" again (fights of 15 s each, 0 blows). Within the forget time, one that has still not come within STUCK_FAR_M has
  // still not come: it stays out of the pick until it does (then it is in reach and the pick takes it).
  const me = bot.entity?.position;
  return me && p.distanceTo?.(me) > STUCK_FAR_M ? cellOfEntity(entity) : null;
}
/** Whether an enderman is one that stuck angry and has not come since (above): it cannot reach the body, so it is no danger to the body's next item. */
export function endermanStuckAway(bot: any, entity: any, now = Date.now()): boolean {
  try { return String(entity?.name ?? '').toLowerCase() === 'enderman' && stuckWhere(bot, entity, now) !== null; } catch { return false; }
}
const STUCK_BELOW = 3;
// end1109p10: after such a stop (#2077 angry 5 below) the head dug netherrack and walked down to the drops; it struck and she died in 3 s.
// The line said it was below and angry, never that it stays so and strikes whoever comes down. In the cause, which is never cut.
const ANGRY_STAYS = '。怒ったまま下に残る: 降りて掘る・拾うとすぐ襲われる';
/**
 * Fights in a row that ended on one enderman without its death (any stop but a reflex's). The stuck mark above keeps to a place: end1109p01 (11/9)
 * fought #929 sixteen times running (support_not_removed 5, enderman_did_not_arrive 9, then support_unsafe; 0 kills in 7 minutes) because it kept
 * walking more than STUCK_NEAR_M from where it stuck, and the head was told each stop on its own. From MISS_STREAK_NOTE on, the line says how many
 * and why, and the kind's pick takes another one first when there is one; whether to try it again, call another or move the roof is the head's.
 */
const MISS_STREAK_NOTE = 3;
const missStreaks = new WeakMap<object, { id: number; count: number; reasons: string[] }>();
export function endermanMissCount(bot: any, id: number): number {
  const streak = missStreaks.get(bot);
  return streak && streak.id === id ? streak.count : 0;
}
/** Counts the fight's end into the streak and returns the outcome, with the streak's words from MISS_STREAK_NOTE fights on. */
export function withMissStreak(bot: any, out: StepOutcome): StepOutcome {
  if (out.code === 'target_killed') { missStreaks.delete(bot); return out; }
  const head = /^fight (?:止まった ([a-z_]+): |済 )enderman #(\d+)/u.exec(out.text ?? '');
  if (!head) return out;
  const id = Number(head[2]);
  if (out.ok) { missStreaks.delete(bot); return out; }
  const reason = head[1] ?? String(out.reason ?? 'stopped');
  if (reason === 'reflex') return out;
  const last = missStreaks.get(bot);
  const streak = last && last.id === id ? last : { id, count: 0, reasons: [] as string[] };
  streak.count += 1; streak.reasons.push(reason);
  missStreaks.set(bot, streak);
  if (streak.count < MISS_STREAK_NOTE) return out;
  const tally = new Map<string, number>();
  for (const r of streak.reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
  const why = [...tally].map(([r, n]) => `${r}×${n}`).join('・');
  return { ...out, text: `${out.text}。・#${id} は ${streak.count} 回続けて倒せていない（${why}）。次の fight target=enderman は他に狙える個体が居ればそちらを先に選ぶ。同じ個体をまた id で狙うか、別の個体か、probe kind=roofsite で屋根の場所を変えるかを決める` };
}
/** The endermen fight may pick: within ENDERMAN_PICK_RANGE, alive, not one that stuck angry (above); nearest first. And the stuck ones apart. */
function endermenToPick(bot: any): { near: any[]; stuck: Array<{ entity: any; at: Cell }> } {
  const at = bot.entity?.position;
  if (!at) return { near: [], stuck: [] };
  const all = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== bot.entity && entity.position && entity.isValid !== false
    && String(entity.name ?? '').toLowerCase() === 'enderman' && entity.position.distanceTo(at) <= ENDERMAN_PICK_RANGE && !isDying(bot, entity))
    .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
  const near: any[] = [], stuck: Array<{ entity: any; at: Cell }> = [];
  for (const entity of all) { const where = stuckWhere(bot, entity); if (where) stuck.push({ entity, at: where }); else near.push(entity); }
  return { near, stuck };
}
const stuckWords = (stuck: Array<{ entity: any; at: Cell }>) => stuck.length
  ? `。怒ったまま近づけなかった ${stuck.map(s => `#${s.entity.id}（(${s.at.x},${s.at.y},${s.at.z}) 付近）`).join('・')} は数えない` : '';
/** Endermen within ENDERMAN_PICK_RANGE but none with its eyes in sight: the words for it (how many, the nearest and what hides it), or null when there is none at all. */
export function endermenWithoutSight(bot: any): string | null {
  const at = bot.entity?.position;
  if (!at) return null;
  const { near: about, stuck } = endermenToPick(bot);
  // end1109p05: ones whose eyes the own cap hid from every step out are not "in sight" from this roof (the cap-only check below would call them seen).
  const hidden = about.filter(entity => hiddenFromRoof(bot, entity));
  const near = about.filter(entity => !hidden.includes(entity));
  if (!near.length && hidden.length) {
    const roofAt = hiddenFromRoof(bot, hidden[0])!;
    return `${ENDERMAN_PICK_RANGE}m 内に狙えるエンダーマンが居ない（${hidden.map(entity => `#${entity.id}`).join("・")}）。${hiddenFromRoofWords(hidden[0].id, roofAt, '自分の屋根の蓋が目を隠し、屋根の外へ出てもどこからも見えなかった')}${stuckWords(stuck)}`;
  }
  if (!near.length) return stuck.length ? `${ENDERMAN_PICK_RANGE}m 内に狙えるエンダーマンが居ない${stuckWords(stuck)}` : null;
  // One in sight at any distance (a near one too, under the hunts' 8 m band) is the caller's to pick.
  const read = bodyReader(bot), roof = roofOver(bot, read);
  const capOnly = (between: Array<{ at: { x: number; y: number; z: number } }>) => !!roof && between.every(b => b.at.y === roof.y + 2 && Math.abs(b.at.x - roof.x) <= 1 && Math.abs(b.at.z - roof.z) <= 1);
  if (near.some(entity => { try { const line = endermanLine(read, at, entity.position, ENDERMAN_EYE); return line.clear || capOnly(line.between); } catch { return true; } })) return null;
  try { if (roof && huntCandidates(read, at, near, roof, undefined, 1).length) return null; } catch { return null; }
  const first = near[0];
  let hide = '';
  try { const line = endermanLine(bodyReader(bot), at, first.position, ENDERMAN_EYE); const b = line.between[0]; if (b) hide = `、間に (${b.at.x},${b.at.y},${b.at.z}) ${b.name}`; } catch { hide = ''; }
  return `${ENDERMAN_PICK_RANGE}m 内のエンダーマン ${near.length} 体はどれも目が見えない（いま狙える個体は無い。最寄りの #${first.id} も ${first.position.distanceTo(at).toFixed(1)}m 先で目が隠れている${hide}）${stuckWords(stuck)}`;
}
/** The feet cell when the nine cells over the 3x3 round it at feet+2 are all solid (a roof the camp laid, or one like it), else null. */
function roofOver(bot: any, read: ReturnType<typeof bodyReader>): { x: number; y: number; z: number } | null {
  const p = bot.entity?.position;
  if (!p) return null;
  const f = { x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) };
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (read(f.x + dx, f.y + 2, f.z + dz)?.solid !== true) return null;
  return f;
}
/** The nearest endermen beyond ENDERMAN_PICK_RANGE the body is told of (up to three): id, distance, cell and the way from here. Empty when none. */
export function endermenFarther(bot: any): string {
  const at = bot.entity?.position;
  if (!at) return '';
  const far = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity.position && entity.isValid !== false && String(entity.name ?? '').toLowerCase() === 'enderman'
    && entity.position.distanceTo(at) > ENDERMAN_PICK_RANGE && !isDying(bot, entity)).sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at)).slice(0, 3);
  if (!far.length) return '';
  const way = (dx: number, dz: number) => { const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360; return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8]; };
  return `見えている遠いエンダーマン: ${far.map(e => `#${e.id} ${e.position.distanceTo(at).toFixed(0)}m ${way(e.position.x - at.x, e.position.z - at.z)} (${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)})`).join('、')}。`;
}
/**
 * The way on when no enderman's eyes are in sight: the roof site that would see the most (probe kind=roofsite's first, its count capped at 4 so the
 * stop stays quick), else the farther ones to walk toward. The old words "go somewhere open or high" sent h28 (11/8, warped forest) up a pillar into
 * the wart canopy, where 20 endermen within 48 m all stayed hidden below; the first kill came only after the planner probed roofsite itself.
 */
export function sightSiteHint(bot: any): string {
  const at = bot.entity?.position;
  const way = (dx: number, dz: number) => { const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360; return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8]; };
  const words = (best: { cell: Cell; seen: number; open: number; above: number; blocks: number }, near = '') => {
    // end1109p08b: the stop line is cut at 160 and these words came after the count of hidden ones, so the head read 「屋根の場所 (9…」 and no
    // more, 15 times. The way on leads now (the caller puts it first), the cell first in it.
    const height = best.above > 2 ? `・相手より ${best.above} 上` : best.above < 0 ? `・${-best.above} 下` : '';
    const distance = at ? Math.hypot(best.cell.x + 0.5 - at.x, best.cell.y - at.y, best.cell.z + 0.5 - at.z) : 0;
    return `屋根の場所 (${best.cell.x},${best.cell.y},${best.cell.z})${near} へ go で行ってから fight target=enderman（その屋根から見込み ${best.seen >= 4 ? '4 体以上' : `${best.seen} 体`}・見通し ${best.open}%・${distance.toFixed(1)}m${height}・ブロック ${best.blocks}）`;
  };
  // end1109p09 (11/9, warped forest): six stops in 110 s named a site that would see 0 endermen (open 38%, 14-17 below where they stood) while 4-6
  // stood hidden within 48 m; the head went elsewhere each time, rightly. A site that sees none is named only when no enderman is near to go after:
  // else the sites round the nearest hidden one (at its level), else the way to it.
  let open: ReturnType<typeof endermanRoofSites>['sites'][number] | undefined;
  try {
    const best = endermanRoofSites(bot, 16, 1, 4).sites[0];
    if (best && best.seen > 0) return words(best);
    if (best && best.open >= OPEN_ROOF_MIN) open = best;
  } catch { /* the plain words below */ }
  const hidden = endermenToPick(bot).near[0];
  if (hidden && at) {
    const there = cellOfEntity(hidden);
    try {
      const site = endermanRoofSites(bot, 10, 1, 4, there).sites[0];
      if (site && site.seen > 0) return words(site, `（#${hidden.id} の近く）`);
    } catch { /* the way to it below */ }
    const rise = there.y - Math.floor(at.y + 1e-3);
    const level = rise > 2 ? `・${rise} 上` : rise < -2 ? `・${-rise} 下` : '';
    return `近くに目が見える屋根の場所が無い。最寄りの #${hidden.id} は ${way(hidden.position.x - at.x, hidden.position.z - at.z)} ${hidden.position.distanceTo(at).toFixed(0)}m (${there.x},${there.y},${there.z})${level}: その高さの開けた地面へ go で寄ってから probe kind=roofsite で場所を選ぶ`;
  }
  if (open) return words(open);
  const far = endermenFarther(bot);
  return `16m 内に目が見える屋根の場所の見込みが無い（高く登っても葉や幹が下の目を隠すことが多い）。${far}エンダーマンの居る開けた地面の方へ歩いてから probe kind=roofsite で場所を選ぶ`;
}
/**
 * An angry one that cannot climb to her (STUCK_BELOW or more below): the roof site nearest its level (probe kind=roofsite's best there), as the words
 * to walk down to it, or '' when none is found. Why: end1109p08b gave the way on as 「相手と同じ高さの地面に作る」 with no place, five times; the
 * head waited on the ledge each time (wait 20 + fight) and never went down.
 */
function lowSiteWords(bot: any, y: number): string {
  try {
    const low = endermanRoofSites(bot, 16, 12, 4).sites.find(s => s.cell.y <= y + 2 && s.cell.y >= y - 1);
    if (low) return `相手の高さの屋根の場所 (${low.cell.x},${low.cell.y},${low.cell.z})（${Number(low.distance).toFixed(1)}m）へ go で降りて（maxDig 40）から fight target=enderman。`;
  } catch { /* the plain words */ }
  return '';
}
/** How far an enderman named by its kind is looked for (its gaze reaches 64 m; the roof hunts of 11/4 killed 7 of 34 that began 33-48 m off). */
const ENDERMAN_PICK_RANGE = 48;
/**
 * `fight target=enderman` (the kind, not an id): which one. One already angry comes first (it is coming whatever is done). Else the nearest one whose
 * EYES the body sees, in the band the roof hunts were won in (8-48 m, those within 30 m first: utils/huntEndermanProbe's order, the same eye line the
 * camp stares along). The old pick (the nearest within 32 m, seen as a body) left out a third of the hunts' targets and chose ones whose eyes a trunk
 * hid, which the camp then stared at for its 8 s and gave up (S6, 11/4: roof-e3 32 of 66 fights ended so). Null: none of these; the caller's own pick.
 */
export function pickEnderman(bot: any): any {
  const at = bot.entity?.position;
  if (!at) return null;
  // end1109p05: one whose eyes the own cap hid, from every step out, cannot be had from this roof: never the fallback either.
  const all = endermenToPick(bot).near.filter(entity => !hiddenFromRoof(bot, entity));
  const fresh = all.filter(entity => endermanMissCount(bot, entity.id) < MISS_STREAK_NOTE);
  const near = fresh.length ? fresh : all;
  const angry = near.find(entity => { try { return endermanAngry(bot.registry, entity); } catch { return false; } });
  if (angry) return angry;
  let band: Array<{ id: number }> = [];
  let laid = true;
  // Under a roof already laid (the cap over the 3x3 at feet+2), one whose eyes only the cap hides is seen from the roof's edge step: the camp's exit takes it.
  try { const read = bodyReader(bot); const roof = roofOver(bot, read); laid = !!roof; band = huntCandidates(read, at, near, roof, undefined, 1); } catch { band = []; }
  if (band.length) return bot.entities?.[band[0].id] ?? null;
  return laid ? null : roofHerePick(bot, near);
}
/** The least openness (probe kind=roofsite's, 0-100) at which a bare spot is worth a roof with no eyes in sight yet: sightSiteHint's own bar. */
const OPEN_ROOF_MIN = 30;
/**
 * No roof laid where the body stands and no eyes from the bare spot: the one the roof laid here would see (from its centre or a step out, as probe
 * kind=roofsite counts), so the camp lays that roof. None such: null, and the watch (fightWatched) keeps the seconds on the bare spot for one that
 * wanders into view. Only ones less than STUCK_BELOW below the feet: an angry one does not climb to a roof.
 * Why: end1109p08b (11/9, warped forest) walked to the roof site the stop line named 10 times and the fight stopped there each time before any
 * roof (the site's count was from the roof's step out, the pick from the bare spot); 680 s went without a kill.
 */
function roofHerePick(bot: any, near: any[]): any {
  const feet = Math.floor(Number(bot.entity?.position?.y) + 1e-3);
  if (!Number.isFinite(feet) || !near.length) return null;
  const level = near.filter(entity => feet - Math.floor(entity.position.y) < STUCK_BELOW);
  if (!level.length) return null;
  return roofHereSight(bot, level)?.seen[0] ?? null;
}

/** The distance from a point (the eye) to a creature's box. */
function boxDistance(eye: { x: number; y: number; z: number }, entity: any): number {
  const half = (entity.width ?? 0.6) / 2, height = entity.height ?? 1.8, p = entity.position;
  const dx = Math.max(Math.abs(eye.x - p.x) - half, 0), dz = Math.max(Math.abs(eye.z - p.z) - half, 0);
  const dy = Math.max(p.y - eye.y, eye.y - (p.y + height), 0);
  return Math.hypot(dx, dy, dz);
}
const labelOf = (entity: any) => `${entity.name ?? entity.username ?? 'entity'} #${entity.id}`;
const cellOfEntity = (entity: any): Cell => ({ x: Math.floor(entity.position.x), y: Math.floor(entity.position.y + 1e-3), z: Math.floor(entity.position.z) });
/** The off hand's shield: durability used so far and its total, or null when no shield is on the arm. */
function shieldState(bot: any): { used: number; max: number } | null {
  const shield = bot.inventory?.slots?.[45];
  if (shield?.name !== 'shield') return null;
  return { used: Number(shield.durabilityUsed ?? 0), max: Number(bot.registry?.itemsByName?.shield?.maxDurability ?? 336) };
}
/** The drops of a kill, as the line tells them: what lies there (the item entities that were not lying about when the fight began), and where from the body. */
function dropsLine(bot: any, baseline: ReadonlySet<number>, where: { x: number; y: number; z: number }): string {
  const stacks = itemsSince(bot, baseline, new Vec3(where.x + 0.5, where.y, where.z + 0.5), 6);
  if (!stacks.length) return '';
  const names = new Map<string, number>();
  for (const entity of stacks) {
    let name = `#${entity.id}`, count = 1;
    try { const stack = entity.getDroppedItem?.(); if (stack?.name) { name = String(stack.name); count = Number(stack.count ?? 1); } } catch { /* its stack not here yet */ }
    names.set(name, (names.get(name) ?? 0) + count);
  }
  return `・落とし物 ${[...names].map(([name, count]) => `${name}×${count}`).join(' ')}`;
}
/** The code a cut is told by in the hand's line: the act's stop word, a reflex as `reflex`. */
const cutCode = (why: string) => /reflex|^floor-|^lava|^auto-/u.test(why) ? 'reflex' : why.startsWith('stop_if') ? 'stopIf' : why;

/**
 * The roof watch. Under a laid roof, `fight target=enderman` that finds no eyes in sight (enderman_not_visible), or whose camp lost its target's eyes
 * (not_visible), keeps the rest of its seconds there: every WATCH_POLL_MS it looks for one whose eyes are in sight (pickEnderman: an angry one first)
 * and fights that one. The hunter's way: the roof is the trap, and they wander and teleport into view. Why: end1108h29 (11/8, warped forest, 13-20
 * endermen within 48 m): of 73 fights, 39 ended at once on these two and went back to the planner (about 10-25 s each round), often from the
 * same roof three times running. Only for the kind (not an id), and never past WATCH_ROUNDS fights or the fight's own seconds.
 */
const WATCH_POLL_MS = 500, WATCH_LEFT_MS = 6_000, WATCH_ROUNDS = 4;
// end1109p03 (11/9, nether bridges): every fight ended so after its whole 60 s, the nearest enderman 32-40 m off behind netherrack and no roof site
// seeing any; the planner got the same words a minute late, six times. With no kill yet, watch only while one is within WATCH_BLIND_NEAR_M, and
// for WATCH_BLIND_MS at most; else say so at once with the way on.
const WATCH_BLIND_NEAR_M = 24, WATCH_BLIND_MS = 25_000;
/** A stop after which the kind's fight watches the rest of its seconds for another enderman (the stuck one is passed over by the pick). */
export function watchesOnAfter(out: StepOutcome): boolean {
  return !out.ok && ['enderman_not_visible', 'not_visible', 'enderman_did_not_arrive'].includes(String((out as { reason?: string }).reason));
}
export async function fight(ctx: StepContext, args: FightArgs): Promise<StepOutcome> {
  return withMissStreak(ctx.bot, await fightWatched(ctx, args));
}
async function fightWatched(ctx: StepContext, args: FightArgs): Promise<StepOutcome> {
  const started = Date.now();
  const first = await fightOnce(ctx, args);
  const byKind = typeof args.target === 'string' && /^(minecraft:)?enderman$/u.test(args.target.trim().toLowerCase());
  if (args.stance === 'flee' || args.den !== undefined) return first;
  if (!byKind) return typeof args.target === 'string' && !/^#?\d+$/u.test(args.target.trim()) ? fightKindOn(ctx, args, started, first) : first;
  const bot = ctx.bot;
  const endAt = Math.min(started + Math.max(5, Math.min(60, args.seconds ?? DEFAULT_SECONDS)) * 1000, ctx.deadline);
  const tried = new Set<number>();
  const notes: string[] = [];
  let out = first;
  // A kill with seconds left watches on for the next one (end1108h30/h31: the head's turns were 18-22% of the 30 minutes, about one a kill, and
  // the kills came 112-120 s apart where the 12 pearls want about 75 s). Its drops stay told in the line, for one pickup after.
  const kills: StepOutcome[] = [];
  for (let round = 0; round < WATCH_ROUNDS; round++) {
    const killedOne = out.ok && out.code === 'target_killed';
    if (killedOne) kills.push(out);
    // end1109p05: 15 of 28 stops were enderman_did_not_arrive (all #619, 6-9 below in a hollow), each one a head turn and most a roof moved;
    // the kind's pick already passes over the stuck one for 5 minutes, so the rest of the seconds watch for another as after not_visible.
    else if (!watchesOnAfter(out)) break;
    const lost = /enderman #(\d+)/u.exec(out.text);
    if (out.reason === 'not_visible' && lost) tried.add(Number(lost[1]));
    // end1108h31 (11/9): 43 such stops, 32 of them right after go to a roof site where no roof stood yet (fightOnce lays it only once it has a
    // target), so this watch ran 4 times and the head spent about 12 s a round on the rest (514 s of 30 min). Watching needs no roof: fightOnce
    // lays one before it strikes. The words say where it watched.
    if (!bot.entity?.position) break;
    // After a kill, watch only while another enderman is about (WATCH_NEAR_M, eyes seen or not): with none, the seconds go back to the head
    // (the practice field: 24 s under the roof for nobody).
    if (killedOne && !endermanAbout(bot, out)) break;
    if (!killedOne && !endermanWithin(bot, WATCH_BLIND_NEAR_M)) {
      notes.push(`${WATCH_BLIND_NEAR_M}m 内にエンダーマンが居ないので見張らずに返す`);
      break;
    }
    const place = roofOver(bot, bodyReader(bot)) ? '屋根の下で' : 'その場で';
    const from = Date.now();
    let next: any = null;
    const until = killedOne ? endAt - WATCH_LEFT_MS : Math.min(endAt - WATCH_LEFT_MS, from + WATCH_BLIND_MS);
    while (Date.now() < until) {
      if (reflexHeld(bot) || Number(bot.health ?? 20) < 8) break;
      const pick = pickEnderman(bot);
      if (pick && (!tried.has(pick.id) || eyesClear(bot, pick))) { next = pick; break; }
      await wait(ctx, WATCH_POLL_MS);
    }
    const watched = ((Date.now() - from) / 1000).toFixed(1);
    const after = killedOne ? '倒した後、' : '';
    if (!next) {
      if (Date.now() - from >= WATCH_POLL_MS) notes.push(`${after}${place} ${watched} 秒見張ったが、目の見える個体は来なかった`);
      break;
    }
    notes.push(`${after}${place} ${watched} 秒見張り、#${next.id}（${next.position.distanceTo(bot.entity.position).toFixed(1)}m）の目が見えた`);
    out = await fightOnce(ctx, { ...args, target: next.id, seconds: Math.max(5, Math.ceil((endAt - Date.now()) / 1000)) });
  }
  if (out.ok && out.code === 'target_killed' && !kills.includes(out)) kills.push(out);
  if (kills.length) {
    // Told as a kill (ok, target_killed: the streak and the head read it so), every kill's line with its drops first, then how the watch ended.
    // A line holds 160 characters (actReport): with more than one kill the line is the kills, their drops summed and the health lost first
    // (the pickup after reads the drops), then how the watch ended, then the watch's notes, what the clip takes first.
    const last = kills[kills.length - 1];
    const tail = out === last ? '' : `。その後: ${out.text.replace(/^fight /u, '').slice(0, 70)}`;
    const watch = notes.length ? `（${notes.join('→')}）` : '';
    if (kills.length === 1) return { ...last, text: `${last.text}${tail}${watch}` };
    return { ...last, text: `${chainedKills(kills)}${tail}${watch}` };
  }
  if (!notes.length) return out;
  return { ...out, text: `${out.text}（${notes.join('→')}。最初の止まり: ${first.text.slice(0, 80)}）` };
}
/**
 * A hostile kind named (not an enderman, not an id): a kill with seconds left fights the next one of that kind within the range, as the head asked
 * the kind. Why: end1109p09 (11/9) `fight magma_cube range=6 seconds=20` "2 体を倒す" ended on the first kill after 1.2 s; the planner's next turn
 * came 20 s later, the second cube struck all the while (health 20 to 4.6) and she died. A magma cube or slime splits into more of its kind: those too.
 */
const KIND_ROUNDS = 4, KIND_LEFT_MS = 3_000;
const SPLITTERS = new Set(['magma_cube', 'slime']);
async function fightKindOn(ctx: StepContext, args: FightArgs, started: number, first: StepOutcome): Promise<StepOutcome> {
  const bot = ctx.bot;
  const kind = String(args.target).trim().toLowerCase().replace(/^minecraft:/u, '');
  const range = Math.max(4, Math.min(16, args.range ?? DEFAULT_RANGE));
  const endAt = Math.min(started + Math.max(5, Math.min(60, args.seconds ?? DEFAULT_SECONDS)) * 1000, ctx.deadline);
  const kills: StepOutcome[] = [];
  let out = first;
  for (let round = 0; round < KIND_ROUNDS; round++) {
    if (!(out.ok && out.code === 'target_killed')) break;
    kills.push(out);
    if (Date.now() > endAt - KIND_LEFT_MS || !bot.entity?.position || ctx.stop?.aborted) break;
    const here = bot.entity.position;
    const next = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== bot.entity && entity.position && entity.isValid !== false
      && String(entity.name ?? '').toLowerCase() === kind && (entity.type === 'hostile' || SPLITTERS.has(kind)) && !isDying(bot, entity)
      && entity.position.distanceTo(here) <= range).sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
    if (!next) break;
    out = await fightOnce(ctx, { ...args, target: next.id, seconds: Math.max(5, Math.ceil((endAt - Date.now()) / 1000)) });
  }
  if (out.ok && out.code === 'target_killed' && !kills.includes(out)) kills.push(out);
  if (!kills.length) return first;
  const last = kills[kills.length - 1];
  const tail = out === last ? '' : `。その後: ${out.text.replace(/^fight /u, '').slice(0, 70)}`;
  if (kills.length === 1) return tail ? { ...last, text: `${last.text}${tail}` } : last;
  return { ...last, text: `${chainedKills(kills, kind)}${tail}` };
}
/** Several kills of one hand in a few words: `fight 済 enderman 2 体倒した（#201・#200）・落とし物 ender_pearl×2・受けた体力 0`. */
export function chainedKills(kills: readonly StepOutcome[], kind = 'enderman'): string {
  const ids: string[] = [], drops = new Map<string, number>();
  let hurt = 0;
  for (const kill of kills) {
    const text = kill.text ?? '';
    const id = new RegExp(`${kind} #(\\d+)`, 'u').exec(text)?.[1];
    if (id) ids.push(`#${id}`);
    for (const m of (/・落とし物 ([^・（]+)/u.exec(text)?.[1] ?? '').matchAll(/([a-z_]+)×(\d+)/gu)) drops.set(m[1], (drops.get(m[1]) ?? 0) + Number(m[2]));
    hurt += Number(/受けた体力 (\d+(?:\.\d+)?)/u.exec(text)?.[1] ?? 0);
  }
  const dropped = drops.size ? `・落とし物 ${[...drops].map(([name, count]) => `${name}×${count}`).join(' ')}` : '・落とし物 なし';
  return `fight 済 ${kind} ${kills.length} 体倒した（${ids.join('・')}）${dropped}・受けた体力 ${Math.round(hurt * 10) / 10}`;
}
const WATCH_NEAR_M = 32;
/** Whether an enderman other than the one just killed is within WATCH_NEAR_M. */
function endermanAbout(bot: any, killed: StepOutcome): boolean {
  const dead = Number(/enderman #(\d+)/u.exec(killed.text ?? '')?.[1] ?? NaN);
  const me = bot.entity?.position;
  if (!me) return false;
  return Object.values(bot.entities ?? {}).some((e: any) => e && e.name === 'enderman' && e.id !== dead && e.isValid !== false
    && e.position && e.position.distanceTo(me) <= WATCH_NEAR_M);
}
/** Whether any live enderman the pick may take is within the distance (one stuck angry below or off does not count: watching for it is time lost). */
function endermanWithin(bot: any, metres: number): boolean {
  const me = bot.entity?.position;
  if (!me) return false;
  return Object.values(bot.entities ?? {}).some((e: any) => e && e.name === 'enderman' && e.isValid !== false && e.position && e.position.distanceTo(me) <= metres
    && !stuckWhere(bot, e));
}
function eyesClear(bot: any, entity: any): boolean {
  try { return endermanLine(bodyReader(bot), bot.entity.position, entity.position, ENDERMAN_EYE).clear; } catch { return false; }
}

async function fightOnce(ctx: StepContext, args: FightArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const host = nativeActionHost(bot);
  const stance = args.stance === 'flee' ? 'flee' : 'fight';
  const seconds = Math.max(5, Math.min(60, args.seconds ?? DEFAULT_SECONDS));
  const range = Math.max(0, Math.min(16, args.range ?? DEFAULT_RANGE));
  const askedRetreatHp = stance === 'fight' && typeof args.retreatHp === 'number' ? Math.max(1, Math.min(19, Math.round(args.retreatHp))) : null;
  const started = Date.now();
  const endAt = Math.min(started + seconds * 1000, ctx.deadline);
  const none = (code: string, text: string, cause?: string) => stopped(bot, code, `fight 止まった ${code}: ${text}`, undefined, undefined, cause);

  const wanted = typeof args.target === 'number' ? args.target : /^#\d+$/u.test(String(args.target).trim()) ? Number(String(args.target).trim().slice(1)) : args.target;
  if (args.den !== undefined) {
    const problem = endermanDenProblem(args.den);
    if (problem || typeof wanted !== 'number' || !Number.isSafeInteger(wanted) || wanted < 0 || stance !== 'fight') return none('invalid_input', problem ?? 'den は指定した enderman #id の stance=fight だけ');
  }
  deathLedgerOf(bot);
  /**
   * A kind named by its name: the nearest one, but for a blaze or an enderman (hunts from one spot) the nearest one the eye sees: a blaze that hovers behind the spawner room's wall,
   * or an enderman behind a hill, is not the one to fight while another stands in sight (lab: three acts in a row stopped on a blaze 1.8 m off behind the wall).
   */
  const pickTarget = (): any => {
    if (typeof wanted === 'string' && stance === 'fight' && /^(minecraft:)?enderman$/u.test(wanted.trim().toLowerCase())) {
      const chosen = pickEnderman(bot);
      if (chosen) return chosen;
      hiddenEyes = endermenWithoutSight(bot);
      if (hiddenEyes) return null;
    }
    const first = findEntity(bot, wanted, 32);
    if (!first || typeof wanted === 'number') return first;
    const kind = String(first.name ?? '').toLowerCase();
    if (!HOVERING_SHOOTERS.has(kind) && kind !== 'enderman') return first;
    const eyes = eyeOf(bot.entity.position);
    const seen = (entity: any): boolean => {
      try { return probeSight(bodyReader(bot), eyes, { creature: { id: entity.id, name: String(entity.name ?? 'entity'), position: entity.position, height: entity.height, width: entity.width } }).visible; } catch { return true; }
    };
    if (seen(first)) return first;
    const others = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== bot.entity && entity.position && entity.isValid !== false && String(entity.name ?? '').toLowerCase() === kind
      && entity.position.distanceTo(bot.entity.position) <= 32 && !isDying(bot, entity)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)).slice(0, 8);
    return others.find(seen) ?? first;
  };
  let hiddenEyes: string | null = null;
  const target = pickTarget();
  // Endermen about, none with its eyes in sight (S6, 11/5, c1 lab: four fights in a row stared 8 s each at one behind the nylium): said at once, before any roof is laid.
  if (!target && hiddenEyes) return { ...none('enderman_not_visible', `${sightSiteHint(bot)}。${hiddenEyes}`), code: 'enderman_not_visible' };
  // Continue contracts (1, decision 4): a creature named by its id that the body saw die a moment ago is already dead; one that is not there and was not seen to die is not found.
  const askedId = creatureIdOf(wanted);
  if (askedId !== null) { const dead = alreadyDead(bot, askedId, target); if (dead) return dead; }
  if (!target || !target.position) {
    // The way on, by kind (S4's c1 trial: three fights in a row said only "not seen in 32 m" at a camp whose blazes hovered behind the spawner cage).
    const name = String(args.target).toLowerCase();
    const next = /blaze/u.test(name) ? '湧き場の部屋が見える足場（probe kind=camp）へ go で寄り、blaze が見えてから呼ぶ。居ない時は少し待つ'
      : /enderman/u.test(name) ? '開けた所へ動いて probe kind=around で居る所を確かめ、見える所で呼ぶ'
        : '近づいて probe kind=around で居る所を確かめてから呼ぶ';
    // Endermen farther off that the body does see (it is told of them out to about 128 m): where they are, so the planner goes toward them (S6, 11/5, c1 lab: 33 calls in a row said only "not in 32 m").
    const farther = /enderman/u.test(name) ? endermenFarther(bot) : '';
    return { ...none('lost', `${args.target} が ${/enderman/u.test(name) ? ENDERMAN_PICK_RANGE : 32}m 内に見えない（死ぬのを見た記録も無い）。${farther}${next}`), code: 'target_not_found' };
  }
  if (target.type === 'player' || target.username) return none('invalid_input', `${labelOf(target)} は人。fight は生き物（敵）にだけ使う`);
  const label = labelOf(target);
  // A hovering shooter (a blaze) is fought from the spot the planner put the body at, under the shield; one in reach of a walk is gone out to between its volleys (a sortie, above).
  const hovering = HOVERING_SHOOTERS.has(String(target.name ?? '').toLowerCase());
  /** The planner's limit, or for a hovering shooter the camp's own (it cannot be left in a turn: a head that forgot the limit does not fight to the death). */
  const retreatHp = askedRetreatHp ?? (stance === 'fight' && hovering ? CAMP_RETREAT_HP : null);
  const camp = bot.entity.position.clone();
  const fromCamp = (at: { x: number; z: number }) => Math.hypot(at.x - camp.x, at.z - camp.z);
  const ender = stance === 'fight' && String(target.name ?? '').toLowerCase() === 'enderman';
  if (args.den !== undefined && !ender) return none('invalid_input', 'den はエンダーマン専用。他の対象には掘らない');
  // end1108h30: #637 stood angry 6 m off and never came; the head named it by its id ten times running, 40-60 s each (559 s of a 1,553 s run). Said at once now.
  const stuckAt = ender && askedId !== null && args.den === undefined ? stuckWhere(bot, target) : null;
  if (stuckAt) return { ...none('enderman_did_not_arrive', `${label} は怒ったまま来なかった個体（(${stuckAt.x},${stuckAt.y},${stuckAt.z}) 付近。そこに居る間、${STUCK_FORGET_MS / 60_000} 分は戦わない）。fight target=enderman で別の個体を選ぶ`), code: 'enderman_did_not_arrive' };
  // end1109p05: #411 named by its id six times under one roof whose cap hid its eyes from every step out (8 s each, 0 blows). Said at once now, the way on first.
  const hiddenRoof = ender && args.den === undefined ? hiddenFromRoof(bot, target) : null;
  if (hiddenRoof) return { ...none('not_visible', `${label}: ${hiddenFromRoofWords(target.id, hiddenRoof, '少し前にこの屋根で、自分の屋根の蓋が目を隠し、屋根の外へ出てもどこからも見えなかった')}`), code: 'enderman_not_visible' };
  /** A camp holds no key and follows nothing: the body stands where the planner put it. */
  const stand = hovering || ender;
  const watch = hovering ? new ShooterWatch(bot) : null;
  const itemsBefore = itemIds(bot);
  let shield0 = shieldState(bot);
  const gate = new StrikeGate();
  let endermanCamp: EndermanCamp | null = null;
  let endermanDen: EndermanDenFight | null = null;
  // Read closure-assigned camps at cleanup time; async fighting() owns their initialization.
  const releaseRoof = () => endermanCamp?.release();
  const releaseDen = () => endermanDen?.release();
  const held0 = reflexHeld(bot);
  if (held0) return none('reflex', `${label} へ向かう前に、反射 ${held0} が体を握っている。終わるまで始めない`);
  const footingRisk = (enemy = target) => stance === 'fight' && isThreat(bot as never, enemy) ? combatFootingRisk(bot, enemy) : null;
  const footingWords = (risk: NonNullable<ReturnType<typeof combatFootingRisk>>) =>
    `敵から押される先の (${risk.at.x},${risk.at.y},${risk.at.z}) が ${risk.kind}。戦う足場が無い（先に背後の壁・床を確保するか、場所を変える）`;
  const initialRisk = footingRisk();
  if (initialRisk) return none('danger', footingWords(initialRisk));
  // end1109o08: on a pillar one wide at night, fight zombie (8 m, below) walked her off it; on the ground three zombies took 20 health in 5 s. A walking
  // enemy below cannot climb the pillar: the body does not go down to it, and says so.
  if (stance === 'fight' && !hovering && !ender && isThreat(bot as never, target)) {
    const feet = feetCell(bot);
    const stand = feet && target.position.y <= feet.y - 2 ? footingAt(bodyReader(bot), feet) : null;
    if (feet && stand?.pillar && stand.deepest >= VOID_DROP) {
      return { ...none('unreachable', `${label} は下（下 ${feet.y - Math.floor(target.position.y)}）。今は${voidWords(stand)}の上で、歩く敵はこの柱を登れない（ここまで届かない）。`
        + '下りて戦うと地上で囲まれる。上で待つ（wait）か、上がって来た敵だけ attack hold で打つ。矢（skeleton）だけは届く'), code: 'stay_on_pillar' };
    }
  }

  // What it fights with: the item named, else the best sword or axe carried. A flight needs none.
  let weaponName: string | null = null;
  if (stance === 'fight') {
    const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string }>;
    const named = args.item ? findItem(bot, args.item) ?? (bot.heldItem?.name === args.item ? bot.heldItem : null) : null;
    const weapon = args.item ? named : bestBlade(items as never[]) ?? (bot.heldItem && /_(sword|axe)$/u.test(bot.heldItem.name) ? bot.heldItem : null);
    if (!weapon) return none('no_weapon', args.item ? `${args.item} を持っていない` : '剣も斧も持っていない（item で持ち物の道具を挙げれば、それで戦う）');
    weaponName = String(weapon.name);
  }

  // ---- the count of the fight ----
  let blows = 0, landed = 0, lost = 0, meals = 0, dead = false, lastHealth = Number(bot.health ?? 20);
  let lastAt = cellOfEntity(target);
  const swings: number[] = [];
  const onHurt = (entity: any) => {
    if (entity?.id !== target.id) return;
    const index = swings.findIndex(at => Date.now() - at <= LANDED_WITHIN_MS);
    if (index >= 0) { swings.splice(index, 1); landed++; }
  };
  const onDead = (entity: any) => { if (entity?.id === target.id) { dead = true; endermanDen?.markKilled(); } };
  const sample = () => { const now = Number(bot.health ?? lastHealth); if (now < lastHealth) lost += lastHealth - now; lastHealth = now; };
  bot.on?.('entityHurt', onHurt); bot.on?.('entityDead', onDead); bot.on?.('health', sample);
  /** The shield's wear since the fight began (a blocked fireball costs it 6 of its 336), or that it broke; across swaps for a spare, what each broken one had left counts as worn. */
  let retiredWear = 0, spares = 0, spareTriedAt = 0;
  const shieldCounts0 = { caught: bot.shieldBlock?.shieldCaught ?? 0, missed: bot.shieldBlock?.shieldMissed ?? 0 };
  // 受けの成功音（古い版はstatus 29）に攻撃元は無い。火の玉と推測せず種別不明で伝える（shieldBlock）。
  const shieldCounts = () => hovering && bot.shieldBlock ? `・盾で受けた ${bot.shieldBlock.shieldCaught - shieldCounts0.caught || 0}（種別不明）・受け損ね ${bot.shieldBlock.shieldMissed - shieldCounts0.missed || 0}` : '';
  const wear = () => {
    const now = shieldState(bot);
    const sparesNote = spares ? `・予備に替えた×${spares}` : '';
    if (shield0 && !now) return `・盾が壊れた${sparesNote}`;
    const total = retiredWear + (shield0 && now ? Math.max(0, now.used - shield0.used) : 0);
    return shield0 && now && (total > 0 || spares) ? `・盾 −${total}（残り${now.max - now.used}）${sparesNote}` : '';
  };
  /** A shield that broke in the fight is replaced from the pack at once (the habit that wears armour waits for a body that is free, and a fight is not). */
  const replaceBroken = async () => {
    const prior = shield0;
    if (!prior || shieldState(bot) || Date.now() - spareTriedAt < SPARE_RETRY_MS) return;
    spareTriedAt = Date.now();
    const spare = findItem(bot, 'shield');
    if (!spare) return;
    try {
      await guard(fightingCtx, Promise.resolve(bot.equip(spare, 'off-hand')), 3000);
      const now = shieldState(bot);
      if (now) { retiredWear += prior.max - prior.used; shield0 = now; spares++; }
    } catch (error) { if (error instanceof StepStopped || CUT.test(String((error as Error)?.message))) throw error; }
  };
  /** What the end adds to the counts: where the creature stood when the time ran out. */
  let ending = '', siteNote = '';
  /** How long the hand stood and waited for the shield reflex that was meeting a shot (no blow goes out meanwhile): told when it is a second or more. */
  let shotWaitMs = 0;
  const counts = () => `与えた打撃 ${landed}（振り ${blows}）・受けた体力 ${r1(lost)}・食べた ${meals}${wear()}${shieldCounts()}${gate.count ? `・見送り ${gate.count}` : ''}${shotWaitMs >= 1000 ? `・盾の間 ${r1(shotWaitMs / 1000)}秒` : ''}${sortiesOut ? `・出撃 ${sortiesOut}${fromCamp(bot.entity.position) >= OUT_M ? `（野営マスから ${r1(fromCamp(bot.entity.position))}m の所で終えた）` : ''}` : ''}${endermanCamp ? `・${endermanCamp.describe(endermanAngry(bot.registry, bot.entities?.[target.id]))}` : ''}${endermanDen ? `・${endermanDen.describe()}` : ''}${siteNote ? `・${siteNote}` : ''}${ending}`;
  /** Continue contracts (1): the blows that landed (the target was hurt within the swing's time), of the blows swung. */
  const struck = (): Progress => ({ unit: 'blow', done: landed, left: null });
  const holder = (reflex?: string | null) => reflex ? `体: 反射 ${reflex}` : '体: fight（反射なし）';

  // A fight is an engagement the shield reflex and the floor's melee/flee reflexes read; a flight is none (it runs, and a shield on the arm slows it).
  const endEngagement = stance === 'fight' ? beginEngagement(host, [String(target.name ?? '*')]) : () => undefined;
  // The planner's fight (combatOwner): above the floor's own limit health the floor does not run for it or wall her in; the hand's retreatHp is the limit that counts.
  // Run 43: the grace after it is this creature's (its id), not any of its kind.
  const endOwner = stance === 'fight' ? markHeadCombat(host, 'fight', [String(target.name ?? '*')], Date.now(), typeof target.id === 'number' ? target.id : undefined) : () => undefined;
  const navigator = bot.pathfinder;
  const previousMovements = navigator?.movements;
  let following = false;
  const follow = () => {
    if (!navigator || following) return;
    following = true;
    navigator.setGoal(new goals.GoalFollow(target, 2), true);
  };
  const unfollow = () => {
    if (!following) return;
    following = false;
    try { navigator?.setGoal(null); } catch { /* stopped */ }
  };
  /** A sortie's way back to the camp: since when (0 when not on it). The sorties gone out, since when the body is out, why it last turned back and when it may go again. */
  let homeSince = 0, sortiesOut = 0, outSince = 0, backWhy = '', sortieAfter = 0;
  const goHome = (now: number) => {
    if (homeSince || !navigator) return;
    unfollow();
    homeSince = now;
    navigator.setGoal(new goals.GoalNear(camp.x, camp.y, camp.z, 1), false);
  };
  const atHome = () => {
    if (!homeSince) return;
    homeSince = 0;
    try { navigator?.setGoal(null); } catch { /* stopped */ }
  };
  const keys: Record<string, boolean> = {};
  const press = (control: string, on: boolean) => { if (keys[control] === on) return; bot.setControlState(control, on); keys[control] = on; };
  const releaseKeys = () => { for (const control of Object.keys(keys)) if (keys[control]) { try { press(control, false); } catch { /* the port is no longer ours */ } } };
  const aimAt = (live: any) => { try { void Promise.resolve(bot.lookAt(live.position.offset(0, (live.height ?? 1.8) * 0.6, 0), true)).catch(() => undefined); } catch { /* the port is no longer ours */ } };

  // The shield reflex meeting a shot takes the look and the legs: this hand holds its own while that lasts.
  const shield = (bot as { shieldBlock?: { raised: number; up: boolean } }).shieldBlock;
  let seenRaised = shield?.raised ?? 0, shotUntil = 0;
  const meetingShot = () => {
    if (!shield) return false;
    if (shield.raised !== seenRaised) { seenRaised = shield.raised; shotUntil = Date.now() + SHOT_HOLD_MS; }
    return shield.up && Date.now() < shotUntil;
  };

  // The hand owns the retreat above combatOwner's yield health (5); below it, or under a safety lease, the floor may take it.
  // Only the fighting wait is cancelled: never abort the act's lease, end its combat mark, or start a second mover beside this one.
  // Health packets wake it at once; physicsTick also covers a health change without that event, including during a sortie or a shield wait.
  const RETREAT = 'fight-retreat';
  let fightingStop: AbortController | null = null, fightingCtx = ctx;
  const actSignal = actionSignal(bot);
  let retreatWait = '';
  const retreatDue = () => retreatHp !== null && Number(bot.health ?? 20) > 0 && Number(bot.health ?? 20) < retreatHp;
  const checkRetreat = () => {
    if (!retreatDue()) { retreatWait = ''; return; }
    // 次のラボで、呼ばれなかったのか、床や中断に譲ったのかを区別する。同じ待ち理由は毎tick書かない。
    const held = reflexHeld(bot);
    const why = dead ? '相手は死んだ' : ctx.stop.aborted ? 'actの停止' : actSignal?.aborted ? 'actionSignalの停止'
      : held ? `反射 ${held}` : !fightingStop ? '退きの途中' : fightingStop.signal.aborted ? '戦う待ちを中断済み' : '';
    if (why) {
      if (why !== retreatWait) log.info(`↩ fight: 体力 ${r1(Number(bot.health))} < retreatHp ${retreatHp}、退きは待つ（${why}）`);
      retreatWait = why; return;
    }
    log.info(`↩ fight: 体力 ${r1(Number(bot.health))} < retreatHp ${retreatHp}、戦う待ちを切って退く`);
    unfollow(); atHome(); releaseKeys();
    fightingStop!.abort(RETREAT);
  };
  bot.on?.('health', checkRetreat); bot.on?.('physicsTick', checkRetreat);

  const equipWeapon = async () => {
    if (!weaponName || bot.heldItem?.name === weaponName) return;
    const item = findItem(bot, weaponName);
    if (item) {
      const stop = fightingCtx.stop;
      // guard releases the wait, not the native equip: a late verification must not retry writes over the retreat's go.
      const hand = new Proxy(bot, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['equip', 'moveSlotItem', 'clickWindow', 'setQuickBarSlot'].includes(String(key)) && stop.aborted) throw new StepStopped(String(stop.reason));
          return value.apply(target, args);
        };
      } });
      await guard(fightingCtx, equipToHandVerified(hand, item), 5000);
    }
  };

  // ---- ways out of reach ----
  /** Runs from the target (and the other threats near) along the headings the floor's flight reads (no lava, no drop, no fire): until `far` metres, `maxMs`, or no way. */
  async function runAway(far: number, maxMs: number, stepCtx = ctx): Promise<'far' | 'blocked' | 'time' | 'gone' | 'reflex'> {
    unfollow();
    const until = Math.min(Date.now() + maxMs, endAt), memory: { heading?: number } = {};
    let blockedSince = 0;
    try {
      while (Date.now() < until) {
        sample();
        if (reflexHeld(bot)) return 'reflex';
        const live = bot.entities?.[target.id];
        if (!live || dead) return 'gone';
        lastAt = cellOfEntity(live);
        if (live.position.distanceTo(bot.entity.position) >= far) return 'far';
        const threats = [live.position, ...(Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== live && entity !== bot.entity && entity.position
          && entity.position.distanceTo(bot.entity.position) <= 8 && isThreat(bot as never, entity)).map(entity => entity.position)];
        const heading = meetingShot() ? null : fleeKeys(bot as never, threats, memory);
        if (heading === null) {
          releaseKeys();
          if (!blockedSince) blockedSince = Date.now();
          if (Date.now() - blockedSince > 1200 && !meetingShot()) return 'blocked';
        } else {
          blockedSince = 0;
          try { void Promise.resolve(bot.look(heading.yaw, 0, true)).catch(() => undefined); } catch { /* not ours any more */ }
          press('forward', true); press('sprint', true); press('jump', heading.jump);
        }
        await wait(stepCtx, TICK_MS);
      }
      return 'time';
    } finally { releaseKeys(); }
  }

  /** The meal that can help now: a golden apple at any hunger; other food only when the hunger is below the mark at which the body mends itself (18). */
  const mealFor = (): string | null => {
    const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string }>;
    if (items.some(item => item.name === 'golden_apple')) return 'golden_apple';
    if (Number(bot.food ?? 20) >= 18) return null;
    return items.filter(item => itemFoodPoints(bot, item.name) > 0 && !NEVER_EAT.has(item.name))
      .sort((a, b) => itemFoodPoints(bot, b.name) - itemFoodPoints(bot, a.name))[0]?.name ?? null;
  };

  // Amendment A-2: how the enemy ended is told in the structure (code), beside the success the hand keeps: target_killed (its death was seen), target_escaped (alive,
  // outside the range, not chased), target_left (a flight that got the range it was asked for, or the enemy went out of sight while fleeing).
  const ENDINGS: Record<string, string> = { '死んだ': 'target_killed', '逃げた': 'target_escaped', '離れた': 'target_left' };
  const finish = (verdict: string, extra = '', lead = ''): StepOutcome => ({ ok: true, progress: struck(), ...(ENDINGS[verdict] ? { code: ENDINGS[verdict] } : {}), text: `fight 済 ${label} ${verdict}${lead}・${counts()}${extra}・${holder()}` });
  /**
   * The creature's death was seen: what it dropped is told first in the line, where the act's clip keeps it. Not waited for: the items spawn in the tick it dies, in the same batch of packets as
   * the death, so they are here when the loop sees the death (waiting a tenth of a second for them was tried, and the floor's melee reflex took the body from the act in that tenth: the
   * corpse, which the game keeps for a second, stood within reach after the fight's mark had ended).
   */
  const killed = async (): Promise<StepOutcome> => {
    const drops = dropsLine(bot, itemsBefore, lastAt);
    if (endermanDen) {
      const pickup = await endermanDen.collect(); sample();
      if (!pickup.ok) return { ...fail(pickup.code, `倒した（死んだ）が、回収中に ${pickup.reason}${drops}`), code: pickup.code };
    }
    return finish('死んだ', '', drops);
  };
  /** `at`: the creature's cell, only where the place is what the line is about (it cannot be reached). */
  const fail = (code: string, text: string, at?: Cell, cause?: string): StepOutcome => {
    const out = { ...stopped(bot, code, `fight 止まった ${code}: ${label} ${text}。${counts()}・${holder(code === 'reflex' ? reflexHeld(bot) : null)}`, at, undefined, cause), progress: struck() };
    // The creature went out of the body's sight with no death seen: the aim's outcome is not seen (goal unknown, code target_lost), not a failure and not a success.
    return code === 'lost' ? { ...out, goal: 'unknown' as const, code: 'target_lost' } : out;
  };

  /**
   * Below retreatHp at a spawner's camp: a footing no blaze of it can see (utils/huntCamp, the one `probe kind=camp` names) within 40 steps: the body goes there with `go` and the hand ends there,
   * telling the facts the planner chooses from (the health, the hunger, the food carried). Eating, waiting and the way back are the planner's (S2, 2026-11-05, the coordinator: raid3 sat at
   * health 6.1 with hunger 17, which mends nothing, and went out again; that choice is the head's, not the body's). Null where no spawner or hideout is known or the way is not walkable: the flight below.
   */
  let hideoutNote = '';
  async function toHideout(): Promise<StepOutcome | null> {
    let spots: Array<{ x: number; y: number; z: number; steps: number }> = [];
    try {
      const hit = scanLoadedBlocks(bot, ['spawner'], { maxHits: 1, maxDistance: 24 }).hits[0];
      const feet = feetCell(bot);
      if (hit && feet) spots = hideoutsFrom(bodyReader(bot), hit.position, feet, 3);
    } catch { spots = []; }
    if (!spots.length) return null;
    const hp0 = Number(bot.health ?? 0);
    const laid = ['cobblestone', 'netherrack'].filter(name => !!findItem(bot, name));
    // The nearest first; one the way to which is shut (go says why) gives way to the next.
    let spot: { x: number; y: number; z: number; steps: number } | undefined;
    for (const candidate of spots) {
      const walked = await go(ctx, { goals: [{ x: candidate.x, y: candidate.y, z: candidate.z }], range: 0.8, seconds: 15, ...(laid.length ? { canPlace: laid, maxPlace: 6 } : {}) });
      sample();
      if (dead) return killed();
      if (reflexHeld(bot)) return fail('reflex', `体力 ${r1(hp0)} で隠れ場所 (${candidate.x},${candidate.y},${candidate.z}) へ向かう途中で反射が体を握った`);
      if (walked.ok) { spot = candidate; break; }
      hideoutNote = `・隠れ場所 (${candidate.x},${candidate.y},${candidate.z}) へは行けなかった（${String(walked.text).replace(/^go 止まった /u, '').slice(0, 70)}）`;
    }
    if (!spot) return null;
    hideoutNote = '';
    sample();
    const health = Number(bot.health ?? 0), food = Number(bot.food ?? 20);
    const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string; count?: number }>;
    const foods = items.filter(item => itemFoodPoints(bot, item.name) > 0 && !NEVER_EAT.has(item.name)).map(item => `${item.name} ${item.count ?? 1}`);
    // The rods as the head's gate counts them (a rod, or two powders or two eyes): with enough of them the way back to the camp cell is not the head's to take.
    const held = (name: string) => items.filter(item => item.name === name).reduce((sum, item) => sum + (item.count ?? 1), 0);
    const rods = held('blaze_rod') + (held('blaze_powder') + held('ender_eye')) / 2;
    // The facts only: whether the health mends here is the hunger's (18 or more), which the planner reads to choose between eating, waiting and going back.
    return fail('retreat', `体力 ${r1(hp0)}→${r1(health)}・満腹度 ${food}（${food >= 18 ? '体力が戻る' : '18 未満では体力が戻らない'}） 退いた先 (${spot.x},${spot.y},${spot.z}) は湧き場から見えない（${spot.steps}歩）に着いた・食べ物 ${foods.length ? foods.join('・') : 'なし'}・ロッド換算 ${rods}。食べる・待つ・野営マスへ戻るは頭が選ぶ（戻る前に probe kind=around で blaze の数を見る）`);
  }

  /** Below retreatHp: gets out of reach; eats what helps, with a gap, and goes back in when the health is back; else leaves for good. Null: fight on. */
  async function retreat(): Promise<StepOutcome | null> {
    if (hovering) {
      const hidden = await toHideout();
      if (hidden) return hidden;
    }
    for (let round = 0; round <= MAX_MEALS; round++) {
      sample();
      // A camp's fight goes back in only when the health is well above the line it left at (it was at the line when the blazes had taken what they had; back at it, one volley takes it again).
      if (Number(bot.health ?? 20) >= (hovering ? backAt(retreatHp as number) : retreatHp as number)) { await equipWeapon(); return null; }
      const meal = round < MAX_MEALS ? mealFor() : null;
      const how = await runAway(meal ? MEAL_GAP : Math.max(range, 6), meal ? 5500 : 5000);
      const live = bot.entities?.[target.id];
      const gap = live ? live.position.distanceTo(bot.entity.position) : Infinity;
      const left = `体力 ${r1(Number(bot.health ?? 0))} < retreatHp ${retreatHp} で退いた（${Number.isFinite(gap) ? `${r1(gap)}m 離れた` : '相手は見えない'}）${hideoutNote}`;
      if (how === 'reflex') return fail('reflex', `${left}。その途中で反射が体を握った`);
      if (dead) return killed();
      if (how === 'gone') return fail('lost', `${left}。相手が見えなくなった`);
      if (!meal) return fail('retreat', `${left}。${round >= MAX_MEALS ? `${MAX_MEALS} 回食べても戻らなかった` : Number(bot.food ?? 20) >= 18 ? '食べても治りが早まらない（満腹度 18 以上）' : '食べる物が無い'}`);
      if (gap < MEAL_MIN_GAP) return fail('retreat', `${left}。食べる間が取れない（${r1(gap)}m）`);
      const ate = await eat(ctx, { item: meal });
      sample();
      if (!ate.ok) return fail('retreat', `${left}。${ate.text}`);
      meals++;
      await equipWeapon();
    }
    return fail('retreat', `体力 ${r1(Number(bot.health ?? 0))} < retreatHp ${retreatHp} のまま`);
  }

  try {
    if (navigator) {
      try { navigator.setMovements(hovering ? buildMovements(bot, false, true, false, true, false, true, 1, false, true, 1, 10, false) : buildMovements(bot, false, true, true, true, false, true, 1, false, true, 3, 10, false)); } catch { /* the navigator keeps the movements it has */ }
    }
    // ---------------- a flight ----------------
    if (stance === 'flee') {
      const far = Math.max(range, 4);
      const how = await runAway(far, endAt - Date.now());
      const live = bot.entities?.[target.id];
      const away = live ? r1(live.position.distanceTo(bot.entity.position)) : null;
      if (how === 'far') return finish('離れた', `（${away}m ≥ ${far}m）`);
      if (how === 'gone') return finish('離れた', '（相手が見えなくなった）');
      if (how === 'reflex') return fail('reflex', '逃げている途中で反射が体を握った');
      if (how === 'blocked') return fail('unreachable', `から逃げる安全な向きが無い（溶岩・崖・壁。${away}m）`, feetCell(bot) ?? lastAt);
      return fail('limit_time', `から ${seconds} 秒で ${far}m まで離れられなかった（${away}m）`);
    }

    // ---------------- a fight ----------------
    const radius = Math.max(range, ZONE_IN + 0.5);
    let angryBest = Infinity, angryBestAt = Date.now();
    const roofCtx = { ...ctx };
    let prepared = false, lastSwing = 0, backUntil = 0, farSince = 0, blindSince = 0, everNear = false, bestBox = Infinity, bestAt = Date.now();
    // The jump of a critical blow: pressed on the ground, in the air once the feet leave it, spent when they come down.
    let jump: 'idle' | 'pressed' | 'air' = 'idle', jumpAt = 0, noJumpUntil = 0, spent = false, struckInAir = false;
    const fighting = async (): Promise<StepOutcome> => {
      checkRetreat();
      if (fightingCtx.stop.aborted) throw new StepStopped(String(fightingCtx.stop.reason));
      if (!prepared) {
        await equipWeapon();
        // The shield goes to the off hand when one is carried; raising it is the shield reflex's.
        const spare = findItem(bot, 'shield');
        if (spare && !bot.inventory?.slots?.[45]) {
          try { await guard(fightingCtx, Promise.resolve(bot.equip(spare, 'off-hand')), 3000); }
          catch (error) { if (error instanceof StepStopped || CUT.test(String((error as Error)?.message))) throw error; }
        }
        shield0 = shieldState(bot);
        if (ender && args.den) {
          endermanDen = new EndermanDenFight(fightingCtx, args.den, target.id, endAt, askedRetreatHp ?? 8);
        } else if (ender) {
          // The hole it is fought from: the site and the blocks are looked at before anything is done.
          releaseRoof();
          endermanCamp = new EndermanCamp(roofCtx, target);
          let refusal = endermanCamp.check();
          // No roof can be made where the body stands (a step beside it that cannot be filled, a plant not to be built over, a hole): a cell within seven blocks where one can is walked to.
          if (refusal?.code === 'no_site') {
            const site = await moveToRoofSite(fightingCtx, target);
            if (site.moved) { siteNote = site.text; endermanCamp = new EndermanCamp(roofCtx, target); refusal = endermanCamp.check(); }
            else return { ...none('no_site', `${refusal.text}。${site.text}`), code: 'no_site' };
          }
          if (refusal) return { ...none(refusal.code, refusal.text, refusal.cause), code: refusal.code };
        }
        prepared = true;
        bestAt = Date.now();
      }
      for (;;) {
        sample();
        if (reflexHeld(bot)) { unfollow(); releaseKeys(); return fail('reflex', '体を反射が握った'); }
        if (dead) return killed();
        checkRetreat();
        if (fightingCtx.stop.aborted) throw new StepStopped(String(fightingCtx.stop.reason));
        if (hovering) await replaceBroken();
        const live = bot.entities?.[target.id];
        if (!live || live.isValid === false) {
          unfollow(); releaseKeys();
          return dead ? killed() : fail('lost', `が見えなくなった（最後は (${lastAt.x},${lastAt.y},${lastAt.z})）`);
        }
        lastAt = cellOfEntity(live);
        const now = Date.now();
        if (now >= endAt) {
          unfollow(); releaseKeys();
          // Where it stood when the time ran out (an angry enderman that never came, a blaze that stayed out of reach, are different matters for the planner).
          const last = eyeOf(bot.entity.position);
          const gap = r1(boxDistance({ x: last[0], y: last[1], z: last[2] }, live));
          ending = `・最後は ${gap}m${ender ? (endermanAngry(bot.registry, live) ? '・怒っている' : '・怒っていない') : ''}`;
          // An angry one that never came within a blow all the fight long is one stuck where it stands: not picked again for a while (end1108h30, #637 at 6 m).
          if (ender && endermanCamp && landed === 0 && gap > STUCK_FAR_M && endermanAngry(bot.registry, live)) noteStuckAngry(bot, target.id, lastAt, now);
          // end1109p06: 11 such stops, all 0 blows, the body on a one-wide bridge (落差 9〜11) and the angry one 4〜5 below; its teleports kept the
          // did-not-arrive check above from firing, and this line said only the time, so the head rebuilt the roof on the high ground 11 times and spent
          // the 128 cobblestone. Why it did not come, and the way on, lead (the same words as enderman_did_not_arrive).
          const below = Math.floor(bot.entity.position.y) - lastAt.y;
          if (ender && endermanCamp && landed === 0 && below >= STUCK_BELOW && endermanAngry(bot.registry, live)) {
            return fail('limit_time', `は ${seconds} 秒来なかった（相手は足元より ${below} 下）: 高い所の屋根へは歩いて登れない。${lowSiteWords(bot, lastAt.y) || '屋根は相手と同じ高さの地面に作るか、'}別の個体を fight target=enderman で呼ぶ。この高さで屋根を作り直さない`, lastAt,
              `怒っているが ${seconds} 秒近づかない: 屋根まで歩ける道が無い（相手は足元より ${below} 下）${ANGRY_STAYS}`);
          }
          return fail('limit_time', `は ${seconds} 秒で倒れなかった`);
        }
        const eye = eyeOf(bot.entity.position);
        const box = boxDistance({ x: eye[0], y: eye[1], z: eye[2] }, live);
        if (box <= radius) { everNear = true; farSince = 0; } else if (!farSince) farSince = now;

        if (endermanDen && retreatHp !== null && Number(bot.health ?? 20) < retreatHp) {
          unfollow(); releaseKeys();
          return fail('retreat', '指定した体力の下限に達した。横穴の手を中止する');
        }
        const risk = footingRisk(live);
        if (risk) { unfollow(); releaseKeys(); return fail('danger', footingWords(risk)); }
      // An angry enderman that does not come to the roof (no way for it from where it stands: S6, 11/5, c1 lab: two 45 s fights, the target held at 10.7 m):
      // said after ANGRY_STUCK_MS without a metre gained, with where it stands, so the planner moves the roof or calls another.
      if (ender && endermanCamp && box > STUCK_FAR_M && endermanAngry(bot.registry, live)) {
        if (box < angryBest - 1) { angryBest = box; angryBestAt = now; }
        if (now - angryBestAt >= ANGRY_STUCK_MS) {
          unfollow(); releaseKeys();
          noteStuckAngry(bot, target.id, lastAt, now);
          // end1109p05: 15 such stops, all #619 6-9 below; the line was cut at 160 before its way on (「相手と同じ高さの地面に屋…」) and the head moved
          // the roof along the high ground nine times. The way on leads; why it did not come is the root cause (kept whole, CAUSE_MAX).
          const below = Math.floor(bot.entity.position.y) - lastAt.y;
          return fail('enderman_did_not_arrive', `は選ばない（そこに居る間 ${STUCK_FORGET_MS / 60_000} 分）: ${below >= STUCK_BELOW ? `足元より ${below} 下で高い所の屋根へは歩いて登れない。${lowSiteWords(bot, lastAt.y) || '屋根は相手と同じ高さの地面に作るか、'}` : '屋根をそちら側の開けた所に作り直すか、'}別の個体を fight target=enderman で呼ぶ。(${lastAt.x},${lastAt.y},${lastAt.z})・${r1(box)}m`, lastAt,
            `怒っているが ${ANGRY_STUCK_MS / 1000} 秒近づかない: 屋根まで歩ける道が無い${below >= STUCK_BELOW ? `（相手は足元より ${below} 下）${ANGRY_STAYS}` : ''}`);
        }
      } else { angryBest = Infinity; angryBestAt = now; }
        if (!ender && farSince && now - farSince >= OUT_OF_RANGE_MS) {
          unfollow(); releaseKeys();
          return everNear ? finish('逃げた', `（range ${r1(range)}m の外へ ${r1(box)}m。追わない）`) : fail('unreachable', `は range ${r1(range)}m の外のまま（${r1(box)}m）`, lastAt);
        }
        // `creeperLit` reads two slots of the entity data and knows no kind: an enderman's `stared_at` flag sits in the slot a creeper's lit fuse does, so the kind is asked first
        // (an enderman that was angry made the body run from "a lit creeper" out of its hole).
        if (String(live.name) === 'creeper' && creeperLit(live) && box < 7) {
          unfollow(); releaseKeys();
          if (await runAway(8, 2500, fightingCtx) === 'reflex') return fail('reflex', '点火したクリーパーから離れる途中で反射が体を握った');
          continue;
        }
        const denSafety = endermanDen?.checkSafety();
        if (denSafety?.kind === 'stop') return { ...fail(denSafety.outcome.reason ?? 'failed', denSafety.outcome.text), code: denSafety.outcome.code ?? denSafety.outcome.reason };
        if (meetingShot()) {
          releaseKeys(); shotWaitMs += TICK_MS;
          const pauseAt = Date.now(); await wait(fightingCtx, TICK_MS);
          endermanDen?.noteWait(Date.now() - pauseAt);
          continue;
        }
        // A sortie (hovering shooters): the window is open while no blaze that sees the body has its flame on and no shot is on its way; only then is a blaze walked to. Beyond
        // the leash, the body turns back to the camp when the window shuts for good (SORTIE_CHARGE_MS), when the target rises or drifts out of the sortie's reach, or after
        // SORTIE_MS; on the way back it only walks.
        let window = true;
        if (watch) {
          const off = fromCamp(bot.entity.position);
          if (off < OUT_M) outSince = 0;
          else if (!outSince) { outSince = now; sortiesOut++; }
          const charged = watch.charged(now)[0];
          const shot = nextShotTicks(bot, SHOT_HOLD_TICKS) !== null;
          window = !charged && !shot;
          const why = off < OUT_M || homeSince ? null
            : shot ? '火の玉が来る'
              : charged && charged.ms >= SORTIE_CHARGE_MS ? `blaze #${charged.entity.id} が溜めている`
                : hoversAboveReach(bot.entity.position, live) ? '届かない高さへ上がった'
                  : fromCamp(live.position) > SORTIE_M ? `野営マスから ${SORTIE_M}m より遠くへ行った`
                    : now - outSince > SORTIE_MS ? `${SORTIE_MS / 1000}秒出た` : null;
          if (why) { backWhy = why; sortieAfter = now + (/秒出た/u.test(why) ? SORTIE_REST_MS : SORTIE_GAP_MS); releaseKeys(); goHome(now); }
          if (homeSince) {
            if (off < HOME_M) atHome();
            else if (now - homeSince > HOME_MS) { atHome(); releaseKeys(); return fail('unreachable', `に出たが野営マスへ ${HOME_MS / 1000}秒で戻れない（${r1(off)}m 離れている・戻る訳: ${backWhy}）。go で野営マスへ`, lastAt); }
            else { await wait(fightingCtx, TICK_MS); continue; }
          }
        }
        if (endermanDen) {
          const step = await endermanDen.advance(live);
          if (step.kind === 'stop') return { ...fail(step.outcome.reason ?? 'failed', step.outcome.text, step.outcome.at, step.outcome.cause), code: step.outcome.code ?? step.outcome.reason };
          let waiting = step.kind !== 'fight' && endermanDen.phase === 'provoke';
          if (step.kind === 'fight') {
            // Legs, never the generic entity centre/eye ray: the completed den deliberately hides the head.
            await equipWeapon();
            const point = endermanDen.strikePoint(live);
            if (point) {
              const turn = await guard(fightingCtx, Promise.resolve(bot.lookAt(point, true)), 300);
              if (turn && !reflexHeld(bot) && Number(bot.health ?? 20) >= Math.max(8, askedRetreatHp ?? 8) && Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name)) {
                // Recheck after the turn (it may teleport), and only from the rear cell.
                if (endermanDen.strikePoint(live)) { lastSwing = Date.now(); blows++; swings.push(lastSwing); bot.attack(live); }
              }
            } else waiting = true;
          }
          const pauseAt = Date.now();
          await wait(fightingCtx, TICK_MS);
          if (waiting) endermanDen.noteWait(Date.now() - pauseAt);
          continue;
        }
        if (endermanCamp) {
          const step = await endermanCamp.advance(live, now, box, endermanAngry(bot.registry, live));
          if (step.kind === 'stop') { unfollow(); releaseKeys(); return { ...fail(step.outcome.reason ?? 'failed', step.outcome.text, step.outcome.at, step.outcome.cause), ...(step.outcome.code ? { code: step.outcome.code } : {}) }; }
          if (step.kind === 'wait') { releaseKeys(); await wait(fightingCtx, TICK_MS); continue; }
          // The roof was laid with building blocks in the hand: the weapon is taken up again for the blows.
          await equipWeapon();
          // Roof combat uses only the legs' ray and 3m eye-to-point reach. Generic aim (60% of height) can fall inside the eye cone at 48m.
          unfollow(); releaseKeys();
          const point = endermanCamp.strikePoint(live);
          if (point) {
            blindSince = 0;
            const turned = await guard(fightingCtx, Promise.resolve(bot.lookAt(point, true)), 300);
            if (turned && !reflexHeld(bot) && Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name) && endermanCamp.strikePoint(live)) {
              lastSwing = Date.now(); blows++; swings.push(lastSwing); bot.attack(live);
            }
          } else if (box <= REACH) {
            blindSince ||= now;
            if (now - blindSince > BLIND_MS) return fail('unreachable', `は ${r1(box)}m の所にいるが間に壁がある（${BLIND_MS / 1000}秒見えない）。別の個体か、足場を変える`, lastAt);
          } else blindSince = 0;
          await wait(fightingCtx, TICK_MS);
          continue;
        }

        // Closing in.
        if (box > (following ? ZONE_OUT : ZONE_IN)) {
          releaseKeys();
          jump = 'idle';
          // A hovering shooter is not followed up into the air, nor past SORTIE_M, nor at all while the window is shut (nor past the leash in the rest after a sortie): the body
          // keeps its place under the shield, turned to what is charged (else to the creature), and waits; the blaze's height is drawn again every five seconds. Nothing is
          // "cannot be reached" in a wait.
          if (ender || (hovering && (hoversAboveReach(bot.entity.position, live) || fromCamp(live.position) > SORTIE_M || !window
            || now < sortieAfter))) {
            unfollow();
            bestBox = box; bestAt = now;
            const winding = watch?.charged(now)[0];
            aimAt(winding?.entity ?? live);
            await wait(fightingCtx, TICK_MS);
            continue;
          }
          if (box < bestBox - NO_GAIN_M || box > radius) { bestBox = box; bestAt = now; }
          // A sortie that gains nothing goes back to the camp and waits a while (a gap, a fence between): the fight is the camp's, not this walk's.
          if (hovering && now - bestAt > NO_GAIN_MS && fromCamp(bot.entity.position) >= OUT_M) {
            backWhy = `${NO_GAIN_MS / 1000}秒近づけない`; sortieAfter = now + SORTIE_REST_MS; bestAt = now; goHome(now); await wait(fightingCtx, TICK_MS); continue;
          }
          if (now - bestAt > NO_GAIN_MS) { unfollow(); return fail('unreachable', `に近づけない（${r1(box)}m、${NO_GAIN_MS / 1000}秒縮まらない）`, lastAt); }
          const swimming = swimControls(bot, live.position);
          if (swimming) {
            unfollow();
            await swimPulse(fightingCtx, swimming, TICK_MS);
            continue;
          }
          follow();
          await wait(fightingCtx, TICK_MS);
          continue;
        }

        // In reach: stand, face it, keep the far edge of a blow, strike with a full swing and, when it can be done, on the way down.
        unfollow();
        bestBox = box; bestAt = now;
        aimAt(live);
        const onGround = bot.entity.onGround === true;
        const vy = Number(bot.entity.velocity?.y ?? 0);
        const wantBack = !stand && (box < TOO_NEAR || now < backUntil);
        // A camp holds no key: the body stands where the planner put it (the spawner room's floor has gaps, and a step back or forward is a step off it).
        if (stand) { releaseKeys(); } else { press('back', wantBack); press('forward', !wantBack && box > TOO_FAR); press('sprint', false); }
        const remaining = Math.max(0, cooldownMs(bot.heldItem?.name) - (now - lastSwing));
        if (jump === 'pressed' && !onGround) { jump = 'air'; press('jump', false); }
        else if (jump === 'pressed' && now - jumpAt > JUMP_FAILS_MS) { jump = 'idle'; noJumpUntil = now + NO_JUMP_MS; press('jump', false); }
        else if (jump === 'air' && onGround) { jump = 'idle'; spent = !struckInAir; struckInAir = false; }
        /** Room to jump: two cells over the head free, not in a liquid or a web. */
        const canJump = (): boolean => {
          const at = bot.entity.position;
          const free = (dy: number) => { try { const block = bot.blockAt?.(at.offset(0, dy, 0), false); return !block || block.boundingBox !== 'block'; } catch { return true; } };
          return !stand && free(1.8) && free(2.6) && !bot.entity.isInWater && !bot.entity.isInLava && !bot.entity.isInWeb && !bot.entity.isOnLadder && now >= noJumpUntil;
        };
        let sees = true;
        try { sees = probeSight(bodyReader(bot), eye, { creature: { id: live.id, name: String(live.name ?? 'entity'), position: live.position, height: live.height, width: live.width } }).visible; } catch { /* taken as seen */ }
        if (box <= REACH && !sees) {
          if (!blindSince) blindSince = now;
          if (now - blindSince > BLIND_MS) { releaseKeys(); return fail('unreachable', `は ${r1(box)}m の所にいるが間に壁がある（${BLIND_MS / 1000}秒見えない）。別の個体か、足場を変える`, lastAt); }
        } else blindSince = 0;
        let strike = false;
        // A blow is struck from behind the shield when it is up. With it down, and a shot about to land or a blaze that sees
        // the body charged long enough to shoot, the blow waits (GATE_PATIENCE_MS at most: a fight with nothing struck is no safer).
        // (S2, 2026-11-03: a blow lands with the shield raised, lab; with the shield up there is no window to wait for.)
        const held = !!watch && box <= REACH && sees && !shield?.up && !gate.may(now, strikeHold(bot, watch, now));
        if (box <= REACH && sees && !held) {
          if (jump === 'air') strike = remaining === 0 && vy < -0.08;
          else if (jump === 'idle') {
            // The first blow of a fight is struck at once: the swing is full and the creature is here (a jump first costs the half second it takes to come down).
            if (remaining === 0 && (spent || lastSwing === 0 || !canJump())) strike = true;
            else if (remaining <= JUMP_LEAD_MS && !spent && canJump()) { jump = 'pressed'; jumpAt = now; press('jump', true); }
          }
        }
        if (strike) {
          spent = false; struckInAir = jump === 'air';
          lastSwing = now; blows++; swings.push(now);
          if (live.name === 'creeper') backUntil = now + CREEPER_BACK_MS;
          bot.attack(live);
        }
        await wait(fightingCtx, TICK_MS);
      }
    };
    for (;;) {
      const stop = fightingStop = new AbortController();
      const onStop = () => stop.abort(ctx.stop.reason);
      ctx.stop.addEventListener('abort', onStop, { once: true });
      if (ctx.stop.aborted) onStop();
      fightingCtx = { ...ctx, stop: stop.signal };
      roofCtx.stop = stop.signal;
      try { return await fighting(); }
      catch (error) {
        if (!(error instanceof StepStopped) || error.why !== RETREAT) throw error;
        if (ctx.stop.aborted) throw new StepStopped(String(ctx.stop.reason));
        if (actionSignal(bot)?.aborted) throw new Error('Action interrupted');
        if (endermanDen || (ender && args.den)) return fail('retreat', '指定した体力の下限に達した。横穴の手を中止する');
        if (reflexHeld(bot)) return fail('reflex', '退く前に反射が体を握った');
        // 待ちを解く間に5以下になった時も床へ譲る。go と床の逃げ・食事を同時に始めない。
        if (Number(bot.health ?? 20) <= HEAD_COMBAT_YIELD_HEALTH) return fail('reflex', `体力 ${r1(Number(bot.health))} で床へ譲る`);
        // The old wait has unwound before go takes the legs. Fire and lava remain go's hazards, even while the body burns.
        fightingStop = null; fightingCtx = ctx;
        releaseRoof();
        const verdict = await retreat();
        if (verdict) return verdict;
      } finally { ctx.stop.removeEventListener('abort', onStop); fightingStop = null; fightingCtx = ctx; }
    }
  } catch (error) {
    if (error instanceof HandCut) throw error;
    if (error instanceof StepStopped || CUT.test(String((error as Error)?.message ?? error))) {
      // The act's stop, or a reflex's lease: the keys written after it would fail (the port refuses a body it no longer owns), so only the counts are told.
      const code = cutCode(error instanceof StepStopped ? error.why : 'reflex');
      const cut = new HandCut(error instanceof StepStopped ? error.why : String((error as Error).message), `fight 止まった ${code}: ${label}。${counts()}・${holder(code === 'reflex' ? reflexHeld(bot) ?? 'lease' : null)}`);
      (cut as { progress?: Progress }).progress = struck();
      throw cut;
    }
    throw error;
  } finally {
    bot.removeListener?.('health', checkRetreat); bot.removeListener?.('physicsTick', checkRetreat);
    bot.removeListener?.('entityHurt', onHurt); bot.removeListener?.('entityDead', onDead); bot.removeListener?.('health', sample);
    releaseRoof();
    releaseDen();
    endEngagement();
    // end1109p02: in the gap between two fight acts the floor-melee reflex stepped back from the rim and walled the still-angry target out with a block.
    // An angry enderman kept near stays the planner's own fight a little longer (the reflex leaves it alone; under FLEE_HEALTH it does not).
    if (ender) {
      try {
        const left = bot.entities?.[target.id];
        if (left?.isValid !== false && left?.position && endermanAngry(bot.registry, left) && left.position.distanceTo(bot.entity.position) <= ENDER_KEEP_M) engageFor(host, ['enderman'], ENDER_KEEP_MS);
      } catch { /* nothing kept */ }
    }
    endOwner();
    unfollow();
    atHome();
    letGo(bot);
    try { if (previousMovements && navigator) navigator.setMovements(previousMovements); } catch { /* kept */ }
  }
}
