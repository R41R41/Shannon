import type { Progress } from '../../integration/commonFca/continueContract.js';
import { feetCell, type Cell } from '../localMap.js';
import type { StepOutcome } from './common.js';

/**
 * Continue contracts (1): how far a part got, by the part's own measure. The helpers every part uses to say it, so that the act never reads it back out of a line's words.
 */
export const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Runs a part and puts the progress `measure` gives on what it returns (unless the part gave its own), and on the stop it throws: the act reads `error.progress`
 * of a hand that was cut (a reflex, its stopIf, the deadline), so a cut hand that had got somewhere is `partial` and not `failed`.
 * `measure` is called with the outcome (or null when the part was cut) and never stops the part: a measure that throws leaves the outcome as it was.
 */
export async function withProgress(run: () => Promise<StepOutcome>, measure: (outcome: StepOutcome | null) => Progress | undefined): Promise<StepOutcome> {
  let outcome: StepOutcome;
  try { outcome = await run(); }
  catch (error) {
    if (error && typeof error === 'object' && !(error as { progress?: unknown }).progress) {
      try { const progress = measure(null); if (progress) (error as { progress?: Progress }).progress = progress; } catch { /* the cut stands without it */ }
    }
    throw error;
  }
  if (outcome.progress) return outcome;
  try { const progress = measure(outcome); return progress ? { ...outcome, progress } : outcome; } catch { return outcome; }
}

/** The metres from a point to the nearest of the cells (their middles across, the cell's own level up). One number with the stop's `left`: the same as go's "あと 6m". */
export function metresTo(position: { x: number; y: number; z: number }, cells: readonly Cell[]): number | null {
  let best: number | null = null;
  for (const cell of cells) {
    const d = Math.hypot(position.x - (cell.x + 0.5), position.y - cell.y, position.z - (cell.z + 0.5));
    if (best === null || d < best) best = d;
  }
  return best;
}

/**
 * A walk's or a go's progress in metres: `done` is how much nearer to the nearest of `aims` the body came since `from` (it never goes below 0: a body that
 * walked away from the place made no headway, so a stop there is not `partial`), `left` and `fromStopM` are the metres from where it stopped. The straight
 * metres, not the route's: the route is the part's own notes.
 */
export function meterProgress(bot: any, from: { x: number; y: number; z: number } | null | undefined, aims: readonly Cell[]): Progress {
  const position = bot.entity?.position;
  const startM = from ? metresTo(from, aims) : null;
  const stopM = position ? metresTo(position, aims) : null;
  const feet = (() => { try { return feetCell(bot); } catch { return null; } })();
  return {
    unit: 'meter', done: startM !== null && stopM !== null ? Math.max(0, round1(startM - stopM)) : 0, left: stopM !== null ? round1(stopM) : null,
    ...(feet ? { at: { x: feet.x, y: feet.y, z: feet.z } } : {}), ...(stopM !== null ? { fromStopM: round1(stopM) } : {}),
  };
}
