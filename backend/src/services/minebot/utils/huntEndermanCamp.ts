import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { ENDERMAN_EYE, ENDERMAN_LEGS, endermanLine, ENDERMAN_STARE_MS, atRoofCentre, endermanAngry, endermanStrikePoint, endermanView,
  planRoof, roofBlockFor, roofCellOccupied, roofExitForSight, roofExitStep, roofInterior, roofInteriorStep, roofSites,
  type EndermanLine, type EndermanView, type RoofPlan, type RoofWorld } from './huntEnderman.js';
import { bodyReader, feetCell, type Cell } from './localMap.js';
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
/** An enderman closer than this and angry is the fight's, not the building's (it reaches the body in a second). */
const CONTACT = 4.2;
const RECOVERY_LIMIT = 2, RECOVERY_MS = 3_000, RECOVERY_STEP_MS = 1_800;
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
    .filter(site => { const block = roofBlockFor(bot, site.blocks); return site.blocks === 0 || (!!block && block.count >= site.blocks); });
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
  check(): { code: string; text: string } | null {
    const bot = this.ctx.bot;
    if (this.plan.problems.length) {
      return { code: 'no_site', text: `ここには屋根の穴を作れない: ${this.plan.problems.join('。')}（${cellText(this.cell)}。平らな床の上か、2 マスの高さの所へ動いてから）` };
    }
    const need = this.plan.placements.length;
    if (need > 0 && (!this.block || this.block.count < need)) {
      return { code: 'missing_item', text: `屋根に建築用ブロックが ${need} 個要る（丸石・土・ネザーラックなど 1 種類で。黒曜石は使わない。持っているのは ${this.block ? `${this.block.name}×${this.block.count}` : 'なし'}）` };
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
  release(): void { this.stopShift(); this.stopExit(); this.guard(true); }

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
    return endermanStrikePoint(bodyReader(this.ctx.bot), this.ctx.bot.entity.position, live.position);
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

  /** Before confirmed anger, a clear exit ray may go round a cap or terrain hiding this same target. */
  private startExit(live: any, view: CampObservation, now: number): boolean {
    if (this.angeredAt || this.observation.stareEndedAt !== null || this.exitStare === this.restares
      || this.observation.exits.length >= ROOF_EXIT_LIMIT || !atRoofCentre(this.ctx.bot.entity.position, this.cell)) return false;
    if (view.eyes.clear) return false;
    const to = roofExitForSight(bodyReader(this.ctx.bot), this.cell, live.position, view.eyes, c => this.shiftOccupied(c))[0];
    if (!to) return false;
    // Out from under the roof only while the way back is shorter than any coming (Codex's pre-deploy review 5, 11/5): the target at least EXIT_MIN_GAP off
    // the exit cell, and no other enderman or hostile already near it.
    const exitAt = new Vec3(to.x + 0.5, to.y, to.z + 0.5);
    if (live.position.distanceTo(exitAt) < EXIT_MIN_GAP) return false;
    const bot = this.ctx.bot;
    if ((Object.values(bot.entities ?? {}) as any[]).some(e => e && e.id !== this.targetId && e !== bot.entity && e.position && e.isValid !== false
      && (e.name === 'enderman' || isHostileEntity(e, bot)) && e.position.distanceTo(exitAt) < EXIT_CLEAR)) return false;
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
      return this.failure('enderman_not_visible', 'not_visible', `エンダーマンの目が見えない（${now - this.blindSince}ms/${SIGHT_MS}ms。間に ${first ? `${cellText(first.at)} ${first.name} ほか ${line.between.length - 1}` : 'なし'}。${box.toFixed(1)}m。対象 #${this.targetId}、微動 ${this.observation.recovery.length}/${RECOVERY_LIMIT}、屋根外の注視 ${this.observation.exits.length}/${ROOF_EXIT_LIMIT}）。屋根内で線を戻せない`, feetCell(this.ctx.bot) ?? this.cell);
    }
    return { kind: 'wait' };
  }

  private failure(code: string, reason: string, text: string, at?: Cell): CampStep {
    this.stopShift(); this.stopExit(); this.guard(true);
    return { kind: 'stop', outcome: { ...stopped(this.ctx.bot, reason, text, at), code } };
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
      if (!this.block || inventoryCount(bot, this.block.name) < 1) return this.failure('roof_failed', 'missing_item', `屋根の途中でブロックが尽きた（${this.laid}/${this.plan.placements.length}）`, next);
      const result = await place(this.ctx, { block: this.block.name, at: [next] });
      if (result.ok) {
        this.laid++;
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
export interface EndermanRoofSite { cell: Cell; blocks: number; distance: number; seen: number; seenIds: number[] }
/**
 * probe kind=roofsite (S6, 11/5): where a roof would see the most endermen. The cells within `radius` where the roof's plan stands (roofSites: uneven ground too,
 * the blocks it takes), each with the endermen whose EYES are in sight from it at 8-48 m (the band the roof hunts were won in), most first, then fewest blocks,
 * then nearest. Read only; the planner chooses one and walks there before `fight target=enderman`. Why: in c1's warped forest the body built where it stood
 * and 1,029 of 1,037 calls found no eyes in sight (the lab, 25 minutes, six kills).
 */
export function endermanRoofSites(bot: any, radius = 16, limit = 5): { sites: EndermanRoofSite[]; endermen: number } {
  const here = feetCell(bot);
  if (!here) return { sites: [], endermen: 0 };
  const read = bodyReader(bot), world = roofWorldOf(bot);
  const at = bot.entity.position;
  const endermen = (Object.values(bot.entities ?? {}) as any[]).filter(e => e?.name === 'enderman' && e.position && e.isValid !== false && e.position.distanceTo(at) <= 64);
  const all = roofSites(world, here, Math.max(4, Math.min(24, Math.round(radius))), undefined, 2000);
  // The nearest first when there are very many (each site reads a line to every enderman).
  const sites = all.sort((a, b) => a.distance - b.distance).slice(0, 300).map(site => {
    const from = { x: site.cell.x + 0.5, y: site.cell.y, z: site.cell.z + 0.5 };
    const seenIds = endermen.filter(e => {
      const d = Math.hypot(e.position.x - from.x, e.position.y - from.y, e.position.z - from.z);
      if (d < 8 || d > 48) return false;
      try { return endermanLine(read, from, e.position, ENDERMAN_EYE).clear; } catch { return false; }
    }).map(e => Number(e.id));
    return { cell: site.cell, blocks: site.blocks, distance: site.distance, seen: seenIds.length, seenIds };
  });
  sites.sort((a, b) => b.seen - a.seen || a.blocks - b.blocks || a.distance - b.distance);
  return { sites: sites.slice(0, limit), endermen: endermen.length };
}
