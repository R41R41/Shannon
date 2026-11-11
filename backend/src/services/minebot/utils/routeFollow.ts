/**
 * followRoute: walks a plan of utils/routePlan with the hands the body already has (run 7, Lai: "その道で動く"). go draws the plan first and walks it when it is complete (primitives/go: planned);
 * the route search of the walk (the pathfinder) walks what is left, or all of it when no complete plan is there.
 *
 * - Steps the tunnel walk takes as cells (a level walked, one up or down, a level cut, a stair cut, a shaft) go in runs to `cells` (utils/tunnelWalk.walkCells: it digs, refuses lava
 *   beside a cell and remembers the cells walked).
 * - A step whose dug block has water at its side or over it is a run of its own and the water is sealed first (`seal`: wetWall.sealWetFaces, the hand's own rule); if a face stays open the
 *   cell is not dug (stopped: blocked), never dug into the water.
 * - A fall of more than one level, a diagonal and a ladder are walked with digging and laying off (`walkTo`) to the step's cell.
 * - A bridge or a step is a block laid in its cell (`place`), then a step onto it. A pillar over rock cuts the rock first (`dig`).
 * The plan is a reading; this follows it and checks at each run end that the body is where the plan said. A difference plans again from where the body stands (`replan`, at most
 * `maxReplans` times): the cells dug so far are open now, so nothing is dug twice.
 * Limits are the caller's: a run that would dig or lay past `maxDig` / `maxPlace` is not begun.
 */
import { Vec3 } from 'vec3';
import type { Cell } from './localMap.js';
import { isStep, type TunnelOutcome } from './tunnelWalk.js';
import type { RoutePlan, RouteStep } from './routePlan.js';

export interface FollowHands {
  /** Walk these cells one at a time, cutting what the steps need (tunnelWalk.walkCells). */
  cells(cells: Vec3[]): Promise<TunnelOutcome>;
  /** Walk to the cell with no digging and no laying; true when the body stands there. */
  walkTo(cell: Cell): Promise<boolean>;
  /** Lay a block in the cell; true when it is there. */
  place(cell: Cell): Promise<boolean>;
  /** Cut a block (the rock over a pillar); true when the cell is empty after. */
  dig(cell: Cell): Promise<boolean>;
  /** Whether water would run into the cell if it were dug (its sides and its top), read now. */
  wetAt(cell: Cell): boolean;
  /** Seal the water at the cell's sides and top; ok when every face held (`placed` blocks were laid), else the words. */
  seal(cell: Cell): Promise<{ ok: boolean; placed: number; words: string }>;
  /** Where the body's feet are. */
  feet(): Cell;
}

export interface FollowOptions {
  /** A plan made from the body's cell now, or null when none can be made (asked after a difference). */
  replan?: (from: Cell, used: { digs: number; places: number }) => RoutePlan | null;
  maxReplans?: number;
  deadline: number;
  /** The most blocks this follow may dig and lay (the caller's limits that are left). Absent: the plan's own numbers are the bound. */
  maxDig?: number;
  maxPlace?: number;
  now?: () => number;
  /**
   * Asked before every run and every group of cells, with the cell the body stands in: the go's own guards (stop, stopIf, the fall, fire and lava) are the caller's.
   * A stop it throws goes on as it is (a StepStopped); an outcome it returns ends the follow with it.
   */
  guard?: (run: Run, from: Cell) => Pick<FollowOutcome, 'stopped' | 'at' | 'reason'> | null;
}

export interface FollowOutcome {
  stopped: 'reached' | 'timeout' | 'blocked' | 'off_route' | 'plan_end' | 'limit_dig' | 'limit_place' | 'unsafe' | 'no_return';
  steps: number;
  digs: number;
  places: number;
  replans: number;
  at?: Cell;
  reason?: string;
}

const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;
const vec = (cell: Cell) => new Vec3(cell.x, cell.y, cell.z);

