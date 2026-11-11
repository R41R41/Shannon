/**
 * followRoute: runs a plan of utils/routePlan with the hands the body already has, and plans again when the body is not where the plan said.
 *
 * - Steps the tunnel walk can take as cells (a level walked, one up or down, a level cut, a stair cut, a shaft, a pillar) go in runs to utils/tunnelWalk.walkCells,
 *   which digs, refuses lava and water beside a cell, and remembers the cells walked (so the way back digs nothing).
 * - A fall of more than one level, a diagonal and a ladder are walked by the route search with digging and laying off (utils/travelProfile.walkOnlyProfile), to the step's cell.
 * - A bridge or a step is a block laid in its cell (the `place` hand), then a step onto it.
 * - A dug block with water at its side is sealed after the body has passed (when the caller gives a `seal`).
 * Nothing here chooses a way: the plan did. After each run the body's cell is compared with the plan's; a difference plans again (the cells dug so far are open now, so
 * nothing is dug twice), at most `maxReplans` times.
 */
import { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';
import type { Cell } from './localMap.js';
import { isStep, walkCells, type TunnelOutcome } from './tunnelWalk.js';
import type { RoutePlan, RouteStep } from './routePlan.js';

/** The hands a run needs; a caller (and a test) may give its own. */
export interface FollowHands {
  /** Walk these cells one at a time, cutting what the steps need (utils/tunnelWalk.walkCells). */
  cells(cells: Vec3[]): Promise<TunnelOutcome>;
  /** Walk to the cell by the route search with no digging and no laying; true when the body stands there. */
  walkTo(cell: Cell): Promise<boolean>;
  /** Lay a block in the cell; true when it is there. */
  place(cell: Cell): Promise<boolean>;
  /** Seal a dug block that has water at its side (optional). */
  seal?(cell: Cell): Promise<boolean>;
  /** Where the body's feet are. */
  feet(): Cell;
}

export interface FollowOptions {
  /** A plan made from the body's cell now, or null when none can be made (asked after a difference). */
  replan?: (from: Cell) => RoutePlan | null;
  maxReplans?: number;
  deadline: number;
}

export interface FollowOutcome {
  stopped: 'reached' | 'timeout' | 'blocked' | 'off_route' | 'plan_end';
  steps: number;
  digs: number;
  places: number;
  replans: number;
  at?: Cell;
  reason?: string;
}

const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;
const vec = (cell: Cell) => new Vec3(cell.x, cell.y, cell.z);

/** Whether a step is one the tunnel walk takes as a cell (see utils/tunnelWalk.isStep), with a laid block done before it by the caller if the step has one. */
function asCell(step: RouteStep, from: Cell): boolean {
  if (step.kind === 'diagonal' || step.kind === 'drop' || step.kind === 'ladder') return false;
  return isStep(from, step.to);
}

/** The steps of a plan as runs: a run of cells, or one hand. */
export type Run = { kind: 'cells'; cells: Cell[]; steps: RouteStep[] } | { kind: 'walk'; step: RouteStep } | { kind: 'laid'; step: RouteStep };

export function runsOf(from: Cell, steps: RouteStep[]): Run[] {
  const runs: Run[] = [];
  let at = from;
  for (const step of steps) {
    // A step that lays its floor first (a bridge, a step up onto a laid block, a level cut over a gap) is a run of its own; so is one that is not a cell step.
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

/** The cells a step lays a block in, floor first (a dug block's seal is the caller's `seal`). */
const laidCells = (step: RouteStep): Cell[] => step.place.filter(cell => !step.wet.some(wet => sameCell(wet, cell)));

export async function followRoute(initial: RoutePlan, hands: FollowHands, options: FollowOptions): Promise<FollowOutcome> {
  const out: FollowOutcome = { stopped: 'plan_end', steps: 0, digs: 0, places: 0, replans: 0 };
  let plan = initial;
  const maxReplans = options.maxReplans ?? 3;
  for (;;) {
    const start = hands.feet();
    const runs = runsOf(start, plan.steps);
    let off: Cell | null = null;
    for (const run of runs) {
      if (Date.now() > options.deadline) return { ...out, stopped: 'timeout' };
      if (run.kind === 'cells') {
        const outcome = await hands.cells(run.cells.map(vec));
        out.steps += outcome.steps; out.digs += outcome.digs;
        const end = run.cells[run.cells.length - 1];
        if (outcome.stopped === 'timeout') return { ...out, stopped: 'timeout' };
        if (outcome.stopped === 'reached') return { ...out, stopped: 'reached', at: hands.feet() };
        if (outcome.stopped === 'blocked') return { ...out, stopped: 'blocked', at: outcome.at, reason: outcome.reason };
        if (!sameCell(hands.feet(), end)) { off = hands.feet(); break; }
      } else if (run.kind === 'walk') {
        const ok = await hands.walkTo(run.step.to);
        if (ok) out.steps++;
        if (!ok || !sameCell(hands.feet(), run.step.to)) { off = hands.feet(); break; }
      } else {
        // Floor first, then the step onto it (cells the step cuts are cut by the walk).
        for (const cell of laidCells(run.step)) {
          if (!(await hands.place(cell))) return { ...out, stopped: 'blocked', at: cell, reason: `(${cell.x},${cell.y},${cell.z}) にブロックを置けなかった` };
          out.places++;
        }
        const outcome = await hands.cells([vec(run.step.to)]);
        out.steps += outcome.steps; out.digs += outcome.digs;
        if (outcome.stopped === 'blocked') return { ...out, stopped: 'blocked', at: outcome.at, reason: outcome.reason };
        if (!sameCell(hands.feet(), run.step.to)) { off = hands.feet(); break; }
      }
      if (hands.seal) for (const cell of (run.kind === 'cells' ? run.steps.flatMap(step => step.wet) : run.step.wet)) { if (await hands.seal(cell)) out.places++; }
    }
    if (!off) {
      const goal = plan.steps.length ? plan.steps[plan.steps.length - 1].to : start;
      return { ...out, stopped: plan.status === 'partial' ? 'plan_end' : sameCell(hands.feet(), goal) ? 'reached' : 'off_route', at: hands.feet() };
    }
    // Not where the plan said: plan again from here, the cells dug so far being open.
    if (out.replans >= maxReplans || !options.replan) return { ...out, stopped: 'off_route', at: off, reason: `計画のマスに着けなかった（いま (${off.x},${off.y},${off.z})）` };
    const again = options.replan(off);
    if (!again || (again.status !== 'success' && again.status !== 'partial') || !again.steps.length) return { ...out, stopped: 'off_route', at: off, reason: '出し直しの道が無い' };
    out.replans++;
    plan = again;
  }
}

// ===== The body's own hands =====

/** The hands of a live body: the tunnel walk's cells, a walk-only route search, and the `place` hand with the cheapest block the pack holds. */
export function bodyHands(bot: CustomBot, extra: { isEnd: (feet: Vec3) => boolean; deadline: number; pillar?: (height: number) => Promise<unknown>;
  walkTo: (cell: Cell) => Promise<boolean>; place: (cell: Cell) => Promise<boolean>; seal?: (cell: Cell) => Promise<boolean> }): FollowHands {
  return {
    cells: cells => walkCells(bot, cells, { isEnd: extra.isEnd, deadline: extra.deadline, pillar: extra.pillar }),
    walkTo: extra.walkTo,
    place: extra.place,
    seal: extra.seal,
    feet: () => { const p = bot.entity.position.floored(); return { x: p.x, y: p.y, z: p.z }; },
  };
}
