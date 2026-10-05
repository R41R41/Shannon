/**
 * What has kept the body from its task lately.
 *
 * An emergency takes the body from the planner that holds the task, and gives it back when it is over. That
 * planner went on from where it had been stopped and knew nothing of the stop: it walked back toward the
 * fortress it was going to, was stopped for the same blazes thirty blocks off, shut itself in, was given the
 * body back, and walked on again, twelve times in twenty minutes, until the food was gone and the wither
 * skeletons had it (paid run L77k). Each emergency was handled well enough; nothing held the twelve together.
 * A person stopped a third time for the same thing asks whether to go on this way at all. This is the count
 * such a question starts from: what the stops were for, how many, how long they took and what they cost.
 *
 * Pure data, no game. Whether to do anything about it is the planner's.
 */
export interface Interruption {
  at: number;
  /** When the task was given back. Absent while the emergency still holds the body. */
  endedAt?: number;
  /** The kind of emergency: hostile_approach, damage, suffocation. */
  cause: string;
  /** What it was about, in the game's words where it has them: the kinds of mob, or the harm (lava, starving). */
  kinds: string[];
  /** Health lost while it held the body. */
  damage: number;
}
export interface InterruptionLog { entries: Interruption[] }

export const INTERRUPTION_WINDOW_MS = 10 * 60_000;
/** Stops for the same thing within the window from which it is said to the planner. */
export const REPEATED_INTERRUPTIONS = 3;
const MAX_ENTRIES = 64;

export const emptyInterruptionLog = (): InterruptionLog => ({ entries: [] });

/** A new stop. One still open is ended by it: the task was not given back in between. */
export function openInterruption(log: InterruptionLog, entry: { cause: string; kinds: string[] }, now: number): Interruption {
  const open = log.entries.at(-1);
  if (open && open.endedAt === undefined) open.endedAt = now;
  const interruption: Interruption = { at: now, cause: entry.cause, kinds: [...new Set(entry.kinds.filter(Boolean))], damage: 0 };
  log.entries.push(interruption);
  if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES);
  return interruption;
}

/** The task has the body back. */
export function closeInterruption(log: InterruptionLog, now: number): void {
  const open = log.entries.at(-1);
  if (open && open.endedAt === undefined) open.endedAt = now;
}

/** Health lost while a stop holds the body. */
export function hurtWhileInterrupted(log: InterruptionLog, amount: number): void {
  const open = log.entries.at(-1);
  if (open && open.endedAt === undefined && amount > 0) open.damage += amount;
}

export interface InterruptionSummary {
  count: number;
  /** Stops each kind had a part in, most first. */
  perKind: Array<{ kind: string; count: number }>;
  /** The kinds that came up `REPEATED_INTERRUPTIONS` times or more. */
  repeated: string[];
  spentMs: number;
  damage: number;
  windowMs: number;
}

/** The stops of the last while, or null when nothing has come up often enough to be worth saying. */
export function summariseInterruptions(log: InterruptionLog, now: number, windowMs = INTERRUPTION_WINDOW_MS): InterruptionSummary | null {
  const recent = log.entries.filter(entry => now - entry.at <= windowMs);
  if (recent.length < REPEATED_INTERRUPTIONS) return null;
  const counts = new Map<string, number>();
  for (const entry of recent) for (const kind of entry.kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const perKind = [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  const repeated = perKind.filter(entry => entry.count >= REPEATED_INTERRUPTIONS).map(entry => entry.kind);
  if (!repeated.length) return null;
  return { count: recent.length, perKind, repeated, windowMs,
    spentMs: recent.reduce((sum, entry) => sum + Math.max(0, (entry.endedAt ?? now) - entry.at), 0),
    damage: Math.round(recent.reduce((sum, entry) => sum + entry.damage, 0) * 10) / 10 };
}

/** The same in a line for the planner: what happened, not what to do about it. */
export function describeInterruptions(summary: InterruptionSummary): string {
  const kinds = summary.perKind.slice(0, 4).map(entry => `${entry.kind} ${entry.count}回`).join('、');
  return `直近${Math.round(summary.windowMs / 60_000)}分で、このタスクは緊急対応に${summary.count}回中断された（${kinds}）。`
    + `緊急対応に計${(summary.spentMs / 60_000).toFixed(1)}分、その間の被ダメージ計${summary.damage}。`
    + `${summary.repeated.join('・')} による中断が繰り返されている`;
}