/** A step that is a cell step of the tunnel walk (not a diagonal, a fall over one level or a ladder). */
function asCell(step: RouteStep, from: Cell): boolean {
  if (step.kind === 'diagonal' || step.kind === 'drop' || step.kind === 'ladder') return false;
  return isStep(from, step.to);
}

export type Run = { kind: 'cells'; cells: Cell[]; steps: RouteStep[] } | { kind: 'walk'; step: RouteStep } | { kind: 'laid'; step: RouteStep };

/** The steps of a plan as runs: a run of cells, or one hand. */
export function runsOf(from: Cell, steps: RouteStep[]): Run[] {
  const runs: Run[] = [];
  let at = from;
  for (const step of steps) {
    if (step.kind === 'bridge' || step.kind === 'scaffold') runs.push({ kind: 'laid', step });
    else if (!asCell(step, at)) runs.push({ kind: 'walk', step });
    else {
      const last = runs[runs.length - 1];
      const floorLaid = step.kind === 'dig_level' && step.place.some(cell => cell.x === step.to.x && cell.y === step.to.y - 1 && cell.z === step.to.z);
      if (floorLaid) runs.push({ kind: 'laid', step });
      else if (last?.kind === 'cells') { last.cells.push(step.to); last.steps.push(step); }
      else runs.push({ kind: 'cells', cells: [step.to], steps: [step] });
    }
    at = step.to;
  }
  return runs;
}

/** The cells a step lays a block in, floor first (the dug blocks that have water at their side are in `place` as their own seal: sealed live, not laid here). */
const laidCells = (step: RouteStep): Cell[] => step.place.filter(cell => !step.wet.some(wet => sameCell(wet, cell)));

