import { Vec3 } from 'vec3';
import { actionSignal, nativeActionHost } from '../../execution/ActionExecution.js';
import { RushShooterWatch } from '../huntBlaze.js';
import { reflexHeld } from '../floorReflexes.js';
import { deathLedgerOf } from '../deathLedger.js';
import { cooldownMs } from './attack.js';
import { guard, inventoryCount, StepStopped, type StepContext, type StepOutcome } from './common.js';
import { middle, point, RushSpace, type RushArea } from './shieldRushSpace.js';
import type { Cell } from '../localMap.js';

export type RushCode = 'TARGET_LOST' | 'HEIGHT_UNREACHABLE' | 'NO_ATTACK_WINDOW' | 'CROSSFIRE' | 'SHIELD_LOW'
  | 'RETREAT_BLOCKED' | 'PICKUP_UNSAFE' | 'TIME_LIMIT' | 'REFLEX' | 'DEAD';
export type RushState = 'BLOCK' | 'CLOSE' | 'STRIKE' | 'PICKUP' | 'RETREAT';
export interface ShieldRushArgs {
  target: string; seconds: number; retreatHp: number; retreatTo: Cell; area: RushArea;
  shieldReserve: number; onCrossfire: 'retreat' | 'continue'; pickup: 'target_drops' | 'none';
}
export interface ShieldRushResult {
  status: 'killed' | 'retreated' | 'failed' | 'cut'; targetDead: boolean | null; code: RushCode | null;
  hits: number; rodsDelta: number; hpMin: number; hpEnd: number; shieldBefore: number; shieldAfter: number; elapsedMs: number;
  at: Cell; safe: boolean; pendingDrops: Array<{ id: number; at: Cell }>;
}
export interface ShieldRushOutcome extends StepOutcome { shieldRush: ShieldRushResult }
export const SHIELD_RUSH_DESCRIPTION = 'attack style=shield_rush: target は見た blaze 1体の #id。seconds(5〜60、帰還込み)・retreatHp(1〜19)・retreatTo({x,y,z})・area({center:{x,y,z},radius:1〜16,maxDrop:0〜3})・shieldReserve(0〜335)・onCrossfire(retreat/continue)・pickup(target_drops/none)を全て指定。'
  + '盾を上げたまま安全な床で詰め、目から当たり箱3m以内かつ視線が通れば打つ。撃破後は指定の落とし物を拾い、指定先へ戻る。再出撃・建築・食事はしない。'
  + 'TARGET_LOST=死亡未確認で見失った、HEIGHT_UNREACHABLE=高くて届かない、NO_ATTACK_WINDOW=接近窓/安全な足場なし、CROSSFIRE=盾1方向で防げない、SHIELD_LOW=盾が残りの下限、RETREAT_BLOCKED=指定先へ帰れない/遮蔽なし、PICKUP_UNSAFE=安全に回収できない、TIME_LIMIT=帰還時間を含む期限、REFLEX=致死危険/床反射へ譲った、DEAD=死亡。'
  + '各行の shieldRush は status(killed/retreated/failed/cut)・targetDead(true/false/null)・code・hits・rodsDelta(荷の増分)・hpMin/hpEnd・shieldBefore/After(残り)・elapsedMs・at・safe・pendingDrops。retreatHpで帰れた時はretreated/code:null。safeは指定先の足場と遮蔽を確認できた時だけtrue。';

