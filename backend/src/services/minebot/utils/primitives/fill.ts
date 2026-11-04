import { actionSignal, nativeActionHost } from '../../execution/ActionExecution.js';
import { reflexHeld, shootersInReach, shootersSeeing } from '../floorReflexes.js';
import { feetCell, type Cell } from '../localMap.js';
import { standableAt, standabilityFires, type Standability } from '../standability.js';
import { blockAt, DIRECTIONS, inventoryCount, StepStopped, type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { go } from './go.js';
import { place } from './place.js';

export interface FillGroup { stand: Cell; at: Cell[] }
export interface FillArgs { block: string; groups: FillGroup[]; retreatHp: number; retreatTo: Cell; seconds: number }
export type FillCode = 'HP_FLOOR' | 'TIME_LIMIT' | 'NO_STAND' | 'NO_BLOCKS' | 'RETREAT_BLOCKED' | 'REFLEX' | 'DEAD';
export interface FillResult {
  status: 'done' | 'partial' | 'retreated' | 'failed' | 'cut'; code: FillCode | null; placed: number; remaining: Cell[];
  skippedBy: { creature: number; reach: number; hazard: number; other: number };
  /** The place hand's own reasons for the cells it skipped, counted (what `other` was). */
  reasons?: Record<string, number>;
  hpMin: number; hpEnd: number; elapsedMs: number; at: Cell; safe: boolean; seen: number;
}
export interface FillOutcome extends StepOutcome { fill: FillResult }
export const FILL_DESCRIPTION = 'fill: block（持っているブロック）・groups（1〜12組、各 {stand:{x,y,z},at:[{x,y,z},…1〜8マス]}）・retreatHp(1〜19)・retreatTo({x,y,z}、必須の帰還先の足)・seconds(5〜60、帰還込み)を全て指定。'
  + '座標は絶対座標。probe kind=lane の standAt と group を元に、置くマスと順序は頭が選ぶ。体は順に歩き1マスずつ置き、置けない所を飛ばして最後に1周だけ再試行し、必ず指定先へ帰還を試みる。足場を妨げる火だけ最大2回消し、道に置かず、盾と飛来弾の反射はresidentに任せる。'
  + '開始時に帰還先の足場・全マス分の手持ち・体力を確認し、不足なら動かず置かずfailed。毎マスと移動中にHP下限・帰還予約時間・反射を確認する。'
  + '行のfill: status(done/partial/retreated/failed/cut)、code(HP_FLOOR/TIME_LIMIT/NO_STAND/NO_BLOCKS/RETREAT_BLOCKED/REFLEX/DEAD/null)、placed(実際に置いた数)、remaining(未完の座標、最大40)、skippedBy(creature/reach/hazard/other、再試行を含む失敗回数)、hpMin/hpEnd、elapsedMs、at(終了位置)、safe、seen(終了位置で見える射手数)。'
  + 'doneは全マスが済み安全に帰還、partialは未完ありで帰還、retreatedはHP/時間で中止して帰還。safeは指定先へ到着して立てており、燃焼も溶岩も無く、見える射手が無い時にtrue。見られていても体力がretreatHp以上ならsafe=trueとし、露出はseenに残す。safe:falseを成功と読まない。REFLEX/cutとDEADはact全体を止める。反射・死亡・外部取消で体の所有権を失った時は帰還を強行しない。';

/** The same boundary check is used by act and by the head's proposed contract. */
export function fillProblem(a: Record<string, any>): string | null {
  const object = (p: any) => p !== null && typeof p === 'object' && !Array.isArray(p);
  const pos = (p: any) => object(p) && Object.keys(p).every(k => ['x', 'y', 'z'].includes(k)) && [p.x, p.y, p.z].every(Number.isFinite);
  const range = (n: any, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;
  if (typeof a.block !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/u.test(a.block)) return 'block は持っているブロックの id';
  if (!range(a.seconds, 5, 60) || !range(a.retreatHp, 1, 19)) return 'seconds は5〜60、retreatHp は1〜19';
  if (!pos(a.retreatTo)) return 'retreatTo は帰還先の足の絶対座標 {x,y,z}（必須）';
  if (!Array.isArray(a.groups) || a.groups.length < 1 || a.groups.length > 12) return 'groups は1〜12組';
  for (const g of a.groups) {
    if (!object(g) || Object.keys(g).some(k => !['stand', 'at'].includes(k)) || !pos(g.stand)
      || !Array.isArray(g.at) || g.at.length < 1 || g.at.length > 8 || !g.at.every(pos)) return '各groupは stand（足の絶対座標）と at（有限の絶対座標1〜8マス）';
  }
  const allowed = new Set(['do', 'block', 'groups', 'retreatHp', 'retreatTo', 'seconds', 'note', 'onFail', 'dependsOn']);
  if (Object.keys(a).some(k => a[k] !== undefined && !allowed.has(k))) return 'fill は指定の欄だけ使える（座標は絶対座標）';
  return null;
}

const cell = (p: Cell): Cell => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const same = (a: Cell | null, b: Cell) => !!a && a.x === b.x && a.y === b.y && a.z === b.z;
const HAZARD = /^(fire|soul_fire|lava|magma_block|cactus|campfire|soul_campfire|wither_rose|sweet_berry_bush|powder_snow)$/u;
const WORDS: Record<FillCode, string> = {
  HP_FLOOR: '体力の下限で設置をやめた', TIME_LIMIT: '帰還の時間を残して設置をやめた', NO_STAND: '帰還先または立ち位置に立てる足場がない',
  NO_BLOCKS: '全マス分のブロックを持っていない', RETREAT_BLOCKED: '指定先への安全な帰還を確認できない', REFLEX: '反射に体を譲った', DEAD: '体が死んだ',
};

/** One ordered build, one retry pass, then the planner's shelter. No choice of cells, fight, shield takeover or automatic resumption. */
export async function fill(ctx: StepContext, args: FillArgs): Promise<FillOutcome> {
  const problem = fillProblem(args);
  if (problem) throw new Error(`invalid_input: ${problem}`);
  const bot = ctx.bot, host = nativeActionHost(bot), started = Date.now(), until = Math.min(ctx.deadline, started + args.seconds * 1000);
  // Snapshot the plan; a caller must not change coordinates while a native operation is in flight.
  const home = cell(args.retreatTo), groups = args.groups.map(g => ({ stand: cell(g.stand), cells: g.at.map(at => ({ at: cell(at), done: false })) }));
  const cells = groups.flatMap(g => g.cells), skippedBy = { creature: 0, reach: 0, hazard: 0, other: 0 };
  const read = (x: number, y: number, z: number) => blockAt(bot, { x, y, z });
  const hp = () => Number(bot.health ?? 0);
  let debug = '', hpMin = hp(), placed = 0, code: FillCode | null = null, cut = false, safe = false, homeReached = false, preflight = true;
  const sample = () => { hpMin = Math.min(hpMin, hp()); };
  const returnBudget = (from: Cell = bot.entity?.position ?? ctx.base) => Math.hypot(from.x - home.x, from.y - home.y, from.z - home.z) * 1800 + 2000;
  const stopped = (work: boolean): boolean => {
    sample();
    if (hp() <= 0) { code = 'DEAD'; return true; }
    const signal = actionSignal(bot), why = String(ctx.stop.reason ?? signal?.reason ?? '');
    if (reflexHeld(host) || ((ctx.stop.aborted || signal?.aborted) && /reflex|floor-|constant:|auto-|lava|breath/u.test(why))) { code = 'REFLEX'; cut = true; return true; }
    if (ctx.stop.aborted || signal?.aborted) { code = 'TIME_LIMIT'; cut = true; return true; }
    // A part may return a failed outcome after child cancellation instead of throwing. Once stopped, never resume work even if HP recovers or the body is closer to home.
    if (work && code !== null) return true;
    if (work && hp() <= args.retreatHp) { code = 'HP_FLOOR'; return true; }
    if (work && until - Date.now() <= returnBudget()) { code = 'TIME_LIMIT'; return true; }
    return false;
  };
  // Child cancellation leaves the act's motor lease intact for retreat. Await the part's unwind; never race an abandoned go against another go.
  const perform = async (work: boolean, deadline: number, run: (part: StepContext) => Promise<StepOutcome>): Promise<StepOutcome> => {
    const control = new AbortController();
    const check = () => {
      if (control.signal.aborted) return;
      if (stopped(work)) control.abort(code);
      else if (Date.now() >= deadline) { code = work ? 'TIME_LIMIT' : 'RETREAT_BLOCKED'; control.abort(code); }
    };
    check();
    if (control.signal.aborted) throw new StepStopped(String(control.signal.reason));
    const timer = setTimeout(check, Math.max(0, deadline - Date.now())), poll = setInterval(check, 50);
    bot.on('health', check); bot.on('physicsTick', check); ctx.stop.addEventListener('abort', check); actionSignal(bot)?.addEventListener('abort', check);
    try { return await run({ ...ctx, stop: control.signal, deadline }); }
    finally {
      clearTimeout(timer); clearInterval(poll); bot.removeListener('health', check); bot.removeListener('physicsTick', check);
      ctx.stop.removeEventListener('abort', check); actionSignal(bot)?.removeEventListener('abort', check); sample();
    }
  };
  const move = (to: Cell, work: boolean) => {
    const deadline = work ? until - Math.max(returnBudget(), returnBudget(to)) : until;
    return perform(work, deadline, part => go(part, { goals: [to], range: 0.8, seconds: Math.max(0, (deadline - Date.now()) / 1000),
      maxDig: 0, maxPlace: 0, maxDrop: 0, waterOk: false }));
  };
  const noStand = (p: Cell, label: string, state: Standability) => {
    code = 'NO_STAND';
    const words: Record<Standability['why'], string> = { ok: '立てる', no_floor: '床がない', floor_hazard: '床が危険',
      no_head_room: '足か頭が塞がっている', fire_near: '火の中か隣', hazard_near: '危険物の中か隣', unloaded: '未ロード' };
    debug = `（${label} ${p.x},${p.y},${p.z}: 足元の下 ${state.floor} ／ ${words[state.why]}（${state.why}））`;
  };
  const fireAttempts = new Map<string, number>();
  const clearFires = async (p: Cell, work: boolean): Promise<Standability> => {
    const key = `${p.x},${p.y},${p.z}`;
    let state = standableAt(read, p);
    for (let attempt = fireAttempts.get(key) ?? 0; attempt < 2 && state.why === 'fire_near'; attempt++) {
      const fires = standabilityFires(read, p), keys = new Set(fires.map(f => `${f.x},${f.y},${f.z}`));
      // Only fire may be repaired: removing it must reveal a loaded, standable cell, with no other hazard.
      if (!fires.length || !standableAt((x, y, z) => keys.has(`${x},${y},${z}`) ? { name: 'air', boundingBox: 'empty' } : read(x, y, z), p).ok) break;
      fireAttempts.set(key, attempt + 1);
      try { await perform(work, work ? until - returnBudget() : until, part => dig(part, { at: [fires[0]], collect: false })); }
      catch {
        if (stopped(work)) throw new StepStopped(String(code));
        return standableAt(read, p);
      }
      state = standableAt(read, p);
      if (stopped(work)) break;
    }
    return state;
  };
  const reasons: Record<string, number> = {};
  const skip = (reason?: string) => {
    const key = String(reason ?? 'none').slice(0, 40); reasons[key] = (reasons[key] ?? 0) + 1;
    if (reason === 'creature_in_cell') skippedBy.creature++;
    else if (/reach|path|body_in_cell|stuck|dead_end/u.test(reason ?? '')) skippedBy.reach++;
    else if (/hazard|fire|lava|magma|cactus/u.test(reason ?? '')) skippedBy.hazard++;
    else skippedBy.other++;
  };
  const seenNow = () => {
    const p = bot.entity?.position;
    // Use loaded blocks directly, including partial shapes, as the cover check (no map-memory fallback).
    return p ? shootersSeeing(bot, shootersInReach(bot, p), p, (x, y, z) => {
      const b = blockAt(bot, { x, y, z });
      return !b || b.boundingBox === 'block' || !!b.shapes?.length;
    }).length : 0;
  };
  const safeAtHome = () => {
    const p = bot.entity?.position;
    if (!p || !same(feetCell(bot), home) || !standableAt(read, home).ok || bot.entity.isInLava || (Number(bot.entity.metadata?.[0] ?? 0) & 1) !== 0) return false;
    homeReached = true;
    return seenNow() === 0 || hp() >= args.retreatHp;
  };
  bot.on('health', sample);
  try {
    if (hp() <= 0 || reflexHeld(host) || ctx.stop.aborted || actionSignal(bot)?.aborted) { stopped(false); return finish(); }
    let homeState = standableAt(read, home);
    if (!homeState.ok && homeState.why !== 'fire_near') { noStand(home, '帰還先', homeState); return finish(); }
    if (inventoryCount(bot, args.block) < cells.length || !bot.registry?.blocksByName?.[args.block]) { code = 'NO_BLOCKS'; return finish(); }
    if (hp() <= args.retreatHp) { code = 'HP_FLOOR'; return finish(); }
    if (homeState.why === 'fire_near') {
      try { homeState = await clearFires(home, true); }
      catch { homeState = standableAt(read, home); }
      if (stopped(true)) return finish();
      if (!homeState.ok) { noStand(home, '帰還先', homeState); return finish(); }
    }
    preflight = false;
    try {
      passes: for (let pass = 0; pass < 2; pass++) {
        for (const group of groups) {
          const pending = group.cells.filter(c => !c.done);
          if (!pending.length) continue;
          if (stopped(true)) break passes;
          let state = standableAt(read, group.stand);
          if (state.why === 'fire_near') state = await clearFires(group.stand, true);
          if (stopped(true)) break passes;
          if (!state.ok) { noStand(group.stand, '立ち位置', state); break passes; }
          const walk = await move(group.stand, true);
          if (stopped(true)) break passes;
          if (!walk.ok || !same(feetCell(bot), group.stand)) { for (const _ of pending) skip(walk.reason ?? 'out_of_reach'); continue; }
          state = standableAt(read, group.stand);
          if (state.why === 'fire_near') state = await clearFires(group.stand, true);
          if (stopped(true)) break passes;
          if (!state.ok) { noStand(group.stand, '立ち位置', state); break passes; }
          for (const target of pending) {
            if (stopped(true)) break passes;
            const before = blockAt(bot, target.at)?.name;
            const near = [target.at, ...Object.values(DIRECTIONS).map(([x, y, z]) => ({ x: target.at.x + x, y: target.at.y + y, z: target.at.z + z }))];
            if (before !== args.block && near.some(p => HAZARD.test(blockAt(bot, p)?.name ?? ''))) { skip('hazard'); continue; }
            let out: StepOutcome;
            try { out = await perform(true, until - returnBudget(), part => place(part, { block: args.block, at: [target.at] })); }
            catch (e) {
              // A server update may have arrived just before HP/time/reflex cancellation. Keep that completed cell in the receipt.
              if (before !== args.block && blockAt(bot, target.at)?.name === args.block) { target.done = true; placed++; }
              throw e;
            }
            if (out.ok) { target.done = true; placed += out.progress?.done ?? (out.goal === 'already' ? 0 : 1); }
            else skip(out.reason);
            ctx.progress?.(`まとめ置き ${placed}/${cells.length}`);
          }
        }
      }
    } catch {
      if (!stopped(false) && code === null) skippedBy.other++;
    }
    // An expired owner cannot drive to shelter or clear the new reflex's controls. Fatal cuts keep the actual position and safe:false.
    if (!stopped(false)) {
      try {
        let state = standableAt(read, home);
        if (state.why === 'fire_near') state = await clearFires(home, false);
        if (stopped(false)) return finish();
        if (!state.ok) {
          noStand(home, '帰還先', state);
          if (state.why !== 'fire_near') code = 'RETREAT_BLOCKED';
          return finish();
        }
        const out = await move(home, false);
        if (out.ok && same(feetCell(bot), home) && !stopped(false)) {
          state = standableAt(read, home);
          if (state.why === 'fire_near') state = await clearFires(home, false);
          if (!stopped(false) && !state.ok) {
            noStand(home, '帰還先', state);
            if (state.why !== 'fire_near') code = 'RETREAT_BLOCKED';
            return finish();
          }
        }
        if (!stopped(false)) {
          safe = out.ok && Date.now() <= until && safeAtHome();
          if (!safe) code = homeReached && hp() < args.retreatHp ? 'HP_FLOOR' : 'RETREAT_BLOCKED';
        }
      } catch {
        if (!stopped(false)) code = 'RETREAT_BLOCKED';
      }
    }
    return finish();
  } finally { bot.removeListener('health', sample); }

  function finish(): FillOutcome {
    sample();
    const remaining = cells.filter(c => !c.done).map(c => ({ ...c.at })), at = { ...(bot.entity?.position ?? ctx.base) };
    // Copy only xyz even when the native position has more enumerable fields.
    const position: Cell = { x: at.x, y: at.y, z: at.z };
    if (!preflight && !safe && !cut && code !== 'DEAD' && code !== 'NO_STAND' && !(homeReached && code === 'HP_FLOOR')) code = 'RETREAT_BLOCKED';
    const status: FillResult['status'] = code === 'DEAD' ? 'failed' : cut ? 'cut' : preflight || !safe || code === 'RETREAT_BLOCKED' ? 'failed'
      : code === 'HP_FLOOR' || code === 'TIME_LIMIT' ? 'retreated' : remaining.length ? 'partial' : 'done';
    const result: FillResult = { status, code, placed, remaining: remaining.slice(0, 40), skippedBy, reasons, hpMin, hpEnd: hp(), elapsedMs: Date.now() - started, at: position, safe, seen: seenNow() };
    const ok = status === 'done' && safe;
    return { ok, ...(code ? { code, reason: code === 'REFLEX' ? 'reflex' : code === 'DEAD' ? 'died' : code } : !ok ? { reason: 'partial' } : {}),
      text: `まとめ置き ${code ?? status}: ${code ? WORDS[code] : status === 'done' ? '指定のマスを済ませ指定先へ戻った' : '未完のマスを残して指定先へ戻った'}${debug}。設置${placed}・未完${remaining.length}・最低体力${hpMin}・安全${safe ? '確認' : '未確認'}`,
      at: position, progress: { unit: 'block', done: placed, left: remaining.length }, fill: result };
  }
}
