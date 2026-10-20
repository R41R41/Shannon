import { nearbyNeeds } from '../../utils/nearbyNeeds.js';
import type { NearbyNeed } from '../../cognition/types.js';
import type { MinecraftBodyEvent, MinecraftControlCommand as Command } from './minecraftControlContract.js';

/**
 * The body's side of "observe while working" (session mb-arch, stage 1, owner 2026-10-20). Run 18 (29 minutes): the planner never had
 * the iron ore 16 m away in sight, and the body spent about 460 s in moves and digs that got nowhere while the API only learnt of it
 * from the receipt, 110 s later. Here the body tells, while a command runs:
 *
 * - `need.appeared` / `need.gone`: the list of nearby needs (utils/nearbyNeeds) changed. Gone only after two readings without it,
 *   so a sheep at the edge of the range does not flicker.
 * - `action.progress`: every PROGRESS_EVERY_MS, how the running skill goes: time, time since it last got anywhere, its measure.
 * - `action.stalled`: once, when a skill that has a measure (WATCHED) has not got better for STALL_MS; again only after progress.
 *
 * The body only measures. Whether a stalled move is cut, or a need is worth a detour, is the API's (its arbiter).
 */
export const BODY_EVENTS = Object.freeze({
  /** Kept while the API has not taken them; past this the oldest progress events go first. */
  max: 256,
  perPoll: 32,
  progressEveryMs: 2_000,
  stallMs: 15_000,
  /**
   * In water a stall is told sooner: a chase there gets slower and the breath reflex cuts in. Run 19: four salmon in 334 s, one chase
   * of 201 s never told as stalled (attack-continuously was not measured at all).
   */
  waterStallMs: 8_000,
  /** The needs list is read this often (utils/nearbyNeeds caches for 3 s itself). */
  needsEveryMs: 3_000,
  /** A move toward a target counts as getting somewhere when the best distance shrinks by this much. */
  closerBy: 1,
  /** A chase counts as getting somewhere when the nearest of what it hunts gets this much closer (they run; a step or two is noise). */
  chaseCloserBy: 2,
  /**
   * A walk without a target (a dig looking for its ore, an exploration) counts when it gets this far from each of the last `trail`
   * places it counted at (so pacing between two spots does not count); a move toward a target counts new ground of `detourBy` the
   * same way (a way round a pond or a cliff takes it away from its target for a while).
   */
  travelBy: 4,
  detourBy: 10,
  trail: 8,
});

/**
 * How each long skill's progress is measured. `target`: the distance to the coordinates it was given (as move-to measures it);
 * `depth`: the height still to go (targetY); `travel`: getting away from where it last counted; `chase`: the nearest of what it
 * hunts (`entityName`) getting closer. Every one also counts a gain in what the body carries (a mined ore, a dug block, a kill's
 * drop). A skill not named here (a wait, a craft) is told in `action.progress` but never stalled.
 */
type Measure = 'target' | 'depth' | 'travel' | 'chase';
const WATCHED: Readonly<Record<string, Measure>> = {
  'move-to': 'target', 'mine-block': 'travel', 'stair-mine': 'depth', 'explore-for-structure': 'travel', 'attack-continuously': 'chase',
};

type Scalar = string | number | boolean | null;
interface Point { x: number; y: number; z: number }
interface EventsBody {
  entity?: { position?: Point & { distanceTo?(other: Point): number }; isInWater?: boolean };
  entities?: Record<string, { name?: string; position?: Point } | undefined>;
  inventory?: { items?(): Array<{ name: string; count: number }> };
}
interface Running {
  id: string; skill: string; measure: Measure | null; args: Readonly<Record<string, unknown>>;
  startedAt: number; lastProgressAt: number; lastToldAt: number; stalledTold: boolean;
  best: number | null; trail: Array<{ at: Point; time: number }>; carried: Map<string, number>; gained: number;
}

export interface BodyEventSource {
  /** Reads the body and queues what changed. Cheap; called on the observation timer. */
  tick(): void;
  pending(limit?: number): readonly MinecraftBodyEvent[];
  /** Drops every event up to and including `through`. */
  acknowledge(through: number): void;
}

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round = (value: number) => Math.round(value * 10) / 10;

