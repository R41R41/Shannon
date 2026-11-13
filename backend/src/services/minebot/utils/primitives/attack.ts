import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { buildMovements } from '../setMovements.js';
import { entityHealth } from '../mapMarks.js';
import { findItem, guard, letGo, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { findEntity } from './use.js';
import { beginEngagement } from '../engagement.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { isThreatEntity } from '../hostileMobHints.js';
import { bodyReader, feetCell, relativeWords } from '../localMap.js';
import { eyeOf, probeSight } from '../probeTools.js';
import { deathLedgerOf } from '../deathLedger.js';
import type { Progress } from '../../integration/commonFca/continueContract.js';
import { swimControls, swimPulse } from './swim.js';
import { markHeadCombat } from '../combatOwner.js';
import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { HOVERING_SHOOTERS, ShooterWatch, StrikeGate, chargeHold, strikeHold } from '../huntBlaze.js';
import { isDragonTarget, strikeDragon } from './dragonStrike.js';
import { endDragonOf } from '../dragonState.js';
import { isCrystalTarget, strikeCrystal } from './crystalStrike.js';
import { takeUpMeleeWeapon } from './meleeWeapon.js';

const { goals } = pathfinder;

/**
 * attack: one creature (by id, or the nearest of a kind within 32 m), until it is dead or for the seconds given (design mb-llm-centric
 * 2.3). It follows the creature on the ground as walk does (no digging, no blocks laid) and strikes with what is in hand when the
 * swing is ready. Whether to fight at all is the planner's: nothing is refused. It stops when the creature is gone, out of reach of a
 * walk, or the time is up, and says how many blows landed and how much health the creature has left.
 */
export interface AttackArgs { target?: string | number; until?: 'dead' | number; chase?: boolean; maxSeconds?: number; mode?: 'chase' | 'hold' }

const REACH = 3.0;
const MAX_SECONDS = 30;
const NO_GAIN_MS = 5000;
/**
 * A blaze is chased only near its camp. end1108h16 S7 (11/8): two chases killed in 0.7 and 2.7 s with no health lost, and the chase and the
 * shots after one blaze took her 15 to 36 m east of the spawner, where nothing spawns (a spawner spawns while a player is within 16 m).
 * With a spawner within 16 m the chase stops once the body is farther than LEASH_SPAWNER_M from it; with none, farther than LEASH_START_M
 * from where the chase began.
 */
export const LEASH_SPAWNER_M = 12;
export const LEASH_START_M = 10;
/** A target this much past the reach is a step or two away: struck even past the radius. */
export const LEASH_NEAR_M = 2;
export function leashOf(bot: any): { at: any; radius: number; spawner: boolean } {
  let hit: { position: any } | undefined;
  try { hit = scanLoadedBlocks(bot, ['spawner'], { maxHits: 1, maxDistance: 16 }).hits[0]; } catch { hit = undefined; }
  return hit ? { at: hit.position.offset(0.5, 0.5, 0.5), radius: LEASH_SPAWNER_M, spawner: true }
    : { at: bot.entity.position.clone(), radius: LEASH_START_M, spawner: false };
}

/** The time a swing needs to be at full strength, by what is held (the game's attack speed). */
export function cooldownMs(held: string | undefined): number {
  if (!held) return 250;
  if (held.endsWith('_sword')) return 625;
  if (held.endsWith('_axe')) return held.startsWith('wooden_') || held.startsWith('stone_') ? 1250 : held.startsWith('iron_') ? 1110 : 1000;
  if (held === 'trident') return 910;
  if (held.endsWith('_shovel') || held.endsWith('_pickaxe')) return held.endsWith('_pickaxe') ? 830 : 1000;
  return 250;
}

const ROD_WATCH_MS = 1000;
const ROD_NEAR_M = 3;
/**
 * end1108h21 (11/8): 13 blazes fell to the sword and 3 rods came in, 2 of them picked up by a hand; the head was never told whether a kill
 * dropped a rod or where it lay (a blaze drops one half the time; one killed over the bridge's void drops it into the void or the lava).
 * Watched for ROD_WATCH_MS after the death: the rod's cell and the fall under it, or that none dropped.
 * end1108h29 (11/8): three endermen fell to attack and the head heard only 倒した, never whether a pearl dropped or where (a pearl, like a rod,
 * comes half the time; the camp's fight already said 落とし物 ender_pearl×1). The same watch now runs for an enderman's pearl.
 */
const KEY_DROPS: Record<string, { item: string; word: string; owner: string }> = {
  blaze: { item: 'blaze_rod', word: 'ロッド', owner: 'ブレイズ' },
  enderman: { item: 'ender_pearl', word: 'パール', owner: 'エンダーマン' },
};
async function rodDropWords(ctx: StepContext, at: any, before: Set<unknown>, kind = 'blaze'): Promise<string> {
  const drop = KEY_DROPS[kind] ?? KEY_DROPS.blaze;
  const bot = ctx.bot;
  if (!at) return '';
  const until = Date.now() + ROD_WATCH_MS;
  const rods = () => (Object.values(bot.entities ?? {}) as any[]).filter(e => e?.name === 'item' && !before.has(e.id) && e.position && e.position.distanceTo(at) <= ROD_NEAR_M + 2
    && (() => { try { return e.getDroppedItem?.()?.name === drop.item; } catch { return false; } })());
  try { while (Date.now() < until && !rods().length) await wait(ctx, 100); } catch { /* the hand was stopped: say what was seen */ }
  const rod = rods()[0];
  if (!rod) return `。${drop.word}は落ちなかった（${drop.owner}が落とすのは半分）`;
  // The drop falls: read the column under it until a solid block (or 48 cells of air: the void).
  const x = Math.floor(rod.position.x), z = Math.floor(rod.position.z);
  const y = Math.floor(rod.position.y);
  let fall = 0, under = '';
  for (; fall < 48; fall++) {
    const block = bot.blockAt?.(new Vec3(x, y - 1 - fall, z));
    if (!block) { under = '未ロード'; break; }
    if (block.boundingBox === 'block' || block.name === 'lava') { under = block.name; break; }
  }
  const self = bot.entity?.position;
  const off = self ? `・${rod.position.distanceTo(self).toFixed(1)}m` : '';
  const land = under === 'lava' ? `。下 ${fall} 段で溶岩に落ちて燃える（拾えない）`
    : !under ? `。下は 48 段以上空所で、拾えない（橋や足場の外で倒すと落とす。床の上で斬る）`
    : fall >= 3 ? `。${fall} 段下の ${under} の上に落ちる（拾うには下りる）`
    : `。歩いて重なれば拾える（pickup target=${drop.item}）`;
  return `。${drop.word}が落ちた (${x},${Math.floor(rod.position.y) - fall},${z})${off}${land}`;
}

/** The id a hand names a creature by ("#41" or 41), or null when it names a kind (a kind does not name one creature, so a death seen is not its answer). */
export function creatureIdOf(target: string | number | undefined): number | null {
  if (typeof target === 'number') return Number.isSafeInteger(target) ? target : null;
  const match = /^#?(\d+)$/u.exec(String(target ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Continue contracts (1, decision 4): the hand's aim, a dead creature, already holds when the body SAW it die (the connection's `entityDead`, in this dimension, within the death memory:
 * utils/deathLedger). A creature that is not there and was not seen to die is not found (`target_not_found`, nothing was moved), never taken for dead.
 */
export function alreadyDead(bot: any, id: number, who?: any): StepOutcome | null {
  const seen = deathLedgerOf(bot).seenDead(id, undefined, who);
  if (!seen) return null;
  return { ok: true, goal: 'already', code: 'target_dead', text: `#${id}${seen.name ? `（${seen.name}）` : ''} は ${(seen.agoMs / 1000).toFixed(0)}秒前に死ぬのを見た（既に済）`,
    progress: { unit: 'blow', done: 0, left: 0 } };
}

/** The seconds an attack may run: the hand's `until`/`maxSeconds`, at most MAX_SECONDS. */
const limitOf = (args: AttackArgs): number => Math.min(MAX_SECONDS, typeof args.until === 'number' && args.until > 0 ? args.until : args.maxSeconds && args.maxSeconds > 0 ? args.maxSeconds : MAX_SECONDS) * 1000;

/**
 * The ender dragon, when the hand names it (by kind, or by the id of the entity that is one): its blows go to its parts and only while it is
 * on the perch (utils/primitives/dragonStrike), in either mode. Null for every other creature.
 */
function dragonNamed(bot: any, target: string | number | undefined): { dragon: any | null; named: boolean } {
  if (isDragonTarget(target)) return { dragon: endDragonOf(bot), named: true };
  const id = creatureIdOf(target);
  const entity = id === null ? null : bot.entities?.[id];
  return entity?.name === 'ender_dragon' ? { dragon: entity, named: true } : { dragon: null, named: false };
}

/** An end crystal the hand names (by kind: the nearest within 64 m; or by the id of one). */
function crystalNamed(bot: any, target: string | number): any | null {
  if (isCrystalTarget(typeof target === 'string' ? target : undefined)) return findEntity(bot, 'end_crystal', 64);
  const id = creatureIdOf(target);
  const entity = id === null ? null : bot.entities?.[id];
  return entity?.name === 'end_crystal' ? entity : null;
}

export async function attack(ctx: StepContext, args: AttackArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const dragon = args.target === undefined ? { dragon: null, named: false } : dragonNamed(bot, args.target);
  if (dragon.named) {
    if (!dragon.dragon) return stopped(bot, 'target_not_found', 'ender_dragon が読み込まれていない（見えていない。エンドに居るか、近づいてから）');
    return strikeDragon(ctx, dragon.dragon, limitOf(args));
  }
  // An end crystal: one blow, and only when its blast leaves the body its health (utils/primitives/crystalStrike).
  const crystal = args.target === undefined ? null : crystalNamed(bot, args.target);
  if (crystal) return strikeCrystal(ctx, crystal);
  if (args.mode === 'hold') return holdAndStrike(ctx, args);
  if (args.target === undefined) return stopped(bot, 'invalid_input', 'attack には target（#id か名前）が要る');
  deathLedgerOf(bot);
  const asked = creatureIdOf(args.target);
  const target = findEntity(bot, args.target, 32);
  // A creature named by its id that the body saw die a moment ago (it may still be listed, its death animation on) is already dead.
  if (asked !== null) { const dead = alreadyDead(bot, asked, target); if (dead) return dead; }
  if (!target) return stopped(bot, 'target_not_found', `${args.target} が 32m 内にいない（死ぬのを見た記録も無い）`);
  const label = `${target.name ?? target.username ?? 'entity'}（id ${target.id}）`;
  const limitMs = Math.min(MAX_SECONDS, typeof args.until === 'number' && args.until > 0 ? args.until : args.maxSeconds && args.maxSeconds > 0 ? args.maxSeconds : MAX_SECONDS) * 1000;
  const untilDead = args.until === undefined || args.until === 'dead';
  const chase = args.chase !== false;
  const started = Date.now();
  const leash = chase && HOVERING_SHOOTERS.has(String(target.name)) ? leashOf(bot) : null;
  const { takenUp } = await takeUpMeleeWeapon(ctx);
  const tookUp = takenUp ? `（${takenUp} を手に持った）` : '';
  let blows = 0, hurt = 0, dead = false;
  /** Continue contracts (1): the blows that landed (the target was hurt), of the blows swung. */
  const landed = (): Progress => ({ unit: 'blow', done: hurt, left: null });
  const onHurt = (entity: any) => { if (entity?.id === target.id) hurt++; };
  let deathAt: any = null;
  const onDead = (entity: any) => { if (entity?.id === target.id) { dead = true; deathAt = entity.position?.clone?.() ?? target.position?.clone?.() ?? null; } };
  const itemsBefore = KEY_DROPS[String(target.name)] ? new Set(Object.values(bot.entities ?? {}).filter((e: any) => e?.name === 'item').map((e: any) => e.id)) : null;
  bot.on('entityHurt', onHurt); bot.on('entityDead', onDead);
  // A fight the planner chose: the dig guard does not count this kind as one shut out, and an archer's arrows are not stepped away from.
  // The low-health flight still runs (the contract's 1.4: the planner raises stopIf.hpBelow to pull out sooner).
  const host = nativeActionHost(bot);
  const endEngagement = beginEngagement(host, [String(target.name ?? '*')]);
  const navigator = bot.pathfinder;
  const previous = navigator?.movements;
  if (chase && navigator) {
    navigator.setMovements(buildMovements(bot, false, true, true, true, false, true, 1, false, true, 3, 10, false));
    navigator.setGoal(new goals.GoalFollow(target, 2), true);
  }
  // A blow that lands is progress too: a target knocked back past the reach by each hit (a wither skeleton, 3.1m) is still being fought, not out of reach.
  let lastSwing = 0, best = Infinity, bestAt = Date.now(), hurtSeen = 0;
  let swimming = false;
  try {
    for (;;) {
      const live = bot.entities?.[target.id];
      if (!live || dead) break;
      if (Date.now() - started >= limitMs) break;
      const distance = live.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) - (live.height ?? 1.8) / 2;
      if (distance < best - 0.3) { best = distance; bestAt = Date.now(); }
      if (hurt > hurtSeen) { hurtSeen = hurt; bestAt = Date.now(); }
      // end1108h17: the cover reflex had already stepped her past the radius, and the first chase let go of a blaze 3.1m away. A blaze a
      // step or two off is struck, and one inside the radius is chased (that leads back in): the leash holds only against a far one outside it.
      if (leash && distance > REACH + LEASH_NEAR_M && bot.entity.position.distanceTo(leash.at) > leash.radius && live.position.distanceTo(leash.at) > leash.radius) {
        letGo(bot);
        const from = leash.at, here = bot.entity.position;
        const where = leash.spawner ? `スポナー (${Math.floor(from.x)},${Math.floor(from.y)},${Math.floor(from.z)}) から ${here.distanceTo(from).toFixed(0)}m` : `追い始めた所から ${here.distanceTo(from).toFixed(0)}m`;
        return { ...stopped(bot, 'leash', `${label} を追うのをやめた: ${where}（${leash.radius}m を超えた。${leash.spawner ? '16m より遠いと新しく湧かない。' : ''}近くに来たブレイズを斬る）。${blows}回振って ${hurt}回当たった`,
          { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) }), progress: landed() };
      }
      if (distance > REACH && (!chase || Date.now() - bestAt > NO_GAIN_MS)) {
        letGo(bot);
        // S1 lab 11/8: the cover reflex had walled a wither skeleton off (cobblestone, 2 high) and attack said 届かない six times naming the
        // creature's own cell (air): the head was not told that a wall stood between. The first solid cell on the line is named (and is the cell).
        const wall = creatureSight(bot, live).between[0];
        const between = wall ? `。間に ${wall.name} (${wall.at.x},${wall.at.y},${wall.at.z})：掘るか回り込めば近づける。壁越しが続くなら窓になる 1 マスを掘る手（dig at=[(${wall.at.x},${wall.at.y},${wall.at.z})] exposeOk=true。開けると相手から見えるので exposeOk が要る）を同じ act の attack の前に入れる` : '';
        const cell = wall ? wall.at : { x: Math.floor(live.position.x), y: Math.floor(live.position.y), z: Math.floor(live.position.z) };
        return { ...stopped(bot, chase ? 'cannot_reach' : 'out_of_reach', `${label} に届かない（${distance.toFixed(1)}m${chase ? `、${NO_GAIN_MS / 1000}秒近づけない` : ''}）。${blows}回振って ${hurt}回当たった${between}`,
          cell), progress: landed() };
      }
      if (distance <= REACH && Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name)) {
        try { await bot.lookAt(live.position.offset(0, (live.height ?? 1.8) * 0.6, 0), true); } catch { /* looked */ }
        bot.attack(live);
        blows++; lastSwing = Date.now();
      }
      const controls = chase && distance > REACH ? swimControls(bot, live.position) : null;
      if (controls) {
        swimming = true;
        await swimPulse(ctx, controls, 50);
        continue;
      }
      if (swimming) {
        swimming = false;
        navigator?.setGoal(new goals.GoalFollow(live, 2), true);
      }
      await wait(ctx, 50);
    }
  } catch (error) {
    if (error && typeof error === 'object' && !(error as { progress?: unknown }).progress) (error as { progress?: Progress }).progress = landed();
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) { letGo(bot); throw error; }
    throw error;
  } finally {
    bot.removeListener('entityHurt', onHurt); bot.removeListener('entityDead', onDead);
    endEngagement();
    try { navigator?.setGoal(null); } catch { /* stopped */ }
    try { if (previous) navigator.setMovements(previous); } catch { /* kept */ }
  }
  const live = bot.entities?.[target.id];
  const health = live ? entityHealth(bot, live) : null;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  // The death is the one the body saw (`entityDead` of this creature while the hand ran): done. A creature that is no longer listed with no death seen (it went out of sight, out of range, into
  // another dimension) is not known dead and not known alive: the aim's outcome is not seen (goal unknown, code target_lost), never a success.
  if (dead) {
    const rod = itemsBefore ? await rodDropWords(ctx, deathAt ?? target.position, itemsBefore, String(target.name)) : '';
    return { ok: true, text: `${label} を倒した（${blows}回振って ${hurt}回当たった、${seconds}秒）${tookUp}${rod}`, progress: landed() };
  }
  if (!live) {
    return { ok: false, goal: 'unknown', reason: 'target_lost', code: 'target_lost', progress: landed(),
      text: `${label} が見えなくなった（死ぬのは見ていない。倒れたか、離れて消えたかは分からない。${blows}回振って ${hurt}回当たった、${seconds}秒）` };
  }
  if (untilDead) return { ...stopped(bot, 'time_up', `${label} は${Math.round(limitMs / 1000)}秒で倒れなかった（${blows}回振って ${hurt}回当たった${health !== null ? `、残り体力 ${health}` : ''}）`), progress: landed() };
  return { ok: true, text: `${label} を ${seconds}秒攻撃した（${blows}回振って ${hurt}回当たった${health !== null ? `、残り体力 ${health}` : ''}）${tookUp}`, progress: landed() };
}

