import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { ENDERMAN_ANGRY_STRIKE_HEIGHTS, ENDERMAN_EYE, ENDERMAN_LEGS, endermanLine, ENDERMAN_STARE_MS, atRoofCentre, endermanAngry, endermanStrikePoint, endermanView,
  planRoof, roofBlockFor, roofBlocksHeld, roofCellOccupied, roofExitForSight, roofExitStep, roofInterior, roofInteriorStep, roofSites,
  type EndermanLine, type EndermanView, type RoofPlan, type RoofWorld } from './huntEnderman.js';
import { bodyReader, feetCell, type BlockReader, type Cell } from './localMap.js';
import { huntCandidates } from './huntEndermanProbe.js';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { reflexHeld } from './floorReflexes.js';
import { isHostileEntity } from './hostileMobHints.js';
import { PLACE_REPLACEABLE, place } from './primitives/place.js';
import { removeRoofSupport } from './huntEndermanSupport.js';
import { cellText, guard, inventoryCount, letGo, stopped, wait, type StepContext, type StepOutcome } from './primitives/common.js';
import { goWith, walkMovements } from './primitives/walk.js';

const { goals } = pathfinder;

/**
 * The live part of the enderman hunt (S2, 2026-11-02; the plan and the reasons are in huntEnderman.ts): build the roof over the body, stare the enderman in the
 * eye from under it, and hold the hole. The fight hand (primitives/fight) asks this for one step at a time and does the blows, the shield and the counts itself.
 *
 * Built before it is angered: a blow costs 7 points and a push. After building, the eye ray gates provoking; the approach and lower-body ray are recorded
 * for diagnostics only, since an angry enderman can teleport here. The same target is retained through every phase and any small recovery inside the standing roof.
 */

/** The longest the roof is worked on (a body that cannot lay it in this is not going to). */
const BUILD_MS = 14_000;
/** A cell that will not be laid in this many tries is the plan's to mend: once, and then the hand says why. */
const CELL_TRIES = 2;
/** Metadata may trail the short stare. Wait looking at legs, never extend the eye contact. */
const ANGER_ACK_MS = 500;
/**
 * The existing sight budget. Recovery spends this budget too; a step never restarts it.
 */
const SIGHT_MS = 8_000;
/**
 * end1109p05 (11/9): under one roof the camp's own cap hid #411's eyes and no step out from under it saw them (出られる 3 方向のどこからも目が見えない),
 * yet the head named #411 by its id six times, 8 s each, 0 blows: the 160-character line cut the reason off at 「出られる…」, and the live state's
 * 「#411 見える（射線の中）」 (it sees some part of her body) read as "its eyes are in sight". Such a one is noted with the roof: while it stays within
 * HIDDEN_NEAR_M of where it stood and the body under that roof, the kind's pick passes over it and its id is answered at once with the reason.
 */
const HIDDEN_NEAR_M = 4, HIDDEN_FORGET_MS = 120_000;
const hiddenUnderRoof = new WeakMap<object, Map<number, { roof: Cell; at: Cell; until: number }>>();
export function noteHiddenFromRoof(bot: any, id: number, roof: Cell, at: Cell, now = Date.now()): void {
  let seen = hiddenUnderRoof.get(bot);
  if (!seen) { seen = new Map(); hiddenUnderRoof.set(bot, seen); }
  seen.set(id, { roof: { ...roof }, at: { ...at }, until: now + HIDDEN_FORGET_MS });
}
/** The roof `entity` was found hidden from, while the body is still under it (its feet within the 3x3) and the enderman near where it stood; else null. */
export function hiddenFromRoof(bot: any, entity: any, now = Date.now()): Cell | null {
  const mark = entity ? hiddenUnderRoof.get(bot)?.get(entity.id) : undefined;
  const feet = feetCell(bot), p = entity?.position;
  if (!mark || now > mark.until || !feet || !p) return null;
  if (feet.y !== mark.roof.y || Math.abs(feet.x - mark.roof.x) > 1 || Math.abs(feet.z - mark.roof.z) > 1) return null;
  return Math.hypot(p.x - mark.at.x - 0.5, p.y - mark.at.y, p.z - mark.at.z - 0.5) <= HIDDEN_NEAR_M ? mark.roof : null;
}
/** The words for one hidden from this roof: what to do first (the line is cut from the back), then why. */
export function hiddenFromRoofWords(id: number, roof: Cell, why: string): string {
  return `この屋根 ${cellText(roof)} の下からは #${id} を狙えない: 別の個体を fight target=enderman で呼ぶ（#${id} はこの屋根では選ばない）か、probe kind=roofsite で屋根の場所を変える。`
    + `live の「見える（射線の中）」は相手から体のどこかが見えることで、こちらの目と相手の目の線ではない（${why}）`;
}
/** An enderman closer than this and angry is the fight's, not the building's (it reaches the body in a second). */
const CONTACT = 4.2;
const RECOVERY_LIMIT = 2, RECOVERY_MS = 3_000, RECOVERY_STEP_MS = 1_800;
/** A blow's reach (fight's REACH), the farthest an angry one is stepped toward, how long it stands there first, the steps a hand. */
const REACH_M = 3.0, REACH_FAR_M = 4.5, REACH_WAIT_MS = 1_500, REACH_STEPS = 2;
/** At most once per stare (including the existing one interrupted-stare retry), independently of interior recovery. */
const ROOF_EXIT_LIMIT = 2;
/** The exit crosses two cells in one segment, with the existing per-cell movement bound. This never renews SIGHT_MS. */
const ROOF_EXIT_STEP_MS = 2 * RECOVERY_STEP_MS;
/**
 * The exterior stare's distances (Codex's pre-deploy review 5, 11/5). The step back is two cells at a sneak (about 1.5 s); an angry enderman walks some 4 m a
 * second. Out only when the target is EXIT_MIN_GAP or more from the exit cell and nothing else hostile is within EXIT_CLEAR of it; back at once when the target
 * comes within EXIT_ABORT of the body. A way back that is blocked or pushed off is walked round once (HOME_WALK_MS) before the hand stops.
 */
const EXIT_MIN_GAP = 10, EXIT_CLEAR = 8, EXIT_ABORT = 7, HOME_WALK_MS = 3_000;

export interface CampObservation extends EndermanView {
  at: number;
  phase: EndermanCamp['phase'];
  targetId: number;
  targetPosition: Cell;
  position: Cell;
}
export interface CampObservationRecord {
  targetId: number;
  roofCell: Cell;
  afterBuild: CampObservation | null;
  latest: CampObservation | null;
  recovery: Array<{ from: Cell; to: Cell; at: number; result: 'moving' | 'arrived' | 'stopped' }>;
  exits: Array<{ from: Cell; to: Cell; at: number; result: 'moving' | 'staring' | 'returning' | 'returned' | 'stopped';
    reason: 'angry' | 'stared' | 'not_visible' | 'near' | null; homeWalk?: 'arrived' | 'failed' }>;
  stareAt: number | null;
  stareEndedAt: number | null;
  angryAt: number | null;
  legsAt: number | null;
  verifiedCaps: number;
  capsPlaced: number;
  supportsRemoved: number;
}
// Body diagnostics only, outside the head/act contract. Ports and the raw bot share the same key.
const observations = new WeakMap<object, CampObservationRecord>();
export function endermanCampObservation(bot: object): CampObservationRecord | null { return observations.get(nativeActionHost(bot)) ?? null; }
export function clearEndermanCampObservation(bot: object): void { observations.delete(nativeActionHost(bot)); }

// end1109p10 (11/9): about 570 s of 23 min went on roof material (wart and netherrack dug a block at a time, drops fetched from holes) while the
// 64 kit cobblestone stood in roofs left after fights that failed, never taken back. The blocks a camp laid and left, so the shortage line names them first.
const LAID_KEEP = 81;
const laidRoofs = new WeakMap<object, Map<string, { cell: Cell; name: string }>>();
export function noteRoofLaid(bot: object, cell: Cell, name: string): void {
  const host = nativeActionHost(bot);
  let laid = laidRoofs.get(host);
  if (!laid) laidRoofs.set(host, laid = new Map());
  const key = `${cell.x},${cell.y},${cell.z}`;
  laid.delete(key);
  laid.set(key, { cell: { x: cell.x, y: cell.y, z: cell.z }, name });
  while (laid.size > LAID_KEEP) laid.delete(laid.keys().next().value as string);
}
export function forgetRoofLaid(bot: object, cell: Cell): void { laidRoofs.get(nativeActionHost(bot))?.delete(`${cell.x},${cell.y},${cell.z}`); }
/** The blocks a camp laid that still stand as laid, not the roof over the feet nor the floor under the 3x3 about them. */
function ownRoofLeft(bot: object, read: BlockReader, here: Cell): Cell[] {
  const laid = laidRoofs.get(nativeActionHost(bot));
  if (!laid) return [];
  const left: Cell[] = [];
  for (const { cell, name } of laid.values()) {
    const dx = cell.x - here.x, dy = cell.y - here.y, dz = cell.z - here.z;
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy >= -1 && dy <= 3) continue;
    if (String(read(cell.x, cell.y, cell.z)?.name ?? '') === name) left.push(cell);
  }
  return left;
}