export class BodyEventWatcher implements BodyEventSource {
  private seq = 0;
  private queue: MinecraftBodyEvent[] = [];
  private running: Running | null = null;
  private needs = new Map<string, { need: NearbyNeed; missing: number }>();
  private needsReadAt = -Infinity;

  constructor(private readonly bot: EventsBody, private readonly now: () => number = Date.now,
    private readonly readNeeds: (bot: EventsBody, now: number) => NearbyNeed[] = (bot, now) => nearbyNeeds(bot as never, now)) {}

  /** A skill command starts: its measure begins now. A read-only skill or a reflex operation is not followed. */
  begin(command: Pick<Command, 'id' | 'skill' | 'arguments'>): void {
    const skill = String(command.skill ?? '').replace(/^mc\./u, '');
    const now = this.now();
    const args = command.arguments ?? {};
    // A chase is measured only on one kind it can find (not a group word such as hostile, nor a stand that waits for them to come).
    const chaseable = WATCHED[skill] !== 'chase' || (/^[a-z_]+$/u.test(String(args.entityName ?? '').trim().toLowerCase())
      && !['hostile', 'food_animals', 'animals', 'any'].includes(String(args.entityName).trim().toLowerCase()) && args.holdPosition !== true);
    this.running = { id: command.id, skill, measure: chaseable ? WATCHED[skill] ?? null : null, args, startedAt: now,
      lastProgressAt: now, lastToldAt: now, stalledTold: false, best: null, trail: [], carried: this.carried(), gained: 0 };
    const at = this.position();
    if (at) this.running.trail.push({ at, time: now });
    this.running.best = this.distance(this.running);
  }

  end(id: string): void { if (this.running?.id === id) this.running = null; }

  tick(): void {
    const now = this.now();
    try { this.follow(now); } catch { /* a body without a world yet */ }
    if (now - this.needsReadAt >= BODY_EVENTS.needsEveryMs) {
      this.needsReadAt = now;
      try { this.diffNeeds(now); } catch { /* the same */ }
    }
  }

  pending(limit: number = BODY_EVENTS.perPoll): readonly MinecraftBodyEvent[] { return this.queue.slice(0, limit); }

  acknowledge(through: number): void {
    if (Number.isSafeInteger(through)) this.queue = this.queue.filter(event => event.seq > through);
  }

  private push(kind: MinecraftBodyEvent['kind'], subject: string, data: Record<string, Scalar>, now: number): void {
    this.queue.push({ seq: ++this.seq, at: new Date(now).toISOString(), kind, subject, data });
    while (this.queue.length > BODY_EVENTS.max) {
      const progress = this.queue.findIndex(event => event.kind === 'action.progress');
      this.queue.splice(progress >= 0 ? progress : 0, 1);
    }
  }

