import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { buildMovements } from '../setMovements.js';
import { beginEngagement } from '../engagement.js';
import { markHeadCombat } from '../combatOwner.js';
import { combatFootingRisk } from '../combatFooting.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
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
import { EndermanCamp, moveToRoofSite } from '../huntEndermanCamp.js';
import { endermanAngry } from '../huntEnderman.js';
import { hideoutsFrom } from '../huntCamp.js';
import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { go } from './go.js';

const { goals } = pathfinder;

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
 * An enderman is fought from a hole it cannot enter (utils/huntEnderman, huntEndermanCamp): the body lays a 3x3 roof over itself at feet+2 from what building
 * blocks it carries, stares the enderman in the eye from under it (the gaze guard is let go for the stare), and from then on stands in the hole under the shield
 * and strikes what comes within reach: it is not followed, and it is not looked in the eye once it is angry (it would teleport away). The roof is the hand's own
 * work and needs no canPlace: the blocks are named in the line when they are short. A bow is no tool for it (it dodges arrows).
 *
 * It never looks for a target of its own: another creature that comes is not turned to (the floor's reflexes answer it, and their word is above this
 * hand's). It never digs and never lays a block. Whatever it does is told in the line: the blows swung and landed, the health lost, the meals, and who
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
export interface FightArgs { target: string | number; stance?: 'fight' | 'flee'; item?: string; retreatHp?: number; range?: number; seconds?: number }

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

export async function fight(ctx: StepContext, args: FightArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const host = nativeActionHost(bot);
  const stance = args.stance === 'flee' ? 'flee' : 'fight';
  const seconds = Math.max(5, Math.min(60, args.seconds ?? DEFAULT_SECONDS));
  const range = Math.max(0, Math.min(16, args.range ?? DEFAULT_RANGE));
  const askedRetreatHp = stance === 'fight' && typeof args.retreatHp === 'number' ? Math.max(1, Math.min(19, Math.round(args.retreatHp))) : null;
  const started = Date.now();
  const endAt = Math.min(started + seconds * 1000, ctx.deadline);
  const none = (code: string, text: string) => stopped(bot, code, `fight 止まった ${code}: ${text}`);

  const wanted = typeof args.target === 'number' ? args.target : /^#\d+$/u.test(String(args.target).trim()) ? Number(String(args.target).trim().slice(1)) : args.target;
  deathLedgerOf(bot);
  /**
   * A kind named by its name: the nearest one, but for a blaze or an enderman (hunts from one spot) the nearest one the eye sees: a blaze that hovers behind the spawner room's wall,
   * or an enderman behind a hill, is not the one to fight while another stands in sight (lab: three acts in a row stopped on a blaze 1.8 m off behind the wall).
   */
  const pickTarget = (): any => {
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
  const target = pickTarget();
  // Continue contracts (1, decision 4): a creature named by its id that the body saw die a moment ago is already dead; one that is not there and was not seen to die is not found.
  const askedId = creatureIdOf(wanted);
  if (askedId !== null) { const dead = alreadyDead(bot, askedId, target); if (dead) return dead; }
  if (!target || !target.position) {
    // The way on, by kind (S4's c1 trial: three fights in a row said only "not seen in 32 m" at a camp whose blazes hovered behind the spawner cage).
    const name = String(args.target).toLowerCase();
    const next = /blaze/u.test(name) ? '湧き場の部屋が見える足場（probe kind=camp）へ go で寄り、blaze が見えてから呼ぶ。居ない時は少し待つ'
      : /enderman/u.test(name) ? '開けた所へ動いて probe kind=around で居る所を確かめ、見える所で呼ぶ'
        : '近づいて probe kind=around で居る所を確かめてから呼ぶ';
    return { ...none('lost', `${args.target} が 32m 内に見えない（死ぬのを見た記録も無い）。${next}`), code: 'target_not_found' };
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
  /** A camp holds no key and follows nothing: the body stands where the planner put it. */
  const stand = hovering || ender;
  const watch = hovering ? new ShooterWatch(bot) : null;
  const itemsBefore = itemIds(bot);
  let shield0 = shieldState(bot);
  const gate = new StrikeGate();
  let endermanCamp: EndermanCamp | null = null;
  const held0 = reflexHeld(bot);
  if (held0) return none('reflex', `${label} へ向かう前に、反射 ${held0} が体を握っている。終わるまで始めない`);
  const footingRisk = (enemy = target) => stance === 'fight' && isThreat(bot as never, enemy) ? combatFootingRisk(bot, enemy) : null;
  const footingWords = (risk: NonNullable<ReturnType<typeof combatFootingRisk>>) =>
    `敵から押される先の (${risk.at.x},${risk.at.y},${risk.at.z}) が ${risk.kind}。戦う足場が無い（先に背後の壁・床を確保するか、場所を変える）`;
  const initialRisk = footingRisk();
  if (initialRisk) return none('danger', footingWords(initialRisk));

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
  const onDead = (entity: any) => { if (entity?.id === target.id) dead = true; };
  const sample = () => { const now = Number(bot.health ?? lastHealth); if (now < lastHealth) lost += lastHealth - now; lastHealth = now; };
  bot.on?.('entityHurt', onHurt); bot.on?.('entityDead', onDead); bot.on?.('health', sample);
  /** The shield's wear since the fight began (a blocked fireball costs it 6 of its 336), or that it broke; across swaps for a spare, what each broken one had left counts as worn. */
  let retiredWear = 0, spares = 0, spareTriedAt = 0;
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
      await guard(ctx, Promise.resolve(bot.equip(spare, 'off-hand')), 3000);
      const now = shieldState(bot);
      if (now) { retiredWear += prior.max - prior.used; shield0 = now; spares++; }
    } catch (error) { if (error instanceof StepStopped || CUT.test(String((error as Error)?.message))) throw error; }
  };
  /** What the end adds to the counts: where the creature stood when the time ran out. */
  let ending = '', siteNote = '';
  /** How long the hand stood and waited for the shield reflex that was meeting a shot (no blow goes out meanwhile): told when it is a second or more. */
  let shotWaitMs = 0;
  const counts = () => `与えた打撃 ${landed}（振り ${blows}）・受けた体力 ${r1(lost)}・食べた ${meals}${wear()}${gate.count ? `・見送り ${gate.count}` : ''}${shotWaitMs >= 1000 ? `・盾の間 ${r1(shotWaitMs / 1000)}秒` : ''}${sortiesOut ? `・出撃 ${sortiesOut}${fromCamp(bot.entity.position) >= OUT_M ? `（野営マスから ${r1(fromCamp(bot.entity.position))}m の所で終えた）` : ''}` : ''}${endermanCamp ? `・${endermanCamp.describe(endermanAngry(bot.registry, bot.entities?.[target.id]))}` : ''}${siteNote ? `・${siteNote}` : ''}${ending}`;
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

  const equipWeapon = async () => {
    if (!weaponName || bot.heldItem?.name === weaponName) return;
    const item = findItem(bot, weaponName);
    if (item) await guard(ctx, equipToHandVerified(bot, item), 5000);
  };

  // ---- ways out of reach ----
  /** Runs from the target (and the other threats near) along the headings the floor's flight reads (no lava, no drop, no fire): until `far` metres, `maxMs`, or no way. */
  async function runAway(far: number, maxMs: number): Promise<'far' | 'blocked' | 'time' | 'gone' | 'reflex'> {
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
        await wait(ctx, TICK_MS);
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
  const killed = async (): Promise<StepOutcome> => finish('死んだ', '', dropsLine(bot, itemsBefore, lastAt));
  /** `at`: the creature's cell, only where the place is what the line is about (it cannot be reached). */
  const fail = (code: string, text: string, at?: Cell): StepOutcome => {
    const out = { ...stopped(bot, code, `fight 止まった ${code}: ${label} ${text}。${counts()}・${holder(code === 'reflex' ? reflexHeld(bot) : null)}`, at), progress: struck() };
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
    const foods = ((bot.inventory?.items?.() ?? []) as Array<{ name: string; count?: number }>).filter(item => itemFoodPoints(bot, item.name) > 0 && !NEVER_EAT.has(item.name))
      .map(item => `${item.name} ${item.count ?? 1}`);
    // The facts only: whether the health mends here is the hunger's (18 or more), which the planner reads to choose between eating, waiting and going back.
    return fail('retreat', `体力 ${r1(hp0)}→${r1(health)}・満腹度 ${food}（${food >= 18 ? '体力が戻る' : '18 未満では体力が戻らない'}） 退いた先 (${spot.x},${spot.y},${spot.z}) は湧き場から見えない（${spot.steps}歩）に着いた・食べ物 ${foods.length ? foods.join('・') : 'なし'}。食べる・待つ・野営マスへ戻るは頭が選ぶ（戻る前に probe kind=around で blaze の数を見る）`);
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
    await equipWeapon();
    // The shield goes to the off hand when one is carried; raising it is the shield reflex's.
    const spare = findItem(bot, 'shield');
    if (spare && !bot.inventory?.slots?.[45]) {
      try { await guard(ctx, Promise.resolve(bot.equip(spare, 'off-hand')), 3000); }
      catch (error) { if (error instanceof StepStopped || CUT.test(String((error as Error)?.message))) throw error; }
    }
    shield0 = shieldState(bot);
    if (ender) {
      // The hole it is fought from: the site and the blocks are looked at before anything is done.
      endermanCamp = new EndermanCamp(ctx, target);
      let refusal = endermanCamp.check();
      // No roof can be made where the body stands (a step beside it that cannot be filled, a plant not to be built over, a hole): a cell within seven blocks where one can is walked to.
      if (refusal?.code === 'no_site') {
        const site = await moveToRoofSite(ctx, target);
        if (site.moved) { siteNote = site.text; endermanCamp = new EndermanCamp(ctx, target); refusal = endermanCamp.check(); }
        else return { ...none('no_site', `${refusal.text}。${site.text}`), code: 'no_site' };
      }
      if (refusal) return { ...none(refusal.code, refusal.text), code: refusal.code };
    }
    const radius = Math.max(range, ZONE_IN + 0.5);
    let lastSwing = 0, backUntil = 0, farSince = 0, blindSince = 0, everNear = false, bestBox = Infinity, bestAt = Date.now();
    // The jump of a critical blow: pressed on the ground, in the air once the feet leave it, spent when they come down.
    let jump: 'idle' | 'pressed' | 'air' = 'idle', jumpAt = 0, noJumpUntil = 0, spent = false, struckInAir = false;
    for (;;) {
      sample();
      if (reflexHeld(bot)) { unfollow(); releaseKeys(); return fail('reflex', '体を反射が握った'); }
      if (dead) return killed();
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
        return fail('limit_time', `は ${seconds} 秒で倒れなかった`);
      }
      const eye = eyeOf(bot.entity.position);
      const box = boxDistance({ x: eye[0], y: eye[1], z: eye[2] }, live);
      if (box <= radius) { everNear = true; farSince = 0; } else if (!farSince) farSince = now;

      // Low health: out of reach, a meal that can help, and back in; else leave.
      if (retreatHp !== null && Number(bot.health ?? 20) < retreatHp) {
        unfollow(); atHome(); releaseKeys();
        const verdict = await retreat();
        if (verdict) return verdict;
        continue;
      }
      const risk = footingRisk(live);
      if (risk) { unfollow(); releaseKeys(); return fail('danger', footingWords(risk)); }
      if (!ender && farSince && now - farSince >= OUT_OF_RANGE_MS) {
        unfollow(); releaseKeys();
        return everNear ? finish('逃げた', `（range ${r1(range)}m の外へ ${r1(box)}m。追わない）`) : fail('unreachable', `は range ${r1(range)}m の外のまま（${r1(box)}m）`, lastAt);
      }
      // `creeperLit` reads two slots of the entity data and knows no kind: an enderman's `stared_at` flag sits in the slot a creeper's lit fuse does, so the kind is asked first
      // (an enderman that was angry made the body run from "a lit creeper" out of its hole).
      if (String(live.name) === 'creeper' && creeperLit(live) && box < 7) {
        unfollow(); releaseKeys();
        if (await runAway(8, 2500) === 'reflex') return fail('reflex', '点火したクリーパーから離れる途中で反射が体を握った');
        continue;
      }
      if (meetingShot()) { releaseKeys(); shotWaitMs += TICK_MS; await wait(ctx, TICK_MS); continue; }
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
          else { await wait(ctx, TICK_MS); continue; }
        }
      }
      if (endermanCamp) {
        const step = await endermanCamp.advance(live, now, box, endermanAngry(bot.registry, live));
        if (step.kind === 'stop') { unfollow(); releaseKeys(); return { ...fail(step.outcome.reason ?? 'failed', step.outcome.text, step.outcome.at), ...(step.outcome.code ? { code: step.outcome.code } : {}) }; }
        if (step.kind === 'wait') { releaseKeys(); await wait(ctx, TICK_MS); continue; }
        // The roof was laid with building blocks in the hand: the weapon is taken up again for the blows.
        await equipWeapon();
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
          await wait(ctx, TICK_MS);
          continue;
        }
        if (box < bestBox - NO_GAIN_M || box > radius) { bestBox = box; bestAt = now; }
        // A sortie that gains nothing goes back to the camp and waits a while (a gap, a fence between): the fight is the camp's, not this walk's.
        if (hovering && now - bestAt > NO_GAIN_MS && fromCamp(bot.entity.position) >= OUT_M) {
          backWhy = `${NO_GAIN_MS / 1000}秒近づけない`; sortieAfter = now + SORTIE_REST_MS; bestAt = now; goHome(now); await wait(ctx, TICK_MS); continue;
        }
        if (now - bestAt > NO_GAIN_MS) { unfollow(); return fail('unreachable', `に近づけない（${r1(box)}m、${NO_GAIN_MS / 1000}秒縮まらない）`, lastAt); }
        const swimming = swimControls(bot, live.position);
        if (swimming) {
          unfollow();
          await swimPulse(ctx, swimming, TICK_MS);
          continue;
        }
        follow();
        await wait(ctx, TICK_MS);
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
      await wait(ctx, TICK_MS);
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
    bot.removeListener?.('entityHurt', onHurt); bot.removeListener?.('entityDead', onDead); bot.removeListener?.('health', sample);
    endermanCamp?.release();
    endEngagement();
    endOwner();
    unfollow();
    atHome();
    letGo(bot);
    try { if (previousMovements && navigator) navigator.setMovements(previousMovements); } catch { /* kept */ }
  }
}
