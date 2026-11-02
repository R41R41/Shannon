import { Vec3 } from 'vec3';
import { ENDERMAN_EYE, planRoof, roofBlockFor, type RoofPlan, type RoofWorld } from './huntEnderman.js';
import { bodyReader, feetCell, type Cell } from './localMap.js';
import { solidBetween } from './probeTools.js';
import { PLACE_REPLACEABLE, place } from './primitives/place.js';
import { cellText, inventoryCount, stopped, wait, type StepContext, type StepOutcome } from './primitives/common.js';

/**
 * The live part of the enderman hunt (S2, 2026-11-02; the plan and the reasons are in huntEnderman.ts): build the roof over the body, stare the enderman in the
 * eye from under it, and hold the hole. The fight hand (primitives/fight) asks this for one step at a time and does the blows, the shield and the counts itself.
 *
 * Built before it is angered, not after (the precedent does it after, to spend no blocks on an enderman that does not turn): an enderman that is angry
 * reaches the body in a second or two and nine blocks take about two seconds to lay, and a blow of its is 7 points and a push. From inside the hole the
 * look to a far enderman's eyes is clear (a ray to eyes 2.55 up from a body's 1.62 rises under the roof's edge at three blocks and more), so the order costs
 * only the blocks, and those stay for the next enderman.
 */

/** The longest the roof is worked on (a body that cannot lay it in this is not going to). */
const BUILD_MS = 14_000;
/** A cell that will not be laid in this many tries is the plan's to mend: once, and then the hand says why. */
const CELL_TRIES = 2;
/** The enderman is stared at for this long before it is said that it cannot be angered from here. */
const STARE_MS = 5_000;
/**
 * An enderman whose eyes are hidden (behind the roof's edge when it is within about 3.7 blocks, or behind a wall) is waited for this long: it wanders, and one that
 * stood in the blind zone of the roof at the first look (lab: a flat plate, the fourth of four, stopped at 0.0 s) comes out of it in a few seconds.
 */
