import { Vec3 } from 'vec3';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { endermanAngry, ENDERMAN_EYE, looksAtEyes } from './huntEnderman.js';
import { isHostileEntity, type ThreatBody } from './hostileMobHints.js';
import { reflexHeld } from './floorReflexes.js';
import { denAir, denCenter, denClearRay, denDigCells, denOffset, denRead, denStandable, denVector, inspectEndermanDen,
  type DenWorld, type EndermanDenSpec } from './huntEndermanDen.js';
import type { Cell } from './localMap.js';
import { dig } from './primitives/dig.js';
import { go } from './primitives/go.js';
import { cellText, guard, inventoryCount, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './primitives/common.js';

export const DEN_ARRIVAL_MS = 20_000;
const TICK_MS = 50, MOVE_MS = 3_000, PICKUP_MS = 5_000, STARE_MS = 5_000, SIGHT_MS = 8_000;
export interface DenEntity {
  id: number; name?: string; position: Vec3; isValid?: boolean; metadata?: unknown[]; width?: number; height?: number;
}
interface LiveBot extends DenWorld, ThreatBody {
  entity: { id?: number; position: Vec3; yaw: number; pitch: number; onGround?: boolean };
  entities: Record<string, DenEntity>;
  health?: number;
  gazeGuard?: { enabled: boolean };
  setControlState(name: string, on: boolean): void;
  look(yaw: number, pitch: number, force?: boolean): Promise<void>;
  lookAt(point: Vec3, force?: boolean): Promise<void>;
  on?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}
export type DenPhase = 'approach' | 'dig' | 'verify' | 'exit' | 'provoke' | 'return' | 'hold' | 'pickup';
export interface EndermanDenObservation {
  targetId: number;
  den: EndermanDenSpec;
  phase: DenPhase;
  setupMs: number;
  digMs: number;
  verifyMs: number;
  setupComplete: boolean;
  dug: Cell[];
  reused: boolean;
  provokedAt: number | null;
  returnedAt: number | null;
  waitMs: number;
  pickupMs: number;
  pickupReason: string | null;
  pearls: number;
  healthLost: number;
  killed: boolean;
  stopReason: string | null;
}
// Body-only diagnostics. No changes to the head contract or the common act result.
const readings = new WeakMap<object, EndermanDenObservation>();
export function endermanDenObservation(bot: object): EndermanDenObservation | null { return readings.get(nativeActionHost(bot)) ?? null; }
export function clearEndermanDenObservation(bot: object): void { readings.delete(nativeActionHost(bot)); }
export type DenStep = { kind: 'fight' } | { kind: 'wait' } | { kind: 'stop'; outcome: StepOutcome };
export type DenPickup = { ok: true; reason: string } | { ok: false; code: string; reason: string };
class DenStop extends Error { constructor(readonly code: string, message: string) { super(message); } }

/** Executes ONE specified den and ONE #id. No site/target search, placement, extra excavation, or pursuit. */
export class EndermanDenFight {
  readonly observation: EndermanDenObservation;
  readonly den: EndermanDenSpec;
  private readonly bot: LiveBot;
  private readonly ctx: StepContext;
  private readonly began = Date.now();
  private readonly floorHp: number;
  private lastHealth: number;
  private guardWas: boolean | null = null;
  private blindAt: number | null = null;
  private stareAt: number | null = null;
  private arrived = false;
  private dropsBefore = new Set<number>();
  private readonly onHealth = (): void => this.sampleHealth();

  constructor(ctx: StepContext, den: EndermanDenSpec, readonly targetId: number, endAt: number, retreatHp = 8) {
    this.den = { entrance: { ...den.entrance }, direction: den.direction };
    this.bot = ctx.bot as LiveBot;
    this.ctx = { ...ctx, deadline: Math.min(ctx.deadline, endAt) };
    this.floorHp = Math.max(8, retreatHp);
    this.lastHealth = Number(this.bot.health ?? 20);
    this.observation = { targetId, den: { entrance: { ...den.entrance }, direction: den.direction }, phase: 'approach', setupMs: 0, digMs: 0, verifyMs: 0,
      setupComplete: false, dug: [], reused: false, provokedAt: null, returnedAt: null, waitMs: 0, pickupMs: 0, pickupReason: null, pearls: 0, healthLost: 0, killed: false, stopReason: null };
    readings.set(nativeActionHost(ctx.bot), this.observation);
    this.bot.on?.('health', this.onHealth);
  }
  get phase(): DenPhase { return this.observation.phase; }
  private setPhase(phase: DenPhase): void { this.observation.phase = phase; }
  private sampleHealth(): void {
    const hp = Number(this.bot.health ?? this.lastHealth);
    this.observation.healthLost += Math.max(0, this.lastHealth - hp); this.lastHealth = hp;
  }
  /** The existing action/reflex lease always wins. Damage or low HP ends this hand; no new autonomous retreat plan. */
  private safety(knownHealthLost = 0): void {
    this.sampleHealth();
    if (this.ctx.stop.aborted) throw new StepStopped(String(this.ctx.stop.reason ?? 'stopped'));
    if (reflexHeld(this.bot)) throw new DenStop('reflex', '反射が体を握った');
    if (Date.now() >= this.ctx.deadline) throw new DenStop('limit_time', '横穴の手の期限に達した');
    if (this.lastHealth < this.floorHp) throw new DenStop('retreat', `体力 ${this.lastHealth} < ${this.floorHp}。横穴の手を中止し、反射に従う`);
    if (this.observation.healthLost > knownHealthLost) throw new DenStop('den_hurt', `受けた体力 ${this.observation.healthLost}。安全な待機が成立していない`);
    if (this.phase === 'pickup' && this.pickupThreat()) throw new DenStop('den_pickup_threat', '他の個体が近いので回収中止');
    if (!this.observation.setupComplete) {
      const check = inspectEndermanDen(this.bot, this.den);
      if (!check.ok) throw new DenStop(check.code, check.reason);
      // Even a distant angry target may teleport here: never continue excavation after anger.
      if (check.remaining.length && Object.values(this.bot.entities).some(e => e.isValid !== false && e.name === 'enderman' && endermanAngry(this.bot.registry, e)
        && (e.id === this.targetId || e.position.distanceTo(this.bot.entity.position) < 12))) throw new DenStop('den_angry_before_ready', '横穴完成前に敵対している。掘り始めない・追加で掘らない');
    } else {
      const check = inspectEndermanDen(this.bot, this.den, true);
      if (!check.ok) throw new DenStop(check.code, check.reason);
    }
  }
  /** Native digging/walking is also interrupted BETWEEN ticks, not only after its promise resolves. */
  private async protectedWork<T>(work: (ctx: StepContext) => Promise<T>): Promise<T> {
    this.safety();
    const stop = new AbortController();
    let failure: DenStop | null = null;
    const parent = () => stop.abort(this.ctx.stop.reason);
    this.ctx.stop.addEventListener('abort', parent, { once: true });
    const timer = setInterval(() => {
      try { this.safety(); }
      catch (error) {
        if (error instanceof DenStop) { failure = error; stop.abort(error.code); }
        else if (error instanceof StepStopped) stop.abort(error.why);
      }
    }, TICK_MS);
    try {
      const result = await work({ ...this.ctx, stop: stop.signal });
      if (failure) throw failure;
      this.safety();
      return result;
    } catch (error) { if (failure) throw failure; throw error; }
    finally { clearInterval(timer); this.ctx.stop.removeEventListener('abort', parent); }
  }
  private keysOff(): void {
    for (const name of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) try { this.bot.setControlState(name, false); } catch { /* the motor lease may be over */ }
  }
  private gaze(on: boolean): void {
    const state = this.bot.gazeGuard;
    if (!state) return;
    if (!on) { this.guardWas ??= state.enabled; state.enabled = false; }
    else if (this.guardWas !== null) { state.enabled = this.guardWas; this.guardWas = null; }
  }
  release(): void {
    this.gaze(true); this.keysOff(); this.sampleHealth();
    this.bot.removeListener?.('health', this.onHealth);
    if (!this.observation.setupComplete) this.observation.setupMs = Date.now() - this.began;
  }
  noteWait(ms: number): void { this.observation.waitMs += ms; }
  markKilled(): void { this.observation.killed = true; }
  /** Read-only safety gate also runs while the shield reflex borrows the look/legs. */
  checkSafety(): DenStep | null {
    try {
      this.safety();
      if (this.phase === 'hold' && !this.arrived && Date.now() - (this.observation.returnedAt ?? Date.now()) >= DEN_ARRIVAL_MS) {
        return this.failure('enderman_did_not_arrive', '穴の奥で20秒待ったが脚を打てる所に来なかった');
      }
      return null;
    } catch (error) { if (error instanceof DenStop) return this.failure(error.code, error.message); throw error; }
  }
  describe(): string {
    this.sampleHealth();
    return `横穴 ${this.observation.dug.length}/4${this.observation.reused ? '（再利用）' : ''}・設営 ${(this.observation.setupMs / 1000).toFixed(1)}秒・待ち ${(this.observation.waitMs / 1000).toFixed(1)}秒`
      + (this.observation.pickupReason ? `・回収 ${this.observation.pickupReason}` : '');
  }
  private failure(code: string, text: string): DenStep {
    this.observation.stopReason = code;
    this.release();
    return { kind: 'stop', outcome: { ...stopped(this.bot, code, `横穴: ${text}（掘ったマスは戻さない）`), code } };
  }
  /** Swept player box, including its corners, on a level full floor. It cannot cut a corner through a wall or drift over a cliff. */
  private sweptSafe(from: Vec3, to: Vec3): boolean {
    if (Math.abs(from.y - to.y) > 0.12 || from.distanceTo(to) > 4.5) return false;
    const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 0.15));
    for (let i = 0; i <= steps; i++) for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) {
      const t = i / steps, p = { x: Math.floor(from.x + (to.x - from.x) * t + dx), y: to.y, z: Math.floor(from.z + (to.z - from.z) * t + dz) };
      if (!denStandable(this.bot, p)) return false;
    }
    return true;
  }
  /** Short straight motion inside the verified corridor, with the eyes lowered and no pathfinder detour. */
  private async move(to: Cell, sprint = false, until = this.ctx.deadline, knownHealthLost = 0): Promise<void> {
    this.gaze(true);
    const point = denCenter(to), endAt = Math.min(until, this.ctx.deadline, Date.now() + MOVE_MS);
    try {
      while (Date.now() < endAt) {
        this.safety(knownHealthLost);
        const p = this.bot.entity.position;
        if (!this.sweptSafe(p, point)) throw new DenStop('den_path_unsafe', `${cellText(to)} への短い通路に壁・液体・空洞・段差がある`);
        const distance = Math.hypot(point.x - p.x, point.z - p.z);
        if (distance <= 0.14) return;
        const turned = await guard(this.ctx, this.bot.look(Math.atan2(p.x - point.x, p.z - point.z), -0.25, true), Math.min(300, endAt - Date.now()));
        this.safety(knownHealthLost);
        if (Date.now() >= endAt) break;
        if (!turned) throw new DenStop('den_turn_timeout', '通路の向きへ向き直れなかった');
        this.bot.setControlState('jump', false); this.bot.setControlState('sneak', false);
        this.bot.setControlState('sprint', sprint && distance > 1); this.bot.setControlState('forward', true);
        await wait(this.ctx, Math.min(TICK_MS, endAt - Date.now()));
      }
      this.safety(knownHealthLost);
      throw new DenStop('den_move_timeout', `${cellText(to)} に短い移動で着けなかった`);
    } finally { this.keysOff(); }
  }
  /** The nearest point INSIDE the lower-body box. Eye-to-point <=3m AND an unobstructed leg ray are required. */
  strikePoint(live: DenEntity): Vec3 | null {
    this.sampleHealth();
    if (this.ctx.stop.aborted || reflexHeld(this.bot) || this.lastHealth < this.floorHp || this.observation.healthLost > 0 || !inspectEndermanDen(this.bot, this.den, true).ok) return null;
    const waitCell = denOffset(this.den, 1), body = this.bot.entity.position;
    if (Math.abs(body.x - waitCell.x - 0.5) > 0.25 || Math.abs(body.z - waitCell.z - 0.5) > 0.25 || Math.abs(body.y - waitCell.y) > 0.12) return null;
    const v = denVector(this.den.direction), entrance = denCenter(this.den.entrance);
    if ((live.position.x - entrance.x) * v.x + (live.position.z - entrance.z) * v.z > -0.75) return null;
    const eye = body.offset(0, 1.62, 0), half = Math.max(0.05, (live.width ?? 0.6) / 2 - 0.01);
    const point = new Vec3(Math.max(live.position.x - half, Math.min(live.position.x + half, eye.x)), live.position.y + 0.8,
      Math.max(live.position.z - half, Math.min(live.position.z + half, eye.z)));
    return eye.distanceTo(point) <= 3 && denClearRay(this.bot, eye, point) ? point : null;
  }
  async advance(live: DenEntity): Promise<DenStep> {
    try {
      this.safety();
      if (live.id !== this.targetId || live.isValid === false) return this.failure('target_lost', '指定した個体がいない。他の個体へ乗り換えない');
      const check = inspectEndermanDen(this.bot, this.den, this.observation.setupComplete);
      if (!check.ok) return this.failure(check.code, check.reason);
      const angry = endermanAngry(this.bot.registry, live);
      if (this.phase === 'approach') {
        this.observation.reused = check.remaining.length === 0;
        const outside = denOffset(this.den, -1);
        if (angry && !check.remaining.length) {
          // Reusing a finished den never digs, and an already angry target needs no second trip outside.
          this.setPhase('verify'); return { kind: 'wait' };
        }
        const p = this.bot.entity.position;
        if (Math.hypot(p.x - outside.x - 0.5, p.z - outside.z - 0.5) > 0.2 || Math.abs(p.y - outside.y) > 0.1) {
          if (denCenter(outside).distanceTo(p) > 10) return this.failure('den_too_far', '入口手前が10mより遠い。先に go で寄る');
          const result = await this.protectedWork(ctx => go(ctx, { goals: [outside], range: 0, seconds: 6, maxDig: 0, maxPlace: 0, maxDrop: 0, waterOk: false, sprint: false }));
          if (!result.ok) return this.failure(result.code ?? result.reason ?? 'den_approach_failed', result.text);
          await this.move(outside);
        }
        this.setPhase('dig'); return { kind: 'wait' };
      }
      if (this.phase === 'dig') {
        // Fresh shell and anger checks precede EVERY block; never widen the four-cell grant.
        const next = denDigCells(this.den).find(p => !denAir(denRead(this.bot, p)));
        if (next) {
          const began = Date.now();
          try {
            const result = await this.protectedWork(ctx => dig(ctx, { at: [next], collect: false, exposeOk: ['enderman'] }));
            if (!result.ok) return this.failure(result.code ?? result.reason ?? 'den_dig_failed', result.text);
            if (!denAir(denRead(this.bot, next))) return this.failure('den_dig_unconfirmed', `${cellText(next)} が空いたことを確認できない`);
          } finally {
            // A cancellation or newly exposed hazard can happen after the server actually opened this cell.
            if (denAir(denRead(this.bot, next)) && !this.observation.dug.some(p => p.x === next.x && p.y === next.y && p.z === next.z)) this.observation.dug.push(next);
            this.observation.digMs += Date.now() - began;
          }
          return { kind: 'wait' };
        }
        this.setPhase('verify'); return { kind: 'wait' };
      }
      if (this.phase === 'verify') {
        const began = Date.now();
        try {
          const ready = inspectEndermanDen(this.bot, this.den, true);
          if (!ready.ok) return this.failure(ready.code, ready.reason);
          await this.move(denOffset(this.den, 1), angry);
          const inside = inspectEndermanDen(this.bot, this.den, true);
          if (!inside.ok) return this.failure(inside.code, inside.reason);
          this.observation.setupComplete = true;
          this.observation.setupMs = Date.now() - this.began;
          this.dropsBefore = new Set(Object.values(this.bot.entities).filter(e => e.name === 'item').map(e => e.id));
          this.setPhase(angry ? 'return' : 'exit');
        } finally { this.observation.verifyMs += Date.now() - began; }
        return { kind: 'wait' };
      }
      if (this.phase === 'exit') {
        if (angry) { this.setPhase('return'); return { kind: 'wait' }; }
        await this.move(denOffset(this.den, -1));
        this.setPhase('provoke'); return { kind: 'wait' };
      }
      if (this.phase === 'provoke') {
        if (angry) { this.observation.provokedAt = Date.now(); this.gaze(true); this.setPhase('return'); }
        else {
          const from = this.bot.entity.position.offset(0, 1.62, 0), eye = live.position.offset(0, ENDERMAN_EYE, 0), now = Date.now();
          if (!denClearRay(this.bot, from, eye)) {
            this.gaze(true); this.stareAt = null; this.blindAt ??= now;
            if (now - this.blindAt >= SIGHT_MS) return this.failure('enderman_not_visible', '入口外から指定個体の目が8秒見えない');
            return { kind: 'wait' };
          }
          this.blindAt = null; this.stareAt ??= now;
          if (now - this.stareAt >= STARE_MS) return this.failure('enderman_not_angry', '目を5秒見ても敵対を確認できない');
          const d = eye.minus(from), yaw = Math.atan2(-d.x, -d.z), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
          if (Object.values(this.bot.entities).some(e => e.id !== live.id && e.name === 'enderman' && e.isValid !== false && looksAtEyes(from, yaw, pitch, e.position))) {
            return this.failure('den_gaze_conflict', '指定個体の目の線に別のエンダーマンもいる');
          }
          this.gaze(false);
          await this.protectedWork(ctx => guard(ctx, this.bot.lookAt(eye, true), 300));
          return { kind: 'wait' };
        }
      }
      if (this.phase === 'return') {
        this.gaze(true);
        await this.move(denOffset(this.den, 1), true);
        this.observation.returnedAt = Date.now(); this.setPhase('hold');
      }
      if (this.phase === 'hold') {
        const p = this.bot.entity.position, rear = denCenter(denOffset(this.den, 1));
        if (Math.abs(p.x - rear.x) > 0.25 || Math.abs(p.z - rear.z) > 0.25 || Math.abs(p.y - rear.y) > 0.12) return this.failure('den_displaced', '奥の待機マスの中心から動かされた（入口へ詰めない）');
        if (this.strikePoint(live)) this.arrived = true;
        if (!this.arrived && Date.now() - (this.observation.returnedAt ?? Date.now()) >= DEN_ARRIVAL_MS) return this.failure('enderman_did_not_arrive', '穴の奥で20秒待ったが脚を打てる所に来なかった');
        this.keysOff(); return { kind: 'fight' };
      }
      return { kind: 'wait' };
    } catch (error) { if (error instanceof DenStop) return this.failure(error.code, error.message); throw error; }
  }
  private pickupThreat(): boolean {
    const outside = denCenter(denOffset(this.den, -1));
    return Object.values(this.bot.entities).some(e => e.id !== this.targetId && e.id !== this.bot.entity.id && e.isValid !== false
      && (e.name === 'enderman' || isHostileEntity(e, this.bot))
      && Math.min(e.position.distanceTo(outside), e.position.distanceTo(this.bot.entity.position)) <= 6);
  }
  /** Only fresh drops within 3m of the entrance exterior; a five-second trip including return, cancelled on any nearby other enderman. */
  async collect(): Promise<DenPickup> {
    const began = Date.now(), pearls = inventoryCount(this.bot, 'ender_pearl'), outside = denCenter(denOffset(this.den, -1));
    this.setPhase('pickup');
    let why = '落とし物なし';
    let leftForDrops = false;
    const until = Math.min(this.ctx.deadline, began + PICKUP_MS);
    try {
      this.safety();
      if (this.pickupThreat()) { why = '他の個体が近いので拾わない'; return { ok: true, reason: why }; }
      // Allow the death's item packets a short bounded window. It is counted as collection, not hidden from the probe's clock.
      await wait(this.ctx, Math.min(200, Math.max(0, until - Date.now())));
      this.safety();
      const drops = Object.values(this.bot.entities).filter(e => e.name === 'item' && !this.dropsBefore.has(e.id) && e.position.distanceTo(outside) <= 3)
        .sort((a, b) => a.position.distanceTo(outside) - b.position.distanceTo(outside)).slice(0, 3);
      for (const drop of drops) {
        this.safety();
        if (Date.now() + 2_000 >= until) { why = '短い回収の期限'; break; }
        if (this.pickupThreat()) { why = '他の個体が近づいたので回収中止'; break; }
        const cell = { x: Math.floor(drop.position.x), y: Math.floor(drop.position.y + 0.001), z: Math.floor(drop.position.z) };
        // Go via the mouth, never diagonally through the side wall. Both legs must be level, dry and unobstructed.
        leftForDrops = true;
        await this.move(denOffset(this.den, -1), false, until - 2_000);
        if (denCenter(cell).distanceTo(outside) > 3 || !this.sweptSafe(this.bot.entity.position, denCenter(cell))) { why = '入口外3m以内で落とし物へ歩ける安全な床がない'; continue; }
        await this.move(cell, false, until - 2_000);
        for (let i = 0; i < 4 && this.bot.entities[drop.id] && Date.now() + 2_000 < until; i++) {
          this.safety(); if (this.pickupThreat()) throw new DenStop('den_pickup_threat', '他の個体が近づいたので回収中止');
          await wait(this.ctx, TICK_MS);
        }
        why = '入口外3m以内だけ回収';
      }
      if (drops.length) { await this.move(denOffset(this.den, -1), false, until); await this.move(denOffset(this.den, 1), true, until); }
      this.safety();
    } catch (error) {
      if (!(error instanceof DenStop)) throw error;
      why = error.message; this.observation.stopReason = error.code;
      if (error.code === 'den_hurt' && leftForDrops && !reflexHeld(this.bot)
        && this.bot.entity.position.distanceTo(denCenter(denOffset(this.den, 1))) > 0.2) {
        // Only the short return may tolerate the damage already reported. Fresh damage, low HP, a reflex or the deadline still stops it.
        const knownHealthLost = this.observation.healthLost;
        try {
          // Still inside the tunnel (past the mouth's outer face along its direction, within the width): go straight to the back, never out through the mouth first.
          const v = denVector(this.den.direction), mouth = denCenter(this.den.entrance), body = this.bot.entity.position;
          const along = (body.x - mouth.x) * v.x + (body.z - mouth.z) * v.z, across = Math.abs((body.x - mouth.x) * v.z - (body.z - mouth.z) * v.x);
          const inside = along >= -0.5 && across <= 0.7;
          if (!inside) await this.move(denOffset(this.den, -1), false, until, knownHealthLost);
          await this.move(denOffset(this.den, 1), true, until, knownHealthLost);
        } catch (returnError) {
          if (!(returnError instanceof DenStop)) throw returnError;
          // A failed return never replaces the original pickup stop or starts another plan.
        }
      }
      if (error.code !== 'den_pickup_threat') return { ok: false, code: error.code, reason: why };
    } finally {
      this.gaze(true); this.keysOff(); this.sampleHealth();
      this.observation.pearls = Math.max(0, inventoryCount(this.bot, 'ender_pearl') - pearls);
      this.observation.pickupMs += Date.now() - began; this.observation.pickupReason = why;
    }
    return { ok: true, reason: why };
  }
}