/** The roof's world as the body reads it (what a block stops, what a block can be put into). */
export function roofWorldOf(bot: any): RoofWorld {
  const read = (x: number, y: number, z: number) => { try { return bot.blockAt?.(new Vec3(x, y, z), false) ?? null; } catch { return null; } };
  return {
    solid: (x, y, z) => { const block = read(x, y, z); return block ? block.boundingBox === 'block' : null; },
    replaceable: (x, y, z) => { const block = read(x, y, z); return !!block && PLACE_REPLACEABLE.has(String(block.name)) && block.name !== 'water' && block.name !== 'lava'; },
  };
}

/** How far the body walks to a roof site. */
const SITE_RADIUS = 7;
const SITE_WALK_MS = 9_000;

/**
 * The body stands where no roof can be made (a step beside it, a plant that is not to be built over): the nearest cell within SITE_RADIUS where the plan stands and the
 * blocks carried are enough is walked to. Says where it went, or that there is none.
 */
export async function moveToRoofSite(ctx: StepContext, target: any): Promise<{ moved: boolean; text: string; cell?: Cell }> {
  const bot = ctx.bot;
  const here = feetCell(bot)!;
  const world = roofWorldOf(bot);
  const at = target.position;
  const dx = at.x - (here.x + 0.5), dz = at.z - (here.z + 0.5), length = Math.hypot(dx, dz);
  const sites = roofSites(world, here, SITE_RADIUS, length > 0.5 ? { x: dx / length, z: dz / length } : undefined, 8)
    .filter(site => site.blocks === 0 || roofBlocksHeld(bot).total >= site.blocks);
  if (!sites.length) return { moved: false, text: `半径${SITE_RADIUS}mに屋根を作れる平らな所が無い（持っている建築用ブロックで足りる所も）` };
  const navigator = bot.pathfinder;
  const previous = navigator?.movements;
  try {
    navigator?.setMovements(walkMovements(bot, false));
    for (const site of sites.slice(0, 3)) {
      const gone = await goWith(ctx, new goals.GoalBlock(site.cell.x, site.cell.y, site.cell.z), Math.min(SITE_WALK_MS, Math.max(500, ctx.deadline - Date.now())), { opened: [], leaves: 0 });
      letGo(bot);
      const now = feetCell(bot);
      if (now && now.x === site.cell.x && now.y === site.cell.y && now.z === site.cell.z && !planRoof(world, now).problems.length) {
        return { moved: true, text: `屋根を作れる所 ${cellText(now)} へ ${site.distance}m 歩いた（ブロック ${site.blocks} 個）`, cell: now };
      }
      if (gone.timedOut || gone.error) continue;
    }
  } finally { try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
  return { moved: false, text: `屋根を作れる所は半径${SITE_RADIUS}mに ${sites.length} か所あったが、歩いて着けなかった` };
}

export type CampStep = { kind: 'fight' } | { kind: 'wait' } | { kind: 'stop'; outcome: StepOutcome };

export class EndermanCamp {
  phase: 'build' | 'provoke' | 'hold' = 'build';
  plan: RoofPlan;
  block: { name: string; count: number } | null;
  laid = 0;
  angeredAt = 0;
  private cell: Cell;
  private began = Date.now();
  private tries = new Map<string, number>();
  private staredSince = 0;
  private restares = 0;
  private blindSince = 0;
  private guardWas: boolean | null = null;
  private replans = 0;
  private readonly targetId: number;
  private standing: Cell;
  private recoveryBegan = 0;
  private shift: { from: Cell; to: Cell; at: number } | null = null;
  private recoveryEnded = false;
  private recoveryBlocker: EndermanLine | null = null;
  private readonly observation: CampObservationRecord;
  private temporary = new Map<string, { cell: Cell; name: string }>();
  private centringSince = 0;
  private exit: { to: Cell; stage: 'out' | 'stare' | 'back'; at: number } | null = null;
  private exitStare = -1;
  private exitRefused: string | null = null;
  /** One sneaking step under the roof toward an angry enderman that stopped just out of a blow's reach (end1109p02: four fights of 20-40 s at 3.5-3.9 m, no swing). */
  private reach: { from: Cell; to: Cell; at: number } | null = null;
  private reachSteps = 0;
  private reachFarSince = 0;

  constructor(private readonly ctx: StepContext, private readonly target: any) {
    const bot = ctx.bot;
    this.cell = feetCell(bot)!;
    this.standing = this.cell;
    this.targetId = target.id;
    this.plan = this.planFrom(this.cell);
    this.block = roofBlockFor(bot, this.plan.placements.length);
    if (!this.plan.placements.length) this.phase = 'provoke';
    this.observation = { targetId: this.targetId, roofCell: { ...this.cell }, afterBuild: null, latest: null, recovery: [], exits: [],
      stareAt: null, stareEndedAt: null, angryAt: null, legsAt: null, verifiedCaps: 0, capsPlaced: 0, supportsRemoved: 0 };
    observations.set(nativeActionHost(bot), this.observation);
  }

  private worldOf(): RoofWorld { return roofWorldOf(this.ctx.bot); }
  private planFrom(cell: Cell): RoofPlan {
    const at = this.target.position;
    const dx = at.x - (cell.x + 0.5), dz = at.z - (cell.z + 0.5), length = Math.hypot(dx, dz);
    return planRoof(this.worldOf(), cell, length > 0.5 ? { x: dx / length, z: dz / length } : undefined, at, true);
  }

  /** What stops the hunt before anything is done: no site, or not enough to build with. Null when it can begin. */
  check(): { code: string; text: string; cause?: string } | null {
    const bot = this.ctx.bot;
    if (this.plan.problems.length) {
      return { code: 'no_site', text: `ここには屋根の穴を作れない: ${this.plan.problems.join('。')}（${cellText(this.cell)}。平らな床の上か、2 マスの高さの所へ動いてから）` };
    }
    const need = this.plan.placements.length;
    const held = roofBlocksHeld(bot);
    if (need > 0 && held.total < need) {
      const kinds = held.kinds.map(kind => `${kind.name}×${kind.count}`).join('・');
      // end1109p10: this line led with the kinds the roof takes and was cut at 160 before the cells to dig (「ここから手の届く warp…」) every time.
      // The shortage is the root cause (kept whole); the way on (the cells, her own left roofs first) leads the text, the kinds come last.
      const way = netherrackNear(bot, need - held.total).replace(/^。/u, '');
      return {
        code: 'missing_item',
        cause: `屋根に建築用ブロックが ${need} 個要る。あと ${need - held.total} 個（持っているのは${kinds ? ` ${kinds}` : ' なし'}）`,
        text: `${way ? `${way}。` : ''}種類は混ぜてよい（丸石・土・ネザーラック・wart ブロックなど。黒曜石は使わない）`,
      };
    }
    if (String(bot.inventory?.slots?.[5]?.name ?? '') === 'carved_pumpkin') {
      return { code: 'pumpkin', text: 'くり抜きかぼちゃを被っているとエンダーマンは怒らない（外してから）' };
    }
    return null;
  }

  /** The cells still to lay, in the plan's order. Once all nine caps stand, supports are only for removal. */
  private remaining(): Cell[] {
    const bot = this.ctx.bot;
    const capsComplete = this.capsStanding() === 9;
    return this.plan.placements.filter(c => {
      if (capsComplete && this.plan.supports.some(s => s.x === c.x && s.y === c.y && s.z === c.z)) return false;
      const block = bot.blockAt?.(new Vec3(c.x, c.y, c.z), false);
      return !block || block.boundingBox !== 'block';
    });
  }

  /** The look held off the enderman's eyes by the body's gaze guard is let go while the hand stares, and put back. */
  private guard(on: boolean): void {
    const state = (this.ctx.bot as any).gazeGuard as { enabled: boolean } | undefined;
    if (!state) return;
    if (!on) { if (this.guardWas === null) this.guardWas = state.enabled; state.enabled = false; }
    else if (this.guardWas !== null) { state.enabled = this.guardWas; this.guardWas = null; }
  }
  /** Put everything back (the hand's end). */
  release(): void { this.stopShift(); this.stopReach(); this.stopExit(); this.guard(true); }

  private stopReach(): void {
    if (!this.reach) return;
    for (const name of ['forward', 'sneak']) { try { this.ctx.bot.setControlState(name, false); } catch { /* lease ended */ } }
    this.reach = null;
  }

  /**
   * hold: an angry target that stays just out of a blow's reach (past REACH_M, within REACH_FAR_M) for REACH_WAIT_MS is met with one straight, sneaking
   * step to the neighbouring roof cell from which its legs are struck: the cell is under the same cap (roofInteriorStep), so the step never leaves the
   * roof. At most REACH_STEPS a hand. Null: nothing to do here (the fight goes on).
   */
  private stepToReach(live: any, now: number, box: number, angry: boolean): CampStep | null {
    const bot = this.ctx.bot, read = bodyReader(bot);
    if (this.reach) {
      const p = bot.entity.position, { from, to } = this.reach, alongX = from.x !== to.x;
      const along = alongX ? p.x : p.z, across = alongX ? p.z : p.x, b = (alongX ? to.x : to.z) + 0.5;
      const feet = feetCell(bot);
      if (now - this.reach.at >= RECOVERY_STEP_MS || reflexHeld(bot) || bot.entity.onGround !== true || Math.abs(p.y - from.y) > 0.1
        || Math.abs(across - ((alongX ? from.z : from.x) + 0.5)) > 0.2 || !roofInteriorStep(read, this.cell, from, to)) {
        this.stopReach(); this.reachSteps = REACH_STEPS;
        if (feet && [from, to].some(c => c.x === feet.x && c.y === feet.y && c.z === feet.z)) { this.standing = feet; return null; }
        return this.failure('roof_failed', 'moved', '屋根内で相手へ 1 歩寄る途中に道から外れた', feet ?? this.cell);
      }
      if (Math.abs(along - b) < 0.12) { this.stopReach(); this.standing = to; return null; }
      try { void Promise.resolve(bot.lookAt(new Vec3(to.x + 0.5, p.y + 1.62, to.z + 0.5), true)).catch(() => undefined); } catch { /* the next tick ends it */ }
      const dx = to.x + 0.5 - p.x, dz = to.z + 0.5 - p.z;
      const dot = (-Math.sin(bot.entity.yaw) * dx - Math.cos(bot.entity.yaw) * dz) / Math.hypot(dx, dz);
      bot.setControlState('sprint', false); bot.setControlState('jump', false);
      bot.setControlState('sneak', true); bot.setControlState('forward', dot > 0.98);
      return { kind: 'wait' };
    }
    if (!angry || box <= REACH_M || box > REACH_FAR_M || this.reachSteps >= REACH_STEPS || this.strikePoint(live)) { this.reachFarSince = 0; return null; }
    this.reachFarSince ||= now;
    if (now - this.reachFarSince < REACH_WAIT_MS) return null;
    const from = this.standing, p = bot.entity.position;
    if (Math.abs(p.x - (from.x + 0.5)) > 0.2 || Math.abs(p.z - (from.z + 0.5)) > 0.2) return null;
    let best: { to: Cell; d: number } | null = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const to = { x: from.x + dx, y: from.y, z: from.z + dz };
      if (!roofInteriorStep(read, this.cell, from, to) || this.shiftOccupied(to)) continue;
      const at = new Vec3(to.x + 0.5, to.y, to.z + 0.5);
      if (!endermanStrikePoint(read, at, live.position, ENDERMAN_ANGRY_STRIKE_HEIGHTS)) continue;
      const d = Math.hypot(live.position.x - at.x, live.position.z - at.z);
      if (!best || d < best.d) best = { to, d };
    }
    this.reachSteps++;
    if (!best) return null;
    this.reach = { from: { ...from }, to: best.to, at: now };
    this.guard(true);
    return { kind: 'wait' };
  }

  /** Keep centring inside this single known cell. An angry target never authorizes movement out of the protected centre. */
  private async centre(now: number, angry: boolean): Promise<CampStep | null> {
    const bot = this.ctx.bot, p = bot.entity.position, c = this.standing;
    if (atRoofCentre(p, c)) { this.centringSince = 0; return null; }
    if (angry || this.angeredAt || bot.entity.onGround !== true || Math.abs(p.y - c.y) > 0.1
      || Math.floor(p.x) !== c.x || Math.floor(p.z) !== c.z || (this.centringSince && now - this.centringSince > 2_000)) {
      return this.failure('roof_failed', 'moved', '屋根中央の各軸±0.2mに留まれない。場所・対象を選び直す', feetCell(bot) ?? c);
    }
    this.centringSince ||= now;
    this.guard(true);
    const turn = await guard(this.ctx, Promise.resolve(bot.lookAt(new Vec3(c.x + 0.5, p.y + 1.62, c.z + 0.5), true)), 300);
    if (!turn || reflexHeld(bot)) return this.failure('roof_failed', 'moved', '屋根中央へ向き直れなかった', c);
    try {
      bot.setControlState('sprint', false); bot.setControlState('jump', false);
      bot.setControlState('sneak', true); bot.setControlState('forward', true);
      await wait(this.ctx, 50);
    } finally {
      for (const name of ['forward', 'sneak']) { try { bot.setControlState(name, false); } catch { /* lease ended */ } }
    }
    return { kind: 'wait' };
  }

  private capsStanding(): number {
    const world = this.worldOf(); let count = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (world.solid(this.cell.x + dx, this.cell.y + 2, this.cell.z + dz) === true) count++;
    this.observation.verifiedCaps = count;
    return count;
  }

  private async legs(live: any, now: number): Promise<void> {
    this.guard(true);
    this.observation.stareEndedAt ??= this.observation.stareAt === null ? null : now;
    const turned = await guard(this.ctx, Promise.resolve(this.ctx.bot.lookAt(live.position.offset(0, ENDERMAN_LEGS, 0), true)), 300);
    if (turned) this.observation.legsAt ??= now;
  }

  /** Rechecked by fight after turning, since the same target may teleport during the turn. */
  strikePoint(live: any): Vec3 | null {
    if (!atRoofCentre(this.ctx.bot.entity.position, this.standing)) return null;
    const angry = !!this.angeredAt || endermanAngry(this.ctx.bot.registry, live);
    return endermanStrikePoint(bodyReader(this.ctx.bot), this.ctx.bot.entity.position, live.position, angry ? ENDERMAN_ANGRY_STRIKE_HEIGHTS : undefined);
  }

  /** The roof and the anger, as the line tells them. */
  describe(angry: boolean): string {
    const roof = this.plan.placements.length ? `屋根 ${this.laid}/${this.plan.placements.length}` : '屋根は既にある';
    const verified = this.observation.verifiedCaps === 9 ? `・天井9/9・仮柱撤去 ${this.observation.supportsRemoved}` : '';
    const shifts = this.observation.recovery;
    const exits = this.observation.exits;
    const exitResult = { moving: '外へ移動中', staring: '注視中', returning: '中央へ戻り中', returned: '中央へ戻った', stopped: '中断' };
    return `${roof}・${this.angeredAt ? '怒らせた' : angry ? '怒っている' : '怒っていない'}${verified}${shifts.length ? `・屋根内の微動 ${shifts.length}/${RECOVERY_LIMIT}（${shifts[shifts.length - 1].result}）` : ''}${exits.length ? `・屋根外の注視 ${exits.length}/${ROOF_EXIT_LIMIT}（${exitResult[exits[exits.length - 1].result]}）` : ''}`;
  }

  private observe(live: any, now: number): CampObservation {
    const bot = this.ctx.bot;
    const position = bot.entity.position;
    const view = { ...endermanView(bodyReader(bot), position, live.position), position: { x: position.x, y: position.y, z: position.z },
      targetPosition: { x: live.position.x, y: live.position.y, z: live.position.z },
      targetId: this.targetId, phase: this.phase, at: now };
    this.observation.latest = view;
    if (atRoofCentre(position, this.cell)) this.observation.afterBuild ??= view;
    return view;
  }

  private stopShift(): void {
    if (!this.shift) return;
    for (const name of ['forward', 'sneak']) { try { this.ctx.bot.setControlState(name, false); } catch { /* release even after cancellation */ } }
    const last = this.observation.recovery[this.observation.recovery.length - 1];
    if (last?.result === 'moving') last.result = 'stopped';
    this.shift = null;
  }

  private shiftOccupied(to: Cell): boolean {
    const bot = this.ctx.bot;
    return roofCellOccupied(Object.values(bot.entities ?? {}), bot.entity.id, to);
  }

  private stopExitMotion(): void {
    for (const name of ['forward', 'sneak']) { try { this.ctx.bot.setControlState(name, false); } catch { /* lease ended */ } }
  }

  private stopExit(): void {
    if (!this.exit) return;
    this.stopExitMotion();
    const last = this.observation.exits[this.observation.exits.length - 1];
    if (last.result !== 'returned') last.result = 'stopped';
    this.exit = null;
  }

  private exitOccupied(to: Cell, destination: Cell): boolean {
    const p = this.ctx.bot.entity.position, alongX = to.x !== this.cell.x;
    const start = Math.floor(alongX ? p.x : p.z), end = alongX ? destination.x : destination.z;
    for (let i = 0; i <= 2; i++) {
      const c = { x: this.cell.x + (to.x - this.cell.x) * i / 2, y: this.cell.y, z: this.cell.z + (to.z - this.cell.z) * i / 2 };
      const along = alongX ? c.x : c.z;
      if (along >= Math.min(start, end) && along <= Math.max(start, end) && this.shiftOccupied(c)) return true;
    }
    return false;
  }

  /**
   * Whether the step out from under the roof may be taken and, when not, why in words for the stop (end1108h29: about eight not_visible stops all read
   * 屋根外の注視 0/2 and nothing said why the step was never tried). why null with no `to`: the eyes are already clear.
   */
  private exitRefusal(live: any, view: CampObservation): { why: string | null; to?: Cell } {
    if (this.angeredAt) return { why: '怒らせた後' };
    if (this.observation.stareEndedAt !== null) return { why: '注視は済んだ' };
    if (this.exitStare === this.restares) return { why: 'この注視では出た後' };
    if (this.observation.exits.length >= ROOF_EXIT_LIMIT) return { why: '回数の上限' };
    if (!atRoofCentre(this.ctx.bot.entity.position, this.cell)) return { why: '屋根の中央にいない' };
    if (view.eyes.clear) return { why: null };
    const read = bodyReader(this.ctx.bot);
    const to = roofExitForSight(read, this.cell, live.position, view.eyes, c => this.shiftOccupied(c))[0];
    if (!to) {
      const anchor = this.cell;
      const cap = view.eyes.between.some(({ at }) => at.y === anchor.y + 2 && Math.abs(at.x - anchor.x) <= 1 && Math.abs(at.z - anchor.z) <= 1);
      const terrain = view.eyes.between.some(({ at }) => Math.abs(at.x - anchor.x) > 2 || Math.abs(at.z - anchor.z) > 2);
      if (!cap && !terrain) return { why: '線を塞ぐのは屋根の脚か 2 マス内の物で、外へ一歩出ても変わらない' };
      const steps = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([x, z]) => ({ x: anchor.x + x, y: anchor.y, z: anchor.z + z }));
      const walkable = steps.filter(c => roofExitStep(read, anchor, c));
      if (!walkable.length) return { why: '4 方向の 2 マス先に、平らな床と空いた通り道が無い' };
      const seeing = walkable.filter(c => endermanLine(read, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, live.position, ENDERMAN_EYE).clear);
      if (!seeing.length) return { why: `出られる ${walkable.length} 方向のどこからも目が見えない` };
      return { why: '出口の通り道に別の生き物' };
    }
    // Out from under the roof only while the way back is shorter than any coming (Codex's pre-deploy review 5, 11/5): the target at least EXIT_MIN_GAP off
    // the exit cell, and no other enderman or hostile already near it.
    const exitAt = new Vec3(to.x + 0.5, to.y, to.z + 0.5);
    if (live.position.distanceTo(exitAt) < EXIT_MIN_GAP) return { why: `対象が出口から ${EXIT_MIN_GAP}m 内` };
    const bot = this.ctx.bot;
    if ((Object.values(bot.entities ?? {}) as any[]).some(e => e && e.id !== this.targetId && e !== bot.entity && e.position && e.isValid !== false
      && (e.name === 'enderman' || isHostileEntity(e, bot)) && e.position.distanceTo(exitAt) < EXIT_CLEAR)) return { why: `出口の ${EXIT_CLEAR}m 内に別の敵` };
    return { why: null, to };
  }

  /** Before confirmed anger, a clear exit ray may go round a cap or terrain hiding this same target. */
  private startExit(live: any, view: CampObservation, now: number): boolean {
    const refusal = this.exitRefusal(live, view);
    if (refusal.why !== null || !refusal.to) { this.exitRefused = refusal.why; return false; }
    this.exitRefused = null;
    const to = refusal.to;
    this.exitStare = this.restares;
    this.exit = { to, stage: 'out', at: now };
    this.observation.exits.push({ from: { ...this.cell }, to, at: now, result: 'moving', reason: null });
    return true;
  }

  private async returnFromExit(live: any, now: number, reason: 'angry' | 'stared' | 'not_visible' | 'near'): Promise<void> {
    if (!this.exit || this.exit.stage === 'back') return;
    this.stopExitMotion();
    this.exit.stage = 'back'; this.exit.at = now;
    const last = this.observation.exits[this.observation.exits.length - 1];
    last.result = 'returning'; last.reason = reason;
    await this.legs(live, now);
  }

  /** Out, a short stationary stare, then the same straight corridor back. Combat is withheld until the original centre is verified. */
  private async advanceExit(live: any, now: number): Promise<CampStep | null> {
    try { return await this.stepExit(live, now); }
    catch { return this.exitStuck('屋根外の注視から中央へ戻る操作を続けられなかった'); }
  }

  /**
   * The straight way back is gone (pushed off it, something in it, the step ran out): the roof centre is walked to once by the walk (no dig, no block laid,
   * HOME_WALK_MS) before the hand stops; an angry enderman is not waited out in the open (Codex's pre-deploy review 5, 11/5). Null: home again, the camp goes on.
   */
  private async exitStuck(text: string): Promise<CampStep | null> {
    const bot = this.ctx.bot, last = this.observation.exits[this.observation.exits.length - 1];
    this.stopExitMotion(); this.guard(true);
    if (!reflexHeld(bot) && !this.ctx.stop.aborted && Date.now() + 500 < this.ctx.deadline) {
      const navigator = bot.pathfinder, previous = navigator?.movements;
      try {
        navigator?.setMovements(walkMovements(bot, false));
        await goWith(this.ctx, new goals.GoalBlock(this.cell.x, this.cell.y, this.cell.z), Math.min(HOME_WALK_MS, Math.max(500, this.ctx.deadline - Date.now())), { opened: [], leaves: 0 });
      } catch { /* judged by where the feet are */ }
      finally { letGo(bot); try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
      const feet = feetCell(bot);
      if (feet && feet.x === this.cell.x && feet.y === this.cell.y && feet.z === this.cell.z) {
        if (last) { last.result = 'returned'; last.homeWalk = 'arrived'; }
        this.stopExit(); this.standing = this.cell;
        return null;
      }
    }
    if (last) last.homeWalk = 'failed';
    return this.failure('roof_failed', 'moved', `${text}。屋根の中央 ${cellText(this.cell)} へ歩いても戻れなかった`, feetCell(bot) ?? this.cell);
  }

  private async stepExit(live: any, now: number): Promise<CampStep | null> {
    const exit = this.exit;
    if (!exit) return null;
    const bot = this.ctx.bot, p = bot.entity.position;
    if (this.angeredAt) await this.returnFromExit(live, now, 'angry');
    // The target coming near while the body is out: back at once, angry or not (the way back takes about 1.5 s).
    else if (exit.stage !== 'back' && live.position.distanceTo(p) < EXIT_ABORT) await this.returnFromExit(live, now, 'near');
    if (exit.stage === 'out' && (now - exit.at >= ROOF_EXIT_STEP_MS || now - this.blindSince > SIGHT_MS)) {
      await this.returnFromExit(live, now, 'not_visible');
    }
    const alongX = exit.to.x !== this.cell.x;
    const along = alongX ? p.x : p.z, across = alongX ? p.z : p.x;
    const a = (alongX ? this.cell.x : this.cell.z) + 0.5, b = (alongX ? exit.to.x : exit.to.z) + 0.5;
    let destination = exit.stage === 'back' ? this.cell : exit.to;
    if (reflexHeld(bot) || bot.entity.onGround !== true || Math.abs(p.y - this.cell.y) > 0.1
      || along < Math.min(a, b) - 0.15 || along > Math.max(a, b) + 0.15
      || Math.abs(across - ((alongX ? this.cell.z : this.cell.x) + 0.5)) > 0.2
      || !roofExitStep(bodyReader(bot), this.cell, exit.to) || this.exitOccupied(exit.to, destination)) {
      return this.exitStuck('屋根外の注視から中央へ戻る平らな道・立ち位置を確認できない');
    }
    if (exit.stage === 'back' && atRoofCentre(p, this.cell)) {
      this.observation.exits[this.observation.exits.length - 1].result = 'returned';
      this.stopExit(); this.standing = this.cell;
      // Only an interrupted stare gets the already bounded retry. A completed stare is never repeated.
      if (!this.angeredAt && this.staredSince && this.observation.stareEndedAt !== null
        && this.observation.stareEndedAt - this.staredSince < ENDERMAN_STARE_MS && this.restares < 1) {
        this.restares++; this.staredSince = 0; this.observation.stareEndedAt = null;
      }
      this.observe(live, now);
      return null;
    }
    if (exit.stage === 'out' && atRoofCentre(p, exit.to)) {
      this.stopExitMotion(); exit.stage = 'stare';
      this.observation.exits[this.observation.exits.length - 1].result = 'staring';
    }
    if (exit.stage === 'stare') {
      const view = this.observe(live, now);
      if (!view.eyes.clear || now - this.blindSince > SIGHT_MS) await this.returnFromExit(live, now, 'not_visible');
      else if (this.staredSince && now - this.staredSince >= ENDERMAN_STARE_MS) await this.returnFromExit(live, now, 'stared');
      else {
        this.staredSince ||= now; this.observation.stareAt ??= now; this.guard(false);
        try {
          const turned = await guard(this.ctx, Promise.resolve(bot.lookAt(live.position.offset(0, ENDERMAN_EYE, 0), true)), 300);
          if (!turned) await this.returnFromExit(live, now, 'not_visible');
        }
        catch { await this.returnFromExit(live, now, 'not_visible'); }
        return { kind: 'wait' };
      }
    }
    destination = exit.stage === 'back' ? this.cell : exit.to;
    if (now - exit.at >= ROOF_EXIT_STEP_MS) return this.exitStuck('屋根外の注視の一歩を終えて中央へ戻れなかった');
    this.guard(true);
    this.stopExitMotion();
    const turned = await guard(this.ctx, Promise.resolve(bot.lookAt(new Vec3(destination.x + 0.5, p.y + 1.62, destination.z + 0.5), true)), 300);
    if (!turned || reflexHeld(bot) || this.ctx.stop.aborted || Date.now() >= this.ctx.deadline
      || !roofExitStep(bodyReader(bot), this.cell, exit.to) || this.exitOccupied(exit.to, destination)) return this.exitStuck('屋根外の注視から中央へ向き直れなかったか、戻る道が変わった');
    if (exit.stage === 'out' && endermanAngry(bot.registry, live)) {
      await this.returnFromExit(live, now, 'angry');
      return { kind: 'wait' };
    }
    bot.setControlState('sprint', false); bot.setControlState('jump', false);
    bot.setControlState('sneak', true); bot.setControlState('forward', true);
    return { kind: 'wait' };
  }

  /** Starts only for a roof block on this target's eye ray and an already protected adjacent cell with a clear eye ray. */
  private recover(live: any, view: CampObservation, now: number): boolean {
    if (this.recoveryEnded || this.observation.recovery.length >= RECOVERY_LIMIT
      || (this.recoveryBegan && now - this.recoveryBegan >= RECOVERY_MS)) return false;
    const first = view.eyes.between[0];
    if (!first || Math.abs(first.at.x - this.cell.x) > 2 || Math.abs(first.at.z - this.cell.z) > 2
      || first.at.y < this.cell.y || first.at.y > this.cell.y + 2
      || !(first.name === 'cobblestone' || this.plan.placements.some(c => c.x === first.at.x && c.y === first.at.y && c.z === first.at.z))) return false;
    const read = bodyReader(this.ctx.bot), from = this.standing, position = view.position;
    // Start near a cell centre. The swept body must remain within the two verified columns.
    if (Math.abs(position.x - (from.x + 0.5)) > 0.2 || Math.abs(position.z - (from.z + 0.5)) > 0.2) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const to = { x: from.x + dx, y: from.y, z: from.z + dz };
      if (!roofInteriorStep(read, this.cell, from, to) || this.shiftOccupied(to)) continue;
      const next = endermanView(read, { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, live.position);
      if (!next.eyes.clear) continue;
      this.recoveryBegan ||= now;
      this.recoveryBlocker = view.eyes;
      this.shift = { from: { ...from }, to, at: now };
      this.observation.recovery.push({ from: { ...from }, to, at: now, result: 'moving' });
      return true;
    }
    return false;
  }

  /** A single straight, sneaking step; never hand a goal to a pathfinder that could leave the roof to go round a support. */
  private moveShift(now: number): void {
    const shift = this.shift;
    if (!shift) return;
    const bot = this.ctx.bot, p = bot.entity.position, { from, to } = shift;
    const alongX = from.x !== to.x;
    const along = alongX ? p.x : p.z, across = alongX ? p.z : p.x;
    const a = (alongX ? from.x : from.z) + 0.5, b = (alongX ? to.x : to.z) + 0.5;
    if (now - shift.at >= RECOVERY_STEP_MS || now - this.recoveryBegan >= RECOVERY_MS || now >= this.ctx.deadline
      || this.ctx.stop.aborted || reflexHeld(bot) || bot.entity.onGround !== true || Math.abs(p.y - from.y) > 0.1
      || along < Math.min(a, b) - 0.15 || along > Math.max(a, b) + 0.15 || Math.abs(across - ((alongX ? from.z : from.x) + 0.5)) > 0.2
      || !roofInteriorStep(bodyReader(bot), this.cell, from, to) || this.shiftOccupied(to)) {
      this.recoveryEnded = true; this.stopShift(); return;
    }
    if (Math.abs(along - b) < 0.12) {
      this.observation.recovery[this.observation.recovery.length - 1].result = 'arrived';
      this.standing = to; this.stopShift(); return;
    }
    try { void Promise.resolve(bot.lookAt(new Vec3(to.x + 0.5, p.y + 1.62, to.z + 0.5), true)).catch(() => undefined); } catch { this.recoveryEnded = true; this.stopShift(); return; }
    const dx = to.x + 0.5 - p.x, dz = to.z + 0.5 - p.z;
    const dot = (-Math.sin(bot.entity.yaw) * dx - Math.cos(bot.entity.yaw) * dz) / Math.hypot(dx, dz);
    bot.setControlState('sprint', false); bot.setControlState('jump', false);
    bot.setControlState('sneak', true); bot.setControlState('forward', dot > 0.98);
  }

  private notVisible(view: CampObservation, now: number, box: number): CampStep {
    this.guard(true); this.staredSince = 0; this.blindSince ||= now;
    const line = this.recoveryEnded && view.eyes.clear ? this.recoveryBlocker ?? view.eyes : view.eyes, first = line.between[0];
    if (now - this.blindSince > SIGHT_MS || this.recoveryEnded) {
      // The step out may never have been weighed (the recovery under the roof held every tick): weigh it now, for the words only.
      if (this.exitRefused === null && !this.observation.exits.length && !view.eyes.clear) {
        const live = this.ctx.bot.entities?.[this.targetId] ?? this.target;
        try { if (live?.position) this.exitRefused = this.exitRefusal(live, view).why ?? '出られた（屋根内の微動を先に使い切った）'; } catch { /* words only */ }
      }
      // The own cap hides the eyes and no step out sees them: this target cannot be had from this roof. The way on first, the cause kept whole.
      const anchor = this.cell;
      const capHides = !!first && first.at.y === anchor.y + 2 && Math.abs(first.at.x - anchor.x) <= 1 && Math.abs(first.at.z - anchor.z) <= 1;
      const live = this.ctx.bot.entities?.[this.targetId] ?? this.target;
      if (capHides && this.exitRefused && !this.exitRefused.startsWith('出られた') && live?.position) {
        const at = { x: Math.floor(live.position.x), y: Math.floor(live.position.y + 1e-3), z: Math.floor(live.position.z) };
        noteHiddenFromRoof(this.ctx.bot, this.targetId, anchor, at, now);
        const cause = `自分の屋根の蓋 ${cellText(first.at)} が #${this.targetId} の目（屋根の床より ${(live.position.y + ENDERMAN_EYE - anchor.y).toFixed(1)} 上・${box.toFixed(1)}m）を隠し、屋根の外へは: ${this.exitRefused}`;
        return { kind: 'stop', outcome: { ...this.failureOutcome('not_visible', hiddenFromRoofWords(this.targetId, anchor, `${now - this.blindSince}ms 見た・微動 ${this.observation.recovery.length}/${RECOVERY_LIMIT}・屋根外の注視 ${this.observation.exits.length}/${ROOF_EXIT_LIMIT}`), feetCell(this.ctx.bot) ?? anchor, cause), code: 'enderman_not_visible' } };
      }
      return this.failure('enderman_not_visible', 'not_visible', `エンダーマンの目が見えない（${now - this.blindSince}ms/${SIGHT_MS}ms。間に ${first ? `${cellText(first.at)} ${first.name} ほか ${line.between.length - 1}` : 'なし'}。${box.toFixed(1)}m。対象 #${this.targetId}、微動 ${this.observation.recovery.length}/${RECOVERY_LIMIT}、屋根外の注視 ${this.observation.exits.length}/${ROOF_EXIT_LIMIT}${this.exitRefused ? `、出ない理由: ${this.exitRefused}` : ''}）。屋根内で線を戻せない`, feetCell(this.ctx.bot) ?? this.cell);
    }
    return { kind: 'wait' };
  }

  private failure(code: string, reason: string, text: string, at?: Cell): CampStep {
    return { kind: 'stop', outcome: { ...this.failureOutcome(reason, text, at), code } };
  }

  private failureOutcome(reason: string, text: string, at?: Cell, cause?: string): StepOutcome {
    this.stopShift(); this.stopExit(); this.guard(true);
    return stopped(this.ctx.bot, reason, text, at, undefined, cause);
  }

  /** One step of the camp. `box` is the distance to the enderman's box, `angry` its `creepy` flag. */
  async advance(live: any, now: number, box: number, angry: boolean): Promise<CampStep> {
    const bot = this.ctx.bot;
    angry ||= endermanAngry(bot.registry, live);
    if (live?.id !== this.targetId || live?.isValid === false || !live?.position) return this.failure('target_lost', 'lost', `対象 #${this.targetId} が見えない。同じ対象以外へ乗り換えない`);
    if (this.ctx.stop.aborted || now >= this.ctx.deadline) return this.failure('limit_time', 'limit_time', '狩りの停止・期限に達した');
    if (angry && this.exit) this.stopExitMotion();
    if (angry && !this.angeredAt) { this.angeredAt = now; this.observation.angryAt = now; await this.legs(live, now); }

    if (this.phase === 'build') {
      // A close angry target may interrupt building only before any temporary support stands.
      if (angry && box <= CONTACT) return this.temporary.size
        ? this.failure('roof_failed', 'support_unsafe', '仮の柱が残っているため戦闘へ進めない。敵対中は柱を掘らない', this.cell)
        : { kind: 'fight' };
      if (now - this.began > BUILD_MS) return this.failure('roof_failed', 'build_stalled', `屋根を ${BUILD_MS / 1000} 秒で建て終えられなかった（${this.laid}/${this.plan.placements.length}）。場所を変えるか、ブロックを増やして呼び直す`, this.cell);
      // Preserve the existing pre-placement replan if pushed into another cell; once anything is laid, never relocate the plan.
      const feet = feetCell(bot);
      if (feet && (feet.x !== this.cell.x || feet.z !== this.cell.z || feet.y !== this.cell.y)) {
        if (this.laid > 0 || this.replans > 1) return this.failure('roof_failed', 'moved', `屋根を建てている間に ${cellText(this.cell)} から ${cellText(feet)} へ動かされた（${this.laid}/${this.plan.placements.length}）`, feet);
        this.cell = feet; this.standing = feet; this.observation.roofCell = { ...feet }; this.plan = this.planFrom(feet); this.replans++;
        if (this.plan.problems.length) return this.failure('no_site', 'no_site', `ここには屋根の穴を作れない: ${this.plan.problems.join('。')}`, feet);
        return { kind: 'wait' };
      }
      const centring = await this.centre(now, angry);
      if (centring) return centring;
      const left = this.remaining();
      if (!left.length) {
        if (this.capsStanding() !== 9) return this.failure('roof_failed', 'roof_incomplete', '下面2mの屋根9個を確認できない', this.cell);
        const temporary = [...this.temporary.entries()].reverse()[0];
        if (temporary) {
          const [key, support] = temporary, block = bot.blockAt(new Vec3(support.cell.x, support.cell.y, support.cell.z), false);
          if (!block || (block.boundingBox === 'block' && block.name !== support.name)) return this.failure('roof_failed', 'support_changed', '仮の柱が変化したため撤去を止めた', support.cell);
          if (block.boundingBox === 'block') {
            if (angry) return this.failure('roof_failed', 'support_unsafe', '敵対中は仮の柱を掘らない', support.cell);
            const removed = await removeRoofSupport(this.ctx, this.cell, support.cell, live, this.began + BUILD_MS);
            if (!removed.ok) return this.failure('roof_failed', 'support_not_removed', `仮の柱を外せない: ${removed.text}`, support.cell);
            this.observation.supportsRemoved++;
          }
          forgetRoofLaid(bot, support.cell);
          this.temporary.delete(key);
          return { kind: 'wait' };
        }
        this.phase = angry ? 'hold' : 'provoke'; this.observe(live, now); return { kind: 'wait' };
      }
      const next = left[0];
      const k = `${next.x},${next.y},${next.z}`;
      const tried = this.tries.get(k) ?? 0;
      if (tried >= CELL_TRIES) {
        const again = this.replans < 2 ? this.planFrom(this.cell) : null;
        if (again && !again.problems.length && again.placements.length) { this.plan = again; this.tries.clear(); this.replans++; return { kind: 'wait' }; }
        return this.failure('roof_failed', 'not_placed', `屋根の ${cellText(next)} に置けない（${this.laid}/${this.plan.placements.length}）`, next);
      }
      this.tries.set(k, tried + 1);
      // Each cell takes whatever roof kind is in hand (end1109p09: kinds mixed).
      if (!this.block || inventoryCount(bot, this.block.name) < 1) this.block = roofBlockFor(bot, 1);
      if (!this.block || inventoryCount(bot, this.block.name) < 1) return this.failure('roof_failed', 'missing_item', `屋根の途中でブロックが尽きた（${this.laid}/${this.plan.placements.length}）`, next);
      const result = await place(this.ctx, { block: this.block.name, at: [next] });
      if (result.ok) {
        this.laid++;
        noteRoofLaid(bot, next, this.block.name);
        if (next.y === this.cell.y + 2 && Math.abs(next.x - this.cell.x) <= 1 && Math.abs(next.z - this.cell.z) <= 1) this.observation.capsPlaced++;
        if (this.plan.supports.some(c => c.x === next.x && c.y === next.y && c.z === next.z)) this.temporary.set(k, { cell: next, name: this.block.name });
      }
      else await wait(this.ctx, 120);
      return { kind: 'wait' };
    }

    if (this.phase === 'provoke' && angry) { this.phase = 'hold'; this.guard(true); this.blindSince = 0; }
    if (this.exit) {
      const step = await this.advanceExit(live, now);
      if (step) return step;
    }
    // A missing/reset flag after confirmed anger is not permission to stare at this same nearby target again.
    let view = this.observe(live, now);
    // Once angered, stop the recovery turn immediately and hold the verified swept space.
    if (this.shift && angry) {
      const feet = feetCell(bot), { from, to } = this.shift;
      if (!feet || ![from, to].some(c => c.x === feet.x && c.y === feet.y && c.z === feet.z)
        || !roofInteriorStep(bodyReader(bot), this.cell, from, to) || !roofInterior(bodyReader(bot), this.cell, feet)) {
        return this.failure('roof_failed', 'moved', '微動中に確認した屋根内の道から動かされた', feet ?? this.cell);
      }
      this.standing = feet; this.stopShift();
    }
    if (this.shift) {
      this.guard(true);
      this.moveShift(now);
      view = this.observe(live, now);
      if (this.shift) return this.notVisible(view, now, box);
      if (this.recoveryEnded) return this.notVisible(view, now, box);
    }
    if (this.phase === 'hold') {
      const reached = this.stepToReach(live, now, box, angry);
      if (reached) return reached;
    }
    const feet = feetCell(bot);
    if (!feet || feet.x !== this.standing.x || feet.y !== this.standing.y || feet.z !== this.standing.z) return this.failure('roof_failed', 'moved', '屋根内の確認した立ち位置から動かされた', feet ?? this.cell);
    const centring = await this.centre(now, angry);
    if (centring) return centring;
    if (this.capsStanding() !== 9) return this.failure('roof_failed', 'roof_incomplete', '屋根9個の保護が失われた', this.cell);

    if (this.phase === 'provoke') {
      // The roof can hide the eyes again after returning. A finished exterior stare still waits only for anger, looking at legs.
      if (this.staredSince && this.observation.stareEndedAt !== null && this.observation.stareEndedAt - this.staredSince >= ENDERMAN_STARE_MS) {
        await this.legs(live, now);
        if (now - this.staredSince >= ENDERMAN_STARE_MS + ANGER_ACK_MS) return this.failure('enderman_not_angry', 'not_provoked', `約0.5秒目を見ても敵対を確認できない（${box.toFixed(1)}m）。同じ場所で目を見続けない`, this.cell);
        return { kind: 'wait' };
      }
      if (!view.eyes.clear) {
        // Losing sight ends the stare, but must not consume the branch for the bounded recovery (including its return step).
        if (this.staredSince) {
          await this.legs(live, now);
          // A stare cut short by the line (not a finished one) may be taken once more after the bounded recovery; a finished stare is never repeated.
          if (now - this.staredSince < ENDERMAN_STARE_MS && this.restares < 1 && this.observation.angryAt === null) {
            this.restares++; this.staredSince = 0; this.observation.stareEndedAt = null;
          }
        }
        this.blindSince ||= now;
        // Under the roof first (a step inside it), out past its edge only when that finds no line (Codex's pre-deploy review 5, 11/5).
        if (now - this.blindSince <= SIGHT_MS && this.recover(live, view, now)) this.moveShift(now);
        else if (now - this.blindSince <= SIGHT_MS && this.startExit(live, view, now)) return (await this.advanceExit(live, now)) ?? { kind: 'wait' };
        return this.notVisible(view, now, box);
      }
      if (this.observation.stareEndedAt !== null || (this.staredSince && now - this.staredSince >= ENDERMAN_STARE_MS)) {
        await this.legs(live, now);
        if (now - this.staredSince >= ENDERMAN_STARE_MS + ANGER_ACK_MS) return this.failure('enderman_not_angry', 'not_provoked', `約0.5秒目を見ても敵対を確認できない（${box.toFixed(1)}m）。同じ場所で目を見続けない`, this.cell);
        return { kind: 'wait' };
      }
      this.blindSince = 0;
      this.staredSince ||= now;
      this.observation.stareAt ??= now;
      this.guard(false);
      try { void Promise.resolve(bot.lookAt(live.position.offset(0, ENDERMAN_EYE, 0), true)).catch(() => undefined); } catch { /* the port is no longer ours */ }
      return { kind: 'wait' };
    }

    // hold delegates range, sight and prolonged obstruction to the existing fight loop. The observed route is not a prerequisite for teleporting here.
    await this.legs(live, now);
    return { kind: 'fight' };
  }
}

