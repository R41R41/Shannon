import pathfinder from 'mineflayer-pathfinder';
import { buildMovements } from '../setMovements.js';
import { entityHealth } from '../mapMarks.js';
import { findItem, guard, letGo, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { findEntity } from './use.js';
import { beginEngagement } from '../engagement.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { isLikelyHostileMobName } from '../hostileMobHints.js';
import { bodyReader, feetCell, relativeWords } from '../localMap.js';
import { eyeOf, probeSight } from '../probeTools.js';
import { deathLedgerOf } from '../deathLedger.js';
import type { Progress } from '../../integration/commonFca/continueContract.js';
import { swimControls, swimPulse } from './swim.js';
import { markHeadCombat } from '../combatOwner.js';
import { bestMeleeWeapon } from '../floorReflexes.js';
import { equipToHandVerified } from '../equipVerified.js';
import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { HOVERING_SHOOTERS, ShooterWatch, StrikeGate, strikeHold } from '../huntBlaze.js';
import { isDragonTarget, strikeDragon } from './dragonStrike.js';
import { endDragonOf } from '../dragonState.js';
import { isCrystalTarget, strikeCrystal } from './crystalStrike.js';

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

/** The time a swing needs to be at full strength, by what is held (the game's attack speed). */
export function cooldownMs(held: string | undefined): number {
  if (!held) return 250;
  if (held.endsWith('_sword')) return 625;
  if (held.endsWith('_axe')) return held.startsWith('wooden_') || held.startsWith('stone_') ? 1250 : held.startsWith('iron_') ? 1110 : 1000;
  if (held === 'trident') return 910;
  if (held.endsWith('_shovel') || held.endsWith('_pickaxe')) return held.endsWith('_pickaxe') ? 830 : 1000;
  return 250;
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
  let blows = 0, hurt = 0, dead = false;
  /** Continue contracts (1): the blows that landed (the target was hurt), of the blows swung. */
  const landed = (): Progress => ({ unit: 'blow', done: hurt, left: null });
  const onHurt = (entity: any) => { if (entity?.id === target.id) hurt++; };
  const onDead = (entity: any) => { if (entity?.id === target.id) dead = true; };
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
  let lastSwing = 0, best = Infinity, bestAt = Date.now();
  let swimming = false;
  try {
    for (;;) {
      const live = bot.entities?.[target.id];
      if (!live || dead) break;
      if (Date.now() - started >= limitMs) break;
      const distance = live.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) - (live.height ?? 1.8) / 2;
      if (distance < best - 0.3) { best = distance; bestAt = Date.now(); }
      if (distance > REACH && (!chase || Date.now() - bestAt > NO_GAIN_MS)) {
        letGo(bot);
        return { ...stopped(bot, chase ? 'cannot_reach' : 'out_of_reach', `${label} に届かない（${distance.toFixed(1)}m${chase ? `、${NO_GAIN_MS / 1000}秒近づけない` : ''}）。${blows}回振って ${hurt}回当たった`,
          { x: Math.floor(live.position.x), y: Math.floor(live.position.y), z: Math.floor(live.position.z) }), progress: landed() };
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
  if (dead) return { ok: true, text: `${label} を倒した（${blows}回振って ${hurt}回当たった、${seconds}秒）`, progress: landed() };
  if (!live) {
    return { ok: false, goal: 'unknown', reason: 'target_lost', code: 'target_lost', progress: landed(),
      text: `${label} が見えなくなった（死ぬのは見ていない。倒れたか、離れて消えたかは分からない。${blows}回振って ${hurt}回当たった、${seconds}秒）` };
  }
  if (untilDead) return { ...stopped(bot, 'time_up', `${label} は${Math.round(limitMs / 1000)}秒で倒れなかった（${blows}回振って ${hurt}回当たった${health !== null ? `、残り体力 ${health}` : ''}）`), progress: landed() };
  return { ok: true, text: `${label} を ${seconds}秒攻撃した（${blows}回振って ${hurt}回当たった${health !== null ? `、残り体力 ${health}` : ''}）`, progress: landed() };
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
  const isHostile = (entity: any) => String(bot.registry?.entitiesByName?.[entity.name]?.type ?? entity.type) === 'hostile' || isLikelyHostileMobName(String(entity.name ?? ''));
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
  // A blow struck with an empty hand is one point of a blaze's twenty: when the hand holds no sword or axe, the best one carried goes into it first (one already held stays).
  let weapon = String(bot.heldItem?.name ?? ''), takenUp = '';
  if (!/_(sword|axe)$/u.test(weapon)) {
    const best = bestMeleeWeapon(bot.inventory?.items?.() ?? []);
    if (best && /_(sword|axe)$/u.test(String(best.name))) {
      try { const held = await guard(ctx, equipToHandVerified(bot, best as { name: string; type: number; slot?: number }), 5000); if (held?.value.held) { weapon = String(best.name); takenUp = weapon; } }
      catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
    }
  }
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
  const gate = new StrikeGate();
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
      const held = !raised && !!near && HOVERING_SHOOTERS.has(String(near.entity.name)) && !gate.may(Date.now(), strikeHold(bot, watch, Date.now()));
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
  const counts = `${blows}回打った・${landed}回当たった・倒した ${killed.length}${killed.length ? `（${killed.join('・')}）` : ''}・受けた傷 ${lost}${wear}${gate.count ? `・見送り ${gate.count}` : ''}`;
  const drops = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity?.name === 'item' && !before.has(entity.id)
    && entity.position.distanceTo(bot.entity.position) <= 8);
  const dropNames = drops.map(entity => { try { const item = entity.getDroppedItem?.(); return item ? `${item.name}×${item.count}` : `#${entity.id}`; } catch { return `#${entity.id}`; } });
  if (unreached) {
    // The act's line is 160 characters with the closed word and what the cell holds: the counts first (and what the kills dropped, a rod to pick up), then the nearest one.
    const held = ((Date.now() - started) / 1000).toFixed(0);
    const nearest = nearestFact(bot, fits, label);
    return { ...stopped(bot, 'out_of_reach', `${held}秒、打てる所（目から${REACH}m・見える）に${label}がいない。${counts}${dropNames.length ? `。落とし物 ${dropNames.join(' ')}（pickup で拾う）` : ''}。${nearest.text}`, nearest.at), progress: struckProgress() };
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
    + `、落とし物 ${dropNames.length ? `${dropNames.join(' ')}（pickup で拾う）` : 'なし'}${spawnerNote}${none}` };
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