export async function followRoute(initial: RoutePlan, hands: FollowHands, options: FollowOptions): Promise<FollowOutcome> {
  const out: FollowOutcome = { stopped: 'plan_end', steps: 0, digs: 0, places: 0, replans: 0 };
  const now = options.now ?? Date.now;
  const maxReplans = options.maxReplans ?? 3;
  const maxDig = options.maxDig ?? Infinity, maxPlace = options.maxPlace ?? Infinity;
  let plan = initial;
  for (;;) {
    const start = hands.feet();
    const runs = runsOf(start, plan.steps);
    let off: Cell | null = null;
    /** A run is begun only inside the limits; the answer is the stop, or null. */
    const overLimit = (digs: number, places: number): FollowOutcome | null => {
      if (out.digs + digs > maxDig) return { ...out, stopped: 'limit_dig', at: hands.feet(), reason: `掘る上限 ${maxDig} を超える（ここまで ${out.digs}、次の所で ${digs}）` };
      if (out.places + places > maxPlace) return { ...out, stopped: 'limit_place', at: hands.feet(), reason: `置く上限 ${maxPlace} を超える（ここまで ${out.places}、次の所で ${places}）` };
      return null;
    };
    /** One step with the water at its dug cells sealed first; null when it is dug, else the stop. */
    const sealed = async (step: RouteStep): Promise<FollowOutcome | null> => {
      for (const cell of step.dig) {
        if (!hands.wetAt(cell)) continue;
        const result = await hands.seal(cell);
        out.places += result.placed;
        if (!result.ok) return { ...out, stopped: 'blocked', at: cell, reason: `(${cell.x},${cell.y},${cell.z}) の裏に水があり塞げない（${result.words}）。水に向かっては掘らない` };
      }
      return null;
    };
    for (const run of runs) {
      if (now() > options.deadline) return { ...out, stopped: 'timeout', at: hands.feet() };
      const refused = options.guard?.(run, hands.feet());
      if (refused) return { ...out, ...refused };
      if (run.kind === 'cells') {
        const wet = run.steps.some(step => step.dig.some(cell => hands.wetAt(cell)));
        const groups: Array<{ cells: Cell[]; steps: RouteStep[] }> = wet ? run.steps.map(step => ({ cells: [step.to], steps: [step] })) : [{ cells: run.cells, steps: run.steps }];
        let ended = false;
        for (const group of groups) {
          if (group !== groups[0]) {
            if (now() > options.deadline) return { ...out, stopped: 'timeout', at: hands.feet() };
            const again = options.guard?.({ kind: 'cells', cells: group.cells, steps: group.steps }, hands.feet());
            if (again) return { ...out, ...again };
          }
          const limit = overLimit(group.steps.reduce((n, step) => n + step.dig.length, 0), 0);
          if (limit) return limit;
          if (wet) { const stop = await sealed(group.steps[0]); if (stop) return stop; }
          // A pillar over rock: the rock over the head is cut first (the walk's pillar hand lays the block).
          for (const step of group.steps) if (step.kind === 'pillar') for (const cell of step.dig) { if (!(await hands.dig(cell))) return { ...out, stopped: 'blocked', at: cell, reason: `(${cell.x},${cell.y},${cell.z}) を掘れなかった` }; out.digs++; }
          const outcome = await hands.cells(group.cells.map(vec));
          out.steps += outcome.steps; out.digs += outcome.digs;
          out.places += group.steps.filter(step => step.kind === 'pillar').length;
          if (outcome.stopped === 'timeout') return { ...out, stopped: 'timeout', at: hands.feet() };
          if (outcome.stopped === 'reached') return { ...out, stopped: 'reached', at: hands.feet() };
          if (outcome.stopped === 'blocked') return { ...out, stopped: 'blocked', at: outcome.at, reason: outcome.reason };
          if (!sameCell(hands.feet(), group.cells[group.cells.length - 1])) { off = hands.feet(); ended = true; break; }
        }
        if (ended) break;
      } else if (run.kind === 'walk') {
        const ok = await hands.walkTo(run.step.to);
        if (ok) out.steps++;
        if (!ok || !sameCell(hands.feet(), run.step.to)) { off = hands.feet(); break; }
      } else {
        const floor = laidCells(run.step);
        const limit = overLimit(run.step.dig.length, floor.length);
        if (limit) return limit;
        if (run.step.dig.length) { const stop = await sealed(run.step); if (stop) return stop; }
        for (const cell of floor) {
          if (!(await hands.place(cell))) return { ...out, stopped: 'blocked', at: cell, reason: `(${cell.x},${cell.y},${cell.z}) にブロックを置けなかった` };
          out.places++;
        }
        const outcome = await hands.cells([vec(run.step.to)]);
        out.steps += outcome.steps; out.digs += outcome.digs;
        if (outcome.stopped === 'blocked') return { ...out, stopped: 'blocked', at: outcome.at, reason: outcome.reason };
        if (!sameCell(hands.feet(), run.step.to)) { off = hands.feet(); break; }
      }
    }
    if (!off && plan.status === 'partial' && options.replan && out.replans < maxReplans && plan.steps.length) {
      // The plan ended at its frontier (the box or the time ended): plan again from there.
      const again = options.replan(hands.feet(), { digs: out.digs, places: out.places });
      if (again && (again.status === 'success' || again.status === 'partial') && again.steps.length) { out.replans++; plan = again; continue; }
    }
    if (!off) {
      const goal = plan.steps.length ? plan.steps[plan.steps.length - 1].to : start;
      return { ...out, stopped: plan.status === 'partial' ? 'plan_end' : sameCell(hands.feet(), goal) ? 'reached' : 'off_route', at: hands.feet() };
    }
    // Not where the plan said: plan again from here, the cells dug so far being open.
    if (out.replans >= maxReplans || !options.replan) return { ...out, stopped: 'off_route', at: off, reason: `計画のマスに着けなかった（いま (${off.x},${off.y},${off.z})）` };
    const again = options.replan(off, { digs: out.digs, places: out.places });
    if (!again || (again.status !== 'success' && again.status !== 'partial') || !again.steps.length) return { ...out, stopped: 'off_route', at: off, reason: '出し直しの道が無い' };
    out.replans++;
    plan = again;
  }
}