/** Shared with the act boundary; reject malformed permissions before any motor operation. */
export function shieldRushProblem(a: Record<string, any>): string | null {
  const pos = (p: any) => p && Object.keys(p).every(k => ['x', 'y', 'z'].includes(k)) && [p.x, p.y, p.z].every(Number.isFinite);
  const range = (n: any, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;
  if (typeof a.target !== 'string' || !/^#\d+$/u.test(a.target) || !Number.isSafeInteger(Number(a.target.slice(1)))) return 'target は blaze 1体の #id';
  if (!range(a.seconds, 5, 60) || !range(a.retreatHp, 1, 19)) return 'seconds は5〜60、retreatHp は1〜19';
  if (!pos(a.retreatTo) || !pos(a.area?.center) || !range(a.area?.radius, 1, 16) || !Number.isInteger(a.area?.maxDrop) || !range(a.area.maxDrop, 0, 3)
    || Object.keys(a.area).some(k => !['center', 'radius', 'maxDrop'].includes(k))) return 'retreatTo と area(center・radius:1〜16・maxDrop:0〜3)が要る';
  if (!range(a.shieldReserve, 0, 335) || !['retreat', 'continue'].includes(a.onCrossfire) || !['target_drops', 'none'].includes(a.pickup)) return 'shieldReserve(0〜335)・onCrossfire・pickup が要る';
  const allowed = new Set(['do', 'style', 'target', 'seconds', 'retreatHp', 'retreatTo', 'area', 'shieldReserve', 'onCrossfire', 'pickup', 'note', 'onFail', 'dependsOn']);
  if (Object.keys(a).some(k => a[k] !== undefined && !allowed.has(k))) return 'shield_rush は指定の欄だけ使える（座標は絶対座標）';
  return null;
}

const WORDS: Record<RushCode, string> = {
  TARGET_LOST: '対象の死亡を確認できず見失った', HEIGHT_UNREACHABLE: '対象が高く、安全な床から剣が届かない',
  NO_ATTACK_WINDOW: '接近できる射撃の切れ目と安全な足場が揃わない', CROSSFIRE: '異なる方向の射線を盾一枚で受け切れない',
  SHIELD_LOW: '盾の残りが指定の下限に達した', RETREAT_BLOCKED: '指定先へ戻る道か、戻った先の遮蔽を確認できない',
  PICKUP_UNSAFE: '落とし物を安全に荷へ入れられない', TIME_LIMIT: '帰還を含む時間の上限に達した', REFLEX: '致死危険への床の反射に体を譲った', DEAD: '体が死んだ',
};
const xyz = (p: Cell): Cell => ({ x: p.x, y: p.y, z: p.z });
const distance = (eye: Vec3, e: any) => {
  const p = e.position, half = (e.width ?? 0.6) / 2;
  return Math.hypot(Math.max(0, Math.abs(eye.x - p.x) - half), Math.max(0, p.y - eye.y, eye.y - p.y - (e.height ?? 1.8)), Math.max(0, Math.abs(eye.z - p.z) - half));
};
/** Shape aware ray to the nearest part of the box, unknown terrain closes it. */
export function rushSight(bot: any, eye: Vec3, to: Vec3): boolean {
  const delta = to.minus(eye), length = delta.norm();
  for (let d = 0.1; d < length; d += 0.1) {
    const p = eye.plus(delta.scaled(d / length)), b = bot.blockAt?.(p.floored(), false);
    if (!b) return false;
    const shapes = b.shapes ?? (b.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []);
    if (shapes.some((s: number[]) => p.x - Math.floor(p.x) >= s[0] && p.x - Math.floor(p.x) <= s[3]
      && p.y - Math.floor(p.y) >= s[1] && p.y - Math.floor(p.y) <= s[4] && p.z - Math.floor(p.z) >= s[2] && p.z - Math.floor(p.z) <= s[5])) return false;
  }
  return true;
}
function tick(ctx: StepContext, until: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const signal = actionSignal(ctx.bot);
    const clean = () => { clearTimeout(timer); ctx.bot.removeListener('physicsTick', onTick); ctx.stop.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); };
    const onTick = () => { clean(); resolve(true); };
    const abort = () => { clean(); reject(new StepStopped(String(ctx.stop.reason ?? signal?.reason ?? 'cancelled'))); };
    const timer = setTimeout(() => { clean(); resolve(false); }, Math.max(0, Math.min(100, until - Date.now())));
    ctx.bot.on('physicsTick', onTick); ctx.stop.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    if (ctx.stop.aborted || signal?.aborted) abort();
  });
}