/**
 * A hold with nothing to strike for this long stops as 届かない (r6, run 29: three holds of 15-60 s under a shaft's roof struck 0 times and
 * came back done, while the blaze was 6 up behind stone; 207-267 s cost 6.5 health and no blow).
 */
export const HOLD_UNREACHED_MS = 8000;
/**
 * With a hovering shooter (a blaze) in sight that is only out of reach for now, the hold waits longer for it: its height is drawn again every five seconds (about
 * one draw in three leaves it more than a sword's reach above the eye), so a hold that gives up after eight seconds gives up on a blaze that comes down in five.
 */
export const HOLD_HOVER_PATIENCE_MS = 25_000;
/** A broken shield is replaced from the pack; a failed try is made again no sooner than this. */
const SPARE_RETRY_MS = 1_500;
/** A shield's durability (the game's, for a shield that broke before its use mark was read). */
const SHIELD_DURABILITY = 336;
/** A blow counts as landed when the creature is hurt within this long of the swing at it. */
const LANDED_WITHIN_MS = 600;

/** What the eye sees of a creature: in sight (nothing solid on the line to its middle), the distance to its box, the solid cells between. */
function creatureSight(bot: any, entity: any) {
  const eye = eyeOf(bot.entity.position);
  return probeSight(bodyReader(bot), eye, { creature: { id: entity.id, name: String(entity.name ?? 'entity'), position: entity.position, height: entity.height, width: entity.width } });
}