const SIGHT_MS = 8_000;
/** An enderman closer than this and angry is the fight's, not the building's (it reaches the body in a second). */
const CONTACT = 4.2;

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
  private blindSince = 0;
  private guardWas: boolean | null = null;
  private replans = 0;

  constructor(private readonly ctx: StepContext, private readonly target: any) {
    const bot = ctx.bot;
    this.cell = feetCell(bot)!;
    this.plan = this.planFrom(this.cell);
    this.block = roofBlockFor(bot, this.plan.placements.length);
    if (!this.plan.placements.length) this.phase = 'provoke';
  }

  private worldOf(): RoofWorld {
    const bot = this.ctx.bot;
    const read = (x: number, y: number, z: number) => { try { return bot.blockAt?.(new Vec3(x, y, z), false) ?? null; } catch { return null; } };
    return {
      solid: (x, y, z) => { const block = read(x, y, z); return block ? block.boundingBox === 'block' : null; },
      replaceable: (x, y, z) => { const block = read(x, y, z); return !!block && PLACE_REPLACEABLE.has(String(block.name)) && block.name !== 'water' && block.name !== 'lava'; },
    };
  }
  private planFrom(cell: Cell): RoofPlan {
    const at = this.target.position;
    const dx = at.x - (cell.x + 0.5), dz = at.z - (cell.z + 0.5), length = Math.hypot(dx, dz);
    return planRoof(this.worldOf(), cell, length > 0.5 ? { x: dx / length, z: dz / length } : undefined);
  }

  /** What stops the hunt before anything is done: no site, or not enough to build with. Null when it can begin. */
  check(): { code: string; text: string } | null {
    const bot = this.ctx.bot;
    if (this.plan.problems.length) {
      return { code: 'no_site', text: `ここには屋根の穴を作れない: ${this.plan.problems.join('。')}（${cellText(this.cell)}。平らな床の上か、2 マスの高さの所へ動いてから）` };
    }
    const need = this.plan.placements.length;
    if (need > 0 && (!this.block || this.block.count < need)) {
      return { code: 'missing_item', text: `屋根に建築用ブロックが ${need} 個要る（持っているのは ${this.block ? `${this.block.name}×${this.block.count}` : 'なし'}。丸石・土・ネザーラックなど）` };
    }
    if (String(bot.inventory?.slots?.[5]?.name ?? '') === 'carved_pumpkin') {
      return { code: 'pumpkin', text: 'くり抜きかぼちゃを被っているとエンダーマンは怒らない（外してから）' };
    }
    return null;
  }

  /** The cells still to lay, in the plan's order. */
  private remaining(): Cell[] {
    const bot = this.ctx.bot;
    return this.plan.placements.filter(c => { const block = bot.blockAt?.(new Vec3(c.x, c.y, c.z), false); return !block || block.boundingBox !== 'block'; });
  }

  /** The look held off the enderman's eyes by the body's gaze guard is let go while the hand stares, and put back. */
  private guard(on: boolean): void {
    const state = (this.ctx.bot as any).gazeGuard as { enabled: boolean } | undefined;
    if (!state) return;
    if (!on) { if (this.guardWas === null) this.guardWas = state.enabled; state.enabled = false; }
    else if (this.guardWas !== null) { state.enabled = this.guardWas; this.guardWas = null; }
  }
  /** Put everything back (the hand's end). */
  release(): void { this.guard(true); }

  /** The roof and the anger, as the line tells them. */
  describe(angry: boolean): string {
    const roof = this.plan.placements.length ? `屋根 ${this.laid}/${this.plan.placements.length}` : '屋根は既にある';
    return `${roof}・${this.angeredAt ? '怒らせた' : angry ? '怒っている' : '怒っていない'}`;
  }

  /** The line of sight from the body's eye to the enderman's eyes is clear of solid blocks (else: the first one on it). */
  private eyeLine(live: any): { clear: boolean; between: string } {
    const bot = this.ctx.bot;
    const from = bot.entity.position.offset(0, 1.62, 0), to = live.position.offset(0, ENDERMAN_EYE, 0);
    const read = bodyReader(bot);
    const between = solidBetween(read, [from.x, from.y, from.z], [to.x, to.y, to.z]);
    const first = between[0];
    return { clear: between.length === 0, between: first ? `間に (${first.x},${first.y},${first.z}) ${read(first.x, first.y, first.z)?.name ?? '未ロード'}${between.length > 1 ? ` ほか ${between.length - 1}` : ''}` : '' };
  }

  private failure(code: string, reason: string, text: string, at?: Cell): CampStep {
    return { kind: 'stop', outcome: { ...stopped(this.ctx.bot, reason, text, at), code } };
  }

  /** One step of the camp. `box` is the distance to the enderman's box, `angry` its `creepy` flag. */
  async advance(live: any, now: number, box: number, angry: boolean): Promise<CampStep> {
    const bot = this.ctx.bot;
    if (angry && !this.angeredAt) this.angeredAt = now;

    if (this.phase === 'build') {
      // An angry enderman within reach is the fight's: the shield, the blow, and the roof when it has gone.
      if (angry && box <= CONTACT) return { kind: 'fight' };
      if (now - this.began > BUILD_MS) return this.failure('roof_failed', 'build_stalled', `屋根を ${BUILD_MS / 1000} 秒で建て終えられなかった（${this.laid}/${this.plan.placements.length}）`, this.cell);
      const left = this.remaining();
      if (!left.length) { this.phase = angry ? 'hold' : 'provoke'; return { kind: 'wait' }; }
      // The body stays in its cell: a blow or a push that moved it makes the plan another one (once, and only before a block is laid).
      const feet = feetCell(bot);
      if (feet && (feet.x !== this.cell.x || feet.z !== this.cell.z || feet.y !== this.cell.y)) {
        if (this.laid > 0 || this.replans > 1) return this.failure('roof_failed', 'moved', `屋根を建てている間に ${cellText(this.cell)} から ${cellText(feet)} へ動かされた（${this.laid}/${this.plan.placements.length}）`, feet);
        this.cell = feet; this.plan = this.planFrom(feet); this.replans++;
        if (this.plan.problems.length) return this.failure('no_site', 'no_site', `ここには屋根の穴を作れない: ${this.plan.problems.join('。')}`, feet);
        return { kind: 'wait' };
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
      if (result.ok) this.laid++;
      else await wait(this.ctx, 120);
      return { kind: 'wait' };
    }

    if (this.phase === 'provoke') {
      if (angry) { this.phase = 'hold'; this.guard(true); return { kind: 'fight' }; }
      const line = this.eyeLine(live);
      if (!line.clear) {
        this.guard(true);
        this.staredSince = 0;
        this.blindSince ||= now;
        if (now - this.blindSince > SIGHT_MS) {
          return this.failure('enderman_not_visible', 'not_visible', `エンダーマンの目が ${SIGHT_MS / 1000} 秒見えない（${line.between}。${box.toFixed(1)}m）。見える所へ動くか、近づくのを待つ`, this.cell);
        }
        return { kind: 'wait' };
      }
      this.blindSince = 0;
      this.staredSince ||= now;
      if (now - this.staredSince > STARE_MS) {
        this.guard(true);
        return this.failure('enderman_not_angry', 'not_provoked', `${STARE_MS / 1000} 秒目を見ても怒らない（${box.toFixed(1)}m。遠すぎるか、まばたきの間に外れた）`, this.cell);
      }
      this.guard(false);
      try { void Promise.resolve(bot.lookAt(live.position.offset(0, ENDERMAN_EYE, 0), true)).catch(() => undefined); } catch { /* the port is no longer ours */ }
      return { kind: 'wait' };
    }

    // hold: the hole is built and the enderman is angry (or calmed again: it is stared at once more)
    if (!angry) { this.phase = 'provoke'; this.staredSince = 0; return { kind: 'wait' }; }
    return { kind: 'fight' };
  }
}
