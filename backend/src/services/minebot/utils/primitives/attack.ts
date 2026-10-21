import pathfinder from 'mineflayer-pathfinder';
import { buildMovements } from '../setMovements.js';
import { entityHealth } from '../mapMarks.js';
import { letGo, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { findEntity } from './use.js';
import { beginEngagement } from '../engagement.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { isLikelyHostileMobName } from '../hostileMobHints.js';

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
function cooldownMs(held: string | undefined): number {
  if (!held) return 250;
  if (held.endsWith('_sword')) return 625;
  if (held.endsWith('_axe')) return held.startsWith('wooden_') || held.startsWith('stone_') ? 1250 : held.startsWith('iron_') ? 1110 : 1000;
  if (held === 'trident') return 910;
  if (held.endsWith('_shovel') || held.endsWith('_pickaxe')) return held.endsWith('_pickaxe') ? 830 : 1000;
  return 250;
}

export async function attack(ctx: StepContext, args: AttackArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  if (args.mode === 'hold') return holdAndStrike(ctx, args);
  if (args.target === undefined) return stopped(bot, 'invalid_input', 'attack には target（#id か名前）が要る');
  const target = findEntity(bot, args.target, 32);
  if (!target) return stopped(bot, 'target_not_found', `${args.target} が 32m 内にいない`);
  const label = `${target.name ?? target.username ?? 'entity'}（id ${target.id}）`;
  const limitMs = Math.min(MAX_SECONDS, typeof args.until === 'number' && args.until > 0 ? args.until : args.maxSeconds && args.maxSeconds > 0 ? args.maxSeconds : MAX_SECONDS) * 1000;
  const untilDead = args.until === undefined || args.until === 'dead';
  const chase = args.chase !== false;
  const started = Date.now();
  let blows = 0, hurt = 0, dead = false;
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
  try {
    for (;;) {
      const live = bot.entities?.[target.id];
      if (!live || dead) break;
      if (Date.now() - started >= limitMs) break;
      const distance = live.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) - (live.height ?? 1.8) / 2;
      if (distance < best - 0.3) { best = distance; bestAt = Date.now(); }
      if (distance > REACH && (!chase || Date.now() - bestAt > NO_GAIN_MS)) {
        letGo(bot);
        return stopped(bot, chase ? 'cannot_reach' : 'out_of_reach', `${label} に届かない（${distance.toFixed(1)}m${chase ? `、${NO_GAIN_MS / 1000}秒近づけない` : ''}）。当てた ${blows}回`,
          { x: Math.floor(live.position.x), y: Math.floor(live.position.y), z: Math.floor(live.position.z) });
      }
      if (distance <= REACH && Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name)) {
        try { await bot.lookAt(live.position.offset(0, (live.height ?? 1.8) * 0.6, 0), true); } catch { /* looked */ }
        bot.attack(live);
        blows++; lastSwing = Date.now();
      }
      await wait(ctx, 50);
    }
  } catch (error) {
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
  if (dead) return { ok: true, text: `${label} を倒した（${blows}回振って ${hurt}回当たった、${seconds}秒）` };
  if (!live) return { ok: true, text: `${label} が見えなくなった（倒れたか、離れて消えた。${blows}回振って ${hurt}回当たった、${seconds}秒）` };
  if (untilDead) return stopped(bot, 'time_up', `${label} は${Math.round(limitMs / 1000)}秒で倒れなかった（${blows}回振って ${hurt}回当たった${health !== null ? `、残り体力 ${health}` : ''}）`);
  return { ok: true, text: `${label} を ${seconds}秒攻撃した（${blows}回振って ${hurt}回当たった${health !== null ? `、残り体力 ${health}` : ''}）` };
}

/**
 * attack mode=hold (the owner's run-26 notes, 2026-10-21): stand where the body is, shield up when one is carried in the off hand, and
 * strike only what comes within reach (about 3 m): the target's kind, or any hostile without one. It never moves and never digs: the
 * waiting place (a gap to strike through) is the planner's to build with place and dig. Ends after the seconds (default 20, at most
 * 60). Says how many were killed, the health lost, and what dropped near.
 */