  private follow(now: number): void {
    const run = this.running;
    if (!run) return;
    const carried = this.carried();
    let gained = 0;
    for (const [name, count] of carried) gained += Math.max(0, count - (run.carried.get(name) ?? 0));
    run.carried = carried;
    let progressed = gained > 0;
    run.gained += gained;
    const distance = this.distance(run);
    const closer = run.measure === 'chase' ? BODY_EVENTS.chaseCloserBy : BODY_EVENTS.closerBy;
    if (distance !== null && (run.best === null || distance <= run.best - closer)) {
      if (run.best !== null) progressed = true;
      run.best = distance;
    }
    // After a kill the next one is chased from wherever it is: closing in on it counts from there.
    if (run.measure === 'chase' && gained > 0) run.best = distance;
    const at = this.position();
    // The last places it counted at, by number not by time: forgetting them after a while let pacing between two spots count again.
    if (run.trail.length > BODY_EVENTS.trail) run.trail = run.trail.slice(-BODY_EVENTS.trail);
    if (!run.trail.length && at) run.trail.push({ at, time: now });
    const away = run.measure === 'travel' ? BODY_EVENTS.travelBy : run.measure === 'target' ? BODY_EVENTS.detourBy : null;
    if (away !== null && at && run.trail.length && run.trail.every(mark => Math.hypot(at.x - mark.at.x, at.y - mark.at.y, at.z - mark.at.z) >= away)) progressed = true;
    if (progressed) { run.lastProgressAt = now; run.stalledTold = false; if (at) run.trail.push({ at, time: now }); }
    // Sooner in water only for a chase or a move: a dig there is slow but still digging.
    const water = this.bot.entity?.isInWater === true && (run.measure === 'chase' || run.measure === 'target');
    const facts = (): Record<string, Scalar> => ({ skill: run.skill, measure: run.measure, elapsedMs: now - run.startedAt,
      sinceProgressMs: now - run.lastProgressAt, gained: run.gained, ...(distance !== null ? { distance: round(distance) } : {}),
      ...(water ? { hazard: 'water' } : {}) });
    if (now - run.lastToldAt >= BODY_EVENTS.progressEveryMs) { run.lastToldAt = now; this.push('action.progress', run.id, facts(), now); }
    if (run.measure && !run.stalledTold && now - run.lastProgressAt >= (water ? BODY_EVENTS.waterStallMs : BODY_EVENTS.stallMs)) {
      run.stalledTold = true;
      this.push('action.stalled', run.id, facts(), now);
    }
  }

  /** The distance still to go by the skill's own measure, or null when it has none (or no coordinates were given). */
  private distance(run: Running): number | null {
    const at = this.position();
    if (!at) return null;
    if (run.measure === 'depth') { const y = number(run.args.targetY); return y === null ? null : Math.abs(at.y - y); }
    if (run.measure === 'chase') return this.nearest(String(run.args.entityName ?? '').trim().toLowerCase(), at);
    if (run.measure !== 'target') return null;
    const x = number(run.args.x), y = number(run.args.y), z = number(run.args.z);
    const goal = typeof run.args.goalType === 'string' ? run.args.goalType : 'nearxz';
    if (goal === 'y') return y === null ? null : Math.abs(y - at.y);
    if (x === null || z === null) return null;
    if (goal === 'xz' || goal === 'nearxz' || y === null) return Math.hypot(x - at.x, z - at.z);
    return Math.hypot(x - at.x, y - at.y, z - at.z);
  }

  /** How far the nearest entity of this name is (a group word such as hostile or food_animals has none), or null. */
  private nearest(name: string, at: Point): number | null {
    if (!/^[a-z_]+$/u.test(name)) return null;
    let best: number | null = null;
    for (const entity of Object.values(this.bot.entities ?? {})) {
      const p = entity?.name === name ? entity.position : undefined;
      if (!p) continue;
      const d = Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  private diffNeeds(now: number): void {
    const seen = new Map(this.readNeeds(this.bot, now).map(need => [need.id, need]));
    for (const [id, need] of seen) {
      const before = this.needs.get(id)?.need;
      this.needs.set(id, { need, missing: 0 });
      // Told again when whether it can be got at changed (a block mine-block just failed to reach), so the API never sends her back to it.
      if (before && before.canReach === need.canReach && (before.exposed === false) === (need.exposed === false)) continue;
      this.push('need.appeared', id, { need: need.need, name: need.name, distance: need.distance, canReach: need.canReach,
        x: need.position.x, y: need.position.y, z: need.position.z,
        ...(need.color ? { color: need.color } : {}), ...(need.exposed === false ? { exposed: false } : {}) }, now);
    }
    for (const [id, entry] of this.needs) {
      if (seen.has(id)) continue;
      entry.missing += 1;
      if (entry.missing < 2) continue;
      this.needs.delete(id);
      this.push('need.gone', id, { need: entry.need.need, name: entry.need.name }, now);
    }
  }

  private position(): Point | null {
    const p = this.bot.entity?.position;
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? { x: p.x, y: p.y, z: p.z } : null;
  }

  private carried(): Map<string, number> {
    const out = new Map<string, number>();
    try { for (const item of this.bot.inventory?.items?.() ?? []) out.set(item.name, (out.get(item.name) ?? 0) + item.count); } catch { /* none */ }
    return out;
  }
}
