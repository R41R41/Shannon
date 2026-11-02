import { Vec3 } from 'vec3';
import { entityHealth } from '../mapMarks.js';
import { beginEngagement } from '../engagement.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { letGo, StepStopped, stopped, wait, type StepContext, type StepOutcome } from './common.js';
import type { Progress } from '../../integration/commonFca/continueContract.js';
import { boxCentre, boxDistance, isDying, isPerched, partBox, partTarget, phaseName, STRIKE_ORDER, type DragonPart } from '../dragonParts.js';
import { dragonPhaseOf, STRIKE_REACH } from '../dragonState.js';

/**
 * attack at the ender dragon: blows at its parts while it is on the perch (phases 5, 6, 7), and only then.
 *
 * The body does not walk to the dragon (it flies, and its perch is the fountain's pillar): where to stand is the planner's, as for a hold.
 * Whether a blow can land is read from the body's eye to the part's box (the server measures the same); the head first (it takes the sword's
 * whole damage), then neck, body and the wings (a quarter and a block). Blows are paced by the held weapon's own wait (a sword 13 ticks, an
 * axe 25), and none is struck while the dragon is off the perch: it takes the damage of a part only when sitting, an arrow does nothing to it
 * there, and its parts move too fast in flight to aim at. The hand ends when the dragon dies (the death is waited for through its dying
 * phase), when it leaves the perch after blows were struck, or when the time is up.
 */
const SWORD_WAIT_MS = 650;
const AXE_WAIT_MS = 1250;
/** A blow counts as landed when the dragon is hurt within this long of the swing. */
const LANDED_WITHIN_MS = 700;
/** After the dragon starts to die its death animation takes ten seconds; the hand waits this long for the death to be seen. */
const DYING_WAIT_MS = 15_000;
/** Perched and nothing in reach for this long: the planner's place is wrong. */
const UNREACHED_MS = 8000;

/** The wait between two blows for what is held (the game's attack speed, with a tick's margin). */
export function swingWaitMs(held: string | undefined): number {
  if (!held) return 300;
  if (held.endsWith('_sword')) return SWORD_WAIT_MS;
  if (held.endsWith('_axe')) return AXE_WAIT_MS;
  if (held === 'trident') return 960;
  if (held.endsWith('_pickaxe') || held.endsWith('_shovel')) return 1050;
  return 300;
}

export const isDragonTarget = (target: string | number | undefined): boolean => typeof target === 'string' && /^(minecraft:)?ender_dragon$/iu.test(target.trim());

/** The part to strike from where the eye is, or null: the first of the strike order whose box is within reach. */
export function partToStrike(dragon: { position: Vec3; yaw?: number }, eye: Vec3, reach = STRIKE_REACH): { part: DragonPart; distance: number } | null {
  for (const part of STRIKE_ORDER) {
    const distance = boxDistance(eye, partBox(dragon, part));
    if (distance <= reach) return { part, distance };
  }
  return null;
}