/** Whether a hand names the blazes as a kind (not one by its id): `target: 'blaze'`. */
export const isBlazeKind = (target: string | number | undefined): boolean => typeof target === 'string' && /^blaze$/iu.test(target.trim());
/** How long no blaze to strike is waited for after the last one fell with a spawner at hand (a spawner draws one every 10 to 40 s), and without one. */
const BLAZE_IDLE_AT_SPAWNER_MS = 45_000;
const BLAZE_IDLE_ELSEWHERE_MS = 8_000;
/** A blaze within this many metres of the eye is looked at for a strike. */
const BLAZE_SEEN_M = 8;

/**
 * attack target=blaze (the kind: round 9's blaze fight lost about 120 s of its 285 to a head that chose one blaze at a time): the blaze nearest the eye that is in sight (nothing solid between) within
 * 8 m is struck until it falls, and then the next, for the hand's seconds (stopIf of the act ends it sooner: its hpBelow is the hand's own). A blaze that cannot be reached (a wall, 3 s without gain) is left
 * for the others, and said at the end. When none is in sight it waits for the spawner's next (45 s at a spawner within 8 m, 8 s elsewhere) and says so. The rod each kill leaves is said as attack says it.
 */
export async function attackBlazes(ctx: StepContext, args: { seconds?: number }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const limitMs = Math.min(120, args.seconds && args.seconds > 0 ? args.seconds : 60) * 1000;
  const started = Date.now();
  const skipped = new Map<number, string>();
  const rods: string[] = [];
  let killed = 0, idleSince = Date.now(), last: StepOutcome | null = null;
  const seen = (): any | null => {
    const eye = bot.entity.position.offset(0, 1.6, 0);
    const found = Object.values(bot.entities ?? {}).filter((e: any) => e?.name === 'blaze' && e.position && !skipped.has(e.id) && e.position.distanceTo(eye) <= BLAZE_SEEN_M)
      .filter((e: any) => { try { return creatureSight(bot, e).between.length === 0; } catch { return false; } })
      .sort((a: any, b: any) => a.position.distanceTo(eye) - b.position.distanceTo(eye));
    return found[0] ?? null;
  };
  let atSpawner: boolean | null = null;
  for (let rounds = 0; rounds < 80; rounds++) {
    const left = limitMs - (Date.now() - started);
    if (left < 2000) break;
    const next = seen();
    if (!next) {
      if (atSpawner === null) { try { atSpawner = scanLoadedBlocks(bot, ['spawner'], { maxHits: 1, maxDistance: 8 }).hits.length > 0; } catch { atSpawner = false; } }
      if (Date.now() - idleSince > (atSpawner ? BLAZE_IDLE_AT_SPAWNER_MS : BLAZE_IDLE_ELSEWHERE_MS)) break;
      await wait(ctx, 400);
      continue;
    }
    const result = await attack(ctx, { target: next.id, until: 'dead', maxSeconds: Math.max(2, Math.floor(left / 1000)) });
    last = result;
    idleSince = Date.now();
    if (result.ok && /倒した/u.test(result.text ?? '')) {
      killed++;
      const rod = /。ロッドが[^。]*/u.exec(result.text ?? '')?.[0];
      if (rod) rods.push(rod.replace(/^。/u, ''));
    } else skipped.set(next.id, `${(result as { reason?: string }).reason ?? result.code ?? 'stopped'}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const left = skipped.size ? `。届かず離れた blaze ${[...skipped.entries()].map(([id, why]) => `#${id}（${why}）`).join('・')}${last && !last.ok ? `。最後の止まり: ${(last.text ?? '').slice(0, 120)}` : ''}` : '';
  const rodWords = rods.length ? `。${rods.slice(-4).join('。')}` : '';
  if (killed > 0) return { ok: true, text: `blaze を ${killed} 体、続けて倒した（${seconds}秒）${rodWords}${left}`, progress: { unit: 'blow', done: killed, left: null } };
  return stopped(bot, skipped.size ? 'cannot_reach' : 'target_not_found',
    skipped.size ? `見えている blaze に届かなかった（${seconds}秒）${left}` : `${BLAZE_SEEN_M}m 内に見える blaze がいない（${seconds}秒待った。壁の向こうなら窓になる 1 マスを dig し、離れているなら湧き場の 1〜3m の野営マスへ go）`);
}

/**
 * attack mode=hold (the owner's run-26 notes, 2026-10-21): stand where the body is, shield up when one is carried in the off hand, and
 * strike only what is within reach (3 m from the eye to its box) and in sight (nothing solid between): the target's kind, or any hostile
 * without one. It never moves and never digs: the waiting place (a gap to strike through) is the planner's to build with place and dig.
 * Ends after the seconds (default 20, at most 60), or, r6, as 届かない when nothing to strike has been in reach and sight for
 * HOLD_UNREACHED_MS: then it says the nearest one's place, how far up or down, whether the eye sees it and the blocks between. Both say
 * the blows swung, the blows landed, the kills, the health lost, and (done) what dropped near.
 */
async function holdAndStrike(ctx: StepContext, args: AttackArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const seconds = Math.max(1, Math.min(60, typeof args.until === 'number' ? args.until : args.maxSeconds ?? 20));
  const wanted = args.target === undefined || args.target === '*' ? null : args.target;
  const wantedId = typeof wanted === 'number' ? wanted : null;
  const wantedName = typeof wanted === 'string' ? wanted.replace(/^minecraft:/u, '').toLowerCase() : null;
  const label = wantedId !== null ? `#${wantedId}` : wantedName ?? '敵';
  // An attack with no target (`*`) goes for a threat by the body's one rule: an unprovoked zombified piglin, piglin with gold worn or enderman is left alone (rig end1109f01).
  const isHostile = (entity: any) => isThreatEntity(entity, bot.registry?.entitiesByName?.[entity.name]?.type, Date.now(), bot as never);
  const fits = (entity: any) => entity && entity !== bot.entity && entity.position && entity.type !== 'player' && entity.name !== 'item'
    && (wantedId !== null ? entity.id === wantedId : wantedName ? String(entity.name).toLowerCase() === wantedName : isHostile(entity));
  // The shield goes to the off hand when one is carried (the hold raises it from there, and the body's reflex raises it against what flies).
  if (!bot.inventory?.slots?.[45]) {
    const spare = findItem(bot, 'shield');
    if (spare) {
      try { await guard(ctx, Promise.resolve(bot.equip(spare, 'off-hand')), 3000); }
      catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
    }
  }
  const { takenUp } = await takeUpMeleeWeapon(ctx);
  const shield = bot.inventory?.slots?.[45]?.name === 'shield';
  // The shield's wear is told across swaps: what each shield that broke had left when it was put on is counted as worn, and the one on the arm by its own mark.
  let shieldUsed0 = Number(bot.inventory?.slots?.[45]?.durabilityUsed ?? 0), retiredWear = 0, spares = 0, spareTriedAt = 0;
  const healthBefore = Number(bot.health ?? 20);
  const before = new Set(Object.keys(bot.entities ?? {}).map(Number));
  const struck = new Set<number>(), killed: string[] = [], swungAt = new Map<number, number>();
  let blows = 0, landed = 0, lastSwing = 0, hurtTaken = 0, raised = false;
  const onDead = (entity: any) => { if (struck.has(entity?.id)) killed.push(String(entity.name)); };
  const onHurt = (entity: any) => {
    if (entity === bot.entity || entity?.id === bot.entity?.id) { hurtTaken++; return; }
    const swung = swungAt.get(entity?.id);
    if (swung !== undefined && Date.now() - swung <= LANDED_WITHIN_MS) { landed++; swungAt.delete(entity.id); }
  };
  bot.on('entityDead', onDead); bot.on('entityHurt', onHurt);
  const host = nativeActionHost(bot);
  const endEngagement = beginEngagement(host, [wantedName ?? '*']);
  const endOwner = markHeadCombat(host, 'fight', [wantedName ?? '*'], Date.now(), wantedId ?? undefined);
  const watch = new ShooterWatch(bot);
  const raise = () => { if (shield && !raised && bot.inventory?.slots?.[45]?.name === 'shield') { try { bot.activateItem(true); raised = true; } catch { /* no shield */ } } };
  /** A shield that broke is replaced from the pack at once: the habit that wears armour waits for a body that is free, and a hold is not. */
  const replaceBroken = async () => {
    if (!shield || bot.inventory?.slots?.[45]?.name === 'shield' || Date.now() - spareTriedAt < SPARE_RETRY_MS) return;
    spareTriedAt = Date.now();
    const spare = findItem(bot, 'shield');
    if (!spare) return;
    raised = false;
    try {
      await guard(ctx, Promise.resolve(bot.equip(spare, 'off-hand')), 3000);
      if (bot.inventory?.slots?.[45]?.name === 'shield') { retiredWear += SHIELD_DURABILITY - shieldUsed0; shieldUsed0 = Number(bot.inventory.slots[45].durabilityUsed ?? 0); spares++; }
    } catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
    raise();
  };
  const lower = () => { if (raised) { try { bot.deactivateItem(); } catch { /* lowered */ } raised = false; } };
  const started = Date.now();
  // A blaze spawner within 8 blocks: the next blaze comes when the spawner draws it (10 to 40 s apart), so nothing in reach is the camp's work and the hold waits its seconds out.
  let atSpawner = false;
  if (wantedName === 'blaze') { try { atSpawner = scanLoadedBlocks(bot, ['spawner'], { maxHits: 1, maxDistance: 8 }).hits.length > 0; } catch { atSpawner = false; } }
  let lastInReach = started, unreached = false;
  const gate = new StrikeGate(), chargeGate = new StrikeGate();
  const struckProgress = (): Progress => ({ unit: 'blow', done: landed, left: null });
  try {
    try { bot.clearControlStates?.(); bot.pathfinder?.setGoal?.(null); } catch { /* standing */ }
    raise();
    for (const until = started + seconds * 1000; Date.now() < until;) {
      await replaceBroken();
      const eyes = bot.entity.position.offset(0, 1.62, 0);
      // Within reach by the cheap distance first; then the eye's line (the sight probe's own computation).
      const near = (Object.values(bot.entities ?? {}) as any[]).filter(fits)
        .filter(entity => entity.position.offset(0, (entity.height ?? 1.8) / 2, 0).distanceTo(eyes) <= REACH + 1.5)
        .map(entity => ({ entity, sight: creatureSight(bot, entity) }))
        .filter(entry => entry.sight.visible && entry.sight.distance <= REACH).sort((a, b) => a.sight.distance - b.sight.distance)[0];
      if (near) lastInReach = Date.now();
      else if (!atSpawner && Date.now() - lastInReach >= HOLD_UNREACHED_MS) {
        // A hovering shooter in sight is only out of reach for now: it is waited for (under the shield) up to HOLD_HOVER_PATIENCE_MS.
        const hovering = (Object.values(bot.entities ?? {}) as any[]).some(entity => fits(entity) && HOVERING_SHOOTERS.has(String(entity.name)) && entity.position.distanceTo(eyes) <= 16
          && creatureSight(bot, entity).visible);
        if (!hovering || Date.now() - lastInReach >= HOLD_HOVER_PATIENCE_MS) { unreached = true; break; }
      }
      // A blow is struck from behind the raised shield. With no shield up (none carried, or lowered by something else), and a shot about to land or a blaze that sees the body charged
      // long enough to shoot, a hovering shooter's blow waits (utils/huntBlaze StrikeGate: 1.5 s in all within each 8 s).
      // (S2, 2026-11-03: a blow lands with the shield raised, lab; the shield stays up for it, and with it up there is no window to wait for.)
      // A fireball about to land is the shield reflex's moment (it turns the look to the shot): no blow, and no look at the target over it, while one is on its way (review 2026-11-03).
      const why = !!near && HOVERING_SHOOTERS.has(String(near.entity.name)) ? strikeHold(bot, watch, Date.now()) : null;
      const shotComing = why !== null && why.startsWith('火の玉');
      // (the gate's patience still bounds it: 1.5 s in all within each 8 s, so a stream of fireballs does not stop every blow)
      // (a blaze that sees the body has its flame on: no blow while it charges, only the shield; the gate's patience still bounds the wait)
      const charging = !!near && HOVERING_SHOOTERS.has(String(near.entity.name)) ? chargeHold(watch, Date.now()) : null;
      // The charge wait has its own patience (chargeGate): spent on a flame that only charges, it would leave no wait for the shot that lands about 3 s later (review 2026-11-05).
      const shotWhy = shotComing || !raised ? why : null;
      const now = Date.now();
      const hovering = !!near && HOVERING_SHOOTERS.has(String(near.entity.name));
      // Both gates are asked each time (no short cut), so each one's hold is timed.
      const held = hovering && [!gate.may(now, shotWhy), !chargeGate.may(now, shotWhy ? null : charging)].some(Boolean);
      if (near && !held && Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name)) {
        raise();
        try { await bot.lookAt(near.entity.position.offset(0, (near.entity.height ?? 1.8) * 0.6, 0), true); } catch { /* looked */ }
        // Marked before the swing: the hurt that answers it may come at once.
        struck.add(near.entity.id); swungAt.set(near.entity.id, Date.now()); blows++; lastSwing = Date.now();
        bot.attack(near.entity);
        await wait(ctx, 100);
        raise();
      }
      await wait(ctx, 50);
    }
  } catch (error) {
    if (error && typeof error === 'object' && !(error as { progress?: unknown }).progress) (error as { progress?: Progress }).progress = struckProgress();
    throw error;
  } finally {
    lower();
    bot.removeListener('entityDead', onDead); bot.removeListener('entityHurt', onHurt);
    endEngagement();
    endOwner();
  }
  const lost = Math.max(0, Math.round((healthBefore - Number(bot.health ?? healthBefore)) * 10) / 10);
  // The shield's wear in this hold (a blocked fireball costs it 6 of its 336), or that it broke; and the blows held back for a shot.
  const shieldNow = bot.inventory?.slots?.[45];
  const wornTotal = retiredWear + (shieldNow?.name === 'shield' ? Math.max(0, Number(shieldNow.durabilityUsed ?? 0) - shieldUsed0) : 0);
  const sparesNote = spares ? `・予備に替えた×${spares}` : '';
  const wear = shield && shieldNow?.name !== 'shield' ? `・盾が壊れた${sparesNote}` : shield && wornTotal > 0 ? `・盾 −${wornTotal}${sparesNote}` : shield && spares ? sparesNote : '';
  const counts = `${blows}回打った・${landed}回当たった・倒した ${killed.length}${killed.length ? `（${killed.join('・')}）` : ''}・受けた傷 ${lost}${wear}${gate.count + chargeGate.count ? `・見送り ${gate.count + chargeGate.count}` : ''}`;
  const drops = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity?.name === 'item' && !before.has(entity.id)
    && entity.position.distanceTo(bot.entity.position) <= 8);
  const dropNames = drops.map(entity => { try { const item = entity.getDroppedItem?.(); return item ? `${item.name}×${item.count}（id ${entity.id}）` : `#${entity.id}`; } catch { return `#${entity.id}`; } });
  // end1108h7b: a rod asked for by radius lost to the nearest brick; the id lets the hand walk to the rod itself.
  const pickWords = drops.length ? `pickup target=#${drops[0].id} で拾う${drops.length > 1 ? `。ほかは target=#${drops.slice(1).map(entity => entity.id).join('・#')}` : ''}` : '';
  if (unreached) {
    // The act's line is 160 characters with the closed word and what the cell holds: the counts first (and what the kills dropped, a rod to pick up), then the nearest one.
    const held = ((Date.now() - started) / 1000).toFixed(0);
    const nearest = nearestFact(bot, fits, label);
    return { ...stopped(bot, 'out_of_reach', `${held}秒、打てる所（目から${REACH}m・見える）に${label}がいない。${counts}${dropNames.length ? `。落とし物 ${dropNames.join(' ')}（${pickWords}）` : ''}。${nearest.text}`, nearest.at), progress: struckProgress() };
  }
  // A hold that struck nothing says where the nearest one was, as the stop does.
  const none = blows === 0 ? `。${nearestFact(bot, fits, label).text}` : '';
  // At a blaze spawner the camp is within three blocks of it (mine-ai-mcp's CAMP_RANGE): how far it is, so that a body put too far is moved.
  let spawnerNote = '';
  if (wantedName === 'blaze' || killed.includes('blaze')) {
    try {
      const spawner = scanLoadedBlocks(bot, ['spawner'], { maxHits: 1, maxDistance: 24 }).hits[0];
      if (spawner) spawnerNote = `、湧き場 (${spawner.position.x},${spawner.position.y},${spawner.position.z}) まで ${Math.round(spawner.distance * 10) / 10}m`;
    } catch { /* unread */ }
  }
  return { ok: true, progress: struckProgress(), text: `${seconds}秒その場で構えた${shield ? '（盾）' : ''}: ${counts}（被弾 ${hurtTaken}回）${takenUp ? `、${takenUp} を手に持った` : ''}`
    + `、落とし物 ${dropNames.length ? `${dropNames.join(' ')}（${pickWords}）` : 'なし'}${spawnerNote}${none}` };
}

