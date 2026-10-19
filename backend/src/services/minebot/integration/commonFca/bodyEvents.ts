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
  /** The needs list is read this often (utils/nearbyNeeds caches for 3 s itself). */
  needsEveryMs: 3_000,
  /** A move toward a target counts as getting somewhere when the best distance shrinks by this much. */
  closerBy: 1,
  /** A walk without a target (a dig looking for its ore, an exploration) counts when it gets this far from where it last counted. */
  travelBy: 4,
});

/**
 * How each long skill's progress is measured. `target`: the distance to the coordinates it was given (as move-to measures it);
 * `depth`: the height still to go (targetY); `travel`: getting away from where it last counted. Every one also counts a gain in what
 * the body carries (a mined ore, a dug block). A skill not named here (a wait, a craft) is told in `action.progress` but never stalled.
 */
const WATCHED: Readonly<Record<string, 'target' | 'depth' | 'travel'>> = {
  'move-to': 'target', 'mine-block': 'travel', 'stair-mine': 'depth', 'explore-for-structure': 'travel',
};

type Scalar = string | number | boolean | null;
interface Point { x: number; y: number; z: number }
interface EventsBody {
  entity?: { position?: Point & { distanceTo?(other: Point): number } };
  inventory?: { items?(): Array<{ name: string; count: number }> };
}
interface Running {
  id: string; skill: string; measure: 'target' | 'depth' | 'travel' | null; args: Readonly<Record<string, unknown>>;
  startedAt: number; lastProgressAt: number; lastToldAt: number; stalledTold: boolean;
  best: number | null; anchor: Point | null; carried: Map<string, number>; gained: number;
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
    this.running = { id: command.id, skill, measure: WATCHED[skill] ?? null, args: command.arguments ?? {}, startedAt: now,
      lastProgressAt: now, lastToldAt: now, stalledTold: false, best: null, anchor: this.position(), carried: this.carried(), gained: 0 };
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
    if (distance !== null && (run.best === null || distance <= run.best - BODY_EVENTS.closerBy)) {
      if (run.best !== null) progressed = true;
      run.best = distance;
    }
    const at = this.position();
    if (run.measure === 'travel' && at && run.anchor && Math.hypot(at.x - run.anchor.x, at.y - run.anchor.y, at.z - run.anchor.z) >= BODY_EVENTS.travelBy) {
      progressed = true; run.anchor = at;
    }
    if (progressed) { run.lastProgressAt = now; run.stalledTold = false; if (run.measure === 'travel') run.anchor = at ?? run.anchor; }
    const facts = (): Record<string, Scalar> => ({ skill: run.skill, measure: run.measure, elapsedMs: now - run.startedAt,
      sinceProgressMs: now - run.lastProgressAt, gained: run.gained, ...(distance !== null ? { distance: round(distance) } : {}) });
    if (now - run.lastToldAt >= BODY_EVENTS.progressEveryMs) { run.lastToldAt = now; this.push('action.progress', run.id, facts(), now); }
    if (run.measure && !run.stalledTold && now - run.lastProgressAt >= BODY_EVENTS.stallMs) {
      run.stalledTold = true;
      this.push('action.stalled', run.id, facts(), now);
    }
  }

  /** The distance still to go by the skill's own measure, or null when it has none (or no coordinates were given). */
  private distance(run: Running): number | null {
    const at = this.position();
    if (!at) return null;
    if (run.measure === 'depth') { const y = number(run.args.targetY); return y === null ? null : Math.abs(at.y - y); }
    if (run.measure !== 'target') return null;
    const x = number(run.args.x), y = number(run.args.y), z = number(run.args.z);
    const goal = typeof run.args.goalType === 'string' ? run.args.goalType : 'nearxz';
    if (goal === 'y') return y === null ? null : Math.abs(y - at.y);
    if (x === null || z === null) return null;
    if (goal === 'xz' || goal === 'nearxz' || y === null) return Math.hypot(x - at.x, z - at.z);
    return Math.hypot(x - at.x, y - at.y, z - at.z);
  }

  private diffNeeds(now: number): void {
    const seen = new Map(this.readNeeds(this.bot, now).map(need => [need.id, need]));
    for (const [id, need] of seen) {
      if (this.needs.has(id)) { this.needs.set(id, { need, missing: 0 }); continue; }
      this.needs.set(id, { need, missing: 0 });
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