export async function strikeDragon(ctx: StepContext, dragon: any, limitMs: number): Promise<StepOutcome> {
  const bot = ctx.bot;
  const id: number = dragon.id;
  const started = Date.now();
  const healthBefore = entityHealth(bot, dragon);
  const parts: Record<string, number> = {};
  const swungAt: number[] = [];
  let blows = 0, landed = 0, lastSwing = 0, dead = false, sawPerch = false, perchedNow = false, lastReach: number | null = null, lastPhase: number | null = null;
  let dyingSince: number | null = null, lastInReach = started;
  const struck = (): Progress => ({ unit: 'blow', done: landed, left: null });
  const onDead = (entity: any) => { if (entity?.id === id) dead = true; };
  const onHurt = (entity: any) => {
    if (entity?.id !== id) return;
    const now = Date.now();
    const at = swungAt.findIndex(when => now - when <= LANDED_WITHIN_MS);
    if (at >= 0) { landed++; swungAt.splice(at, 1); }
  };
  bot.on('entityDead', onDead); bot.on('entityHurt', onHurt);
  const endEngagement = beginEngagement(nativeActionHost(bot), ['ender_dragon']);
  try {
    for (;;) {
      const live = bot.entities?.[id];
      if (!live || dead) break;
      const now = Date.now();
      const phase = dragonPhaseOf(bot, live);
      lastPhase = phase;
      perchedNow = isPerched(phase);
      if (isDying(phase)) {
        dyingSince ??= now;
        if (now - dyingSince >= DYING_WAIT_MS) break;
        await wait(ctx, 100);
        continue;
      }
      if (now - started >= limitMs) break;
      if (perchedNow) {
        // The wait for a perch is not the wait for a reach: the clock for "nothing in reach" starts when the dragon sits.
        if (!sawPerch) lastInReach = now;
        sawPerch = true;
        const eye = new Vec3(bot.entity.position.x, bot.entity.position.y + 1.62, bot.entity.position.z);
        const pick = partToStrike(live, eye);
        lastReach = pick ? pick.distance : boxDistance(eye, partBox(live, 'head'));
        if (pick) {
          lastInReach = now;
          if (now - lastSwing >= swingWaitMs(bot.heldItem?.name)) {
            const target = partTarget(live, pick.part);
            try { await bot.lookAt(new Vec3(target.position.x, target.position.y, target.position.z), true); } catch { /* looked */ }
            // Marked before the swing: the hurt that answers it may come at once.
            swungAt.push(Date.now()); lastSwing = Date.now(); blows++;
            parts[pick.part] = (parts[pick.part] ?? 0) + 1;
            bot.attack(target);
          }
        } else if (now - lastInReach >= UNREACHED_MS) break;
      } else if (sawPerch) break; // the perch is over: the planner decides from where the body stands
      await wait(ctx, 50);
    }
  } catch (error) {
    if (error && typeof error === 'object' && !(error as { progress?: unknown }).progress) (error as { progress?: Progress }).progress = struck();
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) letGo(bot);
    throw error;
  } finally {
    bot.removeListener('entityDead', onDead); bot.removeListener('entityHurt', onHurt);
    endEngagement();
  }
  const live = bot.entities?.[id];
  const healthAfter = live ? entityHealth(bot, live) : null;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const where = Object.entries(parts).map(([part, n]) => `${part} ${n}`).join('・');
  const counts = `${blows}回振って ${landed}回当たった${where ? `（${where}）` : ''}、体力 ${healthBefore ?? '?'}→${healthAfter ?? '?'}、${seconds}秒`;
  const label = `ender_dragon（id ${id}）`;
  if (dead) return { ok: true, text: `${label} を倒した（${counts}）`, progress: struck(), data: { dragon: { blows, landed, parts, dead: true } } };
  if (!live) {
    return { ok: false, goal: 'unknown', reason: 'target_lost', code: 'target_lost', progress: struck(),
      text: `${label} が見えなくなった（死ぬのは見ていない。${counts}）。次: 竜が見える所へ戻り、観測の dragon で phase と体力を見る` };
  }
  const phaseText = lastPhase === null ? 'phase 不明' : `phase ${lastPhase} ${phaseName(lastPhase) ?? ''}`.trim();
  if (isDying(lastPhase)) return { ...stopped(bot, 'time_up', `${label} は死にかけているが死は見ていない（${phaseText}。${counts}）。次: 竜が消えるのを待ち、goal-evidence で死を確かめる`), progress: struck() };
  if (sawPerch && !perchedNow) return { ...stopped(bot, 'perch_over', `止まり木が終わった（${phaseText}）。${blows ? counts : '一度も打てる所に頭・首・胴・翼が無かった'}。次: 次の着地（phase 3）と見回し（phase 6）を息の雲と頭の箱の外で待つ`), progress: struck(), data: { dragon: { blows, landed, parts } } };
  if (blows > 0) return { ...stopped(bot, 'time_up', `${label} は倒れなかった（${phaseText}。${counts}）。次: 止まり木が続くなら同じ手をもう一度`), progress: struck(), data: { dragon: { blows, landed, parts } } };
  if (!sawPerch) return { ...stopped(bot, 'not_perched', `${label} は止まり木に居なかった（${phaseText}、止まっているのは phase 5・6・7 だけ。${seconds}秒待った）。次: 息の雲と頭の箱の外で phase 6 か 7 を待つ。クリスタルが残るなら先に弓で壊す`), progress: struck() };
  const head = lastReach === null ? '' : `。頭の箱まで目から ${lastReach.toFixed(1)}m（${STRIKE_REACH}m まで届く）`;
  const centre = boxCentre(partBox(live, 'head'));
  return { ...stopped(bot, 'out_of_reach', `止まり木に居るが打てる所に頭・首・胴・翼が無い（${phaseText}${head}。頭は (${centre.x.toFixed(1)},${centre.y.toFixed(1)},${centre.z.toFixed(1)}) 付近）。次: 頭の下 3〜4m へ go してから attack`), progress: struck() };
}