/** The nearest creature the hold waits for: its id and place, where from the feet (up/down), the distance from the eye, seen or the blocks between. */
function nearestFact(bot: any, fits: (entity: any) => boolean, label: string): { text: string; at?: { x: number; y: number; z: number } } {
  const eyes = bot.entity.position.offset(0, 1.62, 0);
  const nearest = (Object.values(bot.entities ?? {}) as any[]).filter(fits)
    .map(entity => ({ entity, distance: entity.position.distanceTo(eyes) })).sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return { text: `最寄りの${label}は見えている範囲にいない` };
  const entity = nearest.entity;
  const cell = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y + 1e-3), z: Math.floor(entity.position.z) };
  const feet = feetCell(bot);
  const sight = creatureSight(bot, entity);
  const way = feet ? relativeWords(feet, cell) : '';
  // The first solid cell on the line (the nearest the eye) and how many more: the line has room for one.
  const first = sight.between[0];
  const more = sight.between.length - 1;
  const seen = sight.visible || !first ? '見える' : `見えない：間に (${first.at.x},${first.at.y},${first.at.z}) ${first.name}${more > 0 ? ` ほか ${more}${sight.between.length >= 8 ? ' 以上' : ''}` : ''}`;
  return { text: `最寄り ${entity.name} #${entity.id} (${cell.x},${cell.y},${cell.z}) ${way}・目から${sight.distance}m・${seen}`, at: cell };
}