/** A roof site and how many endermen's eyes are seen from it. */
/**
 * Where to dig the blocks a roof lacks, after the shortage words: the nearest bare netherrack within 6 m. h28 (11/8): the 128 cobblestone of the kit
 * were gone after 16 minutes of roofs and pillars, and the planner, told only "8 blocks needed, you have netherrack×2", stood in a netherrack world and
 * called fight again five times. Netherrack breaks almost at once with an iron or diamond pickaxe.
 */
// end1109p09 (11/9, warped forest): the floor was warped_nylium and the trees wart blocks; only netherrack was looked for, so the line named one cell
// 7 m off again and again. Nylium dug without silk touch drops netherrack; a wart block drops itself and the roof takes it.
const ROOF_SOURCES = new Set(['netherrack', 'warped_nylium', 'crimson_nylium', 'warped_wart_block', 'nether_wart_block']);
const sourceWord = (name: string) => /nylium$/u.test(name) ? `${name}（掘ると netherrack）` : name;
export function netherrackNear(bot: any, short: number): string {
  const here = feetCell(bot);
  if (!here || short <= 0) return '';
  const read = bodyReader(bot);
  let best: { cell: Cell; d: number; name: string } | null = null;
  for (let dx = -6; dx <= 6; dx++) for (let dy = -3; dy <= 4; dy++) for (let dz = -6; dz <= 6; dz++) {
    const cell = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
    const name = String(read(cell.x, cell.y, cell.z)?.name ?? '');
    if (!ROOF_SOURCES.has(name)) continue;
    const bare = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => read(cell.x + x, cell.y + y, cell.z + z)?.solid === false);
    if (!bare) continue;
    const d = Math.hypot(dx, dy - 1, dz);
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && name === 'netherrack')) best = { cell, d, name };
  }
  // end1109p10: her own roofs left after failed fights come first: in reach, at the head of the cells to dig; farther (within 32 m), where they stand.
  const own = bot.entity?.position ? ownRoofLeft(bot, read, here) : [];
  const eye = bot.entity?.position?.offset(0, 1.62, 0);
  const bare = (cell: Cell) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => read(cell.x + x, cell.y + y, cell.z + z)?.solid === false);
  const eyeD = (cell: Cell) => eye ? Math.hypot(cell.x + 0.5 - eye.x, cell.y + 0.5 - eye.y, cell.z + 0.5 - eye.z) : Infinity;
  const ownReach = own.filter(cell => eyeD(cell) <= 4.5 && bare(cell)).sort((a, b) => eyeD(a) - eyeD(b)).slice(0, Math.min(short + 2, 16));
  const ownFar = farOwnRoof(own.filter(cell => !ownReach.includes(cell)), here);
  const farWords = ownFar ? `。前に自分で張った屋根の ${ownFar.n} 個が ${cellText(ownFar.cell)}（${ownFar.d.toFixed(0)}m）に残る（寄れば dig 1 手で回収）` : '';
  if (!best && !ownReach.length) return ownFar ? farWords : '。6m 内に掘れる netherrack は見えない';
  // end1108h29 (11/8): the head dug one far cell at a time and 7 roofs stopped missing_item (about 154 s); the drops of cells dug out of a
  // stand's reach fell into the nylium. The cells the hand reaches from here, in one dig (dig picks up what falls within 2.5 m of a dug cell).
  const rest = best && bot.entity?.position ? reachableNetherrack(bot, read, here, Math.max(0, Math.min(short + 2, 16) - ownReach.length)) : [];
  const reach = [...ownReach, ...rest];
  const names = [...new Set(rest.map(cell => String(read(cell.x, cell.y, cell.z)?.name ?? '')))];
  const label = [...(ownReach.length ? ['前に自分で張った屋根'] : []), ...names].join('・');
  // At most 8 cells named: the line is cut at its end and a cell cut in half is worse than none.
  const reachWords = `。ここから手の届く ${label} ${reach.length} マスを 1 手で: dig の at に ${reach.slice(0, 8).map(cellText).join('・')}（落ちた分は dig が拾う。ツルハシですぐ掘れる）`;
  if (reach.length >= Math.min(short, 4) || ownReach.length) return reachWords;
  const near = `。近くの ${sourceWord(best!.name)} ${cellText(best!.cell)}（${best!.d.toFixed(1)}m）などを dig で ${short} 個以上掘ってから（ツルハシですぐ掘れる）`;
  // A left roof that alone covers the shortage is one walk and one dig; it leads.
  return ownFar && ownFar.n >= short ? `${farWords}${near}` : `${near}${farWords}`;
}
/** The nearest of her own left roof blocks within 32 m, and how many stand within 3 of it (one roof's worth). */
function farOwnRoof(own: Cell[], here: Cell): { cell: Cell; d: number; n: number } | null {
  let nearest: { cell: Cell; d: number } | null = null;
  for (const cell of own) {
    const d = Math.hypot(cell.x - here.x, cell.y - here.y, cell.z - here.z);
    if (d <= 32 && (!nearest || d < nearest.d)) nearest = { cell, d };
  }
  if (!nearest) return null;
  const at = nearest.cell;
  return { ...nearest, n: own.filter(c => Math.max(Math.abs(c.x - at.x), Math.abs(c.y - at.y), Math.abs(c.z - at.z)) <= 3).length };
}
/** Netherrack the hand reaches from where the body stands (eye within 4.5 m, a face bare), never the floor under the 3x3 about the feet; nearest first. */
function reachableNetherrack(bot: any, read: BlockReader, here: Cell, limit: number): Cell[] {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const found: Array<{ cell: Cell; d: number }> = [];
  for (let dx = -5; dx <= 5; dx++) for (let dy = -4; dy <= 5; dy++) for (let dz = -5; dz <= 5; dz++) {
    if (dy < 0 && Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue;
    const cell = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
    const d = Math.hypot(cell.x + 0.5 - eye.x, cell.y + 0.5 - eye.y, cell.z + 0.5 - eye.z);
    if (d > 4.5 || !ROOF_SOURCES.has(String(read(cell.x, cell.y, cell.z)?.name ?? ''))) continue;
    if (![[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => read(cell.x + x, cell.y + y, cell.z + z)?.solid === false)) continue;
    found.push({ cell, d });
  }
  return found.sort((a, b) => a.d - b.d).slice(0, limit).map(f => f.cell);
}
export interface EndermanRoofSite { cell: Cell; blocks: number; distance: number; seen: number; seenIds: number[]; open: number; above: number }
/** The world as it reads once the roof over `cell` is complete (its temporary supports gone), or null when no roof can be planned there. */
function completedRoof(world: RoofWorld, read: BlockReader, cell: Cell): { plan: ReturnType<typeof planRoof>; future: BlockReader } | null {
  const plan = planRoof(world, cell, undefined, undefined, true);
  if (plan.problems.length) return null;
  const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
  const temporary = new Set(plan.supports.map(key));
  const completed = new Set(plan.placements.filter(c => !temporary.has(key(c))).map(key));
  return { plan, future: (x, y, z) => completed.has(`${x},${y},${z}`) ? { name: 'cobblestone', solid: true, top: 1 } : read(x, y, z) };
}
/**
 * The roof the body would lay where it stands, before any is laid: the endermen (of `entities`) whose eyes its completed roof would see (from the
 * centre or a step out, as probe kind=roofsite counts them), and its openness. Null when no roof can be planned here. Why: end1109p08b (11/9, warped
 * forest) walked to the site the stop line named 10 times and `fight target=enderman` stopped there at once each time (no eyes from the bare spot;
 * the site's count was from the roof's step out), 680 s without a kill.
 */
export function roofHereSight<T extends { id: number; position: any }>(bot: any, entities: T[]): { seen: T[]; open: number } | null {
  const here = feetCell(bot);
  if (!here) return null;
  const done = completedRoof(roofWorldOf(bot), bodyReader(bot), here);
  if (!done) return null;
  const all = Object.values(bot.entities ?? {});
  const from = { x: here.x + 0.5, y: here.y, z: here.z + 0.5 };
  const ids = new Set(huntCandidates(done.future, from, entities as any[], here, cell => roofCellOccupied(all, bot.entity.id, cell)).map(e => Number(e.id)));
  return { seen: entities.filter(e => ids.has(Number(e.id))), open: roofSiteOpenness(done.future, here) };
}
/**
 * How open a roof site is: the share (0-100) of eye lines from the completed roof to an enderman's eye height at 12 and 24 m in 16 directions that no
 * block cuts. Why: the count of eyes seen now is a snapshot of wanderers (end1109p02, warped forest: the best site saw 1 of 9, and 17 of the first
 * 21 fights found no eyes in sight); a clearing keeps bringing them into view, which is what a hunter picks a spot for.
 */
const OPEN_DISTANCES = [12, 24], OPEN_DIRECTIONS = 16;
export function roofSiteOpenness(read: BlockReader, cell: Cell): number {
  const from = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
  let clear = 0, all = 0;
  for (let i = 0; i < OPEN_DIRECTIONS; i++) {
    const a = (i / OPEN_DIRECTIONS) * Math.PI * 2;
    for (const d of OPEN_DISTANCES) {
      all++;
      if (endermanLine(read, from, { x: from.x + Math.sin(a) * d, y: cell.y, z: from.z - Math.cos(a) * d }, ENDERMAN_EYE).clear) clear++;
    }
  }
  return Math.round((clear / all) * 100);
}
/**
 * probe kind=roofsite (S6, 11/5): where the completed completeNine roof would see the most endermen. Keep the existing roofSites positions, then read the
 * permanent plan with temporary supports removed. Count EYES at 8-48 m from its centre or the existing known exit geometry, most first, then fewest blocks,
 * then nearest. Read only; the planner chooses one and walks there before `fight target=enderman`. Why: in c1's warped forest the body built where it stood
 * and 1,029 of 1,037 calls found no eyes in sight (the lab, 25 minutes, six kills).
 */
export function endermanRoofSites(bot: any, radius = 16, limit = 5, seenCap = Infinity, around?: Cell): { sites: EndermanRoofSite[]; endermen: number } {
  // around: read the sites round another cell (an enderman's feet) instead of the body's; distance is then from that cell.
  const bodyFeet = feetCell(bot);
  if (!bodyFeet) return { sites: [], endermen: 0 };
  const here = around ?? bodyFeet;
  const read = bodyReader(bot), world = roofWorldOf(bot);
  const at = bot.entity.position;
  const endermen = (Object.values(bot.entities ?? {}) as any[]).filter(e => e?.name === 'enderman' && e.position && e.isValid !== false && e.position.distanceTo(at) <= 64);
  const reach = Math.max(4, Math.min(24, Math.round(radius)));
  const all = roofSites(world, here, reach, undefined, 2000);
  // Where the endermen stand (the median of their feet): end1109p02, a roof 8 above them on a hill, and three angry ones stood 7 m off for 15 s each.
  const feet = endermen.map(e => Math.floor(e.position.y)).sort((a, b) => a - b);
  const level = feet.length ? feet[Math.floor(feet.length / 2)] : null;
  // roofSites reads 2 up and down from the feet only: end1109p08b (warped forest, the body on ledges 3-10 above them) never had a site at their
  // level, every site lost its points for height or saw none, and five angry ones stood below for 15 s each. Their level is read as well.
  if (level !== null && Math.abs(level - here.y) > 2) {
    const have = new Set(all.map(s => `${s.cell.x},${s.cell.y},${s.cell.z}`));
    for (const site of roofSites(world, { x: here.x, y: level, z: here.z }, reach, undefined, 2000)) {
      if (have.has(`${site.cell.x},${site.cell.y},${site.cell.z}`)) continue;
      all.push({ ...site, distance: Math.round(Math.hypot(site.cell.x - here.x, site.cell.y - here.y, site.cell.z - here.z) * 10) / 10 });
    }
  }
  // The nearest first when there are very many (each site reads a line to every enderman).
  const entities = Object.values(bot.entities ?? {});
  const occupied = (cell: Cell) => roofCellOccupied(entities, bot.entity.id, cell);
  const sites = all.sort((a, b) => a.distance - b.distance).slice(0, 300).flatMap(site => {
    const done = completedRoof(world, read, site.cell);
    if (!done) return [];
    const { plan, future } = done;
    const from = { x: site.cell.x + 0.5, y: site.cell.y, z: site.cell.z + 0.5 };
    // seenCap: a caller that only needs a good site, not the full count (the fight's stop line), reads at most that many eyes per site.
    const visible = new Set(huntCandidates(future, from, endermen, site.cell, occupied, seenCap).map(e => Number(e.id)));
    const seenIds = endermen.filter(e => visible.has(Number(e.id))).map(e => Number(e.id));
    return [{ cell: site.cell, blocks: plan.placements.length, distance: site.distance, seen: seenIds.length, seenIds, open: roofSiteOpenness(future, site.cell),
      above: level === null ? 0 : site.cell.y - level }];
  });
  // The eyes seen now and the openness together (a fully open site counts as four eyes): the snapshot alone chose a thicket that saw one.
  // A site more than 2 above where they stand loses three points a block: an angry enderman walks to her, it does not climb a hill or a tower
  // (end1109p03: a site 4-8 above that saw 5 eyes won at one point a block; #416 and #789 stood angry below for 15 s each, four fights).
  const worth = (s: EndermanRoofSite) => s.seen + s.open / 25 - 3 * Math.max(0, s.above - 2);
  sites.sort((a, b) => worth(b) - worth(a) || a.blocks - b.blocks || a.distance - b.distance);
  return { sites: sites.slice(0, limit), endermen: endermen.length };
}