export async function shieldRush(ctx: StepContext, a: ShieldRushArgs): Promise<ShieldRushOutcome> {
  const bot = ctx.bot, host: any = nativeActionHost(bot), started = Date.now();
  const problem = shieldRushProblem(a);
  // The invalid input is an input error, before this mechanism begins; runtime stops use the closed RushCode set.
  if (problem) throw new Error(`invalid_input: ${problem}`);
  const until = Math.min(ctx.deadline, started + a.seconds * 1000), id = Number(a.target.slice(1));
  const space = new RushSpace(bot, a.area), ledger = deathLedgerOf(bot);
  const watch = new RushShooterWatch(bot, (id, entity) => ledger.seenDead(id, undefined, entity) !== null);
  const shieldLeft = () => {
    const s = bot.inventory?.slots?.[45];
    return s?.name === 'shield' ? Math.max(0, Number(bot.registry?.itemsByName?.shield?.maxDurability ?? 336) - Number(s.durabilityUsed ?? 0)) : 0;
  };
  const hp = () => Number(bot.health ?? 0), rods0 = inventoryCount(bot, 'blaze_rod'), shieldBefore = shieldLeft();
  let hpMin = hp(), hits = 0, targetDead: boolean | null = false, code: RushCode | null = null;
  let state: RushState = 'BLOCK', retreat = false, cut = false, safe = false, owned = false, raisedAt = Infinity;
  let physicsTicks = 0, raisedTick = 0;
  let lastSwing = -Infinity, unackedSwing = false, swingAt = 0, lastGain = started, bestDistance = Infinity;
  let deadAt = 0, deathAt: Vec3 | null = null, returnPath: Vec3[] | null = null;
  let target: any = bot.entities?.[id], lastTargetAt: Vec3 | null = target?.position?.clone() ?? null;
  const targetUuid = target?.uuid;
  let stalledAt = started;
  const initialDrops = new Set(Object.values(bot.entities ?? {}).filter((e: any) => e?.name === 'item').map((e: any) => e.id));
  const drops = new Map<number, { id: number; at: Cell; collected: boolean; entity: any }>();
  const sample = () => { hpMin = Math.min(hpMin, hp()); };
  const died = (e: any) => { if (e?.id === id && (!targetUuid || e.uuid === targetUuid)) {
    targetDead = true; deadAt = Date.now(); deathAt = e.position?.clone() ?? lastTargetAt;
    for (const item of Object.values(bot.entities ?? {}) as any[]) if (item?.name === 'item') initialDrops.add(item.id);
  } };
  const hurt = (e: any) => { if (e?.id === id && unackedSwing && Date.now() - swingAt <= 700) { hits++; unackedSwing = false; } };
  const collect = (who: any, item: any) => { if (who?.id === bot.entity?.id && drops.has(item?.id)) drops.get(item.id)!.collected = true; };
  bot.on('health', sample); bot.on('entityDead', died); bot.on('entityHurt', hurt); bot.on('playerCollect', collect);
  const resident = host.shieldBlock, residentBefore = resident ? { enabled: resident.enabled, up: resident.up } : null;
  const stopKeys = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) bot.setControlState?.(k, false); };
  const change = (s: RushState) => { if (state !== s) { state = s; ctx.progress?.(`盾の突撃 ${s}`); } };
  const beginRetreat = (why: RushCode | null) => { if (!retreat) { code = why; retreat = true; change('RETREAT'); stalledAt = Date.now(); } };
  const sees = (e: any, feet = bot.entity.position) => rushSight(bot, feet.offset(0, 1.62, 0), e.position.offset(0, (e.height ?? 1.8) / 2, 0));
  const aimAt = (e: any) => {
    const eyes = bot.entity.position.offset(0, 1.62, 0), p = e.position, d = p.minus(eyes);
    void Promise.resolve(bot.look?.(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), true)).catch(() => undefined);
  };
  // Walking is independent of the shield's facing (backwards/sideways when a shot must be met).
  const move = (to: Vec3) => {
    const p = bot.entity.position, dx = to.x - p.x, dz = to.z - p.z, yaw = bot.entity.yaw ?? 0;
    const forward = -Math.sin(yaw) * dx - Math.cos(yaw) * dz, left = -Math.cos(yaw) * dx + Math.sin(yaw) * dz;
    bot.setControlState('forward', forward > 0.08); bot.setControlState('back', forward < -0.08);
    bot.setControlState('left', left > 0.08); bot.setControlState('right', left < -0.08);
    bot.setControlState('jump', to.y > p.y + 0.4 && bot.entity.onGround === true);
  };
  const returnBudget = (path: Vec3[] | null) => path ? 1500 + path.slice(1).reduce((n, p, i) => n + p.distanceTo(path[i]) / 0.9 * 1000, 0) : Infinity;
  const fatal = () => {
    sample();
    if (hp() <= 0) { code = 'DEAD'; return true; }
    if (reflexHeld(host) || bot.entity.isInLava || (bot.entity.onGround === false && Number(bot.entity.velocity?.y) < -0.8)
      || ((Number(bot.entity.metadata?.[0] ?? 0) & 1) !== 0 && hp() <= 5)) { code = 'REFLEX'; cut = true; return true; }
    return false;
  };
  try {
    if (hp() <= 0) { code = 'DEAD'; return finish(); }
    if (reflexHeld(host)) { code = 'REFLEX'; cut = true; return finish(); }
    returnPath = space.route(bot.entity.position, a.retreatTo);
    if (!returnPath) { code = 'RETREAT_BLOCKED'; return finish(); }
    if (!target?.position || target.name !== 'blaze') {
      const prior = ledger.seenDead(id, undefined, target);
      if (prior?.name === 'blaze') {
        targetDead = true; deadAt = prior.at;
        if (a.pickup === 'target_drops' && !lastTargetAt) beginRetreat('PICKUP_UNSAFE');
      } else { targetDead = null; beginRetreat('TARGET_LOST'); }
    }
    const sword = bot.heldItem?.name?.endsWith('_sword') ? bot.heldItem : bot.inventory.items().find((e: any) => e.name.endsWith('_sword'));
    if (!sword && targetDead !== true) beginRetreat('NO_ATTACK_WINDOW');
    if (shieldLeft() <= a.shieldReserve) beginRetreat('SHIELD_LOW');
    // This scope is the sole shield writer. The resident's disabled branch sees up=false, so it cannot lower ours.
    // Its projectile prediction is reused by RushShooterWatch instead of letting it take the look or the keys.
    if (resident) { resident.up = false; resident.enabled = false; }
    owned = true;
    if (sword && bot.heldItem !== sword) {
      // One native equip, verified afterwards. No retrying helper is abandoned to write during the rush.
      const equipped = await guard(ctx, Promise.resolve(bot.equip(sword, 'hand')), Math.min(1500, until - Date.now()));
      if (!equipped || bot.heldItem?.name !== sword.name || bot.heldItem?.type !== sword.type) beginRetreat('NO_ATTACK_WINDOW');
    }
    bot.pathfinder?.stop?.(); bot.pathfinder?.setGoal?.(null); stopKeys();
    bot.activateItem(true); raisedAt = Date.now();
    let nextRouteAt = 0, routeFrom: Vec3 | null = null, previous = bot.entity.position.clone();
    for (;;) {
      const now = Date.now(); sample();
      if (fatal()) break;
      if (ctx.stop.aborted || actionSignal(bot)?.aborted) throw new StepStopped(String(ctx.stop.reason ?? actionSignal(bot)?.reason));
      if (now >= until) { code = retreat ? 'RETREAT_BLOCKED' : 'TIME_LIMIT'; break; }
      if (!await tick(ctx, until)) continue;
      physicsTicks++;
      if (fatal()) break;
      if (Date.now() >= until) { code = retreat ? 'RETREAT_BLOCKED' : 'TIME_LIMIT'; break; }
      watch.update(Date.now()); stopKeys();
      const p: Vec3 = bot.entity.position, seeing = watch.seeing(), incoming = watch.incoming();
      try { bot.emit('shieldRushTick', { state, target: id, shieldRequested: owned, shieldReady: bot.usingHeldItem === true && physicsTicks - raisedTick >= 5,
        hp: hp(), shieldLeft: shieldLeft(), hits, at: xyz(p), elapsedMs: Date.now() - started,
        shooters: [...watch.shooters.entries()].map(([id, r]) => ({ id, charged: r.flame, missing: r.missing, shots: r.shots, restUntil: r.restUntil })),
        incoming: incoming.map(b => ({ id: b.entity.id, ticks: b.ticks })) }); } catch { /* optional observation only */ }
      const danger = incoming[0] ?? (seeing.length ? { position: seeing[0].position.offset(0, 0.9, 0) } : null);
      if (danger) aimAt(danger); else if (target?.position && !retreat) aimAt({ position: target.position.offset(0, 0.9, 0) });
      if (bot.usingHeldItem === false && shieldLeft() > 0) { bot.activateItem(true); raisedAt = Date.now(); raisedTick = physicsTicks; }
      if (p.distanceTo(previous) > 0.08) { stalledAt = Date.now(); previous = p.clone(); }
      if (Date.now() >= nextRouteAt || !routeFrom || p.distanceTo(routeFrom) > 0.75) {
        returnPath = space.route(p, a.retreatTo); nextRouteAt = Date.now() + 250; routeFrom = p.clone();
      }
      if (!retreat && !returnPath) beginRetreat('RETREAT_BLOCKED');
      if (!retreat && hp() <= a.retreatHp) beginRetreat(null);
      if (!retreat && shieldLeft() <= a.shieldReserve) beginRetreat('SHIELD_LOW');
      const dirs = [...seeing.map(e => e.position), ...incoming.map(e => e.position)].map(v => v.minus(p));
      // Conservative 100 degree spread: leave margin for turning between shots. Calibrate with the real server.
      const crossfire = dirs.some((d, i) => dirs.slice(i + 1).some(e => (d.x * e.x + d.z * e.z) / Math.max(0.001, Math.hypot(d.x, d.z) * Math.hypot(e.x, e.z)) < Math.cos(100 * Math.PI / 180)));
      if (!retreat && crossfire && a.onCrossfire === 'retreat') beginRetreat('CROSSFIRE');
      if (!retreat && until - Date.now() <= returnBudget(returnPath)) beginRetreat('TIME_LIMIT');
      if (retreat) {
        change('RETREAT');
        if (!returnPath || Date.now() - stalledAt > 2000) { code = 'RETREAT_BLOCKED'; break; }
        if (p.distanceTo(point(a.retreatTo)) <= 0.65) {
          safe = space.stand(p) && !seeing.length && !incoming.length && !bot.entity.isInLava
            && (Number(bot.entity.metadata?.[0] ?? 0) & 1) === 0;
          if (!safe) code = 'RETREAT_BLOCKED';
          break;
        }
        const next = returnPath[1] ?? point(a.retreatTo);
        if (!space.edge(middle(p), middle(next))) { code = 'RETREAT_BLOCKED'; break; }
        if (!danger) aimAt({ position: next.offset(0, 1.62, 0) });
        move(next); continue;
      }
      target = bot.entities?.[id];
      if (target?.position) lastTargetAt = target.position.clone();
      if (targetDead !== true && ledger.seenDead(id, undefined, target)) { targetDead = true; deadAt = Date.now(); deathAt = lastTargetAt; }
      if (targetDead === true) {
        change('PICKUP');
        if (a.pickup === 'none') { beginRetreat(null); continue; }
        for (const e of Object.values(bot.entities ?? {}) as any[]) {
          if (e?.name !== 'item' || initialDrops.has(e.id) || drops.has(e.id) || !deathAt || e.position.distanceTo(deathAt) > 2.5 || Date.now() - deadAt > 1200) continue;
          const name = e.getDroppedItem?.()?.name;
          if (name && name !== 'blaze_rod') continue;
          drops.set(e.id, { id: e.id, entity: e, at: xyz(e.position), collected: false });
        }
        const pending = [...drops.values()].filter(d => !d.collected);
        const drop = pending[0];
        if (!drop && Date.now() - deadAt >= 1200) {
          const taken = [...drops.values()].filter(d => d.collected).reduce((n, d) => n + Number(d.entity.getDroppedItem?.()?.count ?? 1), 0);
          if (inventoryCount(bot, 'blaze_rod') - rods0 >= taken) { beginRetreat(null); continue; }
        }
        if (Date.now() - deadAt > 4000) { beginRetreat('PICKUP_UNSAFE'); continue; }
        if (!drop) continue;
        const entity = bot.entities?.[drop.id];
        if (!entity?.position) { beginRetreat('PICKUP_UNSAFE'); continue; }
        drop.at = xyz(entity.position);
        const goal = middle(entity.position), path = space.route(p, goal);
        if (!path || !space.braced(goal, seeing)) { beginRetreat('PICKUP_UNSAFE'); continue; }
        const next = path[1] ?? goal;
        if (next && p.distanceTo(entity.position) > 0.6 && watch.mayClose(p, Date.now()) && watch.mayClose(next, Date.now())) {
          if (!danger) aimAt({ position: next.offset(0, 1.62, 0) });
          move(next);
        }
        continue;
      }
      if (!target?.position || target.isValid === false || target.name !== 'blaze' || (targetUuid && target.uuid !== targetUuid)) {
        targetDead = null; beginRetreat('TARGET_LOST'); continue;
      }
      const eye = p.offset(0, 1.62, 0), reach = distance(eye, target), visible = sees(target);
      if (!visible) { targetDead = null; beginRetreat('TARGET_LOST'); continue; }
      if (reach < bestDistance - 0.15) { bestDistance = reach; lastGain = Date.now(); }
      if (reach <= 3 && Date.now() - raisedAt >= 250 && physicsTicks - raisedTick >= 5) {
        change('STRIKE');
        if (!space.braced(p, seeing)) { beginRetreat('NO_ATTACK_WINDOW'); continue; }
        // No StrikeGate and no deactivateItem: a raised shield is compatible with a melee blow.
        if (Date.now() - lastSwing >= cooldownMs(bot.heldItem?.name)) {
          if (!incoming.length) aimAt({ position: target.position.offset(0, 0.9, 0) });
          lastSwing = swingAt = Date.now(); unackedSwing = true; bot.attack(target);
        }
        continue;
      }
      if (Date.now() - lastGain >= 5000) { beginRetreat(target.position.y - eye.y > 3 ? 'HEIGHT_UNREACHABLE' : 'NO_ATTACK_WINDOW'); continue; }
      // A level route towards that one target only. No 3.5m leash and no alternative target or shelter.
      const next = middle(p).offset(Math.abs(target.position.x - p.x) >= Math.abs(target.position.z - p.z) ? Math.sign(target.position.x - p.x) : 0,
        0, Math.abs(target.position.x - p.x) < Math.abs(target.position.z - p.z) ? Math.sign(target.position.z - p.z) : 0);
      if (Date.now() - raisedAt < 250 || physicsTicks - raisedTick < 5 || !watch.mayClose(p, Date.now()) || !watch.mayClose(next, Date.now()) || !space.edge(middle(p), next) || !space.braced(next, seeing)) { change('BLOCK'); continue; }
      // Every advance also needs a checked route home and enough time left for it.
      const home = space.route(next, a.retreatTo);
      if (!home || until - Date.now() <= returnBudget(home) + 500) { beginRetreat(home ? 'TIME_LIMIT' : 'NO_ATTACK_WINDOW'); continue; }
      change('CLOSE'); move(next);
    }
  } catch (e) {
    const why = String(ctx.stop.reason ?? actionSignal(bot)?.reason ?? (e instanceof StepStopped ? e.why : e));
    cut = ctx.stop.aborted || actionSignal(bot)?.aborted === true || !!reflexHeld(host);
    code = hp() <= 0 ? 'DEAD' : /reflex|floor-|lava|constant:|auto-|breath/u.test(why) || reflexHeld(host) ? 'REFLEX' : cut ? 'TIME_LIMIT' : retreat ? 'RETREAT_BLOCKED' : 'NO_ATTACK_WINDOW';
  } finally {
    bot.removeListener('health', sample); bot.removeListener('entityDead', died); bot.removeListener('entityHurt', hurt); bot.removeListener('playerCollect', collect);
    // A stale motor owner must never clear a new reflex's controls or shield.
    if (owned && !ctx.stop.aborted && !actionSignal(bot)?.aborted && !reflexHeld(host)) { try { stopKeys(); } catch { /* expired owner */ } }
    if (owned && resident && residentBefore) { resident.enabled = residentBefore.enabled; resident.up = bot.usingHeldItem === true; }
  }
  return finish();

  function finish(): ShieldRushOutcome {
    sample();
    const at = xyz(bot.entity?.position ?? ctx.base);
    const status: ShieldRushResult['status'] = code === 'REFLEX' || cut && code !== 'DEAD' ? 'cut' : code === 'DEAD' || code === 'RETREAT_BLOCKED' || ['TARGET_LOST', 'HEIGHT_UNREACHABLE', 'NO_ATTACK_WINDOW', 'PICKUP_UNSAFE'].includes(code ?? '') ? 'failed'
      : targetDead === true && code === null && safe ? 'killed' : 'retreated';
    const result: ShieldRushResult = { status, targetDead, code, hits, rodsDelta: inventoryCount(bot, 'blaze_rod') - rods0, hpMin, hpEnd: hp(), shieldBefore,
      shieldAfter: shieldLeft(), elapsedMs: Date.now() - started, at, safe, pendingDrops: [...drops.values()].filter(d => !d.collected).map(d => ({ id: d.id, at: d.at })) };
    const ok = status === 'killed';
    return { ok, ...(code ? { code, reason: code === 'REFLEX' ? 'reflex' : code === 'DEAD' ? 'died' : code } : !ok ? { reason: 'retreated' } : {}),
      text: `盾の突撃 ${code ?? status}: ${code ? WORDS[code] : status === 'killed' ? '指定の相手を倒し指定先へ戻った' : '指定の体力で戦いをやめ指定先へ戻った'}。命中${hits}・ロッド増分${result.rodsDelta}・最低体力${hpMin}・盾残り${result.shieldAfter}`,
      at, ...(targetDead === null ? { goal: 'unknown' as const } : {}), progress: { unit: 'blow', done: hits, left: targetDead === true ? 0 : null }, shieldRush: result };
  }
}