async function holdAndStrike(ctx: StepContext, args: AttackArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const seconds = Math.max(1, Math.min(60, typeof args.until === 'number' ? args.until : args.maxSeconds ?? 20));
  const wanted = args.target === undefined || args.target === '*' ? null : args.target;
  const wantedId = typeof wanted === 'number' ? wanted : null;
  const wantedName = typeof wanted === 'string' ? wanted.replace(/^minecraft:/u, '').toLowerCase() : null;
  const isHostile = (entity: any) => String(bot.registry?.entitiesByName?.[entity.name]?.type ?? entity.type) === 'hostile' || isLikelyHostileMobName(String(entity.name ?? ''));
  const fits = (entity: any) => entity && entity !== bot.entity && entity.position && entity.type !== 'player' && entity.name !== 'item'
    && (wantedId !== null ? entity.id === wantedId : wantedName ? String(entity.name).toLowerCase() === wantedName : isHostile(entity));
  const shield = bot.inventory?.slots?.[45]?.name === 'shield';
  const healthBefore = Number(bot.health ?? 20);
  const before = new Set(Object.keys(bot.entities ?? {}).map(Number));
  const struck = new Set<number>(), killed: string[] = [];
  let blows = 0, lastSwing = 0, hurtTaken = 0, raised = false;
  const onDead = (entity: any) => { if (struck.has(entity?.id)) killed.push(String(entity.name)); };
  const onHurt = (entity: any) => { if (entity === bot.entity || entity?.id === bot.entity?.id) hurtTaken++; };
  bot.on('entityDead', onDead); bot.on('entityHurt', onHurt);
  const host = nativeActionHost(bot);
  const endEngagement = beginEngagement(host, [wantedName ?? '*']);
  const raise = () => { if (shield && !raised) { try { bot.activateItem(true); raised = true; } catch { /* no shield */ } } };
  const lower = () => { if (raised) { try { bot.deactivateItem(); } catch { /* lowered */ } raised = false; } };
  try {
    try { bot.clearControlStates?.(); bot.pathfinder?.setGoal?.(null); } catch { /* standing */ }
    raise();
    for (const until = Date.now() + seconds * 1000; Date.now() < until;) {
      const eyes = bot.entity.position.offset(0, 1.62, 0);
      const near = (Object.values(bot.entities ?? {}) as any[]).filter(fits)
        .map(entity => ({ entity, distance: entity.position.offset(0, (entity.height ?? 1.8) / 2, 0).distanceTo(eyes) }))
        .filter(entry => entry.distance <= REACH + 0.3).sort((a, b) => a.distance - b.distance)[0];
      if (near && Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name)) {
        lower();
        try { await bot.lookAt(near.entity.position.offset(0, (near.entity.height ?? 1.8) * 0.6, 0), true); } catch { /* looked */ }
        bot.attack(near.entity);
        struck.add(near.entity.id); blows++; lastSwing = Date.now();
        await wait(ctx, 100);
        raise();
      }
      await wait(ctx, 50);
    }
  } finally {
    lower();
    bot.removeListener('entityDead', onDead); bot.removeListener('entityHurt', onHurt);
    endEngagement();
  }
  const drops = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity?.name === 'item' && !before.has(entity.id)
    && entity.position.distanceTo(bot.entity.position) <= 8);
  const dropNames = drops.map(entity => { try { const item = entity.getDroppedItem?.(); return item ? `${item.name}×${item.count}` : `#${entity.id}`; } catch { return `#${entity.id}`; } });
  const lost = Math.max(0, Math.round((healthBefore - Number(bot.health ?? healthBefore)) * 10) / 10);
  return { ok: true, text: `${seconds}秒その場で構えた${shield ? '（盾）' : ''}: ${blows}回打った、倒した ${killed.length}${killed.length ? `（${killed.join('・')}）` : ''}、受けた傷 ${lost}（当たり ${hurtTaken}回）`
    + `、落とし物 ${dropNames.length ? `${dropNames.join(' ')}（pickup で拾う）` : 'なし'}` };
}