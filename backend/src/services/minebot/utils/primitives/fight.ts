import pathfinder from 'mineflayer-pathfinder';
import { buildMovements } from '../setMovements.js';
import { beginEngagement } from '../engagement.js';
import { markHeadCombat } from '../combatOwner.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { bodyReader, feetCell, type Cell } from '../localMap.js';
import { eyeOf, probeSight } from '../probeTools.js';
import { equipToHandVerified } from '../equipVerified.js';
import { itemFoodPoints } from '../foodPoints.js';
import { creeperLit } from '../creeperFuse.js';
import { bestBlade, fleeKeys, isThreat, reflexHeld } from '../floorReflexes.js';
import { cooldownMs } from './attack.js';
import { eat } from './body.js';
import { findEntity } from './use.js';
import { findItem, guard, letGo, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';

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
 *    blow goes out from behind a lowered shield by that reflex's wrapper of `attack`. While that reflex meets a shot in the air, the hand holds its
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
/** The shield reflex meeting a shot holds the body this long after it raised the shield. */
const SHOT_HOLD_MS = 600;
/** A meal takes 1.6 s and a creature of the body's own pace closes about 6 m in that: the run for a meal goes to 8 m (or its time), and it is eaten from 6.5 m. */
const MEAL_GAP = 8, MEAL_MIN_GAP = 6.5, MAX_MEALS = 4;
const NEVER_EAT = new Set(['pufferfish', 'chorus_fruit', 'suspicious_stew', 'spider_eye', 'poisonous_potato', 'enchanted_golden_apple', 'rotten_flesh']);
const CUT = /Action interrupted|Motor owner expired/u;
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
/** The code a cut is told by in the hand's line: the act's stop word, a reflex as `reflex`. */
const cutCode = (why: string) => /reflex|^floor-|^lava|^auto-/u.test(why) ? 'reflex' : why.startsWith('stop_if') ? 'stopIf' : why;

export async function fight(ctx: StepContext, args: FightArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const host = nativeActionHost(bot);
  const stance = args.stance === 'flee' ? 'flee' : 'fight';
  const seconds = Math.max(5, Math.min(60, args.seconds ?? DEFAULT_SECONDS));
  const range = Math.max(0, Math.min(16, args.range ?? DEFAULT_RANGE));
  const retreatHp = stance === 'fight' && typeof args.retreatHp === 'number' ? Math.max(1, Math.min(19, Math.round(args.retreatHp))) : null;
  const started = Date.now();
  const endAt = Math.min(started + seconds * 1000, ctx.deadline);
  const none = (code: string, text: string) => stopped(bot, code, `fight 止まった ${code}: ${text}`);

  const wanted = typeof args.target === 'number' ? args.target : /^#\d+$/u.test(String(args.target).trim()) ? Number(String(args.target).trim().slice(1)) : args.target;
  const target = findEntity(bot, wanted, 32);
  if (!target || !target.position) return none('lost', `${args.target} が 32m 内に見えない`);
  if (target.type === 'player' || target.username) return none('invalid_input', `${labelOf(target)} は人。fight は生き物（敵）にだけ使う`);
  const label = labelOf(target);
  const held0 = reflexHeld(bot);
  if (held0) return none('reflex', `${label} へ向かう前に、反射 ${held0} が体を握っている。終わるまで始めない`);

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
  const counts = () => `与えた打撃 ${landed}（振り ${blows}）・受けた体力 ${r1(lost)}・食べた ${meals}`;
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

  const finish = (verdict: string, extra = ''): StepOutcome => ({ ok: true, text: `fight 済 ${label} ${verdict}・${counts()}${extra}・${holder()}` });
  /** `at`: the creature's cell, only where the place is what the line is about (it cannot be reached). */
  const fail = (code: string, text: string, at?: Cell): StepOutcome => stopped(bot, code, `fight 止まった ${code}: ${label} ${text}。${counts()}・${holder(code === 'reflex' ? reflexHeld(bot) : null)}`, at);

  /** Below retreatHp: gets out of reach; eats what helps, with a gap, and goes back in when the health is back; else leaves for good. Null: fight on. */
  async function retreat(): Promise<StepOutcome | null> {
    for (let round = 0; round <= MAX_MEALS; round++) {
      sample();
      if (Number(bot.health ?? 20) >= (retreatHp as number)) { await equipWeapon(); return null; }
      const meal = round < MAX_MEALS ? mealFor() : null;
      const how = await runAway(meal ? MEAL_GAP : Math.max(range, 6), meal ? 5500 : 5000);
      const live = bot.entities?.[target.id];
      const gap = live ? live.position.distanceTo(bot.entity.position) : Infinity;
      const left = `体力 ${r1(Number(bot.health ?? 0))} < retreatHp ${retreatHp} で退いた（${Number.isFinite(gap) ? `${r1(gap)}m 離れた` : '相手は見えない'}）`;
      if (how === 'reflex') return fail('reflex', `${left}。その途中で反射が体を握った`);
      if (dead) return finish('死んだ');
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
      try { navigator.setMovements(buildMovements(bot, false, true, true, true, false, true, 1, false, true, 3, 10, false)); } catch { /* the navigator keeps the movements it has */ }
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
    const radius = Math.max(range, ZONE_IN + 0.5);
    let lastSwing = 0, backUntil = 0, farSince = 0, blindSince = 0, everNear = false, bestBox = Infinity, bestAt = Date.now();
    // The jump of a critical blow: pressed on the ground, in the air once the feet leave it, spent when they come down.
    let jump: 'idle' | 'pressed' | 'air' = 'idle', jumpAt = 0, noJumpUntil = 0, spent = false, struckInAir = false;
    for (;;) {
      sample();
      if (reflexHeld(bot)) { unfollow(); releaseKeys(); return fail('reflex', '体を反射が握った'); }
      if (dead) return finish('死んだ');
      const live = bot.entities?.[target.id];
      if (!live || live.isValid === false) {
        unfollow(); releaseKeys();
        return dead ? finish('死んだ') : fail('lost', `が見えなくなった（最後は (${lastAt.x},${lastAt.y},${lastAt.z})）`);
      }
      lastAt = cellOfEntity(live);
      const now = Date.now();
      if (now >= endAt) { unfollow(); releaseKeys(); return fail('limit_time', `は ${seconds} 秒で倒れなかった`); }
      const eye = eyeOf(bot.entity.position);
      const box = boxDistance({ x: eye[0], y: eye[1], z: eye[2] }, live);
      if (box <= radius) { everNear = true; farSince = 0; } else if (!farSince) farSince = now;

      // Low health: out of reach, a meal that can help, and back in; else leave.
      if (retreatHp !== null && Number(bot.health ?? 20) < retreatHp) {
        unfollow(); releaseKeys();
        const verdict = await retreat();
        if (verdict) return verdict;
        continue;
      }
      if (farSince && now - farSince >= OUT_OF_RANGE_MS) {
        unfollow(); releaseKeys();
        return everNear ? finish('逃げた', `（range ${r1(range)}m の外へ ${r1(box)}m。追わない）`) : fail('unreachable', `は range ${r1(range)}m の外のまま（${r1(box)}m）`, lastAt);
      }
      if (creeperLit(live) && box < 7) {
        unfollow(); releaseKeys();
        if (await runAway(8, 2500) === 'reflex') return fail('reflex', '点火したクリーパーから離れる途中で反射が体を握った');
        continue;
      }
      if (meetingShot()) { releaseKeys(); await wait(ctx, TICK_MS); continue; }

      // Closing in.
      if (box > (following ? ZONE_OUT : ZONE_IN)) {
        releaseKeys();
        jump = 'idle';
        if (box < bestBox - NO_GAIN_M || box > radius) { bestBox = box; bestAt = now; }
        if (now - bestAt > NO_GAIN_MS) { unfollow(); return fail('unreachable', `に近づけない（${r1(box)}m、${NO_GAIN_MS / 1000}秒縮まらない）`, lastAt); }
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
      const wantBack = box < TOO_NEAR || now < backUntil;
      press('back', wantBack); press('forward', !wantBack && box > TOO_FAR); press('sprint', false);
      const remaining = Math.max(0, cooldownMs(bot.heldItem?.name) - (now - lastSwing));
      if (jump === 'pressed' && !onGround) { jump = 'air'; press('jump', false); }
      else if (jump === 'pressed' && now - jumpAt > JUMP_FAILS_MS) { jump = 'idle'; noJumpUntil = now + NO_JUMP_MS; press('jump', false); }
      else if (jump === 'air' && onGround) { jump = 'idle'; spent = !struckInAir; struckInAir = false; }
      /** Room to jump: two cells over the head free, not in a liquid or a web. */
      const canJump = (): boolean => {
        const at = bot.entity.position;
        const free = (dy: number) => { try { const block = bot.blockAt?.(at.offset(0, dy, 0), false); return !block || block.boundingBox !== 'block'; } catch { return true; } };
        return free(1.8) && free(2.6) && !bot.entity.isInWater && !bot.entity.isInLava && !bot.entity.isInWeb && !bot.entity.isOnLadder && now >= noJumpUntil;
      };
      let sees = true;
      try { sees = probeSight(bodyReader(bot), eye, { creature: { id: live.id, name: String(live.name ?? 'entity'), position: live.position, height: live.height, width: live.width } }).visible; } catch { /* taken as seen */ }
      if (box <= REACH && !sees) {
        if (!blindSince) blindSince = now;
        if (now - blindSince > BLIND_MS) { releaseKeys(); return fail('unreachable', `は ${r1(box)}m の所にいるが間に壁がある（${BLIND_MS / 1000}秒見えない）`, lastAt); }
      } else blindSince = 0;
      let strike = false;
      if (box <= REACH && sees) {
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
      throw new HandCut(error instanceof StepStopped ? error.why : String((error as Error).message), `fight 止まった ${code}: ${label}。${counts()}・${holder(code === 'reflex' ? reflexHeld(bot) ?? 'lease' : null)}`);
    }
    throw error;
  } finally {
    bot.removeListener?.('entityHurt', onHurt); bot.removeListener?.('entityDead', onDead); bot.removeListener?.('health', sample);
    endEngagement();
    endOwner();
    unfollow();
    letGo(bot);
    try { if (previousMovements && navigator) navigator.setMovements(previousMovements); } catch { /* kept */ }
  }
}
